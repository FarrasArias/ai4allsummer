import React, { useEffect, useState } from "react";
import { streamImageAnalysis } from "../api";

type Turn = {
  prompt: string;
  response: string | null;
};

type Props = {
  model?: string;
};

// A File can't go in localStorage, but a data URL can — read the file once
// on selection and persist that instead, so the preview survives a tab
// switch (the pane unmounts like every other tab) without re-uploading.
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type });
}

export default function ImageAnalysisPane({ model }: Props) {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(() => {
    try { return localStorage.getItem("ai4all.image.dataUrl"); } catch { return null; }
  });
  const [imageName, setImageName] = useState<string>(() => {
    try { return localStorage.getItem("ai4all.image.name") || "image"; } catch { return "image"; }
  });
  const [prompt, setPrompt] = useState<string>("Describe this image.");
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      const saved = localStorage.getItem("ai4all.image.turns");
      if (saved) {
        const parsed = JSON.parse(saved) as Turn[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { /* ignore */ }
    return [];
  });
  const [isStreaming, setIsStreaming] = useState(false);

  // Persist Q&A turns so they survive tab switches and page refreshes
  useEffect(() => {
    try {
      localStorage.setItem("ai4all.image.turns", JSON.stringify(turns));
    } catch { /* ignore */ }
  }, [turns]);

  // Persist the current image itself, for the same reason. A large photo's
  // data URL can exceed the localStorage quota — if so, the image just
  // won't survive a tab switch (same as before), but nothing breaks.
  useEffect(() => {
    try {
      if (imageDataUrl) {
        localStorage.setItem("ai4all.image.dataUrl", imageDataUrl);
        localStorage.setItem("ai4all.image.name", imageName);
      } else {
        localStorage.removeItem("ai4all.image.dataUrl");
        localStorage.removeItem("ai4all.image.name");
      }
    } catch { /* quota exceeded */ }
  }, [imageDataUrl, imageName]);

  function selectImage(f: File) {
    readFileAsDataUrl(f)
      .then((dataUrl) => {
        setImageDataUrl(dataUrl);
        setImageName(f.name);
      })
      .catch(() => {});
  }

  // Paste an image (e.g. a screenshot of a PDF figure) directly into the pane.
  // Window-level listener — the pane only mounts while its tab is active.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) {
            selectImage(f);
            e.preventDefault();
            return;
          }
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = Array.from(e.dataTransfer.files).find((x) =>
      x.type.startsWith("image/"),
    );
    if (f) selectImage(f);
  }

  const activeModel = model;

  async function handleAnalyze() {
    if (!imageDataUrl || !activeModel || !prompt.trim()) return;

    const currentPrompt = prompt.trim();
    const imageFile = await dataUrlToFile(imageDataUrl, imageName);

    // Add new turn and get its index
    setTurns((prev) => [...prev, { prompt: currentPrompt, response: "" }]);
    setIsStreaming(true);

    // Use a ref-like approach: accumulate response locally, then update state
    let accumulatedResponse = "";

    try {
      await streamImageAnalysis(
        { prompt: currentPrompt, model: activeModel, image: imageFile },
        (delta: string) => {
          accumulatedResponse += delta;
          // Update the last turn's response
          setTurns((prev) => {
            const next = [...prev];
            const lastIndex = next.length - 1;
            if (lastIndex >= 0) {
              next[lastIndex] = { ...next[lastIndex], response: accumulatedResponse };
            }
            return next;
          });
        },
      );
    } catch (err) {
      console.error(err);
      setTurns((prev) => {
        const next = [...prev];
        const lastIndex = next.length - 1;
        if (lastIndex >= 0) {
          next[lastIndex] = {
            prompt: currentPrompt,
            response: "Sorry, something went wrong while analyzing the image.",
          };
        }
        return next;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      style={{
        display: "grid",
        gridTemplateRows: "auto auto 1fr",
        gap: 12,
        height: "100%",
        minHeight: 0,
      }}
    >
      <div className="panel">
        <div
          className="panel-body"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>
            <div style={{ fontWeight: 500 }}>Image analysis</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Model: {activeModel || "loading default model…"}
            </div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              Tip: paste (Ctrl+V) or drag &amp; drop an image — e.g. a screenshot
              of a figure from a PDF.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) selectImage(f);
              }}
            />
            <button type="button" onClick={handleAnalyze} disabled={!imageDataUrl || !activeModel}>
              Analyze image
            </button>
          </div>
        </div>
      </div>

      {imageDataUrl && (
        <div className="panel">
          <div className="panel-body" style={{ display: "flex", justifyContent: "center" }}>
            <img
              src={imageDataUrl}
              alt="Selected"
              style={{ maxHeight: 200, maxWidth: "100%", objectFit: "contain" }}
            />
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-body" style={{ height: "100%", overflow: "auto" }}>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
              Prompt
            </label>
            <textarea
              style={{ width: "100%", minHeight: 60 }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask the model about the image…"
            />
          </div>
          <div>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Answer</div>
            <div className="chat-history" style={{ maxHeight: 260 }}>
              {turns.map((t, idx) => (
                <div key={idx} className="chat-bubble bot">
                  <div className="bubble">
                    <strong style={{ display: "block", marginBottom: 4 }}>
                      Prompt: {t.prompt}
                    </strong>
                    <div>{t.response || (idx === turns.length - 1 && isStreaming ? "…" : "")}</div>
                  </div>
                </div>
              ))}
              {turns.length === 0 && (
                <div className="chat-bubble bot">
                  <div className="bubble">
                    Upload an image, write a prompt, and click <strong>Analyze image</strong> to
                    see the model's description here.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
