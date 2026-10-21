// Same origin by default: the backend serves the built app, and in dev Vite
// proxies /api to it (vite.config.ts).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Fired when the server answers 401 — the session expired or the account was
// disabled. AuthGate listens for it and shows the login screen.
export const SIGNED_OUT_EVENT = "uness:signed-out";

// All API requests go through here. The backend refuses non-GET requests
// without X-Uness-Client, which stops other websites from submitting forms
// to it (SERVER_STAGE1.md §1c).
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Uness-Client", "1");
  return fetch(`${API_BASE}${path}`, { ...init, headers }).then((res) => {
    // Session expired or the account was disabled: back to the login screen
    if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    return res;
  });
}

// An error whose message is meant for the user, e.g. "You already have a
// request in progress" or a model error reported mid-stream.
export class ApiError extends Error {}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    if (body?.error) return new ApiError(String(body.error));
    if (body?.detail) return new ApiError(String(body.detail));
  } catch {
    /* not JSON */
  }
  return new ApiError(`Server error: ${res.status}`);
}

// Read an SSE response, passing each `data:` payload to onEvent. Buffers
// across network chunks so an event split in two isn't dropped or misparsed.
async function readEvents(res: Response, onEvent: (payload: any) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data:")) continue;
      onEvent(JSON.parse(part.slice(5).trim()));
    }
  }
}

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
  const r = await apiFetch(`/api/models`);
  const j = await r.json();
  return j.models ?? [];
}

export async function pullModel(name: string) {
  const body = new FormData();
  body.append("name", name);
  const r = await apiFetch(`/api/models/pull`, { method: "POST", body });
  return r.json();
}

export async function createModel(name: string, modelfile: string) {
  const body = new FormData();
  body.append("name", name);
  body.append("modelfile", modelfile);
  const r = await apiFetch(`/api/models/create`, { method: "POST", body });
  return r.json();
}

/** Preload a model into Ollama GPU memory. Blocks until the model is ready. */
export async function loadModel(model: string): Promise<{ ok: boolean; error?: string }> {
  const body = new FormData();
  body.append("model", model);
  const res = await apiFetch(`/api/models/load`, { method: "POST", body });
  return res.json();
}

export async function deleteModels(models: string[]) {
  const r = await apiFetch(
    `/api/models?` + new URLSearchParams({ models: models as any }),
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
    onStatus?: (text: string) => void,
): Promise<InferenceMetrics | undefined> {
    const body = new FormData();
    body.append("prompt", prompt);
    body.append("model", model);
    if (thinkingMode) body.append("thinking_mode", thinkingMode);
    (files ?? []).forEach((f) => body.append("files", f));

    return apiFetch(`/api/chat`, { method: "POST", body }).then(async (res) => {
    if (!res.ok) throw await errorFrom(res);
    let metrics: InferenceMetrics | undefined;
    await readEvents(res, (payload) => {
        if (payload.error) throw new ApiError(payload.error);
        if (payload.status) onStatus?.(payload.status);
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
    });
    return metrics;
  });
}

export function streamImageAnalysis(
  { prompt, model, image }: { prompt: string; model: string; image: File },
  onDelta: (text: string) => void,
  onStatus?: (text: string) => void,
) {
  const body = new FormData();
  body.append("prompt", prompt);
  body.append("model", model);
  body.append("image", image);
  return apiFetch(`/api/image/analyze`, { method: "POST", body }).then(async (res) => {
    if (!res.ok) throw await errorFrom(res);
    await readEvents(res, (payload) => {
      if (payload.error) throw new ApiError(payload.error);
      if (payload.status) onStatus?.(payload.status);
      if (payload.delta) onDelta(payload.delta);
    });
  });
}

/* What's happening on the Mac right now — counts only, for everyone */
export type Activity = {
  running: boolean;
  waiting: number;
  /* Your place: 0 = your prompt is running, n = n prompts ahead of yours, null = none queued */
  mine: number | null;
  /* People who used the app in the last 5 minutes */
  active: number;
};

export function streamPower(
  onUpdate: (summary: {
    latest_prompt_Wh: number;
    session_total_Wh: number;
    today_total_Wh: number;
    activity?: Activity;
  }) => void,
) {
  // Reconnects after a dropped connection (e.g. the server restarting),
  // so the numbers don't silently freeze
  let stop = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const connect = () => {
    stop = sse(`${API_BASE}/api/power/stream`, onUpdate, () => {
      if (!closed) retry = setTimeout(connect, 5000);
    });
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    stop();
  };
}

export async function powerSummary() {
  const r = await apiFetch(`/api/power/summary`);
  return r.json();
}

export type ChatInfo = {
  name: string;
  mode?: string;
  created_at?: number;
  updated_at?: number;
};

export async function listChats(): Promise<{ chats: ChatInfo[] }> {
  const r = await apiFetch(`/api/chats`);
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

export async function saveChat(name: string, history: any, meta?: { mode?: string }) {
  const body = new FormData();
  body.append("name", name);
  body.append("history_json", JSON.stringify(history));
  if (meta) body.append("meta_json", JSON.stringify(meta));
  const r = await apiFetch(`/api/chats/save`, { method: "POST", body });
  return r.json();
}

export async function loadChat(name: string) {
  const r = await apiFetch(`/api/chats/${encodeURIComponent(name)}`);
  return r.json();
}

export async function deleteChat(name: string) {
  const r = await apiFetch(`/api/chats/${encodeURIComponent(name)}`, { method: "DELETE" });
  return r.json();
}

export async function renameChat(oldName: string, newName: string) {
  const body = new FormData();
  body.append("old_name", oldName);
  body.append("new_name", newName);
  const r = await apiFetch(`/api/chats/rename`, { method: "POST", body });
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
  const r = await apiFetch(`/api/chats-search?q=${encodeURIComponent(query)}`);
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

  const res = await apiFetch(`/api/chats/save`, { method: "POST", body: fd });
  return { ok: res.ok };
}

export async function resetChatSession(model: string) {
  const body = new FormData();
  body.append("model", model);

  const res = await apiFetch(`/api/chat/reset`, {
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
  const res = await apiFetch(`/api/modes/default-models`);
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
  const res = await apiFetch(`/api/vibe/code`, { method: "POST", body });
  return res.json();
}

export async function resetVibe(model: string) {
  const body = new FormData();
  body.append("model", model);
  const res = await apiFetch(`/api/vibe/reset`, { method: "POST", body });
  return res.json();
}

// ── Coding Agent (claw-code-agent) — SSE streaming ──

export type AgentEvent =
  | { type: "status"; text: string }  // e.g. waiting in line for a turn
  | { type: "thinking" }
  | { type: "assistant"; content: string }
  | { type: "tool_start"; tool: string; args: Record<string, any> }
  | { type: "tool_result"; tool: string; ok: boolean; content: string }
  | { type: "done"; output: string; turns: number; tool_calls: number; usage: Record<string, number>; stop_reason?: string }
  | { type: "error"; error: string };

/**
 * Stream the coding agent's response as SSE events.
 * Returns an abort function.
 */
export function streamAgentChat(
  opts: { prompt: string; model: string },
  onEvent: (event: AgentEvent) => void,
  onDone?: () => void,
  onError?: (err: string) => void,
): () => void {
  const body = new FormData();
  body.append("prompt", opts.prompt);
  body.append("model", opts.model);

  const controller = new AbortController();

  apiFetch(`/api/agent/chat`, {
    method: "POST",
    body,
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        onError?.((await errorFrom(res)).message);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as AgentEvent;
              onEvent(event);
            } catch {
              /* skip malformed lines */
            }
          }
        }
      }
      onDone?.();
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        onError?.(String(err));
      }
    });

  return () => controller.abort();
}

export async function resetAgent(model: string) {
  const body = new FormData();
  body.append("model", model);
  const res = await apiFetch(`/api/agent/reset`, { method: "POST", body });
  return res.json();
}

// Web chat (tools-enabled) — SSE streaming with orchestration status events
export type WebChatEvent =
  | { type: "status"; text: string }
  | { type: "assistant"; content: string }
  | { type: "error"; error: string }
  | { type: "done"; energy_wh?: number; inference_time_ms?: number };

/**
 * Stream a web-chat turn as SSE events (status traces, assistant text, done).
 * Returns an abort function.
 */
export function streamWebChat(
  opts: { prompt: string; model: string; files?: File[] },
  onEvent: (event: WebChatEvent) => void,
  onDone?: () => void,
  onError?: (err: string) => void,
): () => void {
  const body = new FormData();
  body.append("prompt", opts.prompt);
  body.append("model", opts.model);
  (opts.files ?? []).forEach((f) => body.append("files", f));

  const controller = new AbortController();

  apiFetch(`/api/web/chat`, {
    method: "POST",
    body,
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        onError?.((await errorFrom(res)).message);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as WebChatEvent;
              onEvent(event);
            } catch {
              /* skip malformed lines */
            }
          }
        }
      }
      onDone?.();
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        onError?.(String(err));
      }
    });

  return () => controller.abort();
}

/** List documents persisted server-side in the RAG cache for a mode+model. */
export async function getRagDocuments(
  mode: "chat" | "web",
  model: string,
): Promise<string[]> {
  const r = await apiFetch(
    `/api/rag/documents?mode=${mode}&model=${encodeURIComponent(model)}`,
  );
  const j = await r.json();
  return j.documents ?? [];
}

export async function resetWeb(model: string) {
  const body = new FormData();
  body.append("model", model);
  const res = await apiFetch(`/api/web/reset`, { method: "POST", body });
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

  const res = await apiFetch(`/api/image-gen/generate`, { method: "POST", body });
  return res.json();
}

export async function getImageGenStatus(): Promise<{
  sd_available: boolean;
  sd_models: string[];
}> {
  const res = await apiFetch(`/api/image-gen/status`);
  return res.json();
}

export async function resetImageGen(model: string) {
  const body = new FormData();
  body.append("model", model);
  const res = await apiFetch(`/api/image-gen/reset`, { method: "POST", body });
  return res.json();
}

// ── Test Runner ──────────────────────────────────────────────────────────────

export async function getTestPromptFiles(): Promise<string[]> {
  const r = await apiFetch(`/api/test/prompt-files`);
  const j = await r.json();
  return j.files ?? [];
}

/**
 * Start a test run and stream its stdout lines via SSE.
 * Returns an abort function to cancel the stream.
 */
export function runTests(
  opts: {
    promptsFile: string;
    outputFile: string;
    model: string;
    thinkingMode: string;
    resetEvery: number;
  },
  onLine: (line: string) => void,
  onDone?: (exitCode: number) => void,
  onError?: (err: string) => void,
): () => void {
  const body = new FormData();
  body.append("prompts_file", opts.promptsFile);
  body.append("output_file", opts.outputFile);
  body.append("model", opts.model);
  body.append("thinking_mode", opts.thinkingMode);
  body.append("reset_every", String(opts.resetEvery));

  const controller = new AbortController();

  apiFetch(`/api/test/run`, {
    method: "POST",
    body,
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        onError?.(err.error || `HTTP ${res.status}`);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const part of chunk.split("\n\n")) {
          if (!part.startsWith("data:")) continue;
          try {
            const payload = JSON.parse(part.slice(5).trim());
            if (payload.error) {
              onError?.(payload.error);
            } else if (payload.done) {
              onDone?.(payload.exit_code ?? 0);
            } else if (payload.line !== undefined) {
              onLine(payload.line);
            }
          } catch {
            /* ignore malformed SSE */
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        onError?.(String(err));
      }
    });

  return () => controller.abort();
}

export async function stopTests(): Promise<void> {
  await apiFetch(`/api/test/stop`, { method: "POST" });
}

// ── About ────────────────────────────────────────────────────────────────────

export async function getAboutContent(): Promise<{ content: string }> {
  const res = await apiFetch(`/api/about`);
  return res.json();
}

// ── Conduct (log) ────────────────────────────────────────────────────────────

export type ConductPhase = "frame" | "explore" | "refine" | "commit";

export async function getConductContent(): Promise<{ reference: string; snippets: string }> {
  const res = await apiFetch(`/api/conduct/content`);
  return res.json();
}

/**
 * Derive a conduct log's filename stem from its title.
 * Must stay in step with conduct_store.slugify() on the backend — the
 * popover's "this log already exists" check compares against it.
 */
export function slugifyConductTitle(text: string, maxWords = 4): string {
  const words = text.trim().split(/\s+/).slice(0, maxWords).join(" ");
  const slug = words.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "conduct-log";
}

export type ConductLogSummary = {
  slug: string;
  title: string;
  path: string;
  updated_at: number;
  entry_count: number;
  phase_counts: Record<ConductPhase, number>;
};

export async function getConductLogs(): Promise<ConductLogSummary[]> {
  const res = await apiFetch(`/api/conduct/logs`);
  const j = await res.json();
  return j.logs ?? [];
}

export async function indexConductLog(
  slug: string,
  model?: string,
): Promise<{ ok?: boolean; error?: string; chunks?: number | null; skipped?: boolean; model?: string }> {
  const res = await apiFetch(`/api/conduct/log/${encodeURIComponent(slug)}/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model ? { model } : {}),
  });
  return res.json();
}

export async function unindexConductLog(
  slug: string,
  model?: string,
): Promise<{ ok?: boolean; error?: string; removed?: number; model?: string }> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : "";
  const res = await apiFetch(
    `/api/conduct/log/${encodeURIComponent(slug)}/index${qs}`,
    { method: "DELETE" },
  );
  return res.json();
}

/** A log's markdown, for the read-only view. Display only — appends still
 *  go through appendConductLog(). */
export async function getConductLogContent(
  slug: string,
): Promise<{ content?: string; error?: string }> {
  const res = await apiFetch(`/api/conduct/log/${encodeURIComponent(slug)}`);
  return res.json();
}

export async function openConductPath(
  path: string,
  reveal = false,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`/api/conduct/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, reveal }),
  });
  return res.json();
}

export async function appendConductLog(
  slug: string,
  entry: {
    phase: ConductPhase;
    note: string;
    prompt: string;
    response: string;
    model?: string | null;
    mode?: string | null;
    energy_wh?: number | null;
    title?: string;
  },
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const res = await apiFetch(
    `/api/conduct/log/${encodeURIComponent(slug)}/append`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    },
  );
  return res.json();
}

// ── Accounts (server mode, SERVER_STAGE1.md §2) ──

export type Capabilities = {
  agent: boolean;          // Agent mode and the Code tab run commands on the host Mac
  code_tab: boolean;
  test_runner: boolean;
  conduct_open: boolean;   // open/reveal log files on the host Mac
  manage_models: boolean;
  manage_users: boolean;
};

export type AccountUser = { id: number; username: string; role: "admin" | "user"; is_owner: boolean };

export type Me = {
  user: AccountUser | null;
  local: boolean;          // at the host Mac: no login, every feature
  has_password?: boolean;
  capabilities?: Capabilities;
};

async function sendJson<T = any>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

async function getJson<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export const getMe = () => getJson<Me>(`/api/me`);
export const login = (username: string, password: string) =>
  sendJson(`/api/auth/login`, { username, password });
export const logout = () => sendJson(`/api/auth/logout`);
export const changePassword = (newPassword: string, currentPassword?: string) =>
  sendJson(`/api/auth/password`, { new_password: newPassword, current_password: currentPassword });

export const getInvite = (token: string) =>
  getJson<{ role: string; note: string }>(`/api/auth/invite/${encodeURIComponent(token)}`);
export const acceptInvite = (token: string, username: string, password: string) =>
  sendJson(`/api/auth/invite/${encodeURIComponent(token)}`, { username, password });
export const getReset = (token: string) =>
  getJson<{ username: string }>(`/api/auth/reset/${encodeURIComponent(token)}`);
export const acceptReset = (token: string, password: string) =>
  sendJson(`/api/auth/reset/${encodeURIComponent(token)}`, { password });

export type AdminUser = AccountUser & {
  status: "active" | "disabled";
  created_at: number;
  last_seen_at: number | null;
  has_password: boolean;
};
export type Invite = { id: number; role: string; note: string; created_at: number; expires_at: number };

export const listUsers = () => getJson<{ users: AdminUser[] }>(`/api/admin/users`);
export const updateUser = (id: number, patch: { role?: string; status?: string }) =>
  sendJson(`/api/admin/users/${id}`, patch);
export const deleteUser = (id: number) => sendJson(`/api/admin/users/${id}`, undefined, "DELETE");
export const createResetLink = (id: number) =>
  sendJson<{ url: string; expires_hours: number }>(`/api/admin/users/${id}/reset-link`);
export const listInvites = () => getJson<{ invites: Invite[] }>(`/api/admin/invites`);
export const createInvite = (role: string, note: string) =>
  sendJson<{ url: string; expires_days: number }>(`/api/admin/invites`, { role, note });
export const revokeInvite = (id: number) => sendJson(`/api/admin/invites/${id}`, undefined, "DELETE");

// ── Admin: energy report (Energy page) ──

export type EnergyGroup = { prompts: number; wh: number; last: string | null };
export type EnergyReport = {
  from: string;
  to: string;
  totals: { wh: number; prompts: number; people_active: number; people: number };
  people: (EnergyGroup & { user: string; deleted: boolean })[];
  modes: (EnergyGroup & { mode: string })[];
  models: (EnergyGroup & { model: string })[];
  days: { day: string; prompts: number; wh: number }[];
};

/** days = 0 for all time */
export const getEnergyReport = (days: number) => getJson<EnergyReport>(`/api/admin/energy?days=${days}`);

export type ActivePerson = {
  username: string;
  seconds_ago: number | null;
  status: "running" | "waiting" | null;
  ahead: number | null;
  doing: string | null;
};

export type AdminActivity = {
  window_minutes: number;
  running: boolean;
  waiting: number;
  people: ActivePerson[];
};

export const getAdminActivity = () => getJson<AdminActivity>(`/api/admin/activity`);

// A plain link: the browser downloads it with the session cookie
export const ENERGY_CSV_URL = `${API_BASE}/api/admin/energy.csv`;
