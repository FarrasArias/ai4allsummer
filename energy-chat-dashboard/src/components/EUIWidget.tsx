import { useMemo } from "react";

export default function EUIWidget({
    show,
    latestPromptWh,
    sessionTotalWh,
    session1TotalWh,
    session,
    thresholds = { green: 0.5, amber: 2.0 },
    variant = "default",
}: {
    show: boolean;
    latestPromptWh?: number | null;
    sessionTotalWh?: number | null;
    session1TotalWh?: number | null;
    session: 1 | 2;
    thresholds?: { green: number; amber: number };
    /**
     * default: wide, grid-based (main content)
     * sidebar: single-column, compact, matches sidebar card colors
     */
    variant?: "default" | "sidebar";
}) {
    if (!show) return null;

    const level = useMemo<"green" | "amber" | "red">(() => {
        const v = latestPromptWh ?? 0;
        if (v <= thresholds.green) return "green";
        if (v <= thresholds.amber) return "amber";
        return "red";
    }, [latestPromptWh, thresholds]);

    return (
        <div className={`panel eui-widget ${level} ${variant}`}>
            <div className="panel-title">Energy Use</div>
            {/* Live (last prompt) */}
            <div className="eui-row">
                <span className="traffic-dot" aria-label={`EUI ${level}`}></span>
                <div className="eui-col">
                    <div className="eui-label">Live (last prompt)</div>
                    <div className="eui-value">
                        {latestPromptWh?.toFixed(2) ?? "0.00"} Wh
                    </div>
                </div>
            </div>

            {/* This session total (stacked under Live for sidebar “squish”) */}
            <div className="eui-row">
                <div className="eui-col">
                    <div className="eui-label">This session total</div>
                    <div className="eui-value">
                        {sessionTotalWh?.toFixed(2) ?? "0.00"} Wh
                    </div>
                </div>
            </div>

            {/* Optional Session 1 reference when in session 2 */}
            {session === 2 && typeof session1TotalWh === "number" && (
                <div className="eui-row">
                    <div className="eui-col">
                        <div className="eui-label">Session-1 total (reference)</div>
                        <div className="eui-value">{session1TotalWh.toFixed(2)} Wh</div>
                    </div>
                </div>
            )}

            <div className="eui-help">
                <span className="dot green"></span> low &nbsp;
                <span className="dot amber"></span> medium &nbsp;
                <span className="dot red"></span> high
            </div>
        </div>
    );
}
