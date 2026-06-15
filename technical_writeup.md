# System Architecture and Energy Measurement Methodology

## 1. System Overview

The platform is a full-stack research instrument designed to study human interaction with large language models (LLMs) while simultaneously measuring the per-prompt energy cost of inference. It pairs a Python backend (FastAPI) with a browser-based frontend (React/TypeScript) and delegates all model inference to locally hosted open-weight models served through Ollama. The system supports multiple interaction modalities—conversational chat, code assistance, web-augmented chat, image analysis, and image generation—each backed by a dedicated model and session engine. A configurable study framework enables between-subjects experimental designs by assigning participants to either an *intervention* group, which receives real-time energy feedback during interaction, or a *control* group, which does not.

All computation occurs on-premises. No queries leave the local network. Energy telemetry is collected directly from the GPU hardware via the NVIDIA Management Library (NVML), and inference metrics (token counts, latency) are extracted from Ollama's streaming response protocol.

## 2. Backend Architecture

### 2.1 Model Serving

Ollama manages model lifecycle—downloading, loading into GPU memory, and serving inference requests through a local REST API. The backend maintains a model configuration file (`models.json`) that maps each interaction mode to a default model:

| Mode            | Default Model          | Purpose                              |
|-----------------|------------------------|--------------------------------------|
| Chat (fast)     | `qwen2.5:14b`         | Direct-answer conversational chat    |
| Chat (deep)     | `qwen3:14b`           | Chain-of-thought reasoning chat      |
| Code Assistance | `qwen2.5-coder:7b`    | Code generation and debugging        |
| Web Chat        | `qwen2.5:7b`          | Tool-augmented web search chat       |
| Image Analysis  | `qwen2.5vl:7b`        | Multimodal image understanding       |
| Image Generation| `qwen2.5:7b`          | Prompt enhancement for Stable Diffusion |

Users may override these defaults at runtime. Each mode maintains an independent session engine so that conversation history and loaded documents do not bleed across modalities.

### 2.2 Conversation Memory and Context Management

The primary chat engine (`OllamaChat`) maintains a full conversation history as an ordered list of user–assistant message pairs. On each inference call, the engine assembles a prompt consisting of:

1. A **system prompt** containing task instructions and, if documents have been loaded, the full text of those documents annotated with filename headers.
2. The **complete conversation history** accumulated since the last session reset.

Token usage is estimated at approximately one token per four characters of text (a standard heuristic for English-dominant text with Qwen-family tokenizers). The engine enforces a context ceiling of 120,000 tokens and issues warnings when utilization exceeds 80%.

Document ingestion supports PDF (via PyMuPDF page-by-page text extraction), DOCX (paragraph extraction), CSV (statistical summary of the first 20 rows), and plain text with multi-encoding fallback (UTF-8 → Latin-1 → CP-1252 → ISO-8859-1).

### 2.3 Thinking Modes

The chat interface exposes two inference modes that govern model selection and reasoning behaviour:

- **Fast mode**: Uses a smaller, lower-latency model with the Qwen3 reasoning toggle disabled (`think=False`). The model produces a direct answer with no internal chain-of-thought.
- **Deep mode**: Uses a larger, reasoning-capable model with the toggle enabled (`think=True`). The model performs an internal reasoning pass before generating its visible response; reasoning tokens are consumed but not surfaced to the user.

Both modes use a sampling temperature of 0.6 and impose no cap on generated tokens (`num_predict = -1`), ensuring complete responses regardless of length.

### 2.4 Streaming Protocol

All chat responses are delivered as **Server-Sent Events (SSE)**. During inference, the backend yields incremental text chunks:

```
data: {"delta": "<token>"}
```

Upon completion, a terminal event is emitted containing per-prompt metrics:

```
data: {
  "done": true,
  "inference_time_ms": <int>,
  "energy_wh": <float>,
  "input_tokens": <int>,
  "output_tokens": <int>,
  "user_prompt_tokens": <int>
}
```

Here, `input_tokens` and `output_tokens` are reported by Ollama via the `prompt_eval_count` and `eval_count` fields of its final streaming chunk. `user_prompt_tokens` is the heuristic estimate (character count / 4) of the user's message alone, excluding system prompt and conversation history. `inference_time_ms` is wall-clock time from the first call to `stream_chat()` to the final chunk.

## 3. Energy Measurement Methodology

### 3.1 Hardware Telemetry

GPU power draw is sampled via the NVIDIA Management Library (`pynvml`). Each call to the measurement function initialises the library, queries device index 0 for instantaneous power consumption in milliwatts via `nvmlDeviceGetPowerUsage()`, converts to watts, and shuts down the library handle:

$$P_{\text{gpu}}(t) = \frac{\texttt{nvmlDeviceGetPowerUsage}(t)}{1000} \quad [\text{W}]$$

This provides a point-in-time reading of the GPU's total board power draw, inclusive of all active workloads.

### 3.2 Idle Baseline Estimation

A background monitoring thread, running at a fixed period of $\Delta t = 0.2\;\text{s}$, maintains a running estimate of the GPU's idle power consumption using an exponential moving average (EMA):

$$\bar{P}_{\text{idle}}^{(k)} = \alpha \cdot \bar{P}_{\text{idle}}^{(k-1)} + (1 - \alpha) \cdot P_{\text{gpu}}^{(k)}$$

where $\alpha = 0.5$ is the decay factor and the update is applied only when no inference operation is active (i.e., the system is idle). This provides a smoothed estimate of baseline GPU power that adapts to thermal drift and background system load.

### 3.3 Per-Prompt Energy Calculation

When a user submits a prompt, energy is measured inline within the streaming response generator using the following procedure:

**Step 1 — Baseline capture.** Immediately before inference begins, a single GPU power reading is taken. This serves as the idle reference for this specific prompt:

$$P_{\text{baseline}} = P_{\text{gpu}}(t_0)$$

**Step 2 — Inference sampling.** During the streaming loop, GPU power is sampled at approximately 0.2-second intervals. Each chunk yielded by the model triggers a time check; if at least 0.2 seconds have elapsed since the last sample, a new reading is recorded. A final sample is taken immediately after the last token is generated. This produces a set of $n$ inference-time power readings:

$$\mathcal{S} = \{P_{\text{gpu}}(t_1),\; P_{\text{gpu}}(t_2),\; \ldots,\; P_{\text{gpu}}(t_n)\}$$

**Step 3 — Energy computation.** The per-prompt energy is computed as the product of net average power above baseline and total elapsed time, converted from watt-seconds to watt-hours:

$$E_{\text{prompt}} = \max\!\left(0,\;\; \frac{\left(\bar{P}_{\text{inference}} - P_{\text{idle}}\right) \cdot \Delta t_{\text{elapsed}}}{3600}\right) \quad [\text{Wh}]$$

where:

$$\bar{P}_{\text{inference}} = \frac{1}{n} \sum_{i=1}^{n} P_{\text{gpu}}(t_i)$$

$$\Delta t_{\text{elapsed}} = t_{\text{end}} - t_{\text{start}} \quad [\text{s}]$$

$$P_{\text{idle}} = \begin{cases} P_{\text{baseline}} & \text{if } P_{\text{baseline}} > 0 \\ \bar{P}_{\text{idle}}^{(k)} & \text{otherwise (fallback to EMA)} \end{cases}$$

The `max(0, ·)` clamp ensures that measurement noise does not produce negative energy values. Importantly, the baseline sample is **not** included in $\mathcal{S}$; it is used only as the idle reference. This prevents the pre-inference idle reading from diluting the inference-time power average—a correction that is critical for short-duration prompts where few samples are collected.

### 3.4 Session and Daily Aggregation

Per-prompt energy values are accumulated into two running totals:

- **Session total**: The sum of all `E_prompt` values since the last session reset, maintained in server memory.
- **Daily total**: The sum of all recorded entries for the current calendar date, computed by aggregating the persistent energy log stored at `reports/power_consumption_reports.json`.

Each completed inference appends a timestamped record to this log:

```json
{"date": "2026-04-16 14:23:45", "power": 0.0065, "model": "qwen3:1.7b"}
```

These totals are served to the frontend via a streaming endpoint (`/api/power/stream`) that pushes updated summaries at one-second intervals.

### 3.5 Measurement Limitations

Several limitations of this approach should be noted:

1. **Board-level granularity.** NVML reports total GPU board power, not per-process power. If other GPU workloads are active concurrently, their power draw will be attributed to the inference measurement.
2. **Sampling resolution.** At a 0.2-second interval, prompts completing in under 200 ms may yield zero or one inference-time sample. The system mitigates this by capturing a post-inference sample, but very short inferences may still be underestimated.
3. **CPU energy exclusion.** The current implementation measures GPU power only. CPU load is monitored (via `psutil.cpu_percent()`) but is not incorporated into the energy calculation, as CPU contribution to LLM inference is typically small relative to GPU power on systems with dedicated accelerators.
4. **Token estimation.** The user-prompt token count is a heuristic (characters / 4), not a model-specific tokeniser count. Actual token counts from Ollama (`prompt_eval_count`, `eval_count`) are used for all other token metrics.

## 4. Frontend Architecture and Study Design

### 4.1 Experimental Groups

The platform implements a between-subjects design with two conditions:

- **Intervention group**: Participants see a persistent sidebar displaying real-time energy metrics, an impact grade label (A–E), and behavioural tips encouraging energy-efficient interaction patterns.
- **Control group**: Participants interact with an identical chat interface but receive no energy feedback. The sidebar is hidden.

Group assignment is configured per participant at the start of a session and persisted in browser local storage.

### 4.2 Impact Grade Classification

The intervention sidebar classifies cumulative energy usage into five impact grades using a rolling window of recent prompt energy values:

| Grade | Threshold (Wh)  | Description                        |
|-------|------------------|------------------------------------|
| A     | $\leq 0.05$     | Very low estimated impact          |
| B     | $\leq 0.15$     | Low impact — efficient use         |
| C     | $\leq 0.50$     | Moderate impact                    |
| D     | $\leq 1.50$     | High impact                        |
| E     | $> 1.50$        | Very high impact                   |

Grading is deferred until at least five prompts have been submitted to avoid premature classification from insufficient data. The grading input value is, by preference: (1) the rolling average of the last five prompt energies, (2) the session total energy, or (3) the latest single-prompt energy.

### 4.3 Session Management

Each participant completes up to two sessions. The platform tracks:

- **Per-prompt metrics**: timestamp, prompt text, word count, character count.
- **Per-prompt inference metrics**: latency (ms), energy (Wh), input tokens (context), output tokens, user prompt tokens.
- **Session-level metadata**: participant identifier, group assignment, session number, task start/end timestamps, and cumulative energy totals.

At session close, the complete data bundle—message history, prompt metrics, session metadata with energy totals, and an optional interview transcript—is persisted to the server filesystem. When a participant begins Session 2, the Session 1 energy total is retrieved from local storage and displayed for comparison, enabling within-subject longitudinal analysis.

## 5. Automated Batch Testing

An automated test runner enables systematic benchmarking of model performance and energy consumption across standardised prompt sets. The runner operates as a standalone Python script that communicates with the running backend server over the same SSE streaming API used by the frontend.

### 5.1 Execution Model

The runner loads prompts from a CSV or plain-text file, iterates through them sequentially, and writes per-prompt results to an output CSV. For each prompt, it:

1. Sends the prompt as a multipart POST request to the `/api/chat` endpoint.
2. Consumes the SSE stream, accumulating generated text.
3. Extracts metrics from the terminal `done` event: `inference_time_ms`, `energy_wh`, `input_tokens`, `output_tokens`, `user_prompt_tokens`.

To control for context-length effects on latency and energy, the runner resets the backend conversation history every $N$ prompts (configurable, default $N = 5$). This ensures that early prompts in a batch do not benefit from artificially short context windows while later prompts are penalised by long accumulated histories.

### 5.2 Output Schema

Each row of the output CSV contains:

| Field                | Description                                              |
|----------------------|----------------------------------------------------------|
| `index`              | Zero-based prompt index                                  |
| `timestamp`          | ISO-8601 completion time                                 |
| `model`              | Ollama model identifier                                  |
| `thinking_mode`      | `fast` or `deep`                                         |
| `prompt`             | User prompt text                                         |
| `response`           | Full model response text                                 |
| `inference_time_ms`  | Wall-clock inference latency                             |
| `energy_wh`          | Per-prompt GPU energy (Wh)                               |
| `input_tokens`       | Total input context tokens (from Ollama)                 |
| `output_tokens`      | Generated output tokens (from Ollama)                    |
| `user_prompt_tokens` | Estimated tokens for user prompt only                    |
| `error`              | Error message, if any                                    |

The runner supports resume (`--resume` flag), appending to an existing output file from the last completed prompt, enabling recovery from interruptions without data loss.

## 6. Summary

The system provides an end-to-end research platform for studying human–LLM interaction under varying levels of energy awareness. Its key technical contributions are:

1. **Inline per-prompt energy measurement** using direct GPU hardware telemetry, with per-prompt baseline correction and sub-second sampling during inference.
2. **A configurable study framework** supporting between-subjects experimental designs with real-time energy feedback as the intervention variable.
3. **Multi-modal LLM interaction** across five distinct task types, each with independent session management and model configuration.
4. **Automated benchmarking** with controlled context-length resets and standardised output for reproducible energy and performance analysis.

All energy calculations are performed on raw GPU power readings without reliance on manufacturer-reported TDP values or software-estimated proxies, providing empirically grounded per-prompt energy attribution suitable for quantitative analysis.
