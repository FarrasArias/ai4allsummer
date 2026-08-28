
import { useEffect, useState } from "react";
import { API_BASE } from "../api";

type PowerPoint = { date: string; power: number; model: string; type?: string };
export default function AnalyticsPane() {
  const [local, setLocal] = useState<PowerPoint[]>([]);
  const [cloud, setCloud] = useState<PowerPoint[]>([]);

  useEffect(() => {
    fetch(`${API_BASE}/api/analytics/power`).then(r=>r.json()).then((j)=>{
      setLocal(j.local ?? []);
      setCloud(j.default ?? []);
    })
  }, []);

  return (
    <div className="panel-body" style={{ display: "grid", gap: 12 }}>
      <h3>Power analytics</h3>
      <div><strong>Local samples:</strong> {local.length}</div>
      <div><strong>Default (cloud) baselines:</strong> {cloud.length}</div>
      <div className="chat-history" style={{ maxHeight: 320 }}>
        {local.map((r, i) => <div key={i} className="chat-bubble bot"><div className="bubble">{r.date} — {r.model}: {r.power.toFixed ? r.power.toFixed(3) : r.power} Wh</div></div>)}
      </div>
    </div>
  );
}
