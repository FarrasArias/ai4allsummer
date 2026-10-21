import { useEffect, useState } from "react";
import {
  listModels,
  pullModel,
  deleteModels,
  createModel,
} from "../api";

type Props = {
  /* The one model every mode uses (backend/utilities/main_model.py) */
  model?: string;
  /* Download, delete and create models — at this Mac only */
  canManageModels?: boolean;
};

export default function ModelManagerPane({ model, canManageModels = false }: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);

  const [modelfileName, setModelfileName] = useState("");
  const [modelfileText, setModelfileText] = useState("FROM llama3.1\nPARAMETER temperature 0.2");
  const [deleteNames, setDeleteNames] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const ms = await listModels();
      setModels(ms);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handlePull() {
    if (!model) return;
    setPulling(true);
    try {
      await pullModel(model);
      await refresh();
    } finally {
      setPulling(false);
    }
  }

  async function handleCreate() {
    const name = modelfileName.trim();
    if (!name || !modelfileText.trim()) return;
    await createModel(name, modelfileText);
    setModelfileName("");
    await refresh();
  }

  async function handleDelete() {
    const raw = deleteNames.trim();
    if (!raw) return;
    const names = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return;
    await deleteModels(names);
    setDeleteNames("");
    await refresh();
  }

  const installed = !!model && models.includes(model);

  return (
    <div
      className="panel-body"
      style={{
        display: "grid",
        gap: 16,
        alignContent: "flex-start",
      }}
    >
      {/* The model */}
      <section className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Model</h3>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 14 }}>{model ?? "Loading…"}</strong>
            {model && !loading && (
              installed ? (
                <span style={{ fontSize: 12, opacity: 0.8 }}>Installed</span>
              ) : canManageModels ? (
                <button type="button" onClick={handlePull} disabled={pulling}>
                  {pulling ? "Downloading…" : "Download"}
                </button>
              ) : (
                <span style={{ fontSize: 12, opacity: 0.8 }}>Not installed yet</span>
              )
            )}
          </div>
          <p style={{ fontSize: 12, margin: 0, opacity: 0.8 }}>
            Every mode uses this one model, so energy readings can be compared across modes and
            people. <strong>Deep think</strong> in Chat is the same model with its thinking turned on.
            It stays loaded in memory, so prompts don't wait for it to start.
          </p>
        </div>
      </section>

      {/* Advanced: other installed models, create / delete — at this Mac only */}
      {canManageModels && (
      <section className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Advanced</h3>
            <button type="button" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ fontSize: 12 }}>Installed in Ollama</div>
            {models.length === 0 && <div style={{ fontSize: 13 }}>No models found yet.</div>}
            {models.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {models.map((m) => (
                  <li key={m} style={{ fontSize: 13 }}>
                    {m}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={{ display: "grid", gap: 4 }}>
            <label style={{ fontSize: 12 }}>
              Create model (modelfile)
              <input
                style={{ display: "block", width: "100%", marginTop: 4 }}
                placeholder="my-model-name"
                value={modelfileName}
                onChange={(e) => setModelfileName(e.target.value)}
              />
            </label>
            <textarea
              style={{ width: "100%", minHeight: 80 }}
              value={modelfileText}
              onChange={(e) => setModelfileText(e.target.value)}
            />
            <button type="button" onClick={handleCreate} disabled={!modelfileName.trim()}>
              Create model
            </button>
          </div>

          <div style={{ display: "grid", gap: 4 }}>
            <label style={{ fontSize: 12 }}>
              Delete models (comma-separated names)
              <input
                style={{ display: "block", width: "100%", marginTop: 4 }}
                placeholder="model-a, model-b"
                value={deleteNames}
                onChange={(e) => setDeleteNames(e.target.value)}
              />
            </label>
            <button type="button" onClick={handleDelete} disabled={!deleteNames.trim()}>
              Delete
            </button>
          </div>
        </div>
      </section>
      )}
    </div>
  );
}
