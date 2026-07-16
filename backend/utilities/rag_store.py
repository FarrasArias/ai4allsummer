# backend/utilities/rag_store.py
"""
Minimal local RAG store built on Ollama embeddings.

- Chunks documents into overlapping, paragraph-aware pieces
- Embeds chunks locally via an Ollama embedding model
- Retrieves top-k chunks by cosine similarity at question time
- Keeps source filename + PDF page number per chunk so excerpts can cite both
- Optionally persists to disk (JSON + .npy) so uploads survive restarts

No external vector database: for the handful of documents a chat session
loads, a numpy matrix is simpler and faster than running a DB.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import List, Optional, Tuple, Union

import numpy as np
import ollama

logger = logging.getLogger(__name__)

Segment = Tuple[Optional[int], str]  # (pdf page number or None, text)


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
    """Vector store for one engine's uploaded documents (per model, per mode).

    Pass persist_dir to survive backend restarts: chunk texts/metadata go to
    meta.json and the embedding matrix to matrix.npy in that directory.
    """

    def __init__(self, persist_dir: Optional[Union[str, Path]] = None):
        self._chunks: List[str] = []
        self._sources: List[str] = []  # document name per chunk
        self._pages: List[Optional[int]] = []  # pdf page per chunk (or None)
        self._matrix: Optional[np.ndarray] = None  # (n, d), rows L2-normalized
        self._available: Optional[bool] = None  # lazily checked once
        self._persist_dir = Path(persist_dir) if persist_dir else None
        if self._persist_dir:
            self._load_from_disk()

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

    def has_document(self, name: str) -> bool:
        return name in self._sources

    def document_names(self) -> List[str]:
        seen: List[str] = []
        for s in self._sources:
            if s not in seen:
                seen.append(s)
        return seen

    # ── indexing ──
    def add_document(
        self,
        name: str,
        content: Union[str, List[Segment]],
    ) -> Optional[dict]:
        """
        Chunk + embed + index a document.

        content may be a plain string or a list of (page, text) segments —
        segments preserve PDF page numbers for citations.

        Returns summary metadata, or None if RAG is unavailable — the caller
        should then fall back to stuffing the full text into the prompt.
        """
        if not self.is_available():
            return None

        segments: List[Segment] = (
            [(None, content)] if isinstance(content, str) else list(content)
        )

        new_chunks: List[str] = []
        new_pages: List[Optional[int]] = []
        for page, text in segments:
            for chunk in chunk_text(text):
                new_chunks.append(chunk)
                new_pages.append(page)

        if not new_chunks:
            return {"chunks": 0}

        try:
            vectors = np.asarray(_embed_batch(new_chunks), dtype=np.float32)
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

        self._chunks.extend(new_chunks)
        self._sources.extend([name] * len(new_chunks))
        self._pages.extend(new_pages)
        self._matrix = (
            vectors if self._matrix is None else np.vstack([self._matrix, vectors])
        )
        self._save_to_disk()
        logger.info("✓ Indexed %s: %d chunks", name, len(new_chunks))
        return {"chunks": len(new_chunks)}

    # ── retrieval ──
    def search(self, query: str, k: int = TOP_K) -> List[dict]:
        """Return top-k chunks as [{source, page, text, score}], best first."""
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
                "page": self._pages[i],
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
        parts = []
        for i, h in enumerate(hits, 1):
            where = f"from {h['source']}"
            if h["page"] is not None:
                where += f", page {h['page']}"
            parts.append(f"[Excerpt {i} — {where}]\n{h['text']}")
        return "\n\n".join(parts)

    def clear(self) -> None:
        self._chunks = []
        self._sources = []
        self._pages = []
        self._matrix = None
        if self._persist_dir and self._persist_dir.exists():
            try:
                shutil.rmtree(self._persist_dir)
            except OSError as e:
                logger.warning("Could not remove rag cache %s: %s", self._persist_dir, e)

    # ── persistence ──
    def _save_to_disk(self) -> None:
        if not self._persist_dir or self._matrix is None:
            return
        try:
            self._persist_dir.mkdir(parents=True, exist_ok=True)
            meta = {
                "embed_model": EMBED_MODEL,
                "chunks": self._chunks,
                "sources": self._sources,
                "pages": self._pages,
            }
            with open(self._persist_dir / "meta.json", "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False)
            np.save(self._persist_dir / "matrix.npy", self._matrix)
        except OSError as e:
            logger.warning("Could not persist rag store to %s: %s", self._persist_dir, e)

    def _load_from_disk(self) -> None:
        meta_path = self._persist_dir / "meta.json"
        matrix_path = self._persist_dir / "matrix.npy"
        if not (meta_path.exists() and matrix_path.exists()):
            return
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if meta.get("embed_model") != EMBED_MODEL:
                # Embeddings from a different model aren't comparable — discard
                logger.info(
                    "Discarding rag cache %s (embed model changed: %s → %s)",
                    self._persist_dir,
                    meta.get("embed_model"),
                    EMBED_MODEL,
                )
                shutil.rmtree(self._persist_dir, ignore_errors=True)
                return
            matrix = np.load(matrix_path)
            chunks = meta.get("chunks", [])
            if len(chunks) != matrix.shape[0]:
                logger.warning("Rag cache %s is inconsistent — discarding", self._persist_dir)
                shutil.rmtree(self._persist_dir, ignore_errors=True)
                return
            self._chunks = chunks
            self._sources = meta.get("sources", [])
            self._pages = [
                (int(p) if p is not None else None) for p in meta.get("pages", [])
            ]
            self._matrix = matrix.astype(np.float32)
            logger.info(
                "✓ Restored rag store from %s (%d chunks, %d documents)",
                self._persist_dir,
                len(self._chunks),
                len(self.document_names()),
            )
        except Exception as e:
            logger.warning("Could not load rag cache %s: %s", self._persist_dir, e)
