import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    getConductContent,
    getConductLogs,
    openConductPath,
    indexConductLog,
    unindexConductLog,
    getRagDocuments,
    getConductLogContent,
    type ConductLogSummary,
    type ConductPhase,
} from "../api";

type Snippet = { label: string; note: string; code: string };

const PHASE_LABELS: { key: ConductPhase; label: string }[] = [
    { key: "frame", label: "Frame" },
    { key: "explore", label: "Explore" },
    { key: "refine", label: "Refine" },
    { key: "commit", label: "Commit" },
];

function formatUpdatedAt(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const mdComponents = {
    strong: ({ node, ...props }: any) => <strong className="markdown-bold" {...props} />,
    em: ({ node, ...props }: any) => <em className="markdown-italic" {...props} />,
    h1: ({ node, ...props }: any) => <h1 className="markdown-h1" {...props} />,
    h2: ({ node, ...props }: any) => <h2 className="markdown-h2" {...props} />,
    ul: ({ node, ...props }: any) => <ul className="markdown-ul" {...props} />,
    ol: ({ node, ...props }: any) => <ol className="markdown-ol" {...props} />,
    li: ({ node, ...props }: any) => <li className="markdown-li" {...props} />,
    code: ({ node, ...props }: any) => (
        <pre className="markdown-code-block">
            <code {...props} />
        </pre>
    ),
    a: ({ node, ...props }: any) => <a target="_blank" rel="noreferrer" {...props} />,
};

// ## heading starts a snippet — the heading text is the button label. The
// first fenced code block under it is what copies; prose before that code
// block is a note. A heading with no code block is skipped.
function parseSnippets(md: string): Snippet[] {
    const lines = md.split("\n");
    const snippets: Snippet[] = [];
    let i = 0;
    while (i < lines.length) {
        const heading = lines[i].match(/^##\s+(.+?)\s*$/);
        if (!heading) { i++; continue; }
        const label = heading[1].trim();
        i++;

        const noteLines: string[] = [];
        let code: string | null = null;
        while (i < lines.length && !/^##\s+/.test(lines[i])) {
            if (lines[i].trim().startsWith("```")) {
                i++;
                const codeLines: string[] = [];
                while (i < lines.length && !lines[i].trim().startsWith("```")) {
                    codeLines.push(lines[i]);
                    i++;
                }
                code = codeLines.join("\n").trim();
                i++; // consume closing fence
                break;
            }
            noteLines.push(lines[i]);
            i++;
        }
        // Anything after the code block before the next heading isn't part
        // of the spec (note-then-code is the only shape) — skip it.
        while (i < lines.length && !/^##\s+/.test(lines[i])) i++;

        if (code) {
            snippets.push({ label, note: noteLines.join("\n").trim(), code });
        }
    }
    return snippets;
}

function LogCard({ log, onOpen, onReveal, onIndex, onUnindex, busy, indexed, status,
                  expanded, onToggleExpand, content }: {
    log: ConductLogSummary;
    onOpen: () => void;
    onReveal: () => void;
    onIndex: () => void;
    onUnindex: () => void;
    busy: "index" | "unindex" | null;
    /** Indexed for the *current* chat model — indexing is per mode+model. */
    indexed: boolean;
    status: { text: string; tone: "ok" | "error" } | null;
    expanded: boolean;
    onToggleExpand: () => void;
    content: string | null;
}) {
    const filename = log.path.split("/").pop() || log.path;
    return (
        <div className="conduct-log-card">
            <div className="conduct-log-filename">{filename}</div>
            <div className="conduct-log-path">{log.path}</div>
            <div className="conduct-log-meta">
                {log.entry_count} {log.entry_count === 1 ? "entry" : "entries"} · updated{" "}
                {formatUpdatedAt(log.updated_at)}
                {PHASE_LABELS.map((p) => ` · ${p.label} ${log.phase_counts[p.key] ?? 0}`).join("")}
            </div>
            <div className="conduct-log-actions">
                <button
                    type="button"
                    className="conduct-log-action"
                    onClick={onToggleExpand}
                    aria-expanded={expanded}
                >
                    {expanded ? "Hide" : "View"}
                </button>
                <button type="button" className="conduct-log-action" onClick={onOpen}>
                    Open in editor
                </button>
                <button type="button" className="conduct-log-action" onClick={onReveal}>
                    Reveal in folder
                </button>
                <button
                    type="button"
                    className="conduct-log-action"
                    onClick={onIndex}
                    disabled={busy !== null}
                    title="Embed this log so later questions can retrieve it as a source document"
                >
                    {busy === "index" ? "Adding…" : "Add to knowledge layer"}
                </button>
                <button
                    type="button"
                    className="conduct-log-action"
                    onClick={onUnindex}
                    disabled={busy !== null || !indexed}
                    title={
                        indexed
                            ? "Stop this log being retrieved as a source document"
                            : "Not currently in the knowledge layer for this model"
                    }
                >
                    {busy === "unindex" ? "Removing…" : "Remove from knowledge layer"}
                </button>
                {status && <span className={`conduct-log-status ${status.tone}`}>{status.text}</span>}
            </div>

            {expanded && (
                <div className="conduct-log-reader">
                    <p className="conduct-log-reader-note">
                        Read-only — use <strong>Open in editor</strong> to change it.
                    </p>
                    {content === null ? (
                        <p className="conduct-empty-note">Loading…</p>
                    ) : (
                        <div className="conduct-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function ConductPane({ chatModel }: { chatModel?: string | null }) {
    const [reference, setReference] = useState("");
    const [snippetsMd, setSnippetsMd] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

    const [logs, setLogs] = useState<ConductLogSummary[]>([]);
    const [logsLoaded, setLogsLoaded] = useState(false);
    const [logStatus, setLogStatus] = useState<{ slug: string; text: string; tone: "ok" | "error" } | null>(null);
    const [busy, setBusy] = useState<{ slug: string; kind: "index" | "unindex" } | null>(null);
    /** Filenames currently in the RAG cache for chat + chatModel. */
    const [indexedDocs, setIndexedDocs] = useState<string[]>([]);
    const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
    /** Cached per slug; null while a fetch is in flight. */
    const [logContent, setLogContent] = useState<Record<string, string | null>>({});

    useEffect(() => {
        let cancelled = false;
        getConductContent()
            .then((c) => {
                if (cancelled) return;
                setReference(c.reference || "");
                setSnippetsMd(c.snippets || "");
                setLoaded(true);
            })
            .catch(() => {
                if (!cancelled) { setLoaded(true); setLoadError(true); }
            });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        getConductLogs()
            .then((l) => { if (!cancelled) { setLogs(l); setLogsLoaded(true); } })
            .catch(() => { if (!cancelled) setLogsLoaded(true); });
        return () => { cancelled = true; };
    }, []);

    // Which logs are already in the knowledge layer. Scoped to the active
    // chat model, because the RAG cache is per mode+model.
    const refreshIndexed = useCallback(async () => {
        if (!chatModel) { setIndexedDocs([]); return; }
        try { setIndexedDocs(await getRagDocuments("chat", chatModel)); }
        catch { setIndexedDocs([]); }
    }, [chatModel]);

    useEffect(() => { void refreshIndexed(); }, [refreshIndexed]);

    // One log open at a time — re-read on every open so an edit made in the
    // user's editor shows up without a reload.
    function handleToggleExpand(log: ConductLogSummary) {
        if (expandedSlug === log.slug) { setExpandedSlug(null); return; }
        setExpandedSlug(log.slug);
        setLogContent((m) => ({ ...m, [log.slug]: null }));
        getConductLogContent(log.slug)
            .then((r) => setLogContent((m) => ({
                ...m,
                [log.slug]: r.content ?? "*Couldn't read this log.*",
            })))
            .catch(() => setLogContent((m) => ({
                ...m,
                [log.slug]: "*Couldn't read this log.*",
            })));
    }

    const snippets = parseSnippets(snippetsMd);

    function handleCopy(snippet: Snippet) {
        navigator.clipboard.writeText(snippet.code).then(() => {
            setCopiedLabel(snippet.label);
            setTimeout(() => setCopiedLabel((l) => (l === snippet.label ? null : l)), 2000);
        }).catch(() => {});
    }

    async function handleOpenLog(log: ConductLogSummary, reveal: boolean) {
        const res = await openConductPath(log.path, reveal).catch(() => ({ ok: false }));
        if (!res.ok) {
            setLogStatus({ slug: log.slug, text: reveal ? "Couldn't reveal" : "Couldn't open", tone: "error" });
            setTimeout(() => setLogStatus((s) => (s?.slug === log.slug ? null : s)), 2500);
        }
    }

    function flashStatus(slug: string, text: string, tone: "ok" | "error" = "ok") {
        setLogStatus({ slug, text, tone });
        setTimeout(() => setLogStatus((s) => (s?.slug === slug ? null : s)), 3000);
    }

    async function handleIndexLog(log: ConductLogSummary) {
        setBusy({ slug: log.slug, kind: "index" });
        const res = await indexConductLog(log.slug, chatModel ?? undefined)
            .catch(() => ({ error: "failed" as const }));
        setBusy(null);

        let text: string;
        let tone: "ok" | "error" = "ok";
        if ("error" in res && res.error) { text = "Couldn't add"; tone = "error"; }
        else if (res.skipped) text = "Already in context";
        else if (typeof res.chunks === "number") text = `Added · ${res.chunks} sections`;
        else text = "Added";

        flashStatus(log.slug, text, tone);
        void refreshIndexed();
    }

    async function handleUnindexLog(log: ConductLogSummary) {
        setBusy({ slug: log.slug, kind: "unindex" });
        const res = await unindexConductLog(log.slug, chatModel ?? undefined)
            .catch(() => ({ error: "failed" as const }));
        setBusy(null);

        const failed = "error" in res && res.error;
        flashStatus(log.slug, failed ? "Couldn't remove" : "Removed", failed ? "error" : "ok");
        void refreshIndexed();
    }

    return (
        <div className="conduct-pane">
            <div className="conduct-column">
                <section className="card conduct-card">
                    <h2 className="conduct-card-title">Reference</h2>
                    {!loaded ? null : loadError || !reference.trim() ? (
                        <p className="conduct-empty-note">
                            Expected at <code>conduct_logs/reference.md</code>.
                        </p>
                    ) : (
                        <div className="conduct-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                                {reference}
                            </ReactMarkdown>
                        </div>
                    )}
                </section>

                <section className="card conduct-card">
                    <h2 className="conduct-card-title">Snippets</h2>
                    {!loaded ? null : loadError || !snippetsMd.trim() ? (
                        <p className="conduct-empty-note">
                            Expected at <code>conduct_logs/snippets.md</code>.
                        </p>
                    ) : snippets.length === 0 ? (
                        <p className="conduct-empty-note">No snippets found.</p>
                    ) : (
                        <div className="conduct-snippet-list">
                            {snippets.map((s) => (
                                <div className="conduct-snippet" key={s.label}>
                                    <div className="conduct-snippet-header">
                                        <span className="conduct-snippet-label">{s.label}</span>
                                        <button
                                            type="button"
                                            className="conduct-snippet-copy"
                                            onClick={() => handleCopy(s)}
                                        >
                                            {copiedLabel === s.label ? "Copied!" : "Copy"}
                                        </button>
                                    </div>
                                    {s.note && (
                                        <div className="conduct-snippet-note">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                                                {s.note}
                                            </ReactMarkdown>
                                        </div>
                                    )}
                                    <pre className="conduct-snippet-code">{s.code}</pre>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>

            <div className="conduct-column">
                <section className="card conduct-card">
                    <h2 className="conduct-card-title">Your logs</h2>
                    {!logsLoaded ? null : logs.length === 0 ? (
                        <div className="conduct-empty-note">
                            <p>New logs are created in <code>conduct_logs/</code>.</p>
                            <p>→ Log in a chat starts one.</p>
                        </div>
                    ) : (
                        <div className="conduct-log-list">
                            {logs.map((log) => (
                                <LogCard
                                    key={log.slug}
                                    log={log}
                                    onOpen={() => handleOpenLog(log, false)}
                                    onReveal={() => handleOpenLog(log, true)}
                                    onIndex={() => handleIndexLog(log)}
                                    onUnindex={() => handleUnindexLog(log)}
                                    busy={busy?.slug === log.slug ? busy.kind : null}
                                    indexed={indexedDocs.includes(`${log.slug}.md`)}
                                    expanded={expandedSlug === log.slug}
                                    onToggleExpand={() => handleToggleExpand(log)}
                                    content={expandedSlug === log.slug ? logContent[log.slug] ?? null : null}
                                    status={logStatus?.slug === log.slug ? { text: logStatus.text, tone: logStatus.tone } : null}
                                />
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
