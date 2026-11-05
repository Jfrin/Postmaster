#!/usr/bin/env python3
"""Emit aggregate beta health signals; does not configure or deliver alerts."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
from contextlib import closing


def check(root, container, now=None):
    now = time.time() if now is None else now
    issues = []
    try:
        result = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}", "--", container],
            capture_output=True, text=True, timeout=20, check=True,
        )
        if result.stdout.strip() != "true":
            issues.append("beta_container_not_running")
    except (OSError, subprocess.SubprocessError):
        issues.append("beta_container_check_failed")

    data = root / "data"
    try:
        disk = os.statvfs(data)
        if disk.f_blocks == 0 or disk.f_bavail / disk.f_blocks < 0.10:
            issues.append("disk_low")
    except OSError:
        issues.append("disk_check_failed")

    try:
        db = (data / "beta.db").resolve(strict=True)
        with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=5)) as connection:
            connection.execute("PRAGMA query_only=ON")
            now_ms = int(now * 1000)
            scheduler = connection.execute(
                "SELECT expires_at FROM beta_scheduler_lease WHERE id=1"
            ).fetchone()
            if not scheduler or scheduler[0] <= now_ms:
                issues.append("scheduler_lease_missing_or_expired")
            events = connection.execute(
                "SELECT DISTINCT event, failed FROM beta_processing_events "
                "WHERE occurred_at >= ? AND occurred_at <= ? "
                "AND (event LIKE 'cycle_failed%' OR failed > 0)",
                (now_ms - 15 * 60 * 1000, now_ms),
            ).fetchall()
            kinds = {row[0] for row in events}
            if any(kind.startswith("cycle_failed") for kind in kinds):
                issues.append("recent_processing_failure")
            if any(row[1] is not None and row[1] > 0 for row in events):
                issues.append("recent_message_failures")
            if "cycle_failed_insufficient_permission" in kinds:
                issues.append("recent_gmail_permission_failure")
            if "cycle_failed_api_disabled" in kinds:
                issues.append("recent_gmail_api_disabled")
            if "cycle_failed_quota" in kinds:
                issues.append("recent_gmail_quota_failure")
    except (OSError, sqlite3.Error, TypeError, ValueError, OverflowError):
        issues.append("database_check_failed")
    return {"schema": 1, "issues": issues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--container", required=True, help="beta container name or ID")
    parser.add_argument("--stdout", action="store_true", help="print instead of writing syslog")
    args = parser.parse_args()
    message = json.dumps(check(args.root, args.container), separators=(",", ":"))
    if args.stdout:
        print(message)
    else:
        import syslog
        syslog.openlog("postmaster-beta-monitor", syslog.LOG_PID, syslog.LOG_USER)
        syslog.syslog(syslog.LOG_NOTICE, message)


if __name__ == "__main__":
    main()
