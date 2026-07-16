import psutil
import pandas as pd
import os
import re
import json
import subprocess
import sys
import threading

df_default = None

def get_default_power_usages():
    global df_default
    if df_default is None:
        # --- Process Default Model Data ---
        default_file_path = 'configs/default_power_consumptions.json'
        df_default = pd.DataFrame()
        if os.path.exists(default_file_path) and os.path.getsize(default_file_path) > 0:
            with open(default_file_path, 'r') as f:
                default_data = json.load(f)
            df_default = pd.DataFrame(list(default_data.items()), columns=['model', 'power'])
            df_default['type'] = 'Cloud API'
    return df_default

def get_cpu_power_usage():
    try:
        # Approximate by calculating power per logical CPU
        load = psutil.cpu_percent(interval=1)
        return load
    except Exception as e:
        return None


# ---------------------------------------------------------------
# Apple Silicon backend (macOS): powermetrics sampler
#
# powermetrics requires root. setup.sh offers to install a sudoers rule
# allowing passwordless `sudo powermetrics` only; without it this backend
# reports None and the app runs with energy metering disabled (0 Wh),
# exactly like a machine with no NVIDIA GPU today.
#
# We keep one long-lived sampler process and a reader thread that parses
# combined package power (CPU + GPU + ANE — the whole-SoC analog of the
# GPU-only NVIDIA number).
# ---------------------------------------------------------------
_mac_sampler_lock = threading.Lock()
_mac_sampler_started = False
_mac_latest_watts = None  # float | None — updated by the reader thread

# Lines look like: "Combined Power (CPU + GPU + ANE): 4523 mW"
_MAC_POWER_RE = re.compile(
    r"Combined Power \(CPU \+ GPU \+ ANE\):\s*([0-9.]+)\s*mW"
)


def _mac_reader(proc):
    global _mac_latest_watts
    try:
        for line in proc.stdout:
            m = _MAC_POWER_RE.search(line)
            if m:
                _mac_latest_watts = float(m.group(1)) / 1000.0  # mW → W
    except Exception:
        pass
    _mac_latest_watts = None  # sampler died


def _ensure_mac_sampler():
    """Start the powermetrics sampler once. Safe to call on every read."""
    global _mac_sampler_started
    with _mac_sampler_lock:
        if _mac_sampler_started:
            return
        _mac_sampler_started = True
        try:
            proc = subprocess.Popen(
                [
                    "sudo", "-n",  # non-interactive: fail instead of prompting
                    "powermetrics",
                    "--samplers", "cpu_power",
                    "-i", "1000",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            t = threading.Thread(target=_mac_reader, args=(proc,), daemon=True)
            t.start()
        except Exception:
            pass  # metering stays disabled; app still works


def _get_mac_power_usage():
    _ensure_mac_sampler()
    if _mac_latest_watts is None:
        return None, None
    return _mac_latest_watts, "Apple Silicon (powermetrics)"


def _get_nvidia_power_usage():
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        power = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000  # milliwatts to watts
        name = pynvml.nvmlDeviceGetName(handle)
        pynvml.nvmlShutdown()
        return power, name.decode("utf-8") if isinstance(name, bytes) else name
    except Exception:
        return None, None


def get_gpu_power_usage():
    """
    Current accelerator power draw in watts, or (None, None) if unavailable.

    - Windows/Linux + NVIDIA: GPU board power via NVML
    - macOS (Apple Silicon): whole-SoC package power via powermetrics
    """
    if sys.platform == "darwin":
        return _get_mac_power_usage()
    return _get_nvidia_power_usage()

def get_power_usage_history(local_file_path):
    df_local = pd.DataFrame()
    if os.path.exists(local_file_path) and os.path.getsize(local_file_path) > 0:
        df_local = pd.read_json(local_file_path)
        if not df_local.empty:
            df_local['date'] = pd.to_datetime(df_local['date'])
    return df_local