import { useEffect, useState, useRef } from "react";
import Sidebar, { type ModeTab, type ThemeChoice } from "./components/Sidebar";
import HeaderBar from "./components/HeaderBar";
import ChatPane from "./components/ChatPane";
import ModelManagerPane from "./components/ModelManagerPane";
import VibeCodingPane from "./components/VibeCodingPane";
import WebChatPane from "./components/WebChatPane";
import ImageAnalysisPane from "./components/ImageAnalysisPane";
import ImageGenPane from "./components/ImageGenPane";
import TestRunnerPane from "./components/TestRunnerPane";
import { TipProvider } from "./components/TipContext";
import {
    streamPower,
    saveStudySession,
    resetChatSession,
    getModeDefaults,
    loadModel,
    listChats,
    getPinnedChats,
    togglePinnedChat,
    type ModeDefaults,
    type ModeKey,
} from "./api";

import StudyControls, { loadPersistedStudySettings } from "./components/StudyControls";
import type { StudySettings, PromptMetric } from "./components/StudyControls";

type Msg = { role: "user" | "bot"; text: string };

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
    const [currentModel, setCurrentModel] = useState<string | null>(null);

    /* ── Conversation list ── */
    const [chats, setChats] = useState<string[]>([]);
    const [pinnedChats, setPinnedChats] = useState<string[]>([]);
    const [activeChatName, setActiveChatName] = useState("");

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
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const [studyCollapsed, setStudyCollapsed] = useState(true);

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
        listChats().then((j) => setChats(j.chats ?? [])).catch(() => {});
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
    }

    function handleChatSelect(name: string) {
        setActiveChatName(name);
        // Chat loading is handled by ChatPane internally when we switch
        setTab("chat");
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

    function handleClearChat() {
        if (currentModel) {
            resetChatSession(currentModel).catch(() => {});
        }
        setMessages([{ role: "bot", text: "Hi! Ask me anything." }]);
        setActiveChatName("");
        try { localStorage.removeItem("ai4all.chat.messages"); } catch {}
        setChatKey((k) => k + 1);
        setLatestPromptWh(null);
        setSessionTotalWh(null);
        setPromptWhHistory([]);
        lastPromptWhRef.current = null;
    }

    /* ── Conversation actions ── */
    function handleToggleStar(name: string) {
        togglePinnedChat(name);
        setPinnedChats(getPinnedChats());
    }

    function handleDeleteChat(name: string) {
        setChats((prev) => prev.filter((c) => c !== name));
        if (activeChatName === name) {
            setActiveChatName("");
            handleNewChat();
        }
    }

    function handleRenameChat(_name: string, _newName: string) {
        // Rename is client-side only; the backend has no rename endpoint
        setChats((prev) => prev.map((c) => c === _name ? _newName : c));
        if (activeChatName === _name) setActiveChatName(_newName);
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
                        fileCount={0}
                        sessionTotalWh={sessionTotalWh}
                        last2AvgWh={last2AvgWh}
                        onClearChat={handleClearChat}
                        onCopyResponse={handleCopyLastResponse}
                        onSaveResponse={handleSaveLastResponse}
                        copyStatus={copyStatus}
                    />

                    {/* Content area */}
                    {tab === "chat" && (
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
                            />
                        </div>
                    )}

                    {tab === "vibe" && (
                        <div className="pane-scroll">
                            <VibeCodingPane model={vibeModel} />
                        </div>
                    )}

                    {tab === "web" && (
                        <div className="chat-area">
                            <WebChatPane model={webModel} />
                        </div>
                    )}

                    {tab === "image" && (
                        <div className="pane-scroll">
                            <ImageAnalysisPane model={imageModel} />
                        </div>
                    )}

                    {tab === "image_gen" && (
                        <div className="pane-scroll">
                            <ImageGenPane model={imageGenModel} />
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
