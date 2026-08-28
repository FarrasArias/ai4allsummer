import { useState, useEffect, useRef } from "react";

/* ── Types ── */
export type ModeTab = "chat" | "vibe" | "web" | "image" | "image_gen" | "settings" | "testing";
export type ThemeChoice = "light" | "dark" | "system";

type ConvItem = {
    name: string;
    pinned: boolean;
};

type Grade = "A" | "B" | "C" | "D" | "E";

type ContextMenuState = {
    visible: boolean;
    x: number;
    y: number;
    chatName: string;
    isPinned: boolean;
};

type Props = {
    /* Mode / tab switching */
    activeTab: ModeTab;
    onTabChange: (tab: ModeTab) => void;

    /* Conversation list */
    chats: string[];
    pinnedChats: string[];
    activeChatName: string;
    onChatSelect: (name: string) => void;
    onNewChat: () => void;

    /* Conversation actions */
    onToggleStar?: (name: string) => void;
    onDeleteChat?: (name: string) => void;
    onRenameChat?: (name: string, newName: string) => void;

    /* Energy display */
    latestPromptWh?: number | null;
    sessionTotalWh?: number | null;
    promptCount?: number;
    last2AvgWh?: number | null;

    /* Theme */
    theme?: ThemeChoice;
    onThemeChange?: (theme: ThemeChoice) => void;

    /* Search */
    onSearch?: (query: string) => void;
};

/* ═══════════════════════════════════════════════
   SVG Icons — monochrome, inherit currentColor
   ═══════════════════════════════════════════════ */
const S = 16; // default icon size
const svgProps = { xmlns: "http://www.w3.org/2000/svg", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function IconChat({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <path d="M2.5 2h11A1.5 1.5 0 0115 3.5v7A1.5 1.5 0 0113.5 12H5.5L2 15V3.5A1.5 1.5 0 013.5 2z" />
        </svg>
    );
}

function IconCode({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" />
        </svg>
    );
}

function IconWeb({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <circle cx="8" cy="8" r="6" />
            <path d="M2 8h12" />
            <path d="M8 2c-2 2.5-2.5 4.5-2.5 6s.5 3.5 2.5 6c2-2.5 2.5-4.5 2.5-6S10 4.5 8 2z" />
        </svg>
    );
}

function IconImage({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
            <circle cx="5.5" cy="5.5" r="1.2" />
            <path d="M14 10.5l-3.5-3L7 11 5 9l-3 3" />
        </svg>
    );
}

function IconSearch({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <circle cx="6.5" cy="6.5" r="4" />
            <path d="M10 10l4 4" />
        </svg>
    );
}

function IconCalendar({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <rect x="2" y="3" width="12" height="11" rx="1.5" />
            <path d="M2 7h12M5 1v3M11 1v3" />
        </svg>
    );
}

function IconLayers({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <path d="M8 2L1.5 6 8 10l6.5-4L8 2z" />
            <path d="M1.5 9L8 13l6.5-4" />
        </svg>
    );
}

function IconSettings({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <circle cx="8" cy="8" r="2" />
            <path d="M6.8 1.5h2.4l.3 1.8a5.2 5.2 0 011.3.7l1.7-.6.8 1.4-1.4 1.2a5.2 5.2 0 010 1.5l1.4 1.2-.8 1.4-1.7-.6a5.2 5.2 0 01-1.3.7l-.3 1.8H6.8l-.3-1.8a5.2 5.2 0 01-1.3-.7l-1.7.6-.8-1.4 1.4-1.2a5.2 5.2 0 010-1.5L2.7 4.8l.8-1.4 1.7.6a5.2 5.2 0 011.3-.7l.3-1.8z" />
        </svg>
    );
}

function IconPencil({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5L11 2.5z" />
        </svg>
    );
}

function IconTrash({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <path d="M3 4h10M5.5 4V2.5h5V4M4.5 4v9.5h7V4" />
        </svg>
    );
}

function IconStar({ size = S, filled = false }: { size?: number; filled?: boolean }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps} fill={filled ? "currentColor" : "none"}>
            <path d="M8 1.5l2 4.5 5 .5-3.8 3.3L12.4 15 8 12.2 3.6 15l1.2-5.2L1 6.5l5-.5 2-4.5z" />
        </svg>
    );
}

function IconSun({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M12.9 3.1l-1.4 1.4M4.5 11.5l-1.4 1.4" />
        </svg>
    );
}

function IconMoon({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps}>
            <path d="M13.5 8.5a5.5 5.5 0 01-6-6 5.5 5.5 0 106 6z" />
        </svg>
    );
}

function IconBolt({ size = S }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" {...svgProps} fill="currentColor" stroke="none">
            <path d="M9 1L3.5 9H7.5L7 15l5.5-8H8.5L9 1z" />
        </svg>
    );
}

/** Returns the right icon component for a mode key */
function ModeIcon({ mode, size = S }: { mode: string; size?: number }) {
    switch (mode) {
        case "chat": return <IconChat size={size} />;
        case "vibe": return <IconCode size={size} />;
        case "web": return <IconWeb size={size} />;
        case "image":
        case "image_gen": return <IconImage size={size} />;
        default: return <IconChat size={size} />;
    }
}

/* ── Helpers ── */
const MODE_LABELS: Record<string, string> = {
    chat: "Chat",
    vibe: "Code",
    web: "Web",
    image: "Image",
};

function computeGrade(last2AvgWh?: number | null, promptCount?: number): Grade {
    if (!promptCount || promptCount < 5) return "A";
    const v = typeof last2AvgWh === "number" ? last2AvgWh : 0;
    if (v <= 0.05) return "A";
    if (v <= 0.15) return "B";
    if (v <= 0.5) return "C";
    if (v <= 1.5) return "D";
    return "E";
}

const FILTER_ALL = "all";
const FILTER_STARRED = "starred";
const FILTER_KEYS = [
    { key: FILTER_ALL, label: "All" },
    { key: "chat", mode: "chat" },
    { key: "vibe", mode: "vibe" },
    { key: "web", mode: "web" },
    { key: "image", mode: "image" },
];

export default function Sidebar({
    activeTab,
    onTabChange,
    chats,
    pinnedChats,
    activeChatName,
    onChatSelect,
    onNewChat,
    onToggleStar,
    onDeleteChat,
    onRenameChat,
    latestPromptWh,
    sessionTotalWh,
    promptCount,
    last2AvgWh,
    theme = "system",
    onThemeChange,
    onSearch,
}: Props) {
    const [filter, setFilter] = useState(FILTER_ALL);
    const [searchText, setSearchText] = useState("");
    const [energyOpen, setEnergyOpen] = useState(false);
    const [ctxMenu, setCtxMenu] = useState<ContextMenuState>({
        visible: false, x: 0, y: 0, chatName: "", isPinned: false,
    });
    const ctxMenuRef = useRef<HTMLDivElement>(null);

    // Close context menu on outside click
    useEffect(() => {
        if (!ctxMenu.visible) return;
        function handleClick(e: MouseEvent) {
            if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
                setCtxMenu((s) => ({ ...s, visible: false }));
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [ctxMenu.visible]);

    function handleConvContextMenu(e: React.MouseEvent, name: string, isPinned: boolean) {
        e.preventDefault();
        setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, chatName: name, isPinned });
    }

    const totalWh = typeof sessionTotalWh === "number" ? sessionTotalWh : 0;
    const grade = computeGrade(last2AvgWh, promptCount);

    /* ── Build conversation list ── */
    const filteredChats: ConvItem[] = chats
        .map((name) => ({ name, pinned: pinnedChats.includes(name) }))
        .filter((c) => {
            if (filter === FILTER_STARRED) return c.pinned;
            return true;
        })
        .filter((c) => {
            if (!searchText.trim()) return true;
            return c.name.toLowerCase().includes(searchText.toLowerCase());
        });

    const sortedChats = [...filteredChats].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.name.localeCompare(b.name);
    });

    const starred = sortedChats.filter((c) => c.pinned);
    const rest = sortedChats.filter((c) => !c.pinned);

    function handleSearchKeyDown(e: React.KeyboardEvent) {
        if (e.key === "Enter" && searchText.trim() && onSearch) {
            onSearch(searchText.trim());
        }
    }

    return (
        <aside className="sidebar">
            <div className="sidebar-inner">
                {/* ── Brand ── */}
                <div className="sidebar-brand">
                    <div className="sidebar-brand-left">
                        <div className="sidebar-logo">U</div>
                        <span className="sidebar-brand-name">Uness</span>
                    </div>
                    <button
                        className="sidebar-brand-theme"
                        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                        onClick={() => {
                            const next = theme === "dark" ? "light" : "dark";
                            onThemeChange?.(next);
                        }}
                    >
                        {theme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
                    </button>
                </div>

                {/* ── New Chat ── */}
                <button className="sidebar-new-chat" onClick={onNewChat}>
                    + New chat
                </button>

                {/* ── Mode Nav ── */}
                <nav className="sidebar-nav">
                    {(["chat", "vibe", "web", "image"] as const).map((mode) => (
                        <button
                            key={mode}
                            className={`sidebar-nav-item ${activeTab === mode || (mode === "image" && activeTab === "image_gen") ? "active" : ""}`}
                            onClick={() => onTabChange(mode)}
                        >
                            <span className="sidebar-nav-icon"><ModeIcon mode={mode} /></span>
                            <span>{MODE_LABELS[mode]}</span>
                            {mode === "vibe" && (
                                <span className="sidebar-nav-badge">Lite</span>
                            )}
                        </button>
                    ))}
                </nav>

                {/* ── History Header ── */}
                <div className="sidebar-history-header">
                    <span className="sidebar-history-label">History</span>
                    <div className="sidebar-history-actions">
                        <button title="Calendar view"><IconCalendar size={14} /></button>
                        <button title="Manage conversations"><IconLayers size={14} /></button>
                    </div>
                </div>

                {/* ── Search ── */}
                <div className="sidebar-search">
                    <span className="sidebar-search-icon"><IconSearch size={14} /></span>
                    <input
                        type="text"
                        placeholder="Search conversations..."
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                    />
                </div>

                {/* ── Filter Pills ── */}
                <div className="sidebar-filters">
                    {FILTER_KEYS.map((f) => (
                        <button
                            key={f.key}
                            className={`sidebar-filter-pill ${filter === f.key ? "active" : ""}`}
                            onClick={() => setFilter(f.key)}
                            title={f.key === FILTER_ALL ? "All" : MODE_LABELS[f.key] || f.key}
                        >
                            {f.label ? f.label : <ModeIcon mode={f.mode!} size={13} />}
                        </button>
                    ))}
                </div>

                {/* ── Conversation List ── */}
                <div className="sidebar-conv-list">
                    {starred.length > 0 && (
                        <>
                            <div className="sidebar-section-header">
                                <span>Starred</span>
                                <span className="sidebar-section-count">{starred.length}</span>
                            </div>
                            {starred.map((c) => (
                                <button
                                    key={c.name}
                                    className={`sidebar-conv-item ${c.name === activeChatName ? "active" : ""}`}
                                    onClick={() => onChatSelect(c.name)}
                                    onContextMenu={(e) => handleConvContextMenu(e, c.name, true)}
                                >
                                    <span className="sidebar-conv-icon"><IconChat size={14} /></span>
                                    <span className="sidebar-conv-title">{c.name}</span>
                                    <span className="sidebar-conv-star"><IconStar size={12} filled /></span>
                                    <span className="sidebar-conv-actions">
                                        <button title="Edit" onClick={(e) => { e.stopPropagation(); }}><IconPencil size={12} /></button>
                                    </span>
                                </button>
                            ))}
                        </>
                    )}

                    {rest.length > 0 && (
                        <>
                            {starred.length > 0 && (
                                <div className="sidebar-section-header">
                                    <span>Recent</span>
                                    <span className="sidebar-section-count">{rest.length}</span>
                                </div>
                            )}
                            {rest.map((c) => (
                                <button
                                    key={c.name}
                                    className={`sidebar-conv-item ${c.name === activeChatName ? "active" : ""}`}
                                    onClick={() => onChatSelect(c.name)}
                                    onContextMenu={(e) => handleConvContextMenu(e, c.name, false)}
                                >
                                    <span className="sidebar-conv-icon"><IconChat size={14} /></span>
                                    <span className="sidebar-conv-title">{c.name}</span>
                                </button>
                            ))}
                        </>
                    )}

                    {sortedChats.length === 0 && (
                        <div style={{ padding: "12px 8px", fontSize: 13, color: "var(--color-text-dim)" }}>
                            {searchText ? "No matching conversations" : "No saved conversations yet"}
                        </div>
                    )}
                </div>

                {/* ── Settings Link ── */}
                <button
                    className="sidebar-settings"
                    onClick={() => onTabChange("settings")}
                >
                    <span className="sidebar-nav-icon"><IconSettings size={15} /></span>
                    <span>Settings</span>
                </button>

                {/* ── Energy Panel ── */}
                <div className="sidebar-energy">
                    <button
                        className="sidebar-energy-toggle"
                        onClick={() => setEnergyOpen(!energyOpen)}
                    >
                        <span className="sidebar-energy-icon"><IconBolt size={14} /></span>
                        <span className="sidebar-energy-grade">{grade}</span>
                        <span className="sidebar-energy-wh">
                            {totalWh > 0 ? `${totalWh.toFixed(2)} Wh` : "0 Wh"}
                        </span>
                        <span className="sidebar-energy-label">Session energy</span>
                        <span className={`sidebar-energy-chevron ${energyOpen ? "open" : ""}`}>
                            ▾
                        </span>
                    </button>

                    {energyOpen && (
                        <div className="sidebar-energy-details">
                            <div className="sidebar-energy-big">
                                {totalWh > 0 ? `${totalWh.toFixed(2)} Wh` : "0 Wh"}
                            </div>
                            <div className="sidebar-energy-equiv">
                                ≈ {totalWh > 0 ? Math.round(totalWh / 0.09) : 0} chat replies
                            </div>

                            {/* Grade bar */}
                            <div className="sidebar-energy-grade-bar">
                                <div
                                    className="sidebar-energy-grade-bar-fill"
                                    data-grade={grade}
                                />
                            </div>
                            <div className="sidebar-energy-grade-label">
                                <span>Energy grade: {grade}</span>
                                <span>{grade === "A" ? "Excellent" : grade === "B" ? "Good" : grade === "C" ? "Moderate" : grade === "D" ? "High" : "Very high"}</span>
                            </div>

                            <div className="sidebar-energy-breakdown" style={{ marginTop: 8 }}>
                                <div className="sidebar-energy-row">
                                    <span>Latest prompt</span>
                                    <span className="sidebar-energy-row-value">
                                        {typeof latestPromptWh === "number" && latestPromptWh > 0
                                            ? `${latestPromptWh.toFixed(3)} Wh`
                                            : "0 Wh"}
                                    </span>
                                </div>
                                <div className="sidebar-energy-row">
                                    <span>Session total</span>
                                    <span className="sidebar-energy-row-value">
                                        {totalWh > 0 ? `${totalWh.toFixed(3)} Wh` : "0 Wh"}
                                    </span>
                                </div>
                                {typeof promptCount === "number" && promptCount > 0 && (
                                    <div className="sidebar-energy-row">
                                        <span>Prompts this session</span>
                                        <span className="sidebar-energy-row-value">{promptCount}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Context Menu ── */}
            {ctxMenu.visible && (
                <div
                    ref={ctxMenuRef}
                    className="context-menu"
                    style={{ left: ctxMenu.x, top: ctxMenu.y }}
                >
                    <button
                        className="context-menu-item"
                        onClick={() => {
                            onToggleStar?.(ctxMenu.chatName);
                            setCtxMenu((s) => ({ ...s, visible: false }));
                        }}
                    >
                        <span><IconStar size={14} filled={!ctxMenu.isPinned} /></span>
                        <span>{ctxMenu.isPinned ? "Unstar" : "Star"}</span>
                    </button>
                    <button
                        className="context-menu-item"
                        onClick={() => {
                            const newName = prompt("Rename conversation:", ctxMenu.chatName);
                            if (newName && newName.trim() && newName !== ctxMenu.chatName) {
                                onRenameChat?.(ctxMenu.chatName, newName.trim());
                            }
                            setCtxMenu((s) => ({ ...s, visible: false }));
                        }}
                    >
                        <span><IconPencil size={14} /></span>
                        <span>Rename</span>
                    </button>
                    <button
                        className="context-menu-item danger"
                        onClick={() => {
                            onDeleteChat?.(ctxMenu.chatName);
                            setCtxMenu((s) => ({ ...s, visible: false }));
                        }}
                    >
                        <span><IconTrash size={14} /></span>
                        <span>Delete</span>
                    </button>
                </div>
            )}
        </aside>
    );
}
