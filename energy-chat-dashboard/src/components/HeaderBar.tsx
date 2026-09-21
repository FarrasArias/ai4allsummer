import { useState } from "react";
import type { ModeTab } from "./Sidebar";
import type { ConductPhase } from "../api";
import LogPopover from "./LogPopover";

type Props = {
    tab: ModeTab;
    chatName: string;
    activeModel: string | null;
    promptCount: number;
    responseCount: number;
    fileCount: number;
    sessionTotalWh?: number | null;
    last2AvgWh?: number | null;

    onClearChat: () => void;
    onCopyResponse: () => void;
    onSaveResponse: () => void;
    copyStatus?: string | null;

    /* Conduct log */
    onAppendLog?: (args: { phase: ConductPhase; note: string; title?: string }) => Promise<boolean>;
    logTitleDefault?: string;
    showLogTitleField?: boolean;
    /** Slug of the log this session is already appending to, if any. */
    logSlug?: string | null;
};

/* ── Inline SVG icons (monochrome, currentColor) ── */
const svgProps = { xmlns: "http://www.w3.org/2000/svg", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function IconChat({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><path d="M2.5 2h11A1.5 1.5 0 0115 3.5v7A1.5 1.5 0 0113.5 12H5.5L2 15V3.5A1.5 1.5 0 013.5 2z" /></svg>;
}
function IconCode({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" /></svg>;
}
function IconWeb({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><circle cx="8" cy="8" r="6" /><path d="M2 8h12" /><path d="M8 2c-2 2.5-2.5 4.5-2.5 6s.5 3.5 2.5 6c2-2.5 2.5-4.5 2.5-6S10 4.5 8 2z" /></svg>;
}
function IconImage({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><circle cx="5.5" cy="5.5" r="1.2" /><path d="M14 10.5l-3.5-3L7 11 5 9l-3 3" /></svg>;
}
function IconSettings({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><circle cx="8" cy="8" r="2" /><path d="M6.8 1.5h2.4l.3 1.8a5.2 5.2 0 011.3.7l1.7-.6.8 1.4-1.4 1.2a5.2 5.2 0 010 1.5l1.4 1.2-.8 1.4-1.7-.6a5.2 5.2 0 01-1.3.7l-.3 1.8H6.8l-.3-1.8a5.2 5.2 0 01-1.3-.7l-1.7.6-.8-1.4 1.4-1.2a5.2 5.2 0 010-1.5L2.7 4.8l.8-1.4 1.7.6a5.2 5.2 0 011.3-.7l.3-1.8z" /></svg>;
}
function IconTest({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><path d="M6 2h4M7 2v4l-3.5 6A1 1 0 004.4 14h7.2a1 1 0 00.9-1.4L9 6V2" /></svg>;
}
function IconBolt({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 1L3.5 9H7.5L7 15l5.5-8H8.5L9 1z" /></svg>;
}
function IconDownload({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><path d="M8 2v9M4.5 8L8 11.5 11.5 8M3 13.5h10" /></svg>;
}
function IconFile({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><path d="M4 1.5h5.5L13 5v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-13a1 1 0 011-1z" /><path d="M9.5 1.5V5H13" /></svg>;
}
function IconCopy({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><rect x="5" y="5" width="9" height="9" rx="1" /><path d="M2 11V3a1 1 0 011-1h8" /></svg>;
}
function IconTrash({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><path d="M3 4h10M5.5 4V2.5h5V4M4.5 4v9.5h7V4" /></svg>;
}
function IconClip({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}><path d="M7.5 4v7a2.5 2.5 0 005 0V3.5a4 4 0 00-8 0V11a5.5 5.5 0 0011 0V4" /></svg>;
}
function IconConduct({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <circle cx="6" cy="4.7" r="2.7" />
            <path d="M10.7 14v-1.3a2.7 2.7 0 00-2.7-2.7H4a2.7 2.7 0 00-2.7 2.7v1.3" />
            <path d="M10.7 7.3l1.3 1.4 2.7-2.7" />
        </svg>
    );
}
function IconInfo({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 7.2v4" />
            <circle cx="8" cy="4.8" r="0.15" fill="currentColor" stroke="currentColor" strokeWidth="1.4" />
        </svg>
    );
}

function TabIcon({ tab }: { tab: ModeTab }) {
    switch (tab) {
        case "chat": return <IconChat />;
        case "vibe": return <IconCode />;
        case "web": return <IconWeb />;
        case "image":
        case "image_gen": return <IconImage />;
        case "conduct": return <IconConduct />;
        case "about": return <IconInfo />;
        case "settings": return <IconSettings />;
        case "testing": return <IconTest />;
        default: return <IconChat />;
    }
}

const TAB_LABELS: Record<string, string> = {
    chat: "Chat",
    vibe: "Code",
    web: "Web",
    image: "Image Analysis",
    image_gen: "Image Generation",
    conduct: "Conduct",
    about: "About Uness",
    settings: "Settings",
    testing: "Testing",
};

function computeGrade(last2AvgWh?: number | null): string {
    const v = typeof last2AvgWh === "number" ? last2AvgWh : 0;
    if (v <= 0.05) return "A";
    if (v <= 0.15) return "B";
    if (v <= 0.5) return "C";
    if (v <= 1.5) return "D";
    return "E";
}

export default function HeaderBar({
    tab,
    chatName,
    activeModel,
    promptCount,
    responseCount,
    fileCount,
    sessionTotalWh,
    last2AvgWh,
    onClearChat,
    onCopyResponse,
    onSaveResponse,
    copyStatus,
    onAppendLog,
    logTitleDefault,
    showLogTitleField,
    logSlug,
}: Props) {
    const [logOpen, setLogOpen] = useState(false);
    const totalWh = typeof sessionTotalWh === "number" ? sessionTotalWh : 0;
    const grade = computeGrade(last2AvgWh);
    const displayTitle = chatName || TAB_LABELS[tab] || "New conversation";

    return (
        <div className="header-bar">
            {/* ── Row 1: title + energy badge ── */}
            <div className="header-row">
                <div className="header-title-row">
                    <span className="header-type-icon"><TabIcon tab={tab} /></span>
                    <span className="header-title">{displayTitle}</span>
                </div>
                <div className="header-spacer" />
                <div className="header-energy-badge" title={`Session: ${totalWh.toFixed(3)} Wh`}>
                    <span className="energy-icon"><IconBolt size={12} /></span>
                    <span>{grade} · {totalWh > 0 ? `${totalWh.toFixed(2)} Wh` : "0 Wh"}</span>
                </div>
            </div>

            {/* ── Row 2: meta + model + actions ── */}
            <div className="header-row">
                <div className="header-meta">
                    <span><IconClip size={12} /> {fileCount} file{fileCount !== 1 ? "s" : ""}</span>
                    <span>·</span>
                    <span><IconFile size={12} /> {promptCount} prompt{promptCount !== 1 ? "s" : ""}</span>
                    <span>·</span>
                    <span><IconChat size={12} /> {responseCount} response{responseCount !== 1 ? "s" : ""}</span>
                </div>
                <div className="header-spacer" />

                {/* Model display */}
                {activeModel && (
                    <span
                        className="header-model-select"
                        title={`Active model: ${activeModel}`}
                    >
                        {activeModel}
                    </span>
                )}

                {/* Actions */}
                <div className="header-actions">
                    <button
                        className="header-action-btn"
                        onClick={onSaveResponse}
                        title="Save last response"
                    >
                        <IconDownload size={14} /> Save
                    </button>
                    <button
                        className="header-action-btn"
                        onClick={onCopyResponse}
                        title="Copy last response"
                    >
                        <IconCopy size={14} /> {copyStatus || "Copy"}
                    </button>
                    {onAppendLog && (
                        <div className="log-anchor">
                            <button
                                className="header-action-btn"
                                onClick={() => setLogOpen((v) => !v)}
                                title="Add this exchange to your conducting log"
                            >
                                → Log
                            </button>
                            <LogPopover
                                open={logOpen}
                                onClose={() => setLogOpen(false)}
                                showTitleField={!!showLogTitleField}
                                activeSlug={logSlug ?? null}
                                defaultTitle={logTitleDefault || ""}
                                onAppend={onAppendLog}
                            />
                        </div>
                    )}
                    <span className="header-divider" />
                    <button
                        className="header-action-btn danger"
                        onClick={onClearChat}
                        title="Clear conversation"
                    >
                        <IconTrash size={14} /> Clear
                    </button>
                </div>
            </div>
        </div>
    );
}
