import React, { useEffect, useState, useRef } from "react";
import ChatHistory from "./ChatHistory";
import ChatInput from "./ChatInput";
import { streamChat, listChats, saveChat, loadChat, getPinnedChats, togglePinnedChat, searchChats, type SearchResult, type InferenceMetrics } from "../api";
import { useTip } from "./TipContext";

type Msg = { role: "user" | "bot"; text: string; metrics?: InferenceMetrics };

type Props = {
    model?: string; // default chat model (fallback)
    fastModel?: string; // model for fast thinking mode
    deepModel?: string; // model for deep thinking mode
    onUserPrompt?: (m: { ts: number; text: string; words: number; chars: number }) => void;
    onHistoryChange?: (history: Msg[]) => void;
    onModelChange?: (model: string) => void;
};

type ThinkingMode = "fast" | "deep";

export default function ChatPane({
    model,
    fastModel,
    deepModel,
    onUserPrompt,
    onHistoryChange,
    onModelChange,
}: Props) {
    const { showTip } = useTip();

    const [messages, setMessages] = useState<Msg[]>([
        { role: "bot", text: "Hi! Ask me anything." },
    ]);

    const [files, setFiles] = useState<File[]>([]);
    const [chats, setChats] = useState<string[]>([]);
    const [pinnedChats, setPinnedChats] = useState<string[]>([]);
    const [chatName, setChatName] = useState<string>("");
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [copyStatus, setCopyStatus] = useState<string | null>(null);

    const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("fast");
    const [isStreaming, setIsStreaming] = useState(false);

    // Search state
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [showSearchResults, setShowSearchResults] = useState(false);

    // Load saved chat names and pinned chats on mount
    useEffect(() => {
        listChats().then((j) => setChats(j.chats ?? []));
        setPinnedChats(getPinnedChats());
    }, []);

    // Keep App in sync with transcript for study saving
    useEffect(() => {
        onHistoryChange?.(messages);
    }, [messages, onHistoryChange]);

    // Select model based on thinking mode:
    // - fast mode uses fastModel if set, otherwise default model
    // - deep mode uses deepModel if set, otherwise default model
    const activeModel = thinkingMode === "deep"
        ? (deepModel || model)
        : (fastModel || model);

    async function handleSend(text: string) {
        const trimmed = text.trim();
        if (!trimmed) return;

        // If presets aren't configured yet, nudge user to Models tab
        if (!activeModel) {
            setMessages((m) => [
                ...m,
                {
                    role: "bot",
                    text:
                        "I don�t know which chat model to use yet. " +
                        "Open the Models tab and set a Chat model (or override) first.",
                },
            ]);
            return;
        }

        if (onUserPrompt) {
            const words = trimmed.length ? trimmed.split(/\s+/).length : 0;
            const chars = text.length;
            onUserPrompt({ ts: Date.now(), text, words, chars });
        }

        // Let App know which concrete model was used (for reset/energy tracking)
        onModelChange?.(activeModel);

        // Add user message and start streaming response
        setMessages((m) => [...m, { role: "user", text }]);
        setIsStreaming(true);

        let acc = "";
        try {
            const metrics = await streamChat(
                { prompt: text, model: activeModel, files, thinkingMode },
                (delta: string) => {
                    acc += delta;
                    setMessages((m) => {
                        const withoutBotTail =
                            m[m.length - 1]?.role === "bot" ? m.slice(0, -1) : m;
                        return [...withoutBotTail, { role: "bot", text: acc }];
                    });
                },
            );
            // Update the last bot message with metrics once streaming completes
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

            // Demo tip trigger: "Who is Steve?"
            if (/who is steve/i.test(trimmed)) {
                showTip(
                    "Steve is the inventor of Python. He alongside Vanessa Utz co-created the iPhone too.",
                    20000,
                );
            }
        } catch (err) {
            console.error(err);
            setMessages((m) => [
                ...m,
                {
                    role: "bot",
                    text: "Sorry, something went wrong while generating a response.",
                },
            ]);
        } finally {
            setIsStreaming(false);
        }
    }

    function handleSave() {
        if (!chatName) return;
        saveChat(chatName, messages).then(() =>
            listChats().then((j) => setChats(j.chats ?? [])),
        );
    }

    async function handleLoad(name: string) {
        if (!name) return;
        const j = await loadChat(name);
        if (Array.isArray(j)) {
            setMessages(j as any);
        } else if (j && j.length) {
            setMessages(j as any);
        } else if (j && (j as any).history) {
            setMessages((j as any).history as any);
        }
        setChatName(name);
    }

    // Copy last assistant answer (markdown text) to clipboard
    async function handleCopyLastAnswer() {
        const lastBot = [...messages].reverse().find((m) => m.role === "bot");
        if (!lastBot) return;
        const textToCopy = lastBot.text ?? "";

        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(textToCopy);
                setCopyStatus("Copied!");
                setTimeout(() => setCopyStatus(null), 2000);
            } else {
                // Very old browser fallback
                const textarea = document.createElement("textarea");
                textarea.value = textToCopy;
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand("copy");
                document.body.removeChild(textarea);
                setCopyStatus("Copied!");
                setTimeout(() => setCopyStatus(null), 2000);
            }
        } catch (err) {
            console.error("Failed to copy text:", err);
            setCopyStatus("Failed");
            setTimeout(() => setCopyStatus(null), 2000);
        }
    }

    // Save last response to file (default .md for chat)
    function handleSaveLastResponse() {
        const lastBot = [...messages].reverse().find((m) => m.role === "bot");
        if (!lastBot) return;

        const blob = new Blob([lastBot.text], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chat_response_${Date.now()}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Clear loaded files
    function handleClearFiles() {
        setFiles([]);
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    }

    // Clear chat history (keeps files)
    function handleClearChat() {
        setMessages([{ role: "bot", text: "Hi! Ask me anything." }]);
    }

    // Toggle pin status for a chat
    function handleTogglePin(name: string) {
        togglePinnedChat(name);
        setPinnedChats(getPinnedChats());
    }

    // Search across all chats
    async function handleSearch() {
        if (searchQuery.length < 2) return;
        setIsSearching(true);
        try {
            const res = await searchChats(searchQuery);
            setSearchResults(res.results || []);
            setShowSearchResults(true);
        } catch (err) {
            console.error("Search failed:", err);
            setSearchResults([]);
        } finally {
            setIsSearching(false);
        }
    }

    // Load a chat from search result
    function handleLoadFromSearch(chatName: string) {
        handleLoad(chatName);
        setShowSearchResults(false);
        setSearchQuery("");
    }

    const hasBotMessage = messages.some((m) => m.role === "bot");

    // Session metadata: compute stats
    const userMessages = messages.filter((m) => m.role === "user");
    const botMessages = messages.filter((m) => m.role === "bot");
    const totalWords = messages.reduce((acc, m) => acc + (m.text?.split(/\s+/).length || 0), 0);

    // Sort chats: pinned first, then alphabetical
    const sortedChats = [...chats].sort((a, b) => {
        const aPinned = pinnedChats.includes(a);
        const bPinned = pinnedChats.includes(b);
        if (aPinned && !bPinned) return -1;
        if (!aPinned && bPinned) return 1;
        return a.localeCompare(b);
    });

    return (
        <div
            style={{
                display: "grid",
                gridTemplateRows: "auto 1fr auto",
                gap: 12,
                height: "100%",
                minHeight: 0,
            }}
        >
            {/* Toolbar */}
            <div className="panel">
                <div
                    className="panel-body"
                    style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                    }}
                >
                    {/* Left: thinking mode + preset summary */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div
                            style={{
                                display: "flex",
                                gap: 8,
                                alignItems: "center",
                                flexWrap: "wrap",
                            }}
                        >
                            <span style={{ fontWeight: 500 }}>Thinking mode:</span>
                            <div style={{ display: "inline-flex", gap: 4 }}>
                                <button
                                    type="button"
                                    onClick={() => setThinkingMode("fast")}
                                    style={{
                                        padding: "4px 8px",
                                        borderRadius: 999,
                                        border: "1px solid var(--border-subtle, #ccc)",
                                        fontSize: 12,
                                        fontWeight: thinkingMode === "fast" ? 600 : 400,
                                        opacity: thinkingMode === "fast" ? 1 : 0.8,
                                        cursor: "pointer",
                                    }}
                                >
                                    Fast think
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setThinkingMode("deep")}
                                    style={{
                                        padding: "4px 8px",
                                        borderRadius: 999,
                                        border: "1px solid var(--border-subtle, #ccc)",
                                        fontSize: 12,
                                        fontWeight: thinkingMode === "deep" ? 600 : 400,
                                        opacity: thinkingMode === "deep" ? 1 : 0.8,
                                        cursor: "pointer",
                                    }}
                                >
                                    Deep think
                                </button>
                            </div>
                        </div>

                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                            <span>Active model: {activeModel || "not set"}</span>
                            {thinkingMode === "deep" && deepModel && (
                                <span style={{ marginLeft: 8, color: "var(--color-accent, #3b82f6)" }}>(Deep)</span>
                            )}
                            {thinkingMode === "fast" && fastModel && (
                                <span style={{ marginLeft: 8, color: "var(--color-accent, #22c55e)" }}>(Fast)</span>
                            )}
                        </div>
                    </div>

                    {/* Right: files, save/load, copy button */}
                    <div
                        style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                            flexWrap: "wrap",
                        }}
                    >
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
                                    {files.length} file{files.length > 1 ? "s" : ""}: {files.map(f => f.name).join(", ")}
                                </span>
                                <button type="button" onClick={handleClearFiles} title="Clear loaded files">
                                    Clear files
                                </button>
                            </>
                        )}

                        <input
                            placeholder="Chat name"
                            value={chatName}
                            onChange={(e) => setChatName(e.target.value)}
                            style={{ width: 120 }}
                        />
                        <button type="button" onClick={handleSave} disabled={!chatName.trim()}>
                            Save chat
                        </button>

                        <select onChange={(e) => handleLoad(e.target.value)} value="">
                            <option value="" disabled>
                                Load saved chat
                            </option>
                            {sortedChats.map((c) => (
                                <option key={c} value={c}>
                                    {pinnedChats.includes(c) ? "* " : ""}{c}
                                </option>
                            ))}
                        </select>
                        {chatName && (
                            <button
                                type="button"
                                onClick={() => handleTogglePin(chatName)}
                                title={pinnedChats.includes(chatName) ? "Unpin this chat" : "Pin this chat"}
                            >
                                {pinnedChats.includes(chatName) ? "Unpin" : "Pin"}
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={handleCopyLastAnswer}
                            disabled={!hasBotMessage}
                            title="Copy the last assistant answer (Markdown) to clipboard"
                        >
                            {copyStatus || "Copy response"}
                        </button>
                        <button
                            type="button"
                            onClick={handleSaveLastResponse}
                            disabled={!hasBotMessage}
                            title="Save last response as .md file"
                        >
                            Save as .md
                        </button>
                        <button
                            type="button"
                            onClick={handleClearChat}
                            title="Clear chat history"
                        >
                            Clear chat
                        </button>
                    </div>
                </div>

                {/* Search bar */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--color-border, #eee)" }}>
                    <input
                        type="text"
                        placeholder="Search all chats..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                        style={{ flex: 1, maxWidth: 250 }}
                    />
                    <button type="button" onClick={handleSearch} disabled={isSearching || searchQuery.length < 2}>
                        {isSearching ? "Searching..." : "Search"}
                    </button>
                    {showSearchResults && (
                        <button type="button" onClick={() => setShowSearchResults(false)}>
                            Close results
                        </button>
                    )}
                </div>

                {/* Search results */}
                {showSearchResults && searchResults.length > 0 && (
                    <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto", fontSize: 12, border: "1px solid var(--color-border, #eee)", borderRadius: 8, padding: 8 }}>
                        {searchResults.map((r) => (
                            <div key={r.chatName} style={{ marginBottom: 8 }}>
                                <button
                                    type="button"
                                    onClick={() => handleLoadFromSearch(r.chatName)}
                                    style={{ fontWeight: 600, fontSize: 13, cursor: "pointer", background: "none", border: "none", padding: 0, color: "var(--color-accent, #3b82f6)", textDecoration: "underline" }}
                                >
                                    {r.chatName}
                                </button>
                                <span style={{ opacity: 0.7, marginLeft: 8 }}>({r.matches.length} match{r.matches.length > 1 ? "es" : ""})</span>
                                <div style={{ marginTop: 4, opacity: 0.8 }}>
                                    {r.matches.slice(0, 2).map((m, i) => (
                                        <div key={i} style={{ marginLeft: 8, fontStyle: "italic" }}>
                                            [{m.role}] {m.snippet}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {showSearchResults && searchResults.length === 0 && !isSearching && (
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                        No results found for "{searchQuery}"
                    </div>
                )}

                {/* Session Metadata Info */}
                <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--color-border, #eee)", fontSize: 11, opacity: 0.75 }}>
                    <span title="Current model">Model: {activeModel || "none"}</span>
                    <span title="Files loaded">{files.length} file{files.length !== 1 ? "s" : ""} loaded</span>
                    <span title="Number of prompts">{userMessages.length} prompt{userMessages.length !== 1 ? "s" : ""}</span>
                    <span title="Number of responses">{botMessages.length} response{botMessages.length !== 1 ? "s" : ""}</span>
                    <span title="Total words in conversation">{totalWords} words</span>
                    <span title="Thinking mode">{thinkingMode === "deep" ? "Deep thinking" : "Fast thinking"}</span>
                </div>
            </div>

            {/* Chat history */}
            <div className="panel" style={{ minHeight: 0 }}>
                <div className="panel-body" style={{ height: "100%", padding: 0 }}>
                    <ChatHistory messages={messages} isStreaming={isStreaming} thinkingMode={thinkingMode} />
                </div>
            </div>

            {/* Input */}
            <div className="panel">
                <div className="panel-body">
                    <ChatInput onSend={handleSend} />
                </div>
            </div>
        </div>
    );
}
