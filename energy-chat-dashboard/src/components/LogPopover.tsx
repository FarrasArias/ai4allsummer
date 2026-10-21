import { useEffect, useRef, useState } from "react";
import { getConductLogs, slugifyConductTitle } from "../api";
import type { ConductPhase, ConductLogSummary } from "../api";

const PHASES: { key: ConductPhase; label: string; hint: string }[] = [
    { key: "frame", label: "Frame", hint: "Goal, audience, constraints, real documents" },
    { key: "explore", label: "Explore", hint: "Options not answers; verify before building" },
    { key: "refine", label: "Refine", hint: "Draft, then attack the draft" },
    { key: "commit", label: "Commit", hint: "Your choice, your rationale, no AI" },
];

function formatUpdated(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The exchange being logged: the last reply and the prompt that led to it. */
export type LogCapture = { prompt: string; response: string };

export type LogAppendArgs = {
    phase: ConductPhase;
    note: string;
    title?: string;
    prompt: string;
    response: string;
    promptEdited: boolean;
    responseEdited: boolean;
};

type Props = {
    open: boolean;
    onClose: () => void;
    showTitleField: boolean;
    /** The log this session is appending to, once one exists. */
    activeSlug?: string | null;
    defaultTitle: string;
    captured: LogCapture;
    onAppend: (args: LogAppendArgs) => Promise<boolean>;
};

const isEdited = (value: string, original: string) => value.trim() !== original.trim();

export default function LogPopover({ open, onClose, showTitleField, activeSlug, defaultTitle, captured, onAppend }: Props) {
    const [phase, setPhase] = useState<ConductPhase | null>(null);
    const [note, setNote] = useState("");
    const [prompt, setPrompt] = useState(captured.prompt);
    const [response, setResponse] = useState(captured.response);
    const [title, setTitle] = useState(defaultTitle);
    const [submitting, setSubmitting] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [existingLogs, setExistingLogs] = useState<ConductLogSummary[]>([]);
    const ref = useRef<HTMLDivElement>(null);

    // The title is only asked for on a session's first append, and that is
    // the only moment a new slug can collide with a log already on disk.
    const collision = showTitleField
        ? existingLogs.find((l) => l.slug === slugifyConductTitle(title)) ?? null
        : null;

    // On later appends the title is already settled, so show what's in that
    // log instead — otherwise the file you're writing to is never seen.
    const activeLog = !showTitleField && activeSlug
        ? existingLogs.find((l) => l.slug === activeSlug) ?? null
        : null;

    // Reset the compose state each time the popover opens; deliberately not
    // re-running when defaultTitle changes so an in-progress edit isn't
    // clobbered while the popover stays open.
    useEffect(() => {
        if (open) {
            setPhase(null);
            setNote("");
            setPrompt(captured.prompt);
            setResponse(captured.response);
            setTitle(defaultTitle);
            setStatus(null);
            setSubmitting(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        getConductLogs()
            .then((logs) => { if (!cancelled) setExistingLogs(logs); })
            .catch(() => { if (!cancelled) setExistingLogs([]); });
        return () => { cancelled = true; };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        }
        function handleKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open, onClose]);

    if (!open) return null;

    async function handleAppend() {
        if (!phase || submitting) return;
        setSubmitting(true);
        const ok = await onAppend({
            phase,
            note,
            title: showTitleField ? title.trim() || undefined : undefined,
            prompt,
            response,
            promptEdited: isEdited(prompt, captured.prompt),
            responseEdited: isEdited(response, captured.response),
        });
        setSubmitting(false);
        if (ok) {
            setStatus("Added");
            setTimeout(onClose, 700);
        } else {
            setStatus("Failed");
        }
    }

    return (
        <div className="log-popover" ref={ref}>
            {showTitleField && (
                <div className="log-popover-field">
                    <label>Title</label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Log title"
                    />
                    {collision && (
                        <p className="log-popover-collision">
                            <strong>{collision.slug}</strong> already exists — {collision.entry_count}{" "}
                            {collision.entry_count === 1 ? "entry" : "entries"}, updated{" "}
                            {formatUpdated(collision.updated_at)}. Appending adds to that log; edit
                            the title to start a separate one.
                        </p>
                    )}
                </div>
            )}

            {activeLog && (
                <p className="log-popover-shape">
                    Adding to <strong>{activeLog.slug}</strong> — {activeLog.entry_count}{" "}
                    {activeLog.entry_count === 1 ? "entry" : "entries"}
                    {PHASES.map((p) => `, ${p.label} ${activeLog.phase_counts?.[p.key] ?? 0}`).join("")}
                </p>
            )}

            <div className="log-popover-phases">
                {PHASES.map((p) => (
                    <button
                        key={p.key}
                        type="button"
                        className={`log-popover-phase ${phase === p.key ? "active" : ""}`}
                        onClick={() => setPhase(p.key)}
                    >
                        <span className="log-popover-phase-label">{p.label}</span>
                        <span className="log-popover-phase-hint">{p.hint}</span>
                    </button>
                ))}
            </div>

            {/* The captured exchange, editable before it's written; the log
                marks a changed prompt or response as "(edited)" */}
            {(captured.prompt || captured.response) && (
                <>
                    <TurnField label="Prompt" value={prompt} original={captured.prompt} onChange={setPrompt} rows={2} />
                    <TurnField label="Response" value={response} original={captured.response} onChange={setResponse} rows={5} />
                </>
            )}

            <div className="log-popover-field">
                <label>Note (optional)</label>
                <textarea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What did you decide, and why?"
                />
            </div>

            <div className="log-popover-actions">
                <button
                    type="button"
                    className="log-popover-append"
                    onClick={handleAppend}
                    disabled={!phase || submitting}
                >
                    {status || (submitting ? "Adding…" : collision ? "Append to existing log" : "Append")}
                </button>
            </div>
        </div>
    );
}

function TurnField({ label, value, original, onChange, rows }: {
    label: string;
    value: string;
    original: string;
    onChange: (v: string) => void;
    rows: number;
}) {
    const [copyStatus, setCopyStatus] = useState<string | null>(null);
    const edited = isEdited(value, original);

    function handleCopy() {
        navigator.clipboard.writeText(value)
            .then(() => setCopyStatus("Copied"))
            .catch(() => setCopyStatus("Failed"))
            .finally(() => setTimeout(() => setCopyStatus(null), 1500));
    }

    return (
        <div className="log-popover-field">
            <div className="log-popover-field-head">
                <label>
                    {label}
                    {edited && <span className="log-popover-edited"> · edited</span>}
                </label>
                <span className="log-popover-field-tools">
                    {edited && (
                        <button type="button" onClick={() => onChange(original)}>Restore original</button>
                    )}
                    <button type="button" onClick={handleCopy} disabled={!value.trim()}>
                        {copyStatus || "Copy"}
                    </button>
                </span>
            </div>
            <textarea rows={rows} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
        </div>
    );
}
