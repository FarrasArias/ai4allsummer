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

type Props = {
    open: boolean;
    onClose: () => void;
    showTitleField: boolean;
    defaultTitle: string;
    onAppend: (args: { phase: ConductPhase; note: string; title?: string }) => Promise<boolean>;
};

export default function LogPopover({ open, onClose, showTitleField, defaultTitle, onAppend }: Props) {
    const [phase, setPhase] = useState<ConductPhase | null>(null);
    const [note, setNote] = useState("");
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

    // Reset the compose state each time the popover opens; deliberately not
    // re-running when defaultTitle changes so an in-progress edit isn't
    // clobbered while the popover stays open.
    useEffect(() => {
        if (open) {
            setPhase(null);
            setNote("");
            setTitle(defaultTitle);
            setStatus(null);
            setSubmitting(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open || !showTitleField) return;
        let cancelled = false;
        getConductLogs()
            .then((logs) => { if (!cancelled) setExistingLogs(logs); })
            .catch(() => { if (!cancelled) setExistingLogs([]); });
        return () => { cancelled = true; };
    }, [open, showTitleField]);

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
