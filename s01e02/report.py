"""Thin wrapper delegating S01E02 Hub submissions to the canonical tools/hub-client.mjs CLI."""

import json
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
HUB_CLIENT = BASE_DIR.parent / "tools" / "hub-client.mjs"
LOG_FILE = BASE_DIR / "requests.log"


def post_report(url: str, body: dict) -> tuple[int, dict]:
    proc = subprocess.run(
        ["node", str(HUB_CLIENT), "--url", url, "--body", json.dumps(body), "--log", str(LOG_FILE)],
        capture_output=True,
        text=True,
        check=False,
    )
    if not proc.stdout.strip():
        raise RuntimeError(proc.stderr.strip() or "hub-client.mjs exited without output")
    parsed = json.loads(proc.stdout)
    return parsed["status"], parsed["body"]


if __name__ == "__main__":
    video_url = "https://hq.mega.dev/challenges/who-said-what/api/video"
    status, res = post_report(video_url, {"finding": "01:50", "offset": 42})
    print(f"Status: {status}")
    print("Response:", json.dumps(res, indent=2))
