import React, { useEffect, useState } from "react";
import {
  listModels,
  pullModel,
  deleteModels,
  createModel,
  type ModeDefaults,
  type ModeKey,
} from "../api";



type Props = {
    fastModel: string | null;
    deepModel: string | null;
    onFastModelChange?: (m: string | null) => void;
    onDeepModelChange?: (m: string | null) => void;
    modeDefaults?: ModeDefaults;
    modeOverrides?: Partial<Record<ModeKey, string>>;
    onModeOverrideChange?: (mode: ModeKey, model: string | null) => void;
};

export default function ModelManagerPane({
  fastModel,
  deepModel,
  onFastModelChange,
  onDeepModelChange,
    modeDefaults,
    modeOverrides,
    onModeOverrideChange,
}: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);

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

  async function handlePull(name: string) {
    if (!name) return;
    setPulling(name);
    try {
      await pullModel(name);
      await refresh();
    } finally {
      setPulling(null);
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

    function renderModeRow(label: string, key: ModeKey) {
        if (!modeDefaults) return null;

        const info = modeDefaults[key];
        if (!info || !info.default) return null;

        const override = modeOverrides?.[key];
        const effectiveModel = override || info.default;
        const defaultInstalled = models.includes(info.default);
        const isPulling = pulling === info.default;

        return (
            <div
                key={key}
                style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "4px 0",
                }}
            >
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{label}</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                        Default: {info.default}
                    </div>

                    <label style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                        Active model
                        <select
                            value={override ?? ""}
                            onChange={(e) =>
                                onModeOverrideChange?.(
                                    key,
                                    e.target.value ? e.target.value : null,
                                )
                            }
                            style={{ display: "block", width: "100%", marginTop: 4 }}
                        >
                            <option value="">
                                Use default ({info.default})
                            </option>
                            {models.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </select>
                    </label>

                    <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>
                        Currently using: {effectiveModel}
                    </div>
                </div>

                <div style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {defaultInstalled ? (
                        <span style={{ opacity: 0.8 }}>Default installed</span>
                    ) : (
                        <button
                            type="button"
                            onClick={() => handlePull(info.default)}
                            disabled={isPulling}
                        >
                            {isPulling ? "Downloading…" : "Download default"}
                        </button>
                    )}
                </div>
            </div>
        );
    }


  return (
    <div
      className="panel-body"
      style={{
        display: "grid",
        gap: 16,
        alignContent: "flex-start",
      }}
    >
      {/* Installed models */}
      <section className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Installed models</h3>
            <button type="button" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {models.length === 0 && <div>No models found yet.</div>}
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
      </section>

      {/* Mode defaults */}
      <section className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Mode defaults</h3>
          <p style={{ fontSize: 12, margin: 0 }}>
            Each mode has a backend-defined default model. If a model is not installed yet, use the
            Download button to pull it into Ollama.
          </p>
                  {modeDefaults ? (
                      <div style={{ display: "grid", gap: 4 }}>
                          {renderModeRow("Chat (general)", "chat")}
                          {renderModeRow("Vibe Coding", "vibe_coding")}
                          {renderModeRow("Image Analysis", "image")}
                          {renderModeRow("Image Generation", "image_gen")}
                          {renderModeRow("Web", "web")}
                      </div>
                  ) : (
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                          Loading mode defaults from backend…
                      </div>
                  )}
        </div>
      </section>

      {/* Chat presets */}
      <section className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Chat presets</h3>
          <p style={{ fontSize: 12, margin: 0 }}>
            Map installed models to <strong>Fast think</strong> and <strong>Deep think</strong>.
            Chat will use these presets when you switch thinking mode.
          </p>
          <div style={{ display: "grid", gap: 8, maxWidth: 360 }}>
            <label style={{ fontSize: 12 }}>
              Fast think
              <select
                value={fastModel || ""}
                onChange={(e) => onFastModelChange?.(e.target.value || null)}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              >
                <option value="">(not set)</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ fontSize: 12 }}>
              Deep think
              <select
                value={deepModel || ""}
                onChange={(e) => onDeepModelChange?.(e.target.value || null)}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              >
                <option value="">(not set)</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>

      {/* Advanced: create / delete */}
      <section className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Advanced</h3>

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
    </div>
  );
}
