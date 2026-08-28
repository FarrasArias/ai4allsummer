import { useEffect, useMemo, useState } from "react";

export type StudySettings = {
    participantId: string;
    group: "control" | "intervention";
    session: 1 | 2;
    taskStartedAt?: number | null;
    taskEndedAt?: number | null;
};

export type PromptMetric = {
    ts: number;
    text: string;
    words: number;
    chars: number;
};

type Props = {
    settings: StudySettings;
    onSettingsChange: (s: StudySettings) => void;
    onStartTask: () => void;
    onEndTask: () => void;
    onReset?: () => void;           
    prompts: PromptMetric[];
    s1TotalWh?: number | null;

    // NEW: collapsible controls
    collapsible?: boolean;
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
};

const LS_SETTINGS_KEY = "ai4all.study.settings";

export default function StudyControls({
    settings,
    onSettingsChange,
    onStartTask,
    onEndTask,
    onReset,
    prompts,
    s1TotalWh,
    collapsible = false,
    collapsed = false,
    onToggleCollapsed,
}: Props) {
    const [pid, setPid] = useState(settings.participantId);
    const [group, setGroup] = useState<"control" | "intervention">(settings.group);
    const [session, setSession] = useState<1 | 2>(settings.session);

    useEffect(() => {
        const next = { ...settings, participantId: pid.trim(), group, session };
        onSettingsChange(next);
        localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(next));
    }, [pid, group, session]);

    const running = !!settings.taskStartedAt && !settings.taskEndedAt;
    const durMs = useMemo(() => {
        const s = settings.taskStartedAt ?? 0;
        const e = settings.taskEndedAt ?? Date.now();
        return s ? Math.max(0, e - s) : 0;
    }, [settings.taskStartedAt, settings.taskEndedAt]);

    const mins = Math.floor(durMs / 60000);
    const secs = Math.floor((durMs % 60000) / 1000);

    return (
        <div className={`panel study-controls${collapsed ? " is-collapsed" : ""}`}>
            <div
                className="panel-title"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
            >
                <span>Study Controls</span>
                {collapsible && (
                    <button
                        onClick={onToggleCollapsed}
                        aria-expanded={!collapsed}
                        aria-controls="study-controls-grid"
                    >
                        {collapsed ? "Show" : "Hide"}
                    </button>
                )}
            </div>

            {!collapsed && (
                <div id="study-controls-grid" className="study-grid">
                    <label>
                        Participant ID
                        <input value={pid} onChange={(e) => setPid(e.target.value)} placeholder="SIAT-0123" />
                    </label>

                    <label>
                        Session
                        <select
                            value={session}
                            onChange={(e) => setSession(Number(e.target.value) as 1 | 2)}
                        >
                            <option value={1}>1</option>
                            <option value={2}>2</option>
                        </select>
                    </label>

                    <label>
                        Group
                        <select value={group} onChange={(e) => setGroup(e.target.value as any)}>
                            <option value="control">Control</option>
                            <option value="intervention">Intervention</option>
                        </select>
                    </label>

                    <div className="timer">
                        <div>
                            Task timer:{" "}
                            <strong>
                                {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
                            </strong>
                        </div>
                        <div className="btn-row">
                            <button onClick={onStartTask} disabled={running}>
                                Start
                            </button>
                            <button onClick={onEndTask} disabled={!running}>
                                End
                            </button>
                            <button
                                type="button"
                                onClick={onReset}
                                disabled={running} 
                                title="Clear chat, metrics, and energy to start a new session"
                            >
                                Reset
                            </button>
                        </div>
                    </div>

                    <div className="metrics">
                        <div>
                            <strong>Prompts:</strong> {prompts.length}
                        </div>
                        {prompts.length > 0 && (
                            <>
                                <div>
                                    <strong>Avg words:</strong>{" "}
                                    {Math.round(prompts.reduce((a, b) => a + b.words, 0) / prompts.length)}
                                </div>
                                <div>
                                    <strong>Avg chars:</strong>{" "}
                                    {Math.round(prompts.reduce((a, b) => a + b.chars, 0) / prompts.length)}
                                </div>
                            </>
                        )}
                    </div>

                    {session === 2 && typeof s1TotalWh === "number" && (
                        <div className="session1-total">
                            <strong>Session-1 total energy:</strong> {s1TotalWh.toFixed(2)} Wh
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export function loadPersistedStudySettings(): Partial<StudySettings> | null {
    try {
        const raw = localStorage.getItem("ai4all.study.settings");
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}
