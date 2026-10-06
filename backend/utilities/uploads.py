# backend/utilities/uploads.py
"""
Saving uploaded files safely.

Each request's uploads go into their own fresh folder, so two uploads with
the same name never overwrite each other, while the file keeps its original
name (the document index is keyed by filename). Engines read a file fully
when it's loaded, so callers delete the folder once indexing is done.
"""

from __future__ import annotations

import os
import secrets
import shutil
from pathlib import Path

from fastapi import UploadFile

MAX_UPLOAD_BYTES = int(os.environ.get("UNESS_MAX_UPLOAD_MB", "25")) * 1024 * 1024
_CHUNK = 1024 * 1024


class UploadTooLarge(Exception):
    def __init__(self, filename: str):
        limit_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
        super().__init__(f"{filename} is larger than the {limit_mb} MB upload limit")


def clean_filename(name: str | None) -> str:
    """Reduce a client-supplied filename to a plain basename."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(c for c in base if c >= " " and c != "\x7f").strip()
    if base in ("", ".", ".."):
        return "upload"
    if len(base) > 150:
        stem, ext = os.path.splitext(base)
        base = stem[: 150 - len(ext)] + ext
    return base


def new_upload_dir(base: Path) -> Path:
    path = base / secrets.token_hex(8)
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_upload(upload: UploadFile, dest_dir: Path) -> Path:
    """Copy an upload into dest_dir, enforcing the size limit."""
    name = clean_filename(upload.filename)
    dst = dest_dir / name
    written = 0
    with open(dst, "wb") as out:
        while chunk := upload.file.read(_CHUNK):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                out.close()
                dst.unlink(missing_ok=True)
                raise UploadTooLarge(name)
            out.write(chunk)
    return dst


def read_upload(upload: UploadFile) -> bytes:
    """Read an upload into memory, enforcing the size limit."""
    data = upload.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadTooLarge(clean_filename(upload.filename))
    return data


def remove_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
