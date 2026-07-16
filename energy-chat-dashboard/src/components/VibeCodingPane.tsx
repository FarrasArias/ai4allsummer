import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamAgentChat, resetAgent, type AgentEvent } from "../api";

/* ── inject keyframes once ── */
const STYLE_ID = "vibe-agent-anims";
if (!document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes va-pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
    @keyframes va-spin  { to{transform:rotate(360deg)} }
  `;
  document.head.appendChild(s);
}

/* ── types ── */
type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_start"; tool: string; args: Record<string, any> }
  | { kind: "tool_result"; tool: string; ok: boolean; content: string }
  | { kind: "thinking" }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

type Props = { model?: string };

export default function VibeCodingPane({ model }: Props) {
  const [entries, setEntries] = useState<ChatEntry[]>(() => {
    try {
      const saved = localStorage.getItem("ai4all.vibe.entries");
      if (saved) {
        const parsed = JSON.parse(saved) as ChatEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
    return [{ kind: "status", text: "Coding agent ready. Describe a task or paste code." }];
  });

  // Persist transcript so it survives tab switches and page refreshes
  useEffect(() => {
    try {
      localStorage.setItem("ai4all.vibe.entries", JSON.stringify(entries));
    } catch { /* ignore */ }
  }, [entries]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeModel = model || "qwen2.5-coder:7b";

  // auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setInput("");
    setBusy(true);

    setEntries((prev) => [...prev, { kind: "user", text: trimmed }]);

    // Track the latest assistant text index so we can append deltas
    let assistantIdx: number | null = null;

    const abort = streamAgentChat(
      { prompt: trimmed, model: activeModel },
      (ev: AgentEvent) => {
        switch (ev.type) {
          case "thinking":
            setEntries((prev) => [...prev, { kind: "thinking" }]);
            break;

          case "assistant":
            // If we already have an assistant entry from this turn, append
            setEntries((prev) => {
              // Remove the thinking spinner if present
              const cleaned = prev.filter((e) => e.kind !== "thinking");
              if (assistantIdx !== null && cleaned[assistantIdx]?.kind === "assistant") {
                const updated = [...cleaned];
                updated[assistantIdx] = {
                  kind: "assistant",
                  text: (updated[assistantIdx] as any).text + ev.content,
                };
                return updated;
              }
              assistantIdx = cleaned.length;
              return [...cleaned, { kind: "assistant", text: ev.content }];
            });
            break;

          case "tool_start":
            assistantIdx = null; // next assistant block is new
            setEntries((prev) => [
              ...prev.filter((e) => e.kind !== "thinking"),
              { kind: "tool_start", tool: ev.tool, args: ev.args },
            ]);
            break;

          case "tool_result":
            setEntries((prev) => [
              ...prev,
              { kind: "tool_result", tool: ev.tool, ok: ev.ok, content: ev.content },
            ]);
            break;

          case "done":
            // If the final output differs from what we've accumulated, add it
            setEntries((prev) => {
              const cleaned = prev.filter((e) => e.kind !== "thinking");
              const lastAssistant = [...cleaned].reverse().find((e) => e.kind === "assistant");
              if (!lastAssistant && ev.output) {
                return [...cleaned, { kind: "assistant", text: ev.output }];
              }
              // Add a status line with summary
              return [
                ...cleaned,
                {
                  kind: "status",
                  text: `Done — ${ev.turns} turn${ev.turns !== 1 ? "s" : ""}, ${ev.tool_calls} tool call${ev.tool_calls !== 1 ? "s" : ""}`,
                },
              ];
            });
            break;

          case "error":
            setEntries((prev) => [
              ...prev.filter((e) => e.kind !== "thinking"),
              { kind: "error", text: ev.error },
            ]);
            break;
        }
      },
      () => setBusy(false),
      (err) => {
        setEntries((prev) => [...prev, { kind: "error", text: err }]);
        setBusy(false);
      },
    );

    abortRef.current = abort;
  }

  async function handleReset() {
    abortRef.current?.();
    try {
      await resetAgent(activeModel);
    } catch {
      /* ignore */
    }
    setBusy(false);
    setEntries([{ kind: "status", text: "Agent session reset. Ready for a new task." }]);
    try { localStorage.removeItem("ai4all.vibe.entries"); } catch { /* ignore */ }
  }

  function handleStop() {
    abortRef.current?.();
    setBusy(false);
    setEntries((prev) => [
      ...prev.filter((e) => e.kind !== "thinking"),
      { kind: "status", text: "Stopped by user." },
    ]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: 12, height: "100%", minHeight: 0 }}>
      {/* ── Header ── */}
      <div className="panel">
        <div className="panel-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 500 }}>Vibe Coding</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              Agent: {activeModel} — reads files, runs commands, writes code
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {busy && (
              <button type="button" onClick={handleStop} style={{ color: "#c0392b", fontWeight: 600 }}>
                Stop
              </button>
            )}
            <button type="button" onClick={handleReset}>Reset session</button>
          </div>
        </div>
      </div>

      {/* ── Chat log ── */}
      <div
        ref={scrollRef}
        className="panel"
        style={{ overflowY: "auto", minHeight: 0, padding: 0 }}
      >
        <div style={{ padding: "12px 16px", display: "grid", gap: 10 }}>
          {entries.map((entry, i) => (
            <EntryRow key={i} entry={entry} />
          ))}
        </div>
      </div>

      {/* ── Input ── */}
      <div className="panel" style={{ padding: 0 }}>
        <div style={{ display: "flex", gap: 8, padding: 12, alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe a coding task..."
            disabled={busy}
            rows={2}
            style={{
              flex: 1,
              resize: "vertical",
              fontFamily: "inherit",
              fontSize: 14,
              padding: "8px 12px",
              borderRadius: "var(--radius, 8px)",
              border: "1px solid var(--color-border, #ddd)",
              outline: "none",
              minHeight: 44,
            }}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={busy || !input.trim()}
            style={{
              padding: "8px 20px",
              fontWeight: 600,
              background: "var(--color-accent, #1b6e28)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius, 8px)",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy || !input.trim() ? 0.5 : 1,
              alignSelf: "stretch",
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Entry rendering
   ══════════════════════════════════════════════════════════════ */

function EntryRow({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{
            background: "var(--bubble-user, #dcf8c6)",
            padding: "8px 14px",
            borderRadius: 12,
            maxWidth: "80%",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 14,
          }}>
            {entry.text}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div style={{ maxWidth: "90%" }}>
          <div style={{
            background: "var(--bubble-bot, #f0f0f0)",
            padding: "10px 14px",
            borderRadius: 12,
            fontSize: 14,
            lineHeight: 1.6,
          }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
          </div>
        </div>
      );

    case "tool_start":
      return <ToolStartCard tool={entry.tool} args={entry.args} />;

    case "tool_result":
      return <ToolResultCard tool={entry.tool} ok={entry.ok} content={entry.content} />;

    case "thinking":
      return <ThinkingIndicator />;

    case "status":
      return (
        <div style={{ fontSize: 12, color: "var(--color-accent, #1b6e28)", fontWeight: 500, textAlign: "center", padding: "4px 0" }}>
          {entry.text}
        </div>
      );

    case "error":
      return (
        <div style={{ fontSize: 13, color: "#c0392b", fontWeight: 500, padding: "6px 12px", background: "#fdecea", borderRadius: 8 }}>
          Error: {entry.text}
        </div>
      );

    default:
      return null;
  }
}

/* ── Tool call cards ── */

const TOOL_ICONS: Record<string, string> = {
  read_file: "[ Read ]",
  write_file: "[ Write ]",
  edit_file: "[ Edit ]",
  bash: "[ Shell ]",
  glob_search: "[ Glob ]",
  grep_search: "[ Grep ]",
  list_dir: "[ Dir ]",
  web_fetch: "[ Fetch ]",
  delegate_agent: "[ Agent ]",
};

function ToolStartCard({ tool, args }: { tool: string; args: Record<string, any> }) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_ICONS[tool] || `[ ${tool} ]`;

  // Build a short summary from args
  let summary = "";
  if (args.file_path || args.path) summary = String(args.file_path || args.path);
  else if (args.command) summary = String(args.command).slice(0, 80);
  else if (args.pattern) summary = `pattern: ${args.pattern}`;
  else if (args.prompt) summary = String(args.prompt).slice(0, 80);

  return (
    <div
      style={{
        fontSize: 12,
        fontFamily: "Consolas, 'Courier New', monospace",
        background: "#e8eaf6",
        border: "1px solid #c5cae9",
        borderRadius: 8,
        padding: "6px 10px",
        cursor: "pointer",
      }}
      onClick={() => setExpanded((p) => !p)}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontWeight: 700, color: "#283593" }}>{label}</span>
        <span style={{ opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.4, fontSize: 10 }}>
          {expanded ? "[-]" : "[+]"}
        </span>
      </div>
      {expanded && (
        <pre style={{ margin: "6px 0 0", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all", opacity: 0.8 }}>
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultCard({ tool, ok, content }: { tool: string; ok: boolean; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 120 ? content.slice(0, 117) + "..." : content;

  return (
    <div
      style={{
        fontSize: 12,
        fontFamily: "Consolas, 'Courier New', monospace",
        background: ok ? "#e8f5e9" : "#fce4ec",
        border: `1px solid ${ok ? "#c8e6c9" : "#f8bbd0"}`,
        borderRadius: 8,
        padding: "6px 10px",
        cursor: content.length > 120 ? "pointer" : "default",
      }}
      onClick={() => content.length > 120 && setExpanded((p) => !p)}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontWeight: 600, color: ok ? "#2e7d32" : "#c62828" }}>
          {ok ? "OK" : "FAIL"} {tool}
        </span>
        {content.length > 120 && (
          <span style={{ marginLeft: "auto", opacity: 0.4, fontSize: 10 }}>
            {expanded ? "[-]" : "[+]"}
          </span>
        )}
      </div>
      <pre style={{
        margin: "4px 0 0",
        fontSize: 11,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        opacity: 0.7,
        maxHeight: expanded ? "none" : 60,
        overflow: "hidden",
      }}>
        {expanded ? content : preview}
      </pre>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <span style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid var(--color-accent, #1b6e28)",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "va-spin 0.8s linear infinite",
      }} />
      <span style={{ fontSize: 13, color: "var(--color-accent, #1b6e28)", animation: "va-pulse 1.5s ease-in-out infinite" }}>
        Agent is thinking...
      </span>
    </div>
  );
}
