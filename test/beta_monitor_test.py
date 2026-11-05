"""Offline tests for the beta's aggregate monitoring signal."""

import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import beta_monitor  # noqa: E402


class BetaMonitorTest(unittest.TestCase):
    def test_aggregate_failures_are_bounded_and_do_not_expose_subjects(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data").mkdir()
            db = sqlite3.connect(root / "data/beta.db")
            db.executescript("""
                CREATE TABLE beta_scheduler_lease (id INTEGER, expires_at INTEGER);
                INSERT INTO beta_scheduler_lease VALUES (1, 2000000000);
                CREATE TABLE beta_processing_events (subject TEXT, occurred_at INTEGER, event TEXT, failed INTEGER);
            """)
            db.executemany("INSERT INTO beta_processing_events VALUES (?, ?, ?, ?)", [
                ("private@example.com", 999999000, "cycle_failed_insufficient_permission", None),
                ("private@example.com", 999999000, "cycle_failed", None),
                ("private@example.com", 999999000, "cycle_completed", 2),
                ("private@example.com", 999999000 - 16 * 60 * 1000, "cycle_failed_api_disabled", None),
                ("private@example.com", 1000001000, "cycle_failed_quota", None),
            ])
            db.commit()
            db.close()
            running = subprocess.CompletedProcess([], 0, "true\n", "")
            with patch.object(beta_monitor.subprocess, "run", return_value=running):
                result = beta_monitor.check(root, "synthetic", now=1000000)
            self.assertEqual(result["issues"], [
                "recent_processing_failure", "recent_message_failures", "recent_gmail_permission_failure",
            ])
            self.assertNotIn("private@example.com", json.dumps(result))

    def test_missing_database_and_container_are_reported_without_creating_database(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data").mkdir()
            with patch.object(beta_monitor.subprocess, "run", side_effect=OSError("secret")):
                result = beta_monitor.check(root, "synthetic", now=1000000)
            self.assertIn("beta_container_check_failed", result["issues"])
            self.assertIn("database_check_failed", result["issues"])
            self.assertNotIn("secret", json.dumps(result))
            self.assertFalse((root / "data/beta.db").exists())

    def test_expired_scheduler_and_low_disk(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data").mkdir()
            with sqlite3.connect(root / "data/beta.db") as db:
                db.executescript("""
                    CREATE TABLE beta_scheduler_lease (id INTEGER, expires_at INTEGER);
                    INSERT INTO beta_scheduler_lease VALUES (1, 999999999);
                    CREATE TABLE beta_processing_events (subject TEXT, occurred_at INTEGER, event TEXT, failed INTEGER);
                """)
            running = subprocess.CompletedProcess([], 0, "false\n", "")
            disk = type("Disk", (), {"f_blocks": 100, "f_bavail": 9})()
            with patch.object(beta_monitor.subprocess, "run", return_value=running), \
                    patch.object(beta_monitor.os, "statvfs", return_value=disk):
                result = beta_monitor.check(root, "synthetic", now=1000000)
            self.assertEqual(result["issues"], [
                "beta_container_not_running", "disk_low", "scheduler_lease_missing_or_expired",
            ])


if __name__ == "__main__":
    unittest.main()
