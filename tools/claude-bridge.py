#!/usr/bin/env python3
"""
tools/claude-bridge.py - Drop-in Claude CLI shim routing to local worker-bridge.
Implements the subset of Claude Code CLI used by Lamarck:
  claude -p - --output-format json --model <model>
Output format matches Claude CLI JSON envelope:
  {"result": "<output>", "is_error": false}
"""

import sys
import os
import json
from pathlib import Path

# Ensure UTF-8 stdio
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

def load_env_file(path: Path):
    if not path.exists():
        return
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k and k not in os.environ:
                        os.environ[k] = v
    except Exception:
        pass

this_dir = Path(__file__).resolve().parent
load_env_file(this_dir.parent / ".env")

def find_bridge_path():
    env_path = os.getenv("MEGADEV_BRIDGE_PATH")
    if env_path and Path(env_path).exists():
        return Path(env_path)

    candidates = [
        this_dir.parent.parent / "Projekt Hajs" / ".agents" / "mcp_servers" / "worker_bridge.py",
        this_dir.parent / ".agents" / "mcp_servers" / "worker_bridge.py",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None

bridge_module_path = find_bridge_path()
if not bridge_module_path:
    err_envelope = {
        "result": "Could not locate worker_bridge.py via MEGADEV_BRIDGE_PATH or standard locations.",
        "is_error": True
    }
    sys.stdout.write(json.dumps(err_envelope) + "\n")
    sys.stderr.write("[claude-bridge] worker_bridge.py not found.\n")
    sys.exit(1)

# Add directory to sys.path and import
sys.path.insert(0, str(bridge_module_path.parent))
try:
    import worker_bridge
except Exception as e:
    err_envelope = {
        "result": f"Failed importing worker_bridge ({bridge_module_path}): {e}",
        "is_error": True
    }
    sys.stdout.write(json.dumps(err_envelope) + "\n")
    sys.stderr.write(f"[claude-bridge] Import error: {e}\n")
    sys.exit(1)

# Model alias mappings
MODEL_MAP = {
    "haiku": "anthropic/claude-5.5-haiku",
    "sonnet": "deepseek/deepseek-v4.1-flash-1017",
    "opus": "openai/gpt-6-luna",
    "flash": "deepseek/deepseek-v4.1-flash-1017",
    "deepseek": "deepseek/deepseek-v4.1-flash-1017",
    "argon": "google/gemini-4-argon",
}

def parse_args():
    prompt = None
    model = "sonnet"
    output_format = "json"

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-p", "--prompt"):
            if i + 1 < len(args):
                p_val = args[i + 1]
                if p_val == "-":
                    prompt = sys.stdin.read()
                    i += 1
                elif not p_val.startswith("-"):
                    prompt = p_val
                    i += 1
                else:
                    prompt = sys.stdin.read()
            else:
                prompt = sys.stdin.read()
        elif arg == "--model":
            if i + 1 < len(args):
                model = args[i + 1]
                i += 1
        elif arg == "--output-format":
            if i + 1 < len(args):
                output_format = args[i + 1]
                i += 1
        elif arg in ("-v", "--version"):
            sys.stdout.write("claude-worker-bridge 1.0.0\n")
            sys.exit(0)
        else:
            sys.stderr.write(f"[claude-bridge] Notice: unhandled flag '{arg}' ignored\n")
        i += 1

    if prompt is None:
        if not sys.stdin.isatty():
            prompt = sys.stdin.read()
        else:
            prompt = ""

    return prompt, model, output_format

def main():
    prompt, requested_model, output_format = parse_args()

    if not prompt.strip():
        sys.stderr.write("[claude-bridge] No prompt provided.\n")
        envelope = {"result": "", "is_error": True}
        sys.stdout.write(json.dumps(envelope) + "\n")
        sys.exit(1)

    target_model = MODEL_MAP.get(requested_model.lower(), requested_model)
    sys.stderr.write(f"[claude-bridge] Routing model '{requested_model}' -> '{target_model}'\n")

    try:
        if target_model == "google/gemini-4-argon" or requested_model.lower() == "argon":
            output_text = worker_bridge.execute_argon(prompt)
        else:
            output_text = worker_bridge.execute_openrouter(
                prompt=prompt,
                model=target_model
            )

        if output_format == "json":
            envelope = {"result": output_text, "is_error": False}
            sys.stdout.write(json.dumps(envelope) + "\n")
        else:
            sys.stdout.write(output_text + "\n")
        sys.stdout.flush()
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"[claude-bridge] Error during model execution: {e}\n")
        envelope = {"result": f"Execution failed: {str(e)}", "is_error": True}
        sys.stdout.write(json.dumps(envelope) + "\n")
        sys.stdout.flush()
        sys.exit(1)

if __name__ == "__main__":
    main()
