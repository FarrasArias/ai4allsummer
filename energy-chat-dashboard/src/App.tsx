import { useEffect, useState, useRef } from "react";
import Sidebar, { type ModeTab, type ThemeChoice } from "./components/Sidebar";
import HeaderBar from "./components/HeaderBar";
import ChatPane from "./components/ChatPane";
import ModelManagerPane from "./components/ModelManagerPane";
import VibeCodingPane from "./components/VibeCodingPane";
import WebChatPane from "./components/WebChatPane";
import ImageAnalysisPane from "./components/ImageAnalysisPane";
import ImageGenPane from "./components/ImageGenPane";
import ConductPane from "./components/ConductPane";
import AboutPane from "./components/AboutPane";
import TestRunnerPane from "./components/TestRunnerPane";
import { TipProvider } from "./components/TipContext";
import {
    streamPower,
    saveStudySession,
    resetChatSession,
    resetAgent,
    resetWeb,
    getModeDefaults,
    loadModel,
    listChats,
    loadChat,
    saveChat,
    searchChats,
    deleteChat,
    renameChat,
    getPinnedChats,
    setPinnedChats as savePinnedChats,
    togglePinnedChat,
    appendConductLog,
    type ChatInfo,
    type ModeDefaults,
    type ModeKey,
    type ConductPhase,
    type InferenceMetrics,
} from "./api";

import StudyControls, { loadPersistedStudySettings } from "./components/StudyControls";
import type { StudySettings, PromptMetric } from "./components/StudyControls";

type Msg = { role: "user" | "bot"; text: string; metrics?: InferenceMetrics };

function slugifyTitle(text: string, maxWords = 4): string {
    const words = text.trim().split(/\s+/).slice(0, maxWords).join(" ");
    const slug = words.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "conduct-log";
}

function generateChatName(messages: Msg[]): string {
    const firstUser = messages.find(m => m.role === "user");
    if (!firstUser) return `chat-${Date.now()}`;
    const base = firstUser.text.trim()
        .slice(0, 40)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return base || `chat-${Date.now()}`;
}

export default function App() {
    /* ── Energy state ── */
    const [latestPromptWh, setLatestPromptWh] = useState<number | null>(null);
    const [sessionTotalWh, setSessionTotalWh] = useState<number | null>(null);
    const [todayTotalWh, setTodayTotalWh] = useState<number | null>(null);
    const [promptWhHistory, setPromptWhHistory] = useState<number[]>([]);
    const lastPromptWhRef = useRef<number | null>(null);

    /* ── Tab / nav ── */
    const [tab, setTab] = useState<ModeTab>("chat");
    const [chatKey, setChatKey] = useState(0);
    const [vibeKey, setVibeKey] = useState(0);
    const [webKey, setWebKey] = useState(0);
    const [imageKey, setImageKey] = useState(0);
    const [currentModel, setCurrentModel] = useState<string | null>(null);

    /* ── Conversation list ── */
    const [chats, setChats] = useState<ChatInfo[]>([]);
    const [pinnedChats, setPinnedChats] = useState<string[]>([]);
    const [activeChatName, setActiveChatName] = useState("");
    const [fileCount, setFileCount] = useState(0);
    const [chatLoading, setChatLoading] = useState(false);

    /* ── Model management ── */
    const [autoLoadModel, setAutoLoadModel] = useState<boolean>(() => {
        try { return localStorage.getItem("ai4all.autoLoadModel") === "true"; }
        catch { return false; }
    });
    const [modelLoading, setModelLoading] = useState(false);
    const [modelLoadTarget, setModelLoadTarget] = useState<string | null>(null);

    const [fastModel, setFastModel] = useState<string | null>(() => {
        try { return localStorage.getItem("ai4all.chat.fastModel") || null; }
        catch { return null; }
    });
    const [deepModel, setDeepModel] = useState<string | null>(() => {
        try { return localStorage.getItem("ai4all.chat.deepModel") || null; }
        catch { return null; }
    });

    const [modeDefaults, setModeDefaults] = useState<ModeDefaults | null>(null);
    const [modeOverrides, setModeOverrides] = useState<Partial<Record<ModeKey, string>>>(() => {
        try {
            const raw = localStorage.getItem("ai4all.modeOverrides");
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    });

    /* ── Study settings (hidden, accessible via Settings tab) ── */
    const persisted = loadPersistedStudySettings() || {};
    const [study, setStudy] = useState<StudySettings>({
        participantId: persisted.participantId || "",
        group: (persisted.group as any) || "control",
        session: (persisted.session as any) || 1,
        taskStartedAt: null,
        taskEndedAt: null,
    });
    const [promptMetrics, setPromptMetrics] = useState<PromptMetric[]>([]);
    const [s1TotalWh, setS1TotalWh] = useState<number | null>(() => {
        try {
            const key = `ai4all.study.s1TotalWh.${persisted.participantId || "anon"}`;
            const raw = localStorage.getItem(key);
            return raw ? Number(raw) : null;
        } catch { return null; }
    });

    const [messages, setMessages] = useState<Msg[]>([]);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const activeChatNameRef = useRef("");
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const [studyCollapsed, setStudyCollapsed] = useState(true);

    /* ── Conduct log ── */
    // Held for the life of the session so every append after the first
    // lands in the same file; the title is only asked for once.
    const [logSlug, setLogSlug] = useState<string | null>(null);

    /* ── Theme ── */
    const [theme, setTheme] = useState<ThemeChoice>(() => {
        try {
            return (localStorage.getItem("ai4all.theme") as ThemeChoice) || "system";
        } catch { return "system"; }
    });

    /* ── Derived model values ── */
    const vibeModel = modeOverrides.vibe_coding || modeDefaults?.vibe_coding?.default;
    const webModel = modeOverrides.web || modeDefaults?.web?.default;
    const imageModel = modeOverrides.image || modeDefaults?.image?.default;
    const imageGenModel = modeOverrides.image_gen || modeDefaults?.image_gen?.default;
    const chatModeModel = modeOverrides.chat || modeDefaults?.chat?.default;

    // activeModel for display: use whatever ChatPane last reported, else the default
    const activeModel = currentModel || chatModeModel;

    const last2AvgWh =
        promptWhHistory.length > 0
            ? promptWhHistory.reduce((sum, v) => sum + v, 0) / promptWhHistory.length
            : null;

    const defaultLogTitle =
        messages.find((m) => m.role === "user")?.text.trim().split(/\s+/).slice(0, 4).join(" ") ||
        "Conduct log";

    /* ── Effects ── */

    // Persist settings
    useEffect(() => {
        try { localStorage.setItem("ai4all.modeOverrides", JSON.stringify(modeOverrides)); }
        catch { /* ignore */ }
    }, [modeOverrides]);

    // Apply theme
    useEffect(() => {
        if (theme === "system") {
            document.documentElement.removeAttribute("data-theme");
        } else {
            document.documentElement.setAttribute("data-theme", theme);
        }
        try { localStorage.setItem("ai4all.theme", theme); }
        catch { /* ignore */ }
    }, [theme]);

    useEffect(() => {
        try {
            if (fastModel) localStorage.setItem("ai4all.chat.fastModel", fastModel);
            else localStorage.removeItem("ai4all.chat.fastModel");
        } catch { /* ignore */ }
    }, [fastModel]);

    useEffect(() => {
        try {
            if (deepModel) localStorage.setItem("ai4all.chat.deepModel", deepModel);
            else localStorage.removeItem("ai4all.chat.deepModel");
        } catch { /* ignore */ }
    }, [deepModel]);

    useEffect(() => {
        try { localStorage.setItem("ai4all.autoLoadModel", String(autoLoadModel)); }
        catch { /* ignore */ }
    }, [autoLoadModel]);

    // Load mode defaults from backend
    useEffect(() => {
        getModeDefaults()
            .then((defaults) => {
                setModeDefaults(defaults);
                const chatDefaults = defaults.chat;
                if (chatDefaults) {
                    if (!fastModel && chatDefaults.fast) setFastModel(chatDefaults.fast);
                    if (!deepModel && chatDefaults.thinking) setDeepModel(chatDefaults.thinking);
                }
            })
            .catch((err) => console.error("Failed to load mode defaults", err));
    }, []);

    // Load conversation list
    useEffect(() => {
        listChats()
            .then((j) => {
                setChats((j.chats ?? []).filter((c) => c.name !== "_tmp"));
            })
            .catch(() => {});
        setPinnedChats(getPinnedChats());
    }, []);

    // Power stream
    useEffect(() => {
        const stop = streamPower((s) => {
            const latestWh = s.latest_prompt_Wh ?? 0;
            const sessionWh = s.session_total_Wh ?? 0;
            const todayWh = s.today_total_Wh ?? 0;

            setPromptWhHistory((prev) => {
                const prevSeen = lastPromptWhRef.current;
                if (latestWh > 0 && latestWh !== prevSeen) {
                    const next = [...prev, latestWh];
                    if (next.length > 2) next.shift();
                    lastPromptWhRef.current = latestWh;
                    return next;
                }
                lastPromptWhRef.current = latestWh;
                return prev;
            });

            setLatestPromptWh(latestWh);
            setSessionTotalWh(sessionWh);
            setTodayTotalWh(todayWh);
        });
        return stop;
    }, []);

    // Keep activeChatNameRef in sync
    useEffect(() => { activeChatNameRef.current = activeChatName; }, [activeChatName]);

    // Auto-save conversation to backend (debounced 2s after last message change)
    useEffect(() => {
        if (!messages.some(m => m.role === "user")) return;
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            const name = activeChatNameRef.current || generateChatName(messages);
            if (!activeChatNameRef.current) {
                setActiveChatName(name);
                activeChatNameRef.current = name;
            }
            saveChat(name, messages, { mode: "chat" }).then(() => {
                listChats()
                    .then(j => setChats((j.chats ?? []).filter((c) => c.name !== "_tmp")))
                    .catch(() => {});
            }).catch(console.error);
        }, 2000);
        return () => clearTimeout(saveTimerRef.current);
    }, [messages]);

    // Auto-preload model on tab switch (non-chat)
    useEffect(() => {
        if (!autoLoadModel) return;
        let modelToLoad: string | undefined;
        switch (tab) {
            case "vibe": modelToLoad = vibeModel; break;
            case "web": modelToLoad = webModel; break;
            case "image": modelToLoad = imageModel; break;
            case "image_gen": modelToLoad = imageGenModel; break;
        }
        if (modelToLoad) handleRequestModelLoad(modelToLoad);
    }, [tab, autoLoadModel]);

    /* ── Handlers ── */

    async function handleRequestModelLoad(model: string) {
        if (!model || modelLoading) return;
        setModelLoading(true);
        setModelLoadTarget(model);
        try { await loadModel(model); }
        catch (err) { console.error("Failed to pre-load model:", err); }
        finally { setModelLoading(false); setModelLoadTarget(null); }
    }

    function handleNewChat() {
        if (currentModel) {
            resetChatSession(currentModel).catch(() => {});
        }
        setMessages([{ role: "bot", text: "Hi! Ask me anything." }]);
        setActiveChatName("");
        try { localStorage.removeItem("ai4all.chat.messages"); } catch {}
        setChatKey((k) => k + 1);
        setTab("chat");

        // Reset energy for new chat
        setLatestPromptWh(null);
        setSessionTotalWh(null);
        setPromptWhHistory([]);
        lastPromptWhRef.current = null;

        // A new conversation is a new conducting session — ask for a log
        // title again next time, rather than folding it into the old file.
        setLogSlug(null);
    }

    async function handleChatSelect(name: string) {
        setActiveChatName(name);
        setTab("chat");
        setChatLoading(true);
        try {
            const history = await loadChat(name);
            if (Array.isArray(history) && history.length > 0) {
                try { localStorage.setItem("ai4all.chat.messages", JSON.stringify(history)); } catch {}
                setChatKey(k => k + 1);
            }
        } catch (err) {
            console.error("Failed to load chat:", err);
        } finally {
            setChatLoading(false);
        }
    }

    function handleCopyLastResponse() {
        const lastBot = [...messages].reverse().find((m) => m.role === "bot");
        if (!lastBot) return;
        navigator.clipboard.writeText(lastBot.text).then(() => {
            setCopyStatus("Copied!");
            setTimeout(() => setCopyStatus(null), 2000);
        }).catch(() => {
            setCopyStatus("Failed");
            setTimeout(() => setCopyStatus(null), 2000);
        });
    }

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

    async function handleAppendLog(args: { phase: ConductPhase; note: string; title?: string }): Promise<boolean> {
        let lastBotIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "bot") { lastBotIndex = i; break; }
        }
        const lastBot = lastBotIndex >= 0 ? messages[lastBotIndex] : undefined;
        let precedingUser: Msg | undefined;
        for (let i = lastBotIndex - 1; i >= 0; i--) {
            if (messages[i].role === "user") { precedingUser = messages[i]; break; }
        }

        const slug = logSlug || slugifyTitle(args.title || defaultLogTitle);

        try {
            const res = await appendConductLog(slug, {
                phase: args.phase,
                note: args.note,
                prompt: precedingUser?.text || "",
                response: lastBot?.text || "",
                model: activeModel || null,
                mode: tab,
                energy_wh: lastBot?.metrics?.energy_wh ?? null,
                title: args.title,
            });
            if (res.ok && !logSlug) setLogSlug(slug);
            return !!res.ok;
        } catch {
            return false;
        }
    }

    function handleClearChat() {
        // Clear resets every conversational mode (Chat, Code, Web, Image),
        // not just whichever tab is active — each pane keeps its own
        // transcript, so a scoped clear used to look like it "didn't work"
        // on the others.
        if (currentModel) {
            resetChatSession(currentModel).catch(() => {});
        }
        if (vibeModel) {
            resetAgent(vibeModel).catch(() => {});
        }
        if (webModel) {
            resetWeb(webModel).catch(() => {});
        }

        setMessages([{ role: "bot", text: "Hi! Ask me anything." }]);
        setActiveChatName("");
        try {
            localStorage.removeItem("ai4all.chat.messages");
            localStorage.removeItem("ai4all.vibe.entries");
            localStorage.removeItem("ai4all.web.messages");
            localStorage.removeItem("ai4all.image.turns");
            localStorage.removeItem("ai4all.image.dataUrl");
            localStorage.removeItem("ai4all.image.name");
        } catch {}
        setChatKey((k) => k + 1);
        setVibeKey((k) => k + 1);
        setWebKey((k) => k + 1);
        setImageKey((k) => k + 1);
        setLatestPromptWh(null);
        setSessionTotalWh(null);
        setPromptWhHistory([]);
        lastPromptWhRef.current = null;
        setLogSlug(null);
    }

    /* ── Conversation actions ── */
    function handleToggleStar(name: string) {
        togglePinnedChat(name);
        setPinnedChats(getPinnedChats());
    }

    function handleDeleteChat(name: string) {
        setChats((prev) => prev.filter((c) => c.name !== name));
        // Clean up pinned list
        const pinned = getPinnedChats();
        if (pinned.includes(name)) {
            savePinnedChats(pinned.filter(p => p !== name));
            setPinnedChats(pinned.filter(p => p !== name));
        }
        if (activeChatName === name) {
            setActiveChatName("");
            handleNewChat();
        }
        deleteChat(name).catch(console.error);
    }

    function handleRenameChat(oldName: string, newName: string) {
        setChats((prev) => prev.map((c) => c.name === oldName ? { ...c, name: newName } : c));
        if (activeChatName === oldName) setActiveChatName(newName);
        // Update pinned list if the renamed chat was pinned
        const pinned = getPinnedChats();
        const idx = pinned.indexOf(oldName);
        if (idx >= 0) {
            pinned[idx] = newName;
            savePinnedChats([...pinned]);
            setPinnedChats([...pinned]);
        }
        renameChat(oldName, newName).catch(console.error);
    }

    /* ── Search ── */
    async function handleSearch(query: string): Promise<string[]> {
        try {
            const { results } = await searchChats(query);
            return results.map(r => r.chatName);
        } catch {
            return [];
        }
    }

    /* ── Study handlers ── */
    function handleStudyChange(next: StudySettings) {
        setStudy((s) => ({ ...s, ...next }));
        if (next.participantId && next.participantId !== study.participantId) {
            try {
                const key = `ai4all.study.s1TotalWh.${next.participantId}`;
                const raw = localStorage.getItem(key);
                setS1TotalWh(raw ? Number(raw) : null);
            } catch { /* ignore */ }
        }
    }

    function handleStartTask() {
        setStudy((s) => ({ ...s, taskStartedAt: Date.now(), taskEndedAt: null }));
        setPromptMetrics([]);
    }

    async function handleEndTask() {
        const endedAt = Date.now();
        setStudy((s) => ({ ...s, taskEndedAt: endedAt }));
        if (study.session === 1 && typeof sessionTotalWh === "number") {
            const key = `ai4all.study.s1TotalWh.${study.participantId || "anon"}`;
            localStorage.setItem(key, String(sessionTotalWh));
            setS1TotalWh(sessionTotalWh);
        }
        const sessionName = `${(study.participantId || "anon").trim()}_s${study.session}`;
        await saveStudySession({
            name: sessionName,
            history: messages,
            metrics: promptMetrics,
            session: {
                participantId: study.participantId,
                group: study.group,
                session: study.session,
                taskStartedAt: study.taskStartedAt,
                taskEndedAt: endedAt,
                energy: {
                    latestPromptWh: latestPromptWh ?? null,
                    sessionTotalWh: sessionTotalWh ?? null,
                    todayTotalWh: todayTotalWh ?? null,
                    session1TotalWh: s1TotalWh ?? null,
                },
            },
        });
    }

    const userMessages = messages.filter((m) => m.role === "user");
    const botMessages = messages.filter((m) => m.role === "bot");

    return (
        <TipProvider>
            <div className="app-grid">
                {/* ── Sidebar ── */}
                <Sidebar
                    activeTab={tab}
                    onTabChange={setTab}
                    chats={chats}
                    pinnedChats={pinnedChats}
                    activeChatName={activeChatName}
                    onChatSelect={handleChatSelect}
                    onNewChat={handleNewChat}
                    onToggleStar={handleToggleStar}
                    onDeleteChat={handleDeleteChat}
                    onRenameChat={handleRenameChat}
                    latestPromptWh={latestPromptWh}
                    sessionTotalWh={sessionTotalWh}
                    promptCount={promptMetrics.length}
                    last2AvgWh={last2AvgWh}
                    theme={theme}
                    onThemeChange={setTheme}
                    onSearch={handleSearch}
                />

                {/* ── Main Content ── */}
                <section className="main-content">
                    {/* Header bar */}
                    <HeaderBar
                        tab={tab}
                        chatName={activeChatName}
                        activeModel={activeModel || null}
                        promptCount={userMessages.length}
                        responseCount={botMessages.length}
                        fileCount={fileCount}
                        sessionTotalWh={sessionTotalWh}
                        last2AvgWh={last2AvgWh}
                        onClearChat={handleClearChat}
                        onCopyResponse={handleCopyLastResponse}
                        onSaveResponse={handleSaveLastResponse}
                        copyStatus={copyStatus}
                        onAppendLog={handleAppendLog}
                        logTitleDefault={defaultLogTitle}
                        showLogTitleField={!logSlug}
                    />

                    {/* Content area */}
                    {tab === "chat" && chatLoading && (
                        <div className="chat-loading">
                            <span className="model-loading-spinner" style={{ fontSize: 20 }}>⟳</span>
                            <span>Loading conversation…</span>
                        </div>
                    )}
                    {tab === "chat" && !chatLoading && (
                        <div className="chat-area">
                            <ChatPane
                                key={chatKey}
                                model={chatModeModel || undefined}
                                fastModel={fastModel || undefined}
                                deepModel={deepModel || undefined}
                                autoLoadModel={autoLoadModel}
                                modelLoading={modelLoading}
                                onRequestModelLoad={handleRequestModelLoad}
                                onUserPrompt={(m) => setPromptMetrics((arr) => [...arr, m])}
                                onHistoryChange={(history) => setMessages(history)}
                                onModelChange={(model) => setCurrentModel(model)}
                                onFileCountChange={setFileCount}
                            />
                        </div>
                    )}

                    {tab === "vibe" && (
                        <div className="pane-scroll">
                            <VibeCodingPane key={vibeKey} model={vibeModel} />
                        </div>
                    )}

                    {tab === "web" && (
                        <div className="chat-area">
                            <WebChatPane key={webKey} model={webModel} />
                        </div>
                    )}

                    {tab === "image" && (
                        <div className="pane-scroll">
                            <ImageAnalysisPane key={imageKey} model={imageModel} />
                        </div>
                    )}

                    {tab === "image_gen" && (
                        <div className="pane-scroll">
                            <ImageGenPane model={imageGenModel} />
                        </div>
                    )}

                    {tab === "conduct" && (
                        <div className="pane-scroll">
                            <ConductPane />
                        </div>
                    )}

                    {tab === "about" && (
                        <div className="pane-scroll">
                            <AboutPane />
                        </div>
                    )}

                    {tab === "settings" && (
                        <div className="pane-scroll">
                            <ModelManagerPane
                                fastModel={fastModel}
                                deepModel={deepModel}
                                onFastModelChange={setFastModel}
                                onDeepModelChange={setDeepModel}
                                modeDefaults={modeDefaults || undefined}
                                modeOverrides={modeOverrides}
                                onModeOverrideChange={(mode, model) =>
                                    setModeOverrides((prev) => {
                                        const next = { ...prev };
                                        if (!model) delete next[mode];
                                        else next[mode] = model;
                                        return next;
                                    })
                                }
                                autoLoadModel={autoLoadModel}
                                onAutoLoadModelChange={setAutoLoadModel}
                                modelLoading={modelLoading}
                                modelLoadTarget={modelLoadTarget}
                            />

                            {/* Study controls — accessible from Settings */}
                            <div style={{ marginTop: 24 }}>
                                <StudyControls
                                    settings={study}
                                    onSettingsChange={handleStudyChange}
                                    onStartTask={handleStartTask}
                                    onEndTask={handleEndTask}
                                    onReset={handleNewChat}
                                    prompts={promptMetrics}
                                    s1TotalWh={s1TotalWh}
                                    collapsible
                                    collapsed={studyCollapsed}
                                    onToggleCollapsed={() => setStudyCollapsed(v => !v)}
                                />
                            </div>
                        </div>
                    )}

                    {tab === "testing" && (
                        <div className="pane-scroll">
                            <TestRunnerPane defaultModel={chatModeModel || undefined} />
                        </div>
                    )}
                </section>
            </div>
        </TipProvider>
    );
}
