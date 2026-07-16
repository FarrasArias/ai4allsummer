import React, { useEffect, useRef, useState } from "react";
import ChatHistory from "./ChatHistory";
import ChatInput from "./ChatInput";
import { streamWebChat, resetWeb, getRagDocuments, type WebChatEvent } from "../api";

type Msg = { role: "user" | "bot"; text: string };

type Props = {
  model?: string;
};

const WEB_GREETING: Msg = {
  role: "bot",
  text:
    "This mode can use web tools. Ask a question and I'll search the web when it helps answer accurately. You can also attach documents (pdf, docx, txt, csv) to ask about them.",
};

export default function WebChatPane({ model }: Props) {
  const [messages, setMessages] = useState<Msg[]>(() => {
    try {
      const saved = localStorage.getItem("ai4all.web.messages");
      if (saved) {
        const parsed = JSON.parse(saved) as Msg[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
    return [WEB_GREETING];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  // Documents persisted server-side (RAG cache) — survives restarts
  const [serverDocs, setServerDocs] = useState<string[]>([]);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeModel = model;

  // Persist transcript so it survives tab switches and page refreshes
  useEffect(() => {
    try {
      localStorage.setItem("ai4all.web.messages", JSON.stringify(messages));
    } catch { /* ignore */ }
  }, [messages]);

  function refreshServerDocs(m?: string) {
    if (!m) return;
    getRagDocuments("web", m)
      .then(setServerDocs)
      .catch(() => { /* backend may be down — ignore */ });
  }
  useEffect(() => {
    refreshServerDocs(activeModel);
  }, [activeModel]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !activeModel || isLoading) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setIsLoading(true);
    setStatusText("Thinking…");

    let acc = "";
    const abort = streamWebChat(
      { prompt: trimmed, model: activeModel, files },
      (event: WebChatEvent) => {
        if (event.type === "status") {
          setStatusText(event.text);
        } else if (event.type === "assistant") {
          acc += (acc ? "\n\n" : "") + event.content;
          // A user message was just appended, so any bot tail is this turn's
          setMessages((prev) => {
            const next = [...prev];
            if (next[next.length - 1]?.role === "bot") next.pop();
            return [...next, { role: "bot", text: acc }];
          });
        } else if (event.type === "error") {
          setMessages((prev) => [...prev, { role: "bot", text: `⚠️ ${event.error}` }]);
        }
        // "done" carries energy metrics; the sidebar reads them from the
        // shared power stream, so nothing to do here.
      },
      () => {
        setIsLoading(false);
        setStatusText(null);
        // Newly uploaded documents are indexed now — refresh the list
        refreshServerDocs(activeModel);
      },
      (err) => {
        console.error(err);
        setMessages((prev) => [
          ...prev,
          {
            role: "bot",
            text: "Sorry, something went wrong while calling the web-enabled model.",
          },
        ]);
        setIsLoading(false);
        setStatusText(null);
      },
    );
    abortRef.current = abort;
  }

  function handleClearFiles() {
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleReset() {
    if (!activeModel) return;
    abortRef.current?.();
    try {
      await resetWeb(activeModel);
    } catch (err) {
      console.error("Failed to reset web session", err);
    }
    setIsLoading(false);
    setStatusText(null);
    handleClearFiles();
    setServerDocs([]); // backend reset clears the RAG store too
    setMessages([
      {
        role: "bot",
        text: "Web chat context was reset. Ask a new question to start a fresh session.",
      },
    ]);
    try { localStorage.removeItem("ai4all.web.messages"); } catch { /* ignore */ }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr auto auto",
        gap: 12,
        height: "100%",
        minHeight: 0,
      }}
    >
      <div className="panel">
        <div
          className="panel-body"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>
            <div style={{ fontWeight: 500 }}>Web</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Model: {activeModel || "loading default model…"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.txt,.docx,.csv"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            {files.length > 0 && (
              <>
                <span style={{ fontSize: 12, opacity: 0.8 }}>
                  {files.length} file{files.length > 1 ? "s" : ""}: {files.map((f) => f.name).join(", ")}
                </span>
                <button type="button" onClick={handleClearFiles} title="Clear attached files">
                  Clear files
                </button>
              </>
            )}
            {serverDocs.length > 0 && (
              <span style={{ fontSize: 11, opacity: 0.7 }} title={serverDocs.join(", ")}>
                📄 {serverDocs.length} stored document{serverDocs.length > 1 ? "s" : ""} on
                server: {serverDocs.join(", ")} — "Reset web session" removes them
              </span>
            )}
            <button type="button" onClick={handleReset} disabled={!activeModel}>
              Reset web session
            </button>
          </div>
        </div>
      </div>

      <ChatHistory messages={messages} isStreaming={isLoading} />

      {isLoading && statusText && (
        <div
          style={{
            fontSize: 12,
            fontStyle: "italic",
            opacity: 0.75,
            padding: "0 4px",
          }}
        >
          {statusText}
        </div>
      )}

      <ChatInput onSend={handleSend} />
    </div>
  );
}
