# backend/utilities/doc_loaders.py
"""
Shared document text extraction for the chat and web modes.

Extracts TEXT ONLY — images and graphics in documents are deliberately not
processed (energy policy: vision inference is explicit and user-initiated via
the Image tab). When figures are detected, an inline note is appended so the
model can point the user at them.

The unit of output is a segment: (page_number | None, text). PDFs produce one
segment per page so retrieval excerpts can cite page numbers; other formats
produce a single segment with page None.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional, Tuple

import PyPDF2
import docx
import pandas as pd

logger = logging.getLogger(__name__)

Segment = Tuple[Optional[int], str]


def load_pdf_segments(pdf_path: str) -> List[Segment]:
    """Extract per-page text from a PDF, flagging (but not processing) figures."""
    segments: List[Segment] = []
    with open(pdf_path, "rb") as file:
        reader = PyPDF2.PdfReader(file)
        for page_num, page in enumerate(reader.pages, start=1):
            page_text = page.extract_text() or ""

            # Detect images but do NOT process them (see module docstring)
            try:
                image_count = len(page.images)
            except Exception:
                image_count = 0
            if image_count:
                page_text += (
                    f"\n[Note: page {page_num} contains {image_count} "
                    f"figure(s)/graphic(s). They are not read in chat — "
                    f"use the Image tool to analyze them.]"
                )

            if page_text.strip():
                segments.append((page_num, page_text))
    return segments


def load_docx_text(docx_path: str) -> str:
    """Extract text from a DOCX file, flagging (but not processing) images."""
    doc = docx.Document(docx_path)
    text = "\n\n".join(
        paragraph.text for paragraph in doc.paragraphs if paragraph.text
    )
    try:
        image_count = len(doc.inline_shapes)
    except Exception:
        image_count = 0
    if image_count:
        text += (
            f"\n\n[Note: this document contains {image_count} embedded "
            f"image(s). They are not read in chat — use the Image tool to "
            f"analyze them.]"
        )
    return text


def load_txt_text(txt_path: str) -> str:
    """Load a text file with basic encoding fallback."""
    encodings = ["utf-8", "latin-1", "cp1252", "iso-8859-1"]
    for enc in encodings:
        try:
            with open(txt_path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Could not decode {txt_path} with any common encoding")


def load_csv_text(csv_path: str) -> str:
    """Summarize a CSV file as readable text instead of dumping the whole thing."""
    df = pd.read_csv(csv_path)

    text = "CSV File Summary:\n"
    text += f"Rows: {len(df)}, Columns: {len(df.columns)}\n"
    text += f"Column Names: {', '.join(df.columns)}\n\n"
    text += "First 20 rows:\n"
    text += f"{df.head(20).to_string()}\n\n"
    text += "Data Types:\n"
    text += f"{df.dtypes.to_string()}\n\n"
    text += "Basic Statistics:\n"
    text += f"{df.describe().to_string()}"
    return text


def extract_document(file_path: str) -> List[Segment]:
    """
    Extract a document into segments by file type.

    Supports .pdf (per-page segments), .docx/.doc, .txt, .csv (single segment).
    Raises ValueError for unsupported types.
    """
    path = Path(file_path)
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        return load_pdf_segments(str(path))
    if suffix in (".docx", ".doc"):
        return [(None, load_docx_text(str(path)))]
    if suffix == ".txt":
        return [(None, load_txt_text(str(path)))]
    if suffix == ".csv":
        return [(None, load_csv_text(str(path)))]
    raise ValueError(f"Unsupported file type: {suffix}")


def segments_to_text(segments: List[Segment]) -> str:
    """Join segments into one string with page markers (legacy full-text form)."""
    parts: List[str] = []
    for page, text in segments:
        if page is not None:
            parts.append(f"\n--- Page {page} ---\n{text}")
        else:
            parts.append(text)
    return "".join(parts)
