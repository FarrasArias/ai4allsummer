export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export function sse(url: string, onMessage: (data: any) => void, onError?: (e: any) => void) {
  const es = new EventSource(url, { withCredentials: false });
  es.onmessage = (evt) => {
    try {
      onMessage(JSON.parse(evt.data));
    } catch {
      /* ignore */
    }
  };
  es.onerror = (e) => {
    es.close();
    onError?.(e);
  };
  return () => es.close();
}

export async function listModels(): Promise<string[]> {
  const r = await fetch(`${API_BASE}/api/models`);
  const j = await r.json();
  return j.models ?? [];
}

export async function pullModel(name: string) {
  const body = new FormData();
  body.append("name", name);
  const r = await fetch(`${API_BASE}/api/models/pull`, { method: "POST", body });
  return r.json();
}

export async function createModel(name: string, modelfile: string) {
  const body = new FormData();
  body.append("name", name);
  body.append("modelfile", modelfile);
  const r = await fetch(`${API_BASE}/api/models/create`, { method: "POST", body });
  return r.json();
}

export async function deleteModels(models: string[]) {
  const r = await fetch(
    `${API_BASE}/api/models?` + new URLSearchParams({ models: models as any }),
    { method: "DELETE" },
  );
  return r.json();
}

export type ThinkingMode = "fast" | "deep";

export type InferenceMetrics = {
  inference_time_ms: number;
  energy_wh: number;
  input_tokens?: number;
  output_tokens?: number;
  user_prompt_tokens?: number;
};

export function streamChat(
    {
        prompt,
        model,
        files,
        thinkingMode,
    }: { prompt: string; model: string; files?: File[]; thinkingMode?: ThinkingMode },
    onDelta: (text: string) => void,
    onComplete?: (metrics: InferenceMetrics) => void,
): Promise<InferenceMetrics | undefined> {
    const body = new FormData();
    body.append("prompt", prompt);
    body.append("model", model);
    if (thinkingMode) body.append("thinking_mode", thinkingMode);
    (files ?? []).forEach((f) => body.append("files", f));

    return fetch(`${API_BASE}/api/chat`, { method: "POST", body }).then(async (res) => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let metrics: InferenceMetrics | undefined;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.error) throw new Error(payload.error);
        if (payload.delta) onDelta(payload.delta);
        if (payload.done && payload.inference_time_ms !== undefined) {
          metrics = {
            inference_time_ms: payload.inference_time_ms,
            energy_wh: payload.energy_wh ?? 0,
            input_tokens: payload.input_tokens,
            output_tokens: payload.output_tokens,
            user_prompt_tokens: payload.user_prompt_tokens,
          };
          onComplete?.(metrics);
        }
      }
    }
    return metrics;
  });
}

export function streamImageAnalysis(
  { prompt, model, image }: { prompt: string; model: string; image: File },
  onDelta: (text: string) => void,
) {
  const body = new FormData();
  body.append("prompt", prompt);
  body.append("model", model);
  body.append("image", image);
  return fetch(`${API_BASE}/api/image/analyze`, { method: "POST", body }).then(async (res) => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.delta) onDelta(payload.delta);
      }
    }
  });
}

export function streamPower(
  onUpdate: (summary: {
    latest_prompt_Wh: number;
    session_total_Wh: number;
    today_total_Wh: number;
  }) => void,
) {
  return sse(`${API_BASE}/api/power/stream`, onUpdate);
}

export async function powerSummary() {
  const r = await fetch(`${API_BASE}/api/power/summary`);
  return r.json();
}

export async function listChats() {
  const r = await fetch(`${API_BASE}/api/chats`);
  return r.json();
}

// Pinned chats management (stored in localStorage)
const PINNED_CHATS_KEY = "ai4all.pinnedChats";

export function getPinnedChats(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_CHATS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function setPinnedChats(chats: string[]) {
  try {
    localStorage.setItem(PINNED_CHATS_KEY, JSON.stringify(chats));
  } catch {
    // ignore
  }
}

export function togglePinnedChat(chatName: string): boolean {
  const pinned = getPinnedChats();
  const idx = pinned.indexOf(chatName);
  if (idx >= 0) {
    pinned.splice(idx, 1);
    setPinnedChats(pinned);
    return false; // unpinned
  } else {
    pinned.unshift(chatName);
    setPinnedChats(pinned);
    return true; // pinned
  }
}

export function isChatPinned(chatName: string): boolean {
  return getPinnedChats().includes(chatName);
}

export async function saveChat(name: string, history: any) {
  const body = new FormData();
  body.append("name", name);
  body.append("history_json", JSON.stringify(history));
  const r = await fetch(`${API_BASE}/api/chats/save`, { method: "POST", body });
  return r.json();
}

export async function loadChat(name: string) {
  const r = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(name)}`);
  return r.json();
}

export type SearchResult = {
  chatName: string;
  matches: Array<{
    role: string;
    snippet: string;
    index: number;
  }>;
};

export async function searchChats(query: string): Promise<{ results: SearchResult[] }> {
  const r = await fetch(`${API_BASE}/api/chats-search?q=${encodeURIComponent(query)}`);
  return r.json();
}

export async function saveStudySession(opts: {
  name: string; // e.g. "SIAT-0123_s1"
  history: any; // chat transcript array/object
  metrics?: any; // [{ ts, text, words, chars }, ...]
  session?: any; // { participantId, group, session, taskStartedAt, taskEndedAt, energy: {...} }
  interviewText?: string; // optional
}): Promise<{ ok: boolean }> {
  const fd = new FormData();
  fd.set("name", opts.name);
  fd.set("history_json", JSON.stringify(opts.history));
  if (opts.metrics) fd.set("metrics_json", JSON.stringify(opts.metrics));
  if (opts.session) fd.set("session_json", JSON.stringify(opts.session));
  if (opts.interviewText) fd.set("interview_text", opts.interviewText);

  const res = await fetch(`${API_BASE}/api/chats/save`, { method: "POST", body: fd });
  return { ok: res.ok };
}

export async function resetChatSession(model: string) {
  const body = new FormData();
  body.append("model", model);

  const res = await fetch(`${API_BASE}/api/chat/reset`, {
    method: "POST",
    body,
  });

  if (!res.ok) {
    throw new Error("Failed to reset chat session");
  }

  return res.json();
}

export type ModeKey = "chat" | "vibe_coding" | "image" | "web" | "image_gen";

export type ModeInfo = {
  default: string;
  installed: boolean;
  // Chat-specific: fast/thinking model presets from config
  fast?: string;
  fast_installed?: boolean;
  thinking?: string;
  thinking_installed?: boolean;
};

export type ModeDefaults = Record<ModeKey, ModeInfo>;

// Fetch default model per high-level mode (Chat / Vibe coding / Image / Web)
export async function getModeDefaults(): Promise<ModeDefaults> {
  const res = await fetch(`${API_BASE}/api/modes/default-models`);
  if (!res.ok) {
    throw new Error("Failed to load mode defaults");
  }
  return res.json();
}

// Vibe coding (non-streaming JSON API)
export async function vibeCode(opts: { prompt: string; model: string; files?: File[] }) {
  const body = new FormData();
  body.append("prompt", opts.prompt);
  body.append("model", opts.model);
  (opts.files ?? []).forEach((f) => body.append("files", f));
  const res = await fetch(`${API_BASE}/api/vibe/code`, { method: "POST", body });
  return res.json();
}

export async function resetVibe(model: string) {
  const body = new FormData();
  body.append("model", model);
  const res = await fetch(`${API_BASE}/api/vibe/reset`, { method: "POST", body });
  return res.json();
}

// Web chat (tools-enabled, JSON API)
export async function webChat(opts: { prompt: string; model: string }) {
  const body = new FormData();
  body.append("prompt", opts.prompt);
  body.append("model", opts.model);
  const res = await fetch(`${API_BASE}/api/web/chat`, { method: "POST", body });
  return res.json();
}

export async function resetWeb(model: string) {
  const body = new FormData();
  body.append("model", model);
  const res = await fetch(`${API_BASE}/api/web/reset`, { method: "POST", body });
  return res.json();
}

// Image generation (SD WebUI + Ollama prompt enhancement)
export type ImageGenParams = {
  prompt: string;
  model: string;
  enhance?: boolean;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg_scale?: number;
};

export type ImageGenResult = {
  ok: boolean;
  image_b64?: string;
  prompt_used?: string;
  original_prompt?: string;
  parameters?: Record<string, any>;
  error?: string;
};

export async function generateImage(opts: ImageGenParams): Promise<ImageGenResult> {
  const body = new FormData();
  body.append("prompt", opts.prompt);
  body.append("model", opts.model);
  body.append("enhance", String(opts.enhance ?? true));
  if (opts.negative_prompt) body.append("negative_prompt", opts.negative_prompt);
  if (opts.width) body.append("width", String(opts.width));
  if (opts.height) body.append("height", String(opts.height));
  if (opts.steps) body.append("steps", String(opts.steps));
  if (opts.cfg_scale) body.append("cfg_scale", String(opts.cfg_scale));

  const res = await fetch(`${API_BASE}/api/image-gen/generate`, { method: "POST", body });
  return res.json();
}

export async function getImageGenStatus(): Promise<{
  sd_available: boolean;
  sd_models: string[];
}> {
  const res = await fetch(`${API_BASE}/api/image-gen/status`);
  return res.json();
}

export async function resetImageGen(model: string) {
  const body = new FormData();
  body.append("model", model);
  const res = await fetch(`${API_BASE}/api/image-gen/reset`, { method: "POST", body });
  return res.json();
}
