import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ENERGY_CSV_URL, getAdminActivity, getEnergyReport, type AdminActivity, type EnergyReport } from "../api";
import { formatEnergy } from "../format";
import { errorText } from "../session";

/* Admin Energy page: every metered prompt on this Mac, by person, mode,
   model and day, for the study. Data: GET /api/admin/energy. */

const PERIODS = [
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: 90, label: "90 days" },
    { days: 0, label: "All time" },
];

const MODE_LABELS: Record<string, string> = {
    chat: "Chat",
    web: "Web",
    code: "Code (text assistant)",
    agent: "Code / Agent",
    image_analysis: "Image analysis",
    image_generation: "Image generation",
    unknown: "Not recorded",
};

function parseDay(day: string): Date {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d);
}

const shortDay = (day: string) => parseDay(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function shortStamp(stamp: string | null): string {
    if (!stamp) return "—";
    const [day, time] = stamp.split(" ");
    return `${shortDay(day)}, ${time.slice(0, 5)}`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export default function EnergyPane() {
    const [days, setDays] = useState(30);
    const [report, setReport] = useState<EnergyReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let current = true;
        setLoading(true);
        setError(null);
        getEnergyReport(days)
            .then((r) => { if (current) setReport(r); })
            .catch((err) => { if (current) setError(errorText(err)); })
            .finally(() => { if (current) setLoading(false); });
        return () => { current = false; };
    }, [days]);

    return (
        <div className="energy-pane">
            <RightNow />

            <div className="energy-filters">
                <div className="energy-periods" role="group" aria-label="Period">
                    {PERIODS.map((p) => (
                        <button
                            key={p.days}
                            type="button"
                            className={days === p.days ? "active" : ""}
                            aria-pressed={days === p.days}
                            onClick={() => setDays(p.days)}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
                <a className="energy-download" href={ENERGY_CSV_URL} download>
                    Download CSV (every prompt)
                </a>
            </div>

            {error && <p className="auth-error" role="alert">{error}</p>}

            {report && (
                // Refetching keeps the previous numbers on screen, dimmed
                <div className={`energy-body ${loading ? "energy-refreshing" : ""}`} aria-busy={loading}>
                    <Summary report={report} />

                    <section className="panel">
                        <div className="panel-body">
                            <h3 className="energy-h">Energy per day</h3>
                            <DailyChart days={report.days} from={report.from} to={report.to} />
                        </div>
                    </section>

                    <Breakdown
                        title="By person"
                        total={report.totals.wh}
                        rows={report.people.map((p) => ({
                            key: p.user,
                            label: p.deleted ? `${p.user} (deleted)` : p.user,
                            ...p,
                        }))}
                        showLast
                    />
                    <Breakdown
                        title="By mode"
                        total={report.totals.wh}
                        rows={report.modes.map((m) => ({ key: m.mode, label: MODE_LABELS[m.mode] ?? m.mode, ...m }))}
                    />
                    <Breakdown
                        title="By model"
                        total={report.totals.wh}
                        rows={report.models.map((m) => ({ key: m.model, label: m.model, ...m }))}
                    />

                    <p className="energy-note">
                        Each prompt's energy is this Mac's power draw (CPU, GPU and Neural Engine) above idle
                        while that prompt ran. Prompts run one at a time, so each reading belongs to one
                        person. Other work on the Mac during a prompt is counted in it, and the first prompt
                        after an hour with no prompts includes loading the model.
                    </p>
                </div>
            )}
        </div>
    );
}

/* Who's using the app and what's in the queue, by name — refreshed every
   few seconds. Everyone else sees only the counts (sidebar). */
function RightNow() {
    const [data, setData] = useState<AdminActivity | null>(null);

    useEffect(() => {
        let current = true;
        const load = () => getAdminActivity().then((d) => { if (current) setData(d); }).catch(() => {});
        load();
        const timer = setInterval(load, 5000);
        return () => { current = false; clearInterval(timer); };
    }, []);

    if (!data) return null;
    const queue = !data.running
        ? "Nothing running"
        : data.waiting > 0 ? `1 prompt running, ${data.waiting} waiting` : "1 prompt running";
    const ago = (s: number | null) => (s === null ? "—" : s < 60 ? "Just now" : `${Math.round(s / 60)} min ago`);

    return (
        <section className="panel">
            <div className="panel-body">
                <h3 className="energy-h">Right now</h3>
                <p className="energy-sub">
                    {queue}. People who used U.ness in the last {data.window_minutes} minutes:
                    {data.people.length === 0 && " nobody."}
                </p>
                {data.people.length > 0 && (
                    <div className="users-table-wrap">
                        <table className="users-table energy-table">
                            <thead>
                                <tr>
                                    <th scope="col">Person</th>
                                    <th scope="col">Last active</th>
                                    <th scope="col">In line</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.people.map((p) => (
                                    <tr key={p.username}>
                                        <td>{p.username}</td>
                                        <td>{ago(p.seconds_ago)}</td>
                                        <td>
                                            {p.status === "running"
                                                ? `Running ${p.doing}`
                                                : p.status === "waiting"
                                                    ? `Waiting (${p.doing}), ${p.ahead} ahead`
                                                    : "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </section>
    );
}

function Summary({ report }: { report: EnergyReport }) {
    const { wh, prompts, people_active, people } = report.totals;
    return (
        <section className="energy-summary" aria-label="Summary">
            <div className="energy-hero">
                <div className="energy-label">Total energy</div>
                <div className="energy-hero-value">{formatEnergy(wh)}</div>
            </div>
            <div className="energy-tiles">
                <div className="energy-tile">
                    <div className="energy-label">Prompts</div>
                    <div className="energy-tile-value">{prompts.toLocaleString()}</div>
                </div>
                <div className="energy-tile">
                    <div className="energy-label">Average per prompt</div>
                    <div className="energy-tile-value">{prompts ? formatEnergy(wh / prompts) : "—"}</div>
                </div>
                <div className="energy-tile">
                    <div className="energy-label">People with prompts</div>
                    <div className="energy-tile-value">{people_active} of {people}</div>
                </div>
            </div>
        </section>
    );
}

type Row = { key: string; label: string; prompts: number; wh: number; last: string | null };

function Breakdown({ title, rows, total, showLast = false }: { title: string; rows: Row[]; total: number; showLast?: boolean }) {
    return (
        <section className="panel">
            <div className="panel-body">
                <h3 className="energy-h">{title}</h3>
                {rows.length === 0 ? (
                    <p className="energy-sub">No prompts recorded in this period.</p>
                ) : (
                    <div className="users-table-wrap">
                        <table className="users-table energy-table">
                            <thead>
                                <tr>
                                    <th scope="col">{title.replace("By ", "").replace(/^./, (c) => c.toUpperCase())}</th>
                                    <th scope="col" className="num">Prompts</th>
                                    <th scope="col" className="num">Energy</th>
                                    <th scope="col" className="num">Per prompt</th>
                                    <th scope="col">Share of energy</th>
                                    {showLast && <th scope="col">Last prompt</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => {
                                    const share = pct(r.wh, total);
                                    return (
                                        <tr key={r.key}>
                                            <td>{r.label}</td>
                                            <td className="num">{r.prompts.toLocaleString()}</td>
                                            <td className="num">{r.prompts ? formatEnergy(r.wh) : "—"}</td>
                                            <td className="num">{r.prompts ? formatEnergy(r.wh / r.prompts) : "—"}</td>
                                            <td>
                                                <span className="energy-share">
                                                    <span className="energy-share-track" aria-hidden="true">
                                                        <span className="energy-share-fill" style={{ width: `${share}%` }} />
                                                    </span>
                                                    <span className="num">{share}%</span>
                                                </span>
                                            </td>
                                            {showLast && <td>{shortStamp(r.last)}</td>}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </section>
    );
}

/* ── Daily column chart: one series, so no legend; the title names it.
   Hover or arrow keys show a day's value; the same numbers are in the table. ── */

function unitFor(maxWh: number): { unit: string; factor: number } {
    if (maxWh < 0.001) return { unit: "µWh", factor: 1e6 };
    if (maxWh < 1) return { unit: "mWh", factor: 1e3 };
    return { unit: "Wh", factor: 1 };
}

function niceTicks(max: number): number[] {
    if (max <= 0) return [0, 1];
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
    const ticks = [];
    for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(6)));
    return ticks;
}

const tickLabel = (v: number) => (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function DailyChart({ days, from, to }: { days: EnergyReport["days"]; from: string; to: string }) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(640);
    const [active, setActive] = useState<number | null>(null);

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const H = 220, top = 8, bottom = 28, left = 44, right = 8;
    const plotW = width - left - right;
    const plotH = H - top - bottom;
    const maxWh = Math.max(0, ...days.map((d) => d.wh));
    const { unit, factor } = unitFor(maxWh);
    const ticks = niceTicks(maxWh * factor);
    const yMaxWh = ticks[ticks.length - 1] / factor;
    const band = plotW / days.length;
    const barW = Math.min(24, Math.max(2, band * 0.6));
    const y = (wh: number) => top + plotH - (yMaxWh > 0 ? (wh / yMaxWh) * plotH : 0);

    // A handful of evenly spaced date labels, always including the last day
    const labelEvery = Math.max(1, Math.ceil(days.length / 6));
    const labelled = new Set(days.map((_, i) => i).filter((i) => (days.length - 1 - i) % labelEvery === 0));

    function onKey(e: KeyboardEvent<SVGSVGElement>) {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
        e.preventDefault();
        setActive((i) => {
            const cur = i ?? days.length - 1;
            if (e.key === "Home") return 0;
            if (e.key === "End") return days.length - 1;
            return Math.min(days.length - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1)));
        });
    }

    const a = active !== null ? days[active] : null;
    const tipLeft = active !== null ? left + active * band + band / 2 : 0;

    return (
        <div className="energy-chart" ref={wrapRef}>
            <p className="energy-sub">{shortDay(from)} – {shortDay(to)} · values in {unit}</p>
            <svg
                width={width}
                height={H}
                tabIndex={0}
                role="img"
                aria-label={`Energy per day, ${unit}. Use the left and right arrow keys to read each day.`}
                onKeyDown={onKey}
                onFocus={() => setActive((i) => i ?? days.length - 1)}
                onBlur={() => setActive(null)}
                onPointerLeave={() => setActive(null)}
            >
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={left} x2={width - right} y1={y(t / factor)} y2={y(t / factor)} className="energy-grid" />
                        {t > 0 && <text x={left - 8} y={y(t / factor)} className="energy-axis" textAnchor="end" dominantBaseline="middle">{tickLabel(t)}</text>}
                    </g>
                ))}
                {days.map((d, i) => {
                    const h = top + plotH - y(d.wh);
                    const x = left + i * band + (band - barW) / 2;
                    const r = Math.min(4, barW / 2, h);
                    const y0 = top + plotH;
                    return (
                        <g key={d.day}>
                            {h > 0 && (
                                <path
                                    className={`energy-bar ${active !== null && active !== i ? "dim" : ""}`}
                                    d={`M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + barW - r} Q${x + barW},${y0 - h} ${x + barW},${y0 - h + r} V${y0} Z`}
                                />
                            )}
                            {labelled.has(i) && (
                                // the last label ends at the edge instead of centring past it
                                i === days.length - 1
                                    ? <text x={width - right} y={H - 8} className="energy-axis" textAnchor="end">{shortDay(d.day)}</text>
                                    : <text x={left + i * band + band / 2} y={H - 8} className="energy-axis" textAnchor="middle">{shortDay(d.day)}</text>
                            )}
                            {/* the whole column is the hover target, not just the bar */}
                            <rect x={left + i * band} y={top} width={band} height={plotH} fill="transparent" onPointerEnter={() => setActive(i)} />
                        </g>
                    );
                })}
                <line x1={left} x2={width - right} y1={top + plotH} y2={top + plotH} className="energy-baseline" />
            </svg>

            <div
                className="energy-tooltip"
                role="status"
                aria-live="polite"
                style={{ left: Math.min(Math.max(tipLeft, 70), width - 70), visibility: a ? "visible" : "hidden" }}
            >
                {a && (
                    <>
                        <strong>{a.prompts ? formatEnergy(a.wh) : "0"}</strong>
                        <span>{parseDay(a.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {a.prompts} prompt{a.prompts === 1 ? "" : "s"}</span>
                    </>
                )}
            </div>

            <details className="energy-table-toggle">
                <summary>Show as table</summary>
                <div className="users-table-wrap">
                    <table className="users-table energy-table">
                        <thead>
                            <tr><th scope="col">Day</th><th scope="col" className="num">Prompts</th><th scope="col" className="num">Energy</th></tr>
                        </thead>
                        <tbody>
                            {days.filter((d) => d.prompts > 0).reverse().map((d) => (
                                <tr key={d.day}>
                                    <td>{parseDay(d.day).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</td>
                                    <td className="num">{d.prompts}</td>
                                    <td className="num">{formatEnergy(d.wh)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {days.every((d) => d.prompts === 0) && <p className="energy-sub">No prompts recorded in this period.</p>}
                </div>
            </details>
        </div>
    );
}
