import React, { useState, useEffect } from "react";
import { generateImage, getImageGenStatus, type ImageGenResult } from "../api";

type HistoryEntry = {
  prompt: string;
  image_b64: string | null;
  prompt_used: string | null;
  error: string | null;
};

type Props = {
  model?: string;
};

export default function ImageGenPane({ model }: Props) {
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [enhance, setEnhance] = useState(true);
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [steps, setSteps] = useState(25);
  const [cfgScale, setCfgScale] = useState(7.0);
  const [generating, setGenerating] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sdAvailable, setSdAvailable] = useState<boolean | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activeModel = model;

  // Check SD WebUI availability on mount
  useEffect(() => {
    getImageGenStatus()
      .then((s) => setSdAvailable(s.sd_available))
      .catch(() => setSdAvailable(false));
  }, []);

  async function handleGenerate() {
    if (!prompt.trim() || !activeModel) return;

    const currentPrompt = prompt.trim();
    setGenerating(true);

    // Add placeholder entry
    setHistory((prev) => [
      { prompt: currentPrompt, image_b64: null, prompt_used: null, error: null },
      ...prev,
    ]);

    try {
      const result: ImageGenResult = await generateImage({
        prompt: currentPrompt,
        model: activeModel,
        enhance,
        negative_prompt: negativePrompt || undefined,
        width,
        height,
        steps,
        cfg_scale: cfgScale,
      });

      if (result.ok && result.image_b64) {
        setHistory((prev) => {
          const next = [...prev];
          next[0] = {
            prompt: currentPrompt,
            image_b64: result.image_b64!,
            prompt_used: result.prompt_used || null,
            error: null,
          };
          return next;
        });
      } else {
        setHistory((prev) => {
          const next = [...prev];
          next[0] = {
            prompt: currentPrompt,
            image_b64: null,
            prompt_used: null,
            error: result.error || "Unknown error",
          };
          return next;
        });
      }
    } catch (err: any) {
      setHistory((prev) => {
        const next = [...prev];
        next[0] = {
          prompt: currentPrompt,
          image_b64: null,
          prompt_used: null,
          error: err.message || "Request failed",
        };
        return next;
      });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        gap: 12,
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Controls panel */}
      <div className="panel">
        <div className="panel-body" style={{ display: "grid", gap: 8 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>Image Generation</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Enhancer model: {activeModel || "loading default model\u2026"}
              </div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                SD WebUI:{" "}
                {sdAvailable === null
                  ? "checking\u2026"
                  : sdAvailable
                    ? "connected"
                    : "not available (start SD WebUI with --api)"}
              </div>
            </div>
          </div>

          {/* Prompt input */}
          <div>
            <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Prompt</label>
            <textarea
              style={{ width: "100%", minHeight: 60 }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the image you want to generate..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
            />
          </div>

          {/* Enhance toggle + generate button */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={enhance}
                onChange={(e) => setEnhance(e.target.checked)}
              />
              Enhance prompt with AI
            </label>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              style={{ fontSize: 12 }}
            >
              {showAdvanced ? "Hide" : "Show"} advanced
            </button>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!prompt.trim() || !activeModel || generating || sdAvailable === false}
            >
              {generating ? "Generating\u2026" : "Generate"}
            </button>
          </div>

          {/* Advanced settings */}
          {showAdvanced && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                padding: 8,
                border: "1px solid var(--border, #333)",
                borderRadius: 4,
              }}
            >
              <label style={{ fontSize: 12 }}>
                Width
                <input
                  type="number"
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                  min={256}
                  max={1024}
                  step={64}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 12 }}>
                Height
                <input
                  type="number"
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                  min={256}
                  max={1024}
                  step={64}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 12 }}>
                Steps
                <input
                  type="number"
                  value={steps}
                  onChange={(e) => setSteps(Number(e.target.value))}
                  min={1}
                  max={100}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 12 }}>
                CFG Scale
                <input
                  type="number"
                  value={cfgScale}
                  onChange={(e) => setCfgScale(Number(e.target.value))}
                  min={1}
                  max={30}
                  step={0.5}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
                Negative prompt
                <textarea
                  style={{ width: "100%", minHeight: 40, marginTop: 4 }}
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="lowres, bad anatomy, bad hands, text, watermark, blurry"
                />
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Results / history */}
      <div className="panel" style={{ overflow: "auto", minHeight: 0 }}>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          {history.length === 0 && (
            <div className="chat-bubble bot">
              <div className="bubble">
                Describe what you want to see and click <strong>Generate</strong>.
                {sdAvailable === false && (
                  <div style={{ marginTop: 8, color: "#f59e0b" }}>
                    Stable Diffusion WebUI is not running. Start it with <code>--api</code>{" "}
                    flag to enable image generation.
                  </div>
                )}
              </div>
            </div>
          )}

          {history.map((entry, idx) => (
            <div
              key={idx}
              style={{
                border: "1px solid var(--border, #333)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                <strong>Prompt:</strong> {entry.prompt}
              </div>

              {entry.prompt_used && entry.prompt_used !== entry.prompt && (
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
                  <strong>Enhanced:</strong> {entry.prompt_used}
                </div>
              )}

              {entry.error && (
                <div style={{ color: "#ef4444", fontSize: 13 }}>{entry.error}</div>
              )}

              {entry.image_b64 && (
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <img
                    src={`data:image/png;base64,${entry.image_b64}`}
                    alt={entry.prompt}
                    style={{
                      maxWidth: "100%",
                      maxHeight: 512,
                      objectFit: "contain",
                      borderRadius: 4,
                    }}
                  />
                </div>
              )}

              {!entry.image_b64 && !entry.error && idx === 0 && generating && (
                <div style={{ textAlign: "center", padding: 24, opacity: 0.7 }}>
                  Generating image...
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
