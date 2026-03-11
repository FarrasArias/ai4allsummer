import { useEffect, useState, useRef } from "react";
import Sidebar from "./components/Sidebar";
import ChatPane from "./components/ChatPane";
import ModelManagerPane from "./components/ModelManagerPane";
import VibeCodingPane from "./components/VibeCodingPane";
import WebChatPane from "./components/WebChatPane";
import ImageAnalysisPane from "./components/ImageAnalysisPane";
import ImageGenPane from "./components/ImageGenPane";
import { TipProvider } from "./components/TipContext";
import TipsBox from "./components/TipsBox";
// import AnalyticsPane from "./components/AnalyticsPane";
import {
  streamPower,
  saveStudySession,
  resetChatSession,
  getModeDefaults,
  loadModel,
    type ModeDefaults,
    type ModeKey,
} from "./api";

import StudyControls, { loadPersistedStudySettings } from "./components/StudyControls";
import type { StudySettings, PromptMetric } from "./components/StudyControls";

// Keep in sync with ChatPane's message shape
type Msg = { role: "user" | "bot"; text: string };

export default function App() {
  const [kwhUsed, setKwhUsed] = useState(0);
  const [lastPromptEnergyPct, setLastPromptEnergyPct] = useState(0);
  const [totalEnergyPct, setTotalEnergyPct] = useState(0);
  const [litresWater, setLitresWater] = useState(0);
  const [tab, setTab] = useState<"chat" | "vibe" | "web" | "image" | "image_gen" | "settings">("chat");

  const [latestPromptWh, setLatestPromptWh] = useState<number | null>(null);
  const [sessionTotalWh, setSessionTotalWh] = useState<number | null>(null);
  const [todayTotalWh, setTodayTotalWh] = useState<number | null>(null);

  // NEW: rolling energy window for last 5 prompts
  const [promptWhHistory, setPromptWhHistory] = useState<number[]>([]);
  const lastPromptWhRef = useRef<number | null>(null);

  const [chatKey, setChatKey] = useState(0);

  const [currentModel, setCurrentModel] = useState<string | null>(null);

  // Model pre-loading
  const [autoLoadModel, setAutoLoadModel] = useState<boolean>(() => {
    try { return localStorage.getItem("ai4all.autoLoadModel") === "true"; }
    catch { return false; }
  });
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadTarget, setModelLoadTarget] = useState<string | null>(null);

  // Global chat presets for "Fast think" and "Deep think"
  const [fastModel, setFastModel] = useState<string | null>(() => {
    try {
      return localStorage.getItem("ai4all.chat.fastModel") || null;
    } catch {
      return null;
    }
  });
  const [deepModel, setDeepModel] = useState<string | null>(() => {
    try {
      return localStorage.getItem("ai4all.chat.deepModel") || null;
    } catch {
      return null;
    }
  });

    const [modeDefaults, setModeDefaults] = useState<ModeDefaults | null>(null);

    // NEW: per-mode overrides (chat / vibe_coding / image / web)
    const [modeOverrides, setModeOverrides] = useState<
        Partial<Record<ModeKey, string>>
    >(() => {
        try {
            const raw = localStorage.getItem("ai4all.modeOverrides");
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem("ai4all.modeOverrides", JSON.stringify(modeOverrides));
        } catch {
            // ignore
        }
    }, [modeOverrides]);

  useEffect(() => {
    try {
      if (fastModel) {
        localStorage.setItem("ai4all.chat.fastModel", fastModel);
      } else {
        localStorage.removeItem("ai4all.chat.fastModel");
      }
    } catch {
      // ignore
    }
  }, [fastModel]);

  useEffect(() => {
    try {
      if (deepModel) {
        localStorage.setItem("ai4all.chat.deepModel", deepModel);
      } else {
        localStorage.removeItem("ai4all.chat.deepModel");
      }
    } catch {
      // ignore
    }
  }, [deepModel]);

  // Load backend-defined default models per mode (Chat / Vibe / Web / Image)
  // Also initialize fast/deep models from backend config if not set in localStorage
  useEffect(() => {
    getModeDefaults()
      .then((defaults) => {
        setModeDefaults(defaults);

        // Initialize fast/deep models from backend config if not set locally
        const chatDefaults = defaults.chat;
        if (chatDefaults) {
          if (!fastModel && chatDefaults.fast) {
            setFastModel(chatDefaults.fast);
          }
          if (!deepModel && chatDefaults.thinking) {
            setDeepModel(chatDefaults.thinking);
          }
        }
      })
      .catch((err) => {
        console.error("Failed to load mode defaults", err);
      });
  }, []);

  // Persist autoLoadModel preference
  useEffect(() => {
    try { localStorage.setItem("ai4all.autoLoadModel", String(autoLoadModel)); }
    catch { /* ignore */ }
  }, [autoLoadModel]);

  // Pre-load a model into GPU memory (auto-load mode)
  async function handleRequestModelLoad(model: string) {
    if (!model || modelLoading) return;
    setModelLoading(true);
    setModelLoadTarget(model);
    try {
      await loadModel(model);
    } catch (err) {
      console.error("Failed to pre-load model:", err);
    } finally {
      setModelLoading(false);
      setModelLoadTarget(null);
    }
  }

  // ----- Study settings & metrics -----
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
    } catch {
      return null;
    }
  });

  // OPTIONAL: keep a copy of the transcript in App so we can save it with the study bundle
  const [messages, setMessages] = useState<Msg[]>([]);

  // Collapse behaviour
  const [controlsCollapsed, setControlsCollapsed] = useState(true);

  const last2AvgWh =
    promptWhHistory.length > 0
      ? promptWhHistory.reduce((sum, v) => sum + v, 0) / promptWhHistory.length
      : null;

  // ----- Power stream (kept) + expose raw Wh for EUI -----
  useEffect(() => {
    const stop = streamPower((s) => {
      const latestWh = s.latest_prompt_Wh ?? 0;
      const sessionWh = s.session_total_Wh ?? 0;
      const todayWh = s.today_total_Wh ?? 0;

      // NEW: maintain a rolling history of last 5 prompt Wh values
      setPromptWhHistory((prev) => {
        const prevSeen = lastPromptWhRef.current;

        // Only log when we see a new non-zero latest prompt value
        if (latestWh > 0 && latestWh !== prevSeen) {
          const next = [...prev, latestWh];
          if (next.length > 2) next.shift(); // keep only last 2
          lastPromptWhRef.current = latestWh;
          return next;
        }

        // Keep ref in sync even if unchanged or 0
        lastPromptWhRef.current = latestWh;
        return prev;
      });

      setLatestPromptWh(latestWh);
      setSessionTotalWh(sessionWh);
      setTodayTotalWh(todayWh);

      // legacy sidebar metrics. TODO: Check if should remove.
      setKwhUsed(todayWh / 1000);
      setLastPromptEnergyPct(Math.min(100, (latestWh / 1.0) * 100)); // vs 1 Wh baseline
      setTotalEnergyPct(Math.min(100, (sessionWh / 10.0) * 100)); // vs 10 Wh baseline
      setLitresWater(0); // TODO: placeholder
    });
    return stop;
  }, []);

  // ----- Study handlers -----
  function handleStudyChange(next: StudySettings) {
    setStudy((s) => ({ ...s, ...next }));
    // if participantId changes, try to load their S1 total (so Session 2 can show it)
    if (next.participantId && next.participantId !== study.participantId) {
      try {
        const key = `ai4all.study.s1TotalWh.${next.participantId}`;
        const raw = localStorage.getItem(key);
        setS1TotalWh(raw ? Number(raw) : null);
      } catch {
        // ignore
      }
    }
  }

  function handleStartTask() {
    setStudy((s) => ({ ...s, taskStartedAt: Date.now(), taskEndedAt: null }));
    setPromptMetrics([]); // reset metrics for the new task window
  }

  async function handleEndTask() {
    const endedAt = Date.now();
    setStudy((s) => ({ ...s, taskEndedAt: endedAt }));

    // Persist Session-1 total locally so Session-2 can reference it
    if (study.session === 1 && typeof sessionTotalWh === "number") {
      const key = `ai4all.study.s1TotalWh.${study.participantId || "anon"}`;
      localStorage.setItem(key, String(sessionTotalWh));
      setS1TotalWh(sessionTotalWh);
    }

    // Build folder name and save full study bundle via existing /api/chats/save
    const sessionName = `${(study.participantId || "anon").trim()}_s${study.session}`;

    await saveStudySession({
      name: sessionName,
      history: messages, // transcript lifted from ChatPane via onHistoryChange
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
          session1TotalWh: s1TotalWh ?? null, // handy for Session 2 audits
        },
      },
    });
  }

  async function handleResetAll() {
    // 1) Ask backend to reset per-model state & energy if we know the model
    if (currentModel) {
      try {
        await resetChatSession(currentModel);
      } catch (err) {
        console.error("Failed to reset backend chat session", err);
      }
    }

    // 2) Clear study timer but leave participant / group / session
    setStudy((s) => ({
      ...s,
      taskStartedAt: null,
      taskEndedAt: null,
    }));

    // 3) Clear prompt metrics + transcript
    setPromptMetrics([]);
    setMessages([{ role: "bot", text: "Hi! Ask me anything." }]);

    // 4) Clear energy UI / summary state
    setLatestPromptWh(null);
    setSessionTotalWh(null);
    setTodayTotalWh(null);
    setPromptWhHistory([]);
    lastPromptWhRef.current = null;
    setKwhUsed(0);
    setLastPromptEnergyPct(0);
    setTotalEnergyPct(0);
    setLitresWater(0);

    // 5) Remount ChatPane to reset its internal state (files, chat name, etc.)
    setChatKey((k) => k + 1);
  }

    // When auto-load is on, preload the relevant model when switching non-chat tabs.
    // (The chat tab is handled inside ChatPane via its own activeModel effect.)
    useEffect(() => {
        if (!autoLoadModel) return;
        let modelToLoad: string | undefined;
        switch (tab) {
            case "vibe":      modelToLoad = vibeModel;     break;
            case "web":       modelToLoad = webModel;      break;
            case "image":     modelToLoad = imageModel;    break;
            case "image_gen": modelToLoad = imageGenModel; break;
        }
        if (modelToLoad) handleRequestModelLoad(modelToLoad);
    }, [tab, autoLoadModel]); // eslint-disable-line react-hooks/exhaustive-deps

    const hasSidebar = study.group === "intervention";
    const showSidebar = hasSidebar && tab === "chat";

    const vibeModel =
        modeOverrides.vibe_coding || modeDefaults?.vibe_coding?.default;
    const webModel = modeOverrides.web || modeDefaults?.web?.default;
    const imageModel =
        modeOverrides.image || modeDefaults?.image?.default;
    const imageGenModel =
        modeOverrides.image_gen || modeDefaults?.image_gen?.default;

    // (optional) chat general override, if you want to use it later
    const chatModeModel =
        modeOverrides.chat || modeDefaults?.chat?.default;

    return (
      <TipProvider>
        <div className={`app-grid ${!showSidebar ? "no-sidebar" : ""}`}>
            {showSidebar && (
                <aside className="sidebar">
                    <Sidebar
                        kwhUsed={kwhUsed}
                        lastPromptEnergyPct={lastPromptEnergyPct}
                        totalEnergyPct={totalEnergyPct}
                        litresWater={litresWater}
                        showEUI={true}
                        latestPromptWh={latestPromptWh}
                        sessionTotalWh={sessionTotalWh}
                        session1TotalWh={s1TotalWh}
                        session={study.session}
                        promptCount={promptMetrics.length}
                        last2AvgWh={last2AvgWh}
                    />
                    <TipsBox />
                </aside>
            )}

      <section className="chat">
        {/* Top bar tabs (row 1: auto) */}
        <div className="panel">
          <div className="panel-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setTab("chat")}>Chat</button>
            <button onClick={() => setTab("vibe")}>Vibe Coding</button>
            <button onClick={() => setTab("web")}>Web</button>
            <button onClick={() => setTab("image")}>Image</button>
            <button onClick={() => setTab("image_gen")}>Image Gen</button>
            <button onClick={() => setTab("settings")}>Settings</button>
          </div>
        </div>

        {/* Main area (row 2: 1fr) */}
        <div className="chat-main">
          {tab === "chat" && (
            <>
              <StudyControls
                settings={study}
                onSettingsChange={handleStudyChange}
                onStartTask={handleStartTask}
                onEndTask={handleEndTask}
                onReset={handleResetAll}
                prompts={promptMetrics}
                s1TotalWh={s1TotalWh}
                collapsible
                collapsed={controlsCollapsed}
                onToggleCollapsed={() => setControlsCollapsed((v) => !v)}
              />
                <div className="chat-scroll-container">
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
            </>
          )}

          {tab === "vibe" && <VibeCodingPane model={vibeModel} />}

          {tab === "web" && <WebChatPane model={webModel} />}

          {tab === "image" && <ImageAnalysisPane model={imageModel} />}

          {tab === "image_gen" && <ImageGenPane model={imageGenModel} />}

          {tab === "settings" && (
            <div style={{ overflow: "auto", height: "100%", minHeight: 0 }}>
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
                                  if (!model) {
                                      delete next[mode];  // revert to backend default
                                  } else {
                                      next[mode] = model;
                                  }
                                  return next;
                              })
                          }
                          autoLoadModel={autoLoadModel}
                          onAutoLoadModelChange={setAutoLoadModel}
                          modelLoading={modelLoading}
                          modelLoadTarget={modelLoadTarget}
                      />
            </div>
          )}

          {/* {tab === "analytics" && <AnalyticsPane />} */}
        </div>
      </section>
    </div>
      </TipProvider>
  );
}
