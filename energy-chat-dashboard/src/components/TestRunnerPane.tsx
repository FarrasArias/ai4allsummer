import React, { useEffect, useRef, useState } from "react";
import {
  getTestPromptFiles,
  listModels,
  runTests,
  stopTests,
} from "../api";

type Props = {
  /** Pre-selected model from settings (optional) */
  defaultModel?: string;
};

export default function TestRunnerPane({ defaultModel }: Props) {
  // ── Form state ──
  const [promptFiles, setPromptFiles] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [selectedPromptFile, setSelectedPromptFile] = useState("");
  const [outputFile, setOutputFile] = useState("test_results.csv");
  const [model, setModel] = useState(defaultModel || "");
  const [thinkingMode, setThinkingMode] = useState<"fast" | "deep">("fast");
  const [resetEvery, setResetEvery] = useState(5);

  // ── Run state ──
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom of log when new lines come in
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  // Fetch available prompt files and models on mount
  useEffect(() => {
    getTestPromptFiles().then((files) => {
      setPromptFiles(files);
      if (files.length > 0 && !selectedPromptFile) {
        setSelectedPromptFile(files[0]);
      }
    });
    listModels().then((ms) => {
      setModels(ms);
      if (!model && ms.length > 0) {
        setModel(defaultModel || ms[0]);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleStart() {
    if (!selectedPromptFile || !model) return;
    setRunning(true);
    setLines([]);
    setExitCode(null);

    const abort = runTests(
      {
        promptsFile: selectedPromptFile,
        outputFile,
        model,
        thinkingMode,
        resetEvery,
      },
      (line) => setLines((prev) => [...prev, line]),
      (code) => {
        setExitCode(code);
        setRunning(false);
      },
      (err) => {
        setLines((prev) => [...prev, `ERROR: ${err}`]);
        setRunning(false);
      },
    );

    abortRef.current = abort;
  }

  async function handleStop() {
    abortRef.current?.();
    await stopTests();
    setRunning(false);
    setLines((prev) => [...prev, "── Test run stopped by user ──"]);
  }

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
              <option value="" disabled>
                Select a file…
              </option>
              {promptFiles.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
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
              <option value="" disabled>
                Select a model…
              </option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          {/* Thinking mode + reset every (inline) */}
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
              Reset every N prompts
              <input
                type="number"
                min={1}
                value={resetEvery}
                onChange={(e) => setResetEvery(Math.max(1, Number(e.target.value)))}
                disabled={running}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
          </div>

          {/* Run / Stop buttons */}
          <div style={{ display: "flex", gap: 8 }}>
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

      {/* ── Log output ── */}
      {lines.length > 0 && (
        <section className="panel">
          <div className="panel-body" style={{ padding: 0 }}>
            <h4 style={{ margin: "12px 12px 4px" }}>Output</h4>
            <pre
              style={{
                margin: 0,
                padding: "8px 12px 12px",
                maxHeight: 400,
                overflowY: "auto",
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: "Consolas, 'Courier New', monospace",
                background: "var(--color-surface, #f9f9f9)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {lines.map((l, i) => (
                <div key={i}>{l || "\u00A0"}</div>
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
                  ? "Test run completed successfully."
                  : `Test run exited with code ${exitCode}.`}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
