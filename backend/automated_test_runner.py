#!/usr/bin/env python3
"""
automated_test_runner.py
========================

Runs a batch of test prompts against the AI4ALL backend and saves
response + metrics (tokens, energy, time) to a CSV file.

Usage:
    python automated_test_runner.py \
        --prompts prompts.csv \
        --output results.csv \
        --model qwen3:14b \
        --thinking fast \
        --reset-every 5

Prompts file can be:
  - CSV with a column named "prompt"
  - Plain text file with one prompt per line (.txt)

Resume support: if the run is interrupted, re-run with --resume to
continue from where it left off (appends to the existing output CSV).
"""

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime

import requests

# -- Configuration ---------------------------------------------------------------

BASE_URL        = "http://localhost:8000"
CHAT_ENDPOINT   = f"{BASE_URL}/api/chat"
RESET_ENDPOINT  = f"{BASE_URL}/api/chat/reset"

DEFAULT_MODEL       = "qwen3:14b"
DEFAULT_THINKING    = "fast"
DEFAULT_RESET_EVERY = 5
DEFAULT_OUTPUT      = "test_results.csv"

# Max seconds to wait for a single prompt response.  Increase for slow models.
REQUEST_TIMEOUT = 300

# -------------------------------------------------------------------------------


def load_prompts(path: str) -> list[str]:
    """Load prompts from a CSV (column 'prompt') or plain text file."""
    if path.lower().endswith(".csv"):
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            if not rows:
                return []
            # Try 'prompt' column first, fall back to first column
            col = "prompt" if "prompt" in rows[0] else list(rows[0].keys())[0]
            return [row[col].strip() for row in rows if row[col].strip()]
    else:
        # Plain text: one prompt per line
        with open(path, encoding="utf-8") as f:
            return [line.strip() for line in f if line.strip()]


def check_server() -> bool:
    """Check if the backend server is reachable."""
    try:
        r = requests.get(f"{BASE_URL}/api/health", timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def reset_session(model: str) -> None:
    """Reset the backend chat session for the given model."""
    try:
        r = requests.post(RESET_ENDPOINT, data={"model": model}, timeout=10)
        r.raise_for_status()
        print(f"  [reset] Session reset for model '{model}'")
    except Exception as e:
        print(f"  [reset] WARNING: Failed to reset session: {e}")


def run_prompt(prompt: str, model: str, thinking_mode: str) -> dict:
    """
    Send one prompt to the backend and stream the SSE response.

    Returns a dict with:
        response, inference_time_ms, energy_wh,
        input_tokens, output_tokens, user_prompt_tokens, error
    """
    result = {
        "response": "",
        "inference_time_ms": None,
        "energy_wh": None,
        "input_tokens": None,
        "output_tokens": None,
        "user_prompt_tokens": None,
        "error": None,
    }

    acc = ""
    try:
        # Must send as multipart/form-data because the /api/chat endpoint
        # includes an optional File() parameter alongside Form() fields.
        # Using data= sends x-www-form-urlencoded which FastAPI rejects.
        multipart_fields = {
            "prompt": (None, prompt),
            "model": (None, model),
            "thinking_mode": (None, thinking_mode),
        }
        r = requests.post(
            CHAT_ENDPOINT,
            files=multipart_fields,
            stream=True,
            timeout=REQUEST_TIMEOUT,
        )
        if r.status_code != 200:
            # Read the error body for a useful message
            try:
                err_body = r.json()
                detail = err_body.get("detail", err_body)
            except Exception:
                detail = r.text[:500]
            result["error"] = f"HTTP {r.status_code}: {detail}"
            return result

        for raw_line in r.iter_lines():
            if not raw_line:
                continue
            line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
            if not line.startswith("data: "):
                continue

            payload = json.loads(line[6:])

            if "error" in payload:
                result["error"] = payload["error"]
                break

            if "delta" in payload:
                acc += payload["delta"]

            if payload.get("done"):
                result["inference_time_ms"] = payload.get("inference_time_ms")
                result["energy_wh"]         = payload.get("energy_wh")
                result["input_tokens"]      = payload.get("input_tokens")
                result["output_tokens"]     = payload.get("output_tokens")
                result["user_prompt_tokens"]= payload.get("user_prompt_tokens")
                break

        result["response"] = acc

    except requests.exceptions.Timeout:
        result["error"] = f"Timeout after {REQUEST_TIMEOUT}s"
    except Exception as e:
        result["error"] = str(e)

    return result


def count_existing_rows(output_path: str) -> int:
    """Count completed rows in the output CSV (for --resume support)."""
    if not os.path.exists(output_path):
        return 0
    with open(output_path, newline="", encoding="utf-8") as f:
        return max(0, sum(1 for _ in f) - 1)  # subtract header row


def run_batch(
    prompts: list[str],
    model: str,
    thinking_mode: str,
    output_path: str,
    reset_every: int,
    start_index: int = 0,
) -> None:
    """Run all prompts, writing results to output_path incrementally."""

    fieldnames = [
        "index", "timestamp", "model", "thinking_mode",
        "prompt", "response",
        "inference_time_ms", "energy_wh",
        "input_tokens", "output_tokens", "user_prompt_tokens",
        "error",
    ]

    file_exists = os.path.exists(output_path) and start_index > 0
    mode = "a" if file_exists else "w"

    with open(output_path, mode, newline="", encoding="utf-8") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        if not file_exists:
            writer.writeheader()

        total = len(prompts)
        for i, prompt in enumerate(prompts[start_index:], start=start_index):

            # Reset every N prompts (skip before the very first prompt)
            if i > 0 and i % reset_every == 0:
                print(f"\n[{i}/{total}] Resetting session (every {reset_every} prompts)...")
                reset_session(model)
                print()

            prompt_num = i + 1
            preview = prompt[:70] + ("..." if len(prompt) > 70 else "")
            print(f"[{prompt_num}/{total}] {preview}")

            res = run_prompt(prompt, model, thinking_mode)

            if res["error"]:
                print(f"  ERROR: {res['error']}")
            else:
                ms        = res["inference_time_ms"] or 0
                mwh       = (res["energy_wh"] or 0) * 1000
                ctx_tok   = res["input_tokens"]
                q_tok     = res["user_prompt_tokens"]
                out_tok   = res["output_tokens"]
                print(f"  OK {ms}ms | {mwh:.4f} mWh | ctx={ctx_tok} q={q_tok} out={out_tok}")

            writer.writerow({
                "index":              i,
                "timestamp":          datetime.now().isoformat(timespec="seconds"),
                "model":              model,
                "thinking_mode":      thinking_mode,
                "prompt":             prompt,
                "response":           res["response"],
                "inference_time_ms":  res["inference_time_ms"],
                "energy_wh":          res["energy_wh"],
                "input_tokens":       res["input_tokens"],
                "output_tokens":      res["output_tokens"],
                "user_prompt_tokens": res["user_prompt_tokens"],
                "error":              res["error"],
            })
            # Flush after every row - safe against crashes mid-run
            csvfile.flush()

    print(f"\nDone. {total - start_index} prompts completed.")
    print(f"Results saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="AI4ALL automated prompt tester",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--prompts", required=True,
        help="Path to prompts file (.csv with 'prompt' column, or .txt one-per-line)",
    )
    parser.add_argument(
        "--output", default=DEFAULT_OUTPUT,
        help=f"Output CSV path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--model", default=DEFAULT_MODEL,
        help=f"Ollama model name (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--thinking", choices=["fast", "deep"], default=DEFAULT_THINKING,
        help=f"Thinking mode (default: {DEFAULT_THINKING})",
    )
    parser.add_argument(
        "--reset-every", type=int, default=DEFAULT_RESET_EVERY,
        help=f"Reset session every N prompts to clear history (default: {DEFAULT_RESET_EVERY})",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Resume an interrupted run - appends to existing output CSV",
    )
    args = parser.parse_args()

    # Validate prompts file
    if not os.path.exists(args.prompts):
        print(f"ERROR: Prompts file not found: {args.prompts}")
        sys.exit(1)

    prompts = load_prompts(args.prompts)
    if not prompts:
        print("ERROR: No prompts found in file.")
        sys.exit(1)

    # Resume support
    start_index = 0
    if args.resume:
        start_index = count_existing_rows(args.output)
        if start_index >= len(prompts):
            print(f"All {len(prompts)} prompts already completed. Nothing to do.")
            sys.exit(0)
        print(f"Resuming from prompt {start_index + 1}/{len(prompts)}\n")

    # Verify server is reachable before starting
    if not check_server():
        print(f"ERROR: Cannot reach backend at {BASE_URL}")
        print("       Make sure the server is running (start.bat or:")
        print("       python -m uvicorn server:app --host 0.0.0.0 --port 8000)")
        sys.exit(1)

    # Verify the requested model is installed in Ollama
    try:
        models_resp = requests.get(f"{BASE_URL}/api/models", timeout=10)
        installed = models_resp.json().get("models", [])
        if args.model not in installed:
            print(f"ERROR: Model '{args.model}' is not installed in Ollama.")
            print(f"       Installed models: {', '.join(installed) if installed else '(none)'}")
            print(f"       Pull it with: ollama pull {args.model}")
            sys.exit(1)
    except Exception as e:
        print(f"WARNING: Could not verify model availability: {e}")

    # Print run summary
    print("=" * 60)
    print(f"Model:        {args.model}")
    print(f"Thinking:     {args.thinking}")
    print(f"Prompts:      {len(prompts)} total"
          + (f" (starting at #{start_index + 1})" if start_index > 0 else ""))
    print(f"Reset every:  {args.reset_every} prompts")
    print(f"Output:       {args.output}")
    print("=" * 60)
    print()

    # Reset session before starting
    print("Resetting session before starting...")
    reset_session(args.model)
    print()

    run_batch(
        prompts=prompts,
        model=args.model,
        thinking_mode=args.thinking,
        output_path=args.output,
        reset_every=args.reset_every,
        start_index=start_index,
    )


if __name__ == "__main__":
    main()
