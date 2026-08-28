import { useEffect, useState, useRef } from "react";
import ChatHistory from "./ChatHistory";
import ChatInput from "./ChatInput";
import EmptyState from "./EmptyState";
import { streamChat, streamAgentChat, getRagDocuments, type InferenceMetrics, type AgentEvent } from "../api";

type Msg = { role: "user" | "bot"; text: string; metrics?: InferenceMetrics };

type Props = {
    model?: string;
    fastModel?: string;
    deepModel?: string;
    autoLoadModel?: boolean;
    modelLoading?: boolean;
    onRequestModelLoad?: (model: string) => void;
    onUserPrompt?: (m: { ts: number; text: string; words: number; chars: number }) => void;
    onHistoryChange?: (history: Msg[]) => void;
    onModelChange?: (model: string) => void;
};

type ThinkingMode = "fast" | "deep";

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

export default function ChatPane({
    model,
    fastModel,
    deepModel,
    autoLoadModel,
    modelLoading,
    onRequestModelLoad,
    onUserPrompt,
    onHistoryChange,
    onModelChange,
}: Props) {
    const [messages, setMessages] = useState<Msg[]>(() => {
        try {
            const saved = localStorage.getItem("ai4all.chat.messages");
            if (saved) {
                const parsed = JSON.parse(saved) as Msg[];
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch { /* ignore */ }
        return [{ role: "bot", text: "Hi! Ask me anything." }];
    });

    const [files, setFiles] = useState<File[]>([]);
    const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("fast");
    const [agentMode, setAgentMode] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [statusText, setStatusText] = useState<string | null>(null);
    const [serverDocs, setServerDocs] = useState<string[]>([]);
    const agentAbortRef = useRef<(() => void) | null>(null);
    const [waitingForFirstDelta, setWaitingForFirstDelta] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const activeModel = thinkingMode === "deep"
        ? (deepModel || model)
        : (fastModel || model);

    // Keep App in sync
    useEffect(() => { onHistoryChange?.(messages); }, [messages, onHistoryChange]);

    // Auto-persist chat
    useEffect(() => {
        try { localStorage.setItem("ai4all.chat.messages", JSON.stringify(messages)); }
        catch { /* quota exceeded */ }
    }, [messages]);

    // Auto-load model
    useEffect(() => {
        if (autoLoadModel && activeModel) onRequestModelLoad?.(activeModel);
    }, [activeModel, autoLoadModel]);

    // Refresh server docs
    function refreshServerDocs(model?: string) {
        if (!model) return;
        getRagDocuments("chat", model).then(setServerDocs).catch(() => {});
    }
    useEffect(() => { refreshServerDocs(activeModel); }, [activeModel]);

    async function handleSend(text: string) {
        const trimmed = text.trim();
        if (!trimmed) return;

        if (!activeModel) {
            setMessages((m) => [...m, {
                role: "bot",
                text: "No chat model configured yet. Open Settings and set a Chat model first.",
            }]);
            return;
        }

        if (onUserPrompt) {
            const words = trimmed.split(/\s+/).length;
            onUserPrompt({ ts: Date.now(), text, words, chars: text.length });
        }

        onModelChange?.(activeModel);
        setMessages((m) => [...m, { role: "user", text }]);
        setIsStreaming(true);
        setWaitingForFirstDelta(true);

        if (agentMode) {
            let acc = "";
            const abort = streamAgentChat(
                { prompt: text, model: activeModel },
                (event: AgentEvent) => {
                    if (event.type === "thinking") {
                        setWaitingForFirstDelta(false);
                        setStatusText("Agent is working…");
                        return;
                    }
                    if (event.type === "assistant") {
                        setWaitingForFirstDelta(false);
                        setStatusText(null);
                        acc += event.content;
                    } else if (event.type === "tool_start") {
                        setWaitingForFirstDelta(false);
                        setStatusText(`Running ${event.tool}…`);
                        const argsPreview = Object.entries(event.args || {})
                            .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
                            .join(", ");
                        acc += `\n\n> **Tool:** \`${event.tool}\` ${argsPreview ? `— ${argsPreview}` : ""}\n`;
                    } else if (event.type === "tool_result") {
                        const status = event.ok ? "OK" : "FAILED";
                        const preview = (event.content || "").slice(0, 200);
                        acc += `> Result (${status}): ${preview}${event.content?.length > 200 ? "…" : ""}\n\n`;
                    } else if (event.type === "error") {
                        acc += `\n\n**Error:** ${event.error}\n`;
                    }
                    setMessages((m) => {
                        const withoutBotTail = m[m.length - 1]?.role === "bot" ? m.slice(0, -1) : m;
                        return [...withoutBotTail, { role: "bot", text: acc }];
                    });
                },
                () => { setIsStreaming(false); setWaitingForFirstDelta(false); setStatusText(null); },
                (err) => {
                    console.error(err);
                    setMessages((m) => [...m, { role: "bot", text: "Agent error: " + err }]);
                    setIsStreaming(false); setWaitingForFirstDelta(false); setStatusText(null);
                },
            );
            agentAbortRef.current = abort;
        } else {
            let acc = "";
            let firstDeltaReceived = false;
            try {
                const metrics = await streamChat(
                    { prompt: text, model: activeModel, files, thinkingMode },
                    (delta: string) => {
                        if (!firstDeltaReceived) {
                            firstDeltaReceived = true;
                            setWaitingForFirstDelta(false);
                            setStatusText(null);
                        }
                        acc += delta;
                        setMessages((m) => {
                            const withoutBotTail = m[m.length - 1]?.role === "bot" ? m.slice(0, -1) : m;
                            return [...withoutBotTail, { role: "bot", text: acc }];
                        });
                    },
                    undefined,
                    (status: string) => setStatusText(status),
                );
                if (metrics) {
                    setMessages((m) => {
                        const lastIdx = m.length - 1;
                        if (lastIdx >= 0 && m[lastIdx].role === "bot") {
                            const updated = [...m];
                            updated[lastIdx] = { ...updated[lastIdx], metrics };
                            return updated;
                        }
                        return m;
                    });
                }
            } catch (err) {
                console.error(err);
                setMessages((m) => [...m, {
                    role: "bot",
                    text: "Sorry, something went wrong while generating a response.",
                }]);
            } finally {
                setIsStreaming(false);
                setWaitingForFirstDelta(false);
                setStatusText(null);
                setFiles((prev) => prev.filter((f) => !IMAGE_FILE_RE.test(f.name)));
                refreshServerDocs(activeModel);
            }
        }
    }

    // Only show "Hi! Ask me anything." as empty
    const hasConversation = messages.length > 1 || (messages.length === 1 && messages[0].role === "user");

    return (
        <>
            {/* Chat history or empty state */}
            {hasConversation ? (
                <ChatHistory
                    messages={messages}
                    isStreaming={isStreaming}
                    thinkingMode={thinkingMode}
                    isWaitingForModel={waitingForFirstDelta}
                />
            ) : (
                <EmptyState tab="chat" />
            )}

            {/* Input bar */}
            <div className="chat-input-container">
                <div className="chat-input-card">
                    {/* Loading banner */}
                    {modelLoading && (
                        <div className="model-loading-banner">
                            <span className="model-loading-spinner" style={{ fontSize: 18 }}>⟳</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 500, marginBottom: 4, fontSize: 13 }}>Loading model into GPU…</div>
                                <div className="model-loading-bar"><div className="model-loading-bar-fill" /></div>
                            </div>
                        </div>
                    )}

                    {/* Status text */}
                    {isStreaming && statusText && (
                        <div style={{ fontSize: 12, fontStyle: "italic", opacity: 0.7, padding: "4px 14px 0" }}>
                            {statusText}
                        </div>
                    )}

                    {/* File input (hidden, triggered by attachment) */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".pdf,.txt,.docx,.csv,.png,.jpg,.jpeg,.webp,.gif,.bmp"
                        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                        style={{ display: "none" }}
                    />

                    <ChatInput onSend={handleSend} disabled={isStreaming || !!modelLoading} />

                    {/* Bottom controls */}
                    <div className="chat-input-controls">
                        <button
                            className={`input-pill ${thinkingMode === "deep" ? "active" : ""}`}
                            onClick={() => setThinkingMode(thinkingMode === "deep" ? "fast" : "deep")}
                            title={thinkingMode === "deep" ? "Switch to fast thinking" : "Switch to deep thinking"}
                        >
                            <span className="input-pill-icon">🧠</span>
                            Deep think
                        </button>

                        <button
                            className={`input-pill ${agentMode ? "active" : ""}`}
                            onClick={() => setAgentMode(!agentMode)}
                            title={agentMode ? "Disable agent mode" : "Enable agent mode (tools)"}
                        >
                            <span className="input-pill-icon">🤖</span>
                            Agent
                        </button>

                        <button
                            className="input-pill"
                            onClick={() => fileInputRef.current?.click()}
                            title="Attach files"
                        >
                            <span className="input-pill-icon">📎</span>
                            {files.length > 0 ? `${files.length} file${files.length > 1 ? "s" : ""}` : "Attach"}
                        </button>

                        {files.length > 0 && (
                            <button
                                className="input-pill"
                                onClick={() => { setFiles([]); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                                title="Clear files"
                                style={{ color: "var(--color-danger)" }}
                            >
                                ✕
                            </button>
                        )}

                        {serverDocs.length > 0 && (
                            <span style={{ fontSize: 11, color: "var(--color-text-dim)" }} title={serverDocs.join(", ")}>
                                📄 {serverDocs.length} stored doc{serverDocs.length > 1 ? "s" : ""}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
