#!/usr/bin/env python3
"""Emit privacy-safe health signals to syslog for Azure Monitor."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def check(root, now=None):
    now = time.time() if now is None else now
    issues = []
    try:
        result = subprocess.run(
            ["docker", "compose", "--project-directory", str(root), "ps", "--all", "--quiet", "postmaster", "ui"],
            capture_output=True, text=True, timeout=20, check=True,
        )
        ids = result.stdout.split()
        if not ids:
            raise ValueError("no containers")
        inspected = subprocess.run(["docker", "inspect", *ids], capture_output=True, text=True, timeout=20, check=True)
        containers = json.loads(inspected.stdout)
        services = {c["Config"]["Labels"].get("com.docker.compose.service"): c["State"] for c in containers}
        for service in ("postmaster", "ui"):
            state = services.get(service, {})
            if not state.get("Running"):
                issues.append(f"{service}_not_running")
            elif service == "postmaster" and state.get("Health", {}).get("Status") == "unhealthy":
                issues.append("postmaster_unhealthy")
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        issues.append("container_check_failed")

    data = root / "data"
    try:
        age = now - (data / "heartbeat").stat().st_mtime
        if age > 900 or age < -60:
            issues.append("heartbeat_stale")
    except OSError:
        issues.append("heartbeat_missing")

    try:
        status = json.loads((data / "status.json").read_text(encoding="utf-8"))
        if status.get("state") == "stopped":
            issues.append("processing_stopped")
        elif status.get("state") not in ("idle", "scanning"):
            issues.append("status_invalid")
        if status.get("lastError"):
            issues.append("cycle_error")
        if (status.get("lastCycle") or {}).get("failed", 0) > 0:
            issues.append("message_failures")
    except (OSError, ValueError, TypeError, AttributeError):
        issues.append("status_unavailable")

    try:
        disk = os.statvfs(data)
        if disk.f_blocks == 0 or disk.f_bavail / disk.f_blocks < 0.10:
            issues.append("disk_low")
    except OSError:
        issues.append("disk_check_failed")
    return {"schema": 1, "issues": issues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--stdout", action="store_true", help="print instead of writing syslog")
    args = parser.parse_args()
    message = json.dumps(check(args.root.resolve()), separators=(",", ":"))
    if args.stdout:
        print(message)
    else:
        import syslog
        syslog.openlog("postmaster-monitor", syslog.LOG_PID, syslog.LOG_USER)
        syslog.syslog(syslog.LOG_NOTICE, message)


if __name__ == "__main__":
    main()
