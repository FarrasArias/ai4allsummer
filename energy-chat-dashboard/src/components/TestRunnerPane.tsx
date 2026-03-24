import React, { useEffect, useRef, useState } from "react";
import {
  getTestPromptFiles,
  listModels,
  runTests,
  stopTests,
} from "../api";

/* ── tiny CSS-in-JS keyframes (injected once) ── */
const STYLE_ID = "test-runner-animations";
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes tr-bounce {
      0%, 80%, 100% { transform: scale(0); }
      40%           { transform: scale(1); }
    }
    @keyframes tr-pulse {
      0%, 100% { opacity: .45; }
      50%      { opacity: 1; }
    }
    @keyframes tr-progress {
      0%   { background-position: 0% 50%; }
      100% { background-position: 200% 50%; }
    }
  `;
  document.head.appendChild(style);
}

type Props = {
  defaultModel?: string;
};

export default function TestRunnerPane({ defaultModel }: Props) {
  // -- form state --
  const [promptFiles, setPromptFiles] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [selectedPromptFile, setSelectedPromptFile] = useState("");
  const [outputFile, setOutputFile] = useState("test_results.csv");
  const [model, setModel] = useState(defaultModel || "");
  const [thinkingMode, setThinkingMode] = useState<"fast" | "deep">("fast");
  const [resetEvery, setResetEvery] = useState(5);
  const [repeatCount, setRepeatCount] = useState(1);

  // -- run state --
  const [running, setRunning] = useState(false);
  const [currentRun, setCurrentRun] = useState(0);      // 1-indexed
  const [totalRuns, setTotalRuns] = useState(0);
  const [statusText, setStatusText] = useState("");      // live one-liner
  const [lines, setLines] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  // fetch files + models on mount
  useEffect(() => {
    getTestPromptFiles().then((files) => {
      setPromptFiles(files);
      if (files.length > 0 && !selectedPromptFile) setSelectedPromptFile(files[0]);
    });
    listModels().then((ms) => {
      setModels(ms);
      if (!model && ms.length > 0) setModel(defaultModel || ms[0]);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── parse a stdout line to extract a friendly status ── */
  function parseStatus(line: string, run: number, total: number): string | null {
    const prefix = total > 1 ? `Run ${run}/${total}` : "";

    // e.g. "[3/10] What is machine learning?"
    const prompt = line.match(/^\[(\d+)\/(\d+)\]\s+(.+)/);
    if (prompt) {
      const q = `Q ${prompt[1]}/${prompt[2]}`;
      const text = prompt[3].length > 50 ? prompt[3].slice(0, 47) + "..." : prompt[3];
      return [prefix, q, `"${text}"`].filter(Boolean).join("  ·  ");
    }

    // result line "  OK 925ms | ..."
    if (line.trimStart().startsWith("OK ")) {
      return null; // keep previous status, the log has the detail
    }

    // reset line
    if (line.includes("[reset]")) {
      return [prefix, "Resetting session..."].filter(Boolean).join("  ·  ");
    }

    // done
    if (line.startsWith("Done.")) {
      return [prefix, "Finished!"].filter(Boolean).join("  ·  ");
    }

    return null;
  }

  /* ── run a single iteration, returns a promise ── */
  function runOnce(run: number, total: number): Promise<number> {
    return new Promise((resolve, reject) => {
      // For repeated runs, append _runN to the output filename stem
      let outFile = outputFile;
      if (total > 1) {
        const dot = outputFile.lastIndexOf(".");
        const stem = dot > 0 ? outputFile.slice(0, dot) : outputFile;
        const ext = dot > 0 ? outputFile.slice(dot) : ".csv";
        outFile = `${stem}_run${run}${ext}`;
      }

      setLines((prev) => [
        ...prev,
        ...(run > 1 ? ["", `${"=".repeat(60)}`] : []),
        total > 1 ? `>>> Run ${run} of ${total}  (output: ${outFile})` : "",
      ].filter((l) => l !== undefined));

      const abort = runTests(
        {
          promptsFile: selectedPromptFile,
          outputFile: outFile,
          model,
          thinkingMode,
          resetEvery,
        },
        (line) => {
          setLines((prev) => [...prev, line]);
          const s = parseStatus(line, run, total);
          if (s) setStatusText(s);
        },
        (code) => resolve(code),
        (err) => reject(new Error(err)),
      );

      abortRef.current = abort;
    });
  }

  /* ── start handler (loops N times) ── */
  async function handleStart() {
    if (!selectedPromptFile || !model) return;
    cancelledRef.current = false;
    setRunning(true);
    setLines([]);
    setExitCode(null);
    setTotalRuns(repeatCount);
    setStatusText("Starting...");

    let lastCode = 0;
    for (let i = 1; i <= repeatCount; i++) {
      if (cancelledRef.current) break;
      setCurrentRun(i);
      try {
        lastCode = await runOnce(i, repeatCount);
        if (lastCode !== 0) break; // stop on failure
      } catch (err: any) {
        setLines((prev) => [...prev, `ERROR: ${err.message}`]);
        lastCode = 1;
        break;
      }
    }

    setExitCode(lastCode);
    setRunning(false);
    setStatusText("");
  }

  async function handleStop() {
    cancelledRef.current = true;
    abortRef.current?.();
    await stopTests();
    setRunning(false);
    setStatusText("");
    setLines((prev) => [...prev, "", "-- Test run stopped by user --"]);
  }

  /* ── progress fraction (for the bar) ── */
  const progressFraction =
    totalRuns > 0 && running ? (currentRun - 1) / totalRuns : 0;

  return (
    <div className="panel-body" style={{ display: "grid", gap: 16, alignContent: "flex-start" }}>
      {/* ── Config form ── */}
      <section className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Test Runner</h3>
          <p style={{ fontSize: 12, margin: 0 }}>
            Run a batch of prompts against the backend and collect metrics
            (tokens, energy, latency) into a CSV file.
          </p>

          {/* Prompt file */}
          <label style={{ fontSize: 12 }}>
            Prompts file
            <select
              value={selectedPromptFile}
              onChange={(e) => setSelectedPromptFile(e.target.value)}
              disabled={running}
              style={{ display: "block", width: "100%", marginTop: 4 }}
            >
              <option value="" disabled>Select a file...</option>
              {promptFiles.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </label>

          {/* Output file */}
          <label style={{ fontSize: 12 }}>
            Output CSV
            <input
              type="text"
              value={outputFile}
              onChange={(e) => setOutputFile(e.target.value)}
              disabled={running}
              placeholder="test_results.csv"
              style={{ display: "block", width: "100%", marginTop: 4 }}
            />
            {repeatCount > 1 && (
              <span style={{ fontSize: 11, opacity: 0.6 }}>
                Files will be named {outputFile.replace(".csv", "")}_run1.csv, ...run{repeatCount}.csv
              </span>
            )}
          </label>

          {/* Model */}
          <label style={{ fontSize: 12 }}>
            Model
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={running}
              style={{ display: "block", width: "100%", marginTop: 4 }}
            >
              <option value="" disabled>Select a model...</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>

          {/* Row: thinking + reset every + repeat */}
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ fontSize: 12, flex: 1 }}>
              Thinking mode
              <select
                value={thinkingMode}
                onChange={(e) => setThinkingMode(e.target.value as "fast" | "deep")}
                disabled={running}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              >
                <option value="fast">Fast</option>
                <option value="deep">Deep</option>
              </select>
            </label>

            <label style={{ fontSize: 12, flex: 1 }}>
              Reset every N
              <input
                type="number"
                min={1}
                value={resetEvery}
                onChange={(e) => setResetEvery(Math.max(1, Number(e.target.value)))}
                disabled={running}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>

            <label style={{ fontSize: 12, flex: 1 }}>
              Repeat N times
              <input
                type="number"
                min={1}
                max={100}
                value={repeatCount}
                onChange={(e) => setRepeatCount(Math.max(1, Math.min(100, Number(e.target.value))))}
                disabled={running}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
          </div>

          {/* Run / Stop */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!running ? (
              <button
                type="button"
                onClick={handleStart}
                disabled={!selectedPromptFile || !model}
                style={{
                  padding: "8px 20px",
                  fontWeight: 600,
                  background: "var(--color-accent, #1b6e28)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--radius, 8px)",
                  cursor: "pointer",
                }}
              >
                Run Tests
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStop}
                style={{
                  padding: "8px 20px",
                  fontWeight: 600,
                  background: "#c0392b",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--radius, 8px)",
                  cursor: "pointer",
                }}
              >
                Stop
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Live status card (only while running) ── */}
      {running && (
        <section
          className="panel"
          style={{
            background: "linear-gradient(135deg, #e8f5e9 0%, #f1f8e9 100%)",
            border: "1px solid #c8e6c9",
          }}
        >
          <div className="panel-body" style={{ display: "grid", gap: 10, padding: "14px 16px" }}>
            {/* top row: bouncing dots + status text */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <BouncingDots />
              <span style={{ fontSize: 13, fontWeight: 500, color: "#2e7d32" }}>
                {statusText || "Working..."}
              </span>
            </div>

            {/* progress bar (only for multi-run) */}
            {totalRuns > 1 && (
              <div style={{ display: "grid", gap: 4 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#388e3c",
                    textAlign: "right",
                  }}
                >
                  Run {currentRun} of {totalRuns}
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "#c8e6c9",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.max(2, progressFraction * 100)}%`,
                      borderRadius: 3,
                      background: "linear-gradient(90deg, #66bb6a, #43a047)",
                      transition: "width 0.4s ease",
                    }}
                  />
                </div>
              </div>
            )}

            {/* shimmer bar (always, gives a sense of activity) */}
            <div
              style={{
                height: 3,
                borderRadius: 2,
                background:
                  "linear-gradient(90deg, transparent 0%, #81c784 30%, #43a047 50%, #81c784 70%, transparent 100%)",
                backgroundSize: "200% 100%",
                animation: "tr-progress 1.8s linear infinite",
              }}
            />
          </div>
        </section>
      )}

      {/* ── Log output ── */}
      {lines.length > 0 && (
        <section className="panel">
          <div className="panel-body" style={{ padding: 0 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                margin: "12px 12px 4px",
              }}
            >
              <h4 style={{ margin: 0 }}>Output</h4>
              {!running && lines.length > 0 && (
                <button
                  type="button"
                  onClick={() => setLines([])}
                  style={{ fontSize: 11, padding: "2px 8px", opacity: 0.7 }}
                >
                  Clear
                </button>
              )}
            </div>
            <pre
              style={{
                margin: 0,
                padding: "8px 12px 12px",
                maxHeight: 400,
                overflowY: "auto",
                fontSize: 12,
                lineHeight: 1.6,
                fontFamily: "Consolas, 'Courier New', monospace",
                background: "var(--color-surface, #f9f9f9)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {lines.map((l, i) => (
                <LogLine key={i} text={l} />
              ))}
              <div ref={logEndRef} />
            </pre>

            {exitCode !== null && (
              <div
                style={{
                  padding: "8px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  color: exitCode === 0 ? "var(--color-accent, #1b6e28)" : "#c0392b",
                  borderTop: "1px solid var(--color-border, #eee)",
                }}
              >
                {exitCode === 0
                  ? `All ${totalRuns > 1 ? `${totalRuns} runs` : "tests"} completed successfully.`
                  : `Test run exited with code ${exitCode}.`}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/* ── Bouncing dots indicator ── */
function BouncingDots() {
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "#43a047",
            display: "inline-block",
            animation: `tr-bounce 1.2s ${i * 0.16}s infinite ease-in-out both`,
          }}
        />
      ))}
    </span>
  );
}

/* ── Colorized log line ── */
function LogLine({ text }: { text: string }) {
  if (!text) return <div>{"\u00A0"}</div>;

  // run header
  if (text.startsWith(">>>")) {
    return <div style={{ color: "#1565c0", fontWeight: 600 }}>{text}</div>;
  }
  // separator
  if (/^={10,}/.test(text)) {
    return <div style={{ opacity: 0.3 }}>{text}</div>;
  }
  // success line
  if (text.trimStart().startsWith("OK ")) {
    return <div style={{ color: "#2e7d32" }}>{text}</div>;
  }
  // error
  if (text.trimStart().startsWith("ERROR")) {
    return <div style={{ color: "#c62828", fontWeight: 500 }}>{text}</div>;
  }
  // prompt line [n/m]
  if (/^\[\d+\/\d+\]/.test(text)) {
    return <div style={{ color: "#37474f" }}>{text}</div>;
  }
  // reset
  if (text.includes("[reset]")) {
    return <div style={{ color: "#6a1b9a", fontStyle: "italic" }}>{text}</div>;
  }
  // done
  if (text.startsWith("Done.") || text.startsWith("Results saved")) {
    return <div style={{ color: "#1b5e20", fontWeight: 600 }}>{text}</div>;
  }

  return <div>{text}</div>;
}
