import React, { useState, useRef, useEffect } from "react";

type Props = { onSend: (text: string) => void; disabled?: boolean };

export default function ChatInput({ onSend, disabled = false }: Props) {
    const [text, setText] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    function doSend() {
        const trimmed = text.trim();
        if (!trimmed) return;
        onSend(trimmed);
        setText("");
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        doSend();
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            doSend();
        }
    }

    // Auto-resize
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = el.scrollHeight + "px";
    }, [text]);

    return (
        <form className="chat-input" onSubmit={handleSubmit} aria-label="Chat composer">
            <textarea
                ref={textareaRef}
                className="chat-text"
                placeholder={disabled ? "Waiting for model…" : "Message Uness…"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                disabled={disabled}
            />
            <button
                className="chat-send"
                type="submit"
                aria-label="Send message"
                disabled={disabled || !text.trim()}
            >
                ➤
            </button>
        </form>
    );
}
