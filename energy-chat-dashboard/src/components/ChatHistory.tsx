import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { InferenceMetrics } from "../api";

type Msg = { role: "user" | "bot"; text: string; metrics?: InferenceMetrics };
type Props = {
  messages: Msg[];
  isStreaming?: boolean;
  thinkingMode?: "fast" | "deep";
};

// Format milliseconds to human-readable string
function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(0);
  return `${minutes}m ${remainingSeconds}s`;
}

// Format energy to human-readable string
function formatEnergy(wh: number): string {
  if (wh < 0.001) return `${(wh * 1000000).toFixed(2)} µWh`;
  if (wh < 1) return `${(wh * 1000).toFixed(2)} mWh`;
  return `${wh.toFixed(4)} Wh`;
}

// Rotating thinking messages for deep thinking mode
const THINKING_MESSAGES = [
  "Analyzing the question...",
  "Retrieving relevant knowledge...",
  "Evaluating possible approaches...",
  "Organizing the response...",
  "Composing final answer...",
];

export default function ChatHistory({ messages, isStreaming = false, thinkingMode = "fast" }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0);

  useEffect(() => {
    ref.current?.scrollTo({
      top: ref.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isStreaming]);

  // Rotate thinking messages every 10 seconds during deep thinking
  useEffect(() => {
    if (!isStreaming || thinkingMode !== "deep") {
      setThinkingMessageIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setThinkingMessageIndex((prev) => (prev + 1) % THINKING_MESSAGES.length);
    }, 10000); // 10 seconds

    return () => clearInterval(interval);
  }, [isStreaming, thinkingMode]);

  return (
    <div className="chat-history" ref={ref} aria-label="Chat history">
      {messages.map((m, i) => (
        <div key={i} className={`chat-bubble ${m.role}`}>
          <div className="bubble">
            <ReactMarkdown
              components={{
                strong: ({ node, ...props }) => (
                  <strong className="markdown-bold" {...props} />
                ),
                em: ({ node, ...props }) => (
                  <em className="markdown-italic" {...props} />
                ),
                h1: ({ node, ...props }) => (
                  <h1 className="markdown-h1" {...props} />
                ),
                h2: ({ node, ...props }) => (
                  <h2 className="markdown-h2" {...props} />
                ),
                ul: ({ node, ...props }) => (
                  <ul className="markdown-ul" {...props} />
                ),
                ol: ({ node, ...props }) => (
                  <ol className="markdown-ol" {...props} />
                ),
                li: ({ node, ...props }) => (
                  <li className="markdown-li" {...props} />
                ),
                code: ({ node, ...props }) => (
                  <pre className="markdown-code-block">
                    <code {...props} />
                  </pre>
                ),
              }}
            >
              {m.text}
            </ReactMarkdown>
            {/* Display inference metrics for bot messages */}
            {m.role === "bot" && m.metrics && (
              <div className="inference-metrics">
                <span title="Inference time">⏱ {formatTime(m.metrics.inference_time_ms)}</span>
                <span title="Energy consumption">⚡ {formatEnergy(m.metrics.energy_wh)}</span>
                {(m.metrics.input_tokens != null || m.metrics.output_tokens != null) && (
                  <span title="Tokens: user prompt / total context → output">
                    Tokens: {m.metrics.user_prompt_tokens ?? "?"}/{m.metrics.input_tokens ?? "?"} → {m.metrics.output_tokens ?? "?"}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}

      {isStreaming && (
        <div className="chat-bubble bot">
            <div
            className="bubble typing-indicator"
            aria-label="Assistant is responding"
            >
                {thinkingMode === "deep" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontStyle: "italic", opacity: 0.9 }}>
                      {THINKING_MESSAGES[thinkingMessageIndex]}
                    </span>
                    <span className="thinking-dots">
                      <span></span>
                      <span></span>
                      <span></span>
                    </span>
                  </div>
                ) : (
                  <>
                    <span></span>
                    <span></span>
                    <span></span>
                  </>
                )}
            </div>
        </div>
        )}
    </div>
  );
}
