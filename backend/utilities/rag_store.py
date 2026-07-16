# backend/utilities/rag_store.py
"""
Minimal local RAG store built on Ollama embeddings.

- Chunks documents into overlapping, paragraph-aware pieces
- Embeds chunks locally via an Ollama embedding model
- Retrieves top-k chunks by cosine similarity at question time

No external vector database: for the handful of documents a chat session
loads, a numpy matrix is simpler and faster than running a DB. Everything
stays in memory with the chat engine that owns it (documents are
re-uploaded after a server restart, same as the old document window).
"""

from __future__ import annotations

import json
import logging
import os
from typing import List, Optional

import numpy as np
import ollama

logger = logging.getLogger(__name__)


def _default_embed_model() -> str:
    env = os.environ.get("OLLAMA_EMBED_MODEL")
    if env:
        return env
    try:
        with open(os.path.join("configs", "models.json"), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        model = cfg.get("embedding", {}).get("default")
        if model:
            return model
    except (OSError, json.JSONDecodeError):
        pass
    return "nomic-embed-text"


EMBED_MODEL = _default_embed_model()

# Chunking parameters (characters; ~4 chars/token → ~375 tokens per chunk)
CHUNK_CHARS = 1500
CHUNK_OVERLAP = 200

# Retrieval
TOP_K = 4


def chunk_text(
    text: str,
    max_chars: int = CHUNK_CHARS,
    overlap: int = CHUNK_OVERLAP,
) -> List[str]:
    """Split text into overlapping chunks, preferring paragraph boundaries."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: List[str] = []
    current = ""

    def flush():
        nonlocal current
        if current.strip():
            chunks.append(current.strip())
        current = ""

    for para in paragraphs:
        if len(para) > max_chars:
            # Oversized paragraph: flush what we have, then hard-split it
            flush()
            start = 0
            while start < len(para):
                piece = para[start : start + max_chars].strip()
                if piece:
                    chunks.append(piece)
                start += max_chars - overlap
        elif len(current) + len(para) + 2 > max_chars:
            flush()
            current = para
        else:
            current = f"{current}\n\n{para}" if current else para
    flush()
    return chunks


def _embed_batch(texts: List[str]) -> List[List[float]]:
    """Embed texts via Ollama, handling both new and legacy client APIs."""
    try:
        resp = ollama.embed(model=EMBED_MODEL, input=list(texts))
        embs = (
            resp.get("embeddings")
            if isinstance(resp, dict)
            else getattr(resp, "embeddings", None)
        )
        if embs:
            return [[float(x) for x in e] for e in embs]
    except AttributeError:
        pass  # older ollama-python without embed(): fall through
    out: List[List[float]] = []
    for t in texts:
        resp = ollama.embeddings(model=EMBED_MODEL, prompt=t)
        emb = (
            resp.get("embedding")
            if isinstance(resp, dict)
            else getattr(resp, "embedding", None)
        )
        out.append([float(x) for x in emb])
    return out


class RagStore:
    """In-memory vector store for one chat engine's uploaded documents."""

    def __init__(self):
        self._chunks: List[str] = []
        self._sources: List[str] = []  # document name per chunk
        self._matrix: Optional[np.ndarray] = None  # (n, d), rows L2-normalized
        self._available: Optional[bool] = None  # lazily checked once

    # ── availability ──
    def is_available(self) -> bool:
        """True if the embedding model is installed in Ollama (checked once)."""
        if self._available is None:
            try:
                ollama.show(EMBED_MODEL)
                self._available = True
            except Exception:
                self._available = False
                logger.warning(
                    "Embedding model '%s' not found — RAG disabled, falling back "
                    "to full-document context. Enable with: ollama pull %s",
                    EMBED_MODEL,
                    EMBED_MODEL,
                )
        return self._available

    def has_documents(self) -> bool:
        return self._matrix is not None and len(self._chunks) > 0

    # ── indexing ──
    def add_document(self, name: str, text: str) -> Optional[dict]:
        """
        Chunk + embed + index a document.

        Returns summary metadata, or None if RAG is unavailable — the caller
        should then fall back to stuffing the full text into the prompt.
        """
        if not self.is_available():
            return None
        chunks = chunk_text(text)
        if not chunks:
            return {"chunks": 0}
        try:
            vectors = np.asarray(_embed_batch(chunks), dtype=np.float32)
        except Exception as e:
            logger.error(
                "Embedding failed for %s: %s — falling back to full-document context",
                name,
                e,
            )
            return None
        # L2-normalize rows so dot product == cosine similarity
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vectors = vectors / norms

        self._chunks.extend(chunks)
        self._sources.extend([name] * len(chunks))
        self._matrix = (
            vectors if self._matrix is None else np.vstack([self._matrix, vectors])
        )
        logger.info("✓ Indexed %s: %d chunks", name, len(chunks))
        return {"chunks": len(chunks)}

    # ── retrieval ──
    def search(self, query: str, k: int = TOP_K) -> List[dict]:
        """Return top-k chunks as [{source, text, score}], best first."""
        if not self.has_documents():
            return []
        try:
            qvec = np.asarray(_embed_batch([query])[0], dtype=np.float32)
        except Exception as e:
            logger.error("Query embedding failed: %s", e)
            return []
        qnorm = np.linalg.norm(qvec)
        if qnorm == 0:
            return []
        scores = self._matrix @ (qvec / qnorm)
        top = np.argsort(scores)[::-1][:k]
        return [
            {
                "source": self._sources[i],
                "text": self._chunks[i],
                "score": float(scores[i]),
            }
            for i in top
        ]

    def build_context(self, query: str, k: int = TOP_K) -> str:
        """Format retrieved chunks as a context block for the system prompt."""
        hits = self.search(query, k)
        if not hits:
            return ""
        parts = [
            f"[Excerpt {i} — from {h['source']}]\n{h['text']}"
            for i, h in enumerate(hits, 1)
        ]
        return "\n\n".join(parts)

    def clear(self) -> None:
        self._chunks = []
        self._sources = []
        self._matrix = None
