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
import AccountPanel from "./components/AccountPanel";
import UsersPanel from "./components/UsersPanel";
import EnergyPane from "./components/EnergyPane";
import { TipProvider } from "./components/TipContext";
import {
    streamPower,
    saveStudySession,
    resetChatSession,
    resetAgent,
    resetWeb,
    getModeDefaults,
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
    slugifyConductTitle,
    type ChatInfo,
    type ModeDefaults,
    type Activity,
    type ConductPhase,
    type InferenceMetrics,
} from "./api";

import StudyControls, { loadPersistedStudySettings } from "./components/StudyControls";
import { useSession } from "./session";
import { GRADE_WINDOW, computeGrade } from "./energyGrade";
import type { StudySettings, PromptMetric } from "./components/StudyControls";

type Msg = { role: "user" | "bot"; text: string; metrics?: InferenceMetrics };

function generateChatName(messages: Msg[]): string {
    const firstUser = messages.find(m => m.role === "user");
    if (!firstUser) return `chat-${Date.now()}`;
    const base = firstUser.text.trim()
        .slice(0, 40)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // "." and ".." aren't valid folder names; the backend rejects them
    return base && base !== "." && base !== ".." ? base : `chat-${Date.now()}`;
}

export default function App() {
    /* ── Who's using the app, and what they may use (server mode) ── */
    const { me } = useSession();
    const caps = me.capabilities!;
    /* ── Energy state ── */
    const [latestPromptWh, setLatestPromptWh] = useState<number | null>(null);
    const [sessionTotalWh, setSessionTotalWh] = useState<number | null>(null);
    const [todayTotalWh, setTodayTotalWh] = useState<number | null>(null);
    const [promptWhHistory, setPromptWhHistory] = useState<number[]>([]);
    const lastPromptWhRef = useRef<number | null>(null);
    const [activity, setActivity] = useState<Activity | null>(null);

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

    /* Conduct tools visibility — default on, per CONDUCT_STAGE1.md §6 */
    const [showConductTools, setShowConductTools] = useState<boolean>(() => {
        try { return localStorage.getItem("ai4all.showConductTools") !== "false"; }
        catch { return true; }
    });
    // Every mode uses the one model the server names (backend/utilities/main_model.py)
    const [modeDefaults, setModeDefaults] = useState<ModeDefaults | null>(null);

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
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    const vibeModel = modeDefaults?.vibe_coding?.default;
    const webModel = modeDefaults?.web?.default;
    const imageModel = modeDefaults?.image?.default;
    const imageGenModel = modeDefaults?.image_gen?.default;
    const chatModeModel = modeDefaults?.chat?.default;

    // activeModel for display: use whatever ChatPane last reported, else the default
    const activeModel = currentModel || chatModeModel;

    const recentAvgWh =
        promptWhHistory.length > 0
            ? promptWhHistory.reduce((sum, v) => sum + v, 0) / promptWhHistory.length
            : null;
    // One grade for the sidebar and the header badge (energyGrade.ts)
    const grade = computeGrade(recentAvgWh, promptMetrics.length);

    const defaultLogTitle =
        messages.find((m) => m.role === "user")?.text.trim().split(/\s+/).slice(0, 4).join(" ") ||
        "Conduct log";

    /* ── Effects ── */

    // Model choices saved by earlier versions no longer apply: one model for everyone
    useEffect(() => {
        try {
            ["ai4all.chat.fastModel", "ai4all.chat.deepModel", "ai4all.modeOverrides", "ai4all.autoLoadModel"]
                .forEach((k) => localStorage.removeItem(k));
        } catch { /* ignore */ }
    }, []);

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
        try { localStorage.setItem("ai4all.showConductTools", String(showConductTools)); }
        catch { /* ignore */ }
        // Don't strand the user on a tab that just disappeared from the nav.
        if (!showConductTools && tab === "conduct") setTab("chat");
    }, [showConductTools, tab]);

    // Online, the Code tab (it runs the agent) and the test runner are locked
    useEffect(() => {
        if ((tab === "vibe" && !caps.code_tab) || (tab === "testing" && !caps.test_runner) ||
            (tab === "energy" && !caps.manage_users)) setTab("chat");
    }, [tab, caps.code_tab, caps.test_runner, caps.manage_users]);

    // Load mode defaults from backend
    useEffect(() => {
        getModeDefaults()
            .then(setModeDefaults)
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
                    if (next.length > GRADE_WINDOW) next.shift();
                    lastPromptWhRef.current = latestWh;
                    return next;
                }
                lastPromptWhRef.current = latestWh;
                return prev;
            });

            setLatestPromptWh(latestWh);
            setSessionTotalWh(sessionWh);
            setTodayTotalWh(todayWh);
            setActivity(s.activity ?? null);
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

    /* ── Handlers ── */

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

        const slug = logSlug || slugifyConductTitle(args.title || defaultLogTitle);

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
                    grade={grade}
                    activity={activity}
                    theme={theme}
                    onThemeChange={setTheme}
                    onSearch={handleSearch}
                    showConductTools={showConductTools}
                    showCodeTab={caps.code_tab}
                    showEnergyReport={caps.manage_users}
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
                        grade={grade}
                        onClearChat={handleClearChat}
                        onCopyResponse={handleCopyLastResponse}
                        onSaveResponse={handleSaveLastResponse}
                        copyStatus={copyStatus}
                        onAppendLog={showConductTools ? handleAppendLog : undefined}
                        logTitleDefault={defaultLogTitle}
                        showLogTitleField={!logSlug}
                        logSlug={logSlug}
                        accountLabel={me.local ? "This Mac" : me.user!.username}
                        onOpenAccount={() => setTab("settings")}
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
                                allowAgent={caps.agent}
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
                            <ConductPane chatModel={activeModel || null} canOpenFiles={caps.conduct_open} />
                        </div>
                    )}

                    {tab === "about" && (
                        <div className="pane-scroll">
                            <AboutPane />
                        </div>
                    )}

                    {tab === "settings" && (
                        <div className="pane-scroll">
                            <div style={{ display: "grid", gap: 16, marginBottom: 16 }}>
                                <AccountPanel />
                                {caps.manage_users && <UsersPanel onOpenEnergy={() => setTab("energy")} />}
                            </div>
                            <ModelManagerPane
                                canManageModels={caps.manage_models}
                                model={chatModeModel}
                            />

                            {/* Conduct tools — CONDUCT_STAGE1.md §6 */}
                            <div style={{ marginTop: 24 }}>
                                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", fontSize: 13 }}>
                                    <input
                                        type="checkbox"
                                        checked={showConductTools}
                                        onChange={(e) => setShowConductTools(e.target.checked)}
                                        style={{ marginTop: 2, flexShrink: 0 }}
                                    />
                                    <div>
                                        <strong>Show Conduct tools</strong>
                                        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                                            When enabled (default): the Conduct page appears in the sidebar
                                            and chat gains a "→ Log" button for recording a turn against a
                                            phase.
                                            <br />
                                            When disabled: both are hidden. Your existing log files are left
                                            untouched on disk.
                                        </div>
                                    </div>
                                </label>
                            </div>

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

                    {tab === "energy" && caps.manage_users && (
                        <div className="pane-scroll">
                            <EnergyPane />
                        </div>
                    )}

                    {tab === "testing" && caps.test_runner && (
                        <div className="pane-scroll">
                            <TestRunnerPane defaultModel={chatModeModel || undefined} />
                        </div>
                    )}
                </section>
            </div>
        </TipProvider>
    );
}
