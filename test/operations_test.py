"""Run with: python3 -m unittest discover -s test -p '*_test.py'."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import tarfile
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load("backup")
monitor = load("monitor")


@unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"), "age is required")
class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "app"
        for directory in ("config", "secrets", "data"):
            (self.root / directory).mkdir(parents=True)
        for name in (".env", "config/categories.yaml", "secrets/credentials.json", "secrets/token.json"):
            (self.root / name).write_text("synthetic-secret", encoding="utf-8")
        self.identity = self.base / "identity.txt"
        subprocess.run(["age-keygen", "-o", str(self.identity)], check=True, capture_output=True)
        self.recipient = subprocess.check_output(["age-keygen", "-y", str(self.identity)], text=True).strip()
        self.db = sqlite3.connect(self.root / "data" / "state.db")
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE test (value TEXT)")
        self.db.execute("INSERT INTO test VALUES ('committed WAL data')")
        self.db.commit()

    def test_encrypted_snapshot_and_isolated_restore(self):
        archive = self.base / "backup.age"
        backup.backup(self.root, archive, self.recipient)
        self.assertNotIn(b"synthetic-secret", archive.read_bytes())
        dest = self.base / "restored"
        backup.restore(archive, dest, self.identity)
        self.assertEqual((dest / ".env").read_text(), "synthetic-secret")
        with sqlite3.connect(dest / "data" / "state.db") as db:
            self.assertEqual(db.execute("SELECT value FROM test").fetchone()[0], "committed WAL data")
        self.assertFalse((dest / "data" / "control.json").exists())
        self.assertEqual((dest / ".env").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            backup.restore(archive, dest, self.identity)
        with self.assertRaises(FileExistsError):
            backup.backup(self.root, archive, self.recipient)

    def test_wrong_key_removes_partial_restore(self):
        archive = self.base / "backup.age"
        backup.backup(self.root, archive, self.recipient)
        wrong = self.base / "wrong.txt"
        subprocess.run(["age-keygen", "-o", str(wrong)], check=True, capture_output=True)
        dest = self.base / "wrong-restore"
        with self.assertRaises((ValueError, RuntimeError, OSError, backup.tarfile.TarError)):
            backup.restore(archive, dest, wrong)
        self.assertFalse(dest.exists())

    def test_rejects_backup_in_app_and_symlinks(self):
        with self.assertRaises(ValueError):
            backup.backup(self.root, self.root / "backup.age", self.recipient)
        (self.root / "secrets" / "link").symlink_to(self.root / ".env")
        with self.assertRaises(ValueError):
            backup.backup(self.root, self.base / "backup.age", self.recipient)

    def test_rejects_archive_path_traversal(self):
        archive = self.base / "unsafe.age"
        plain = io.BytesIO()
        with tarfile.open(fileobj=plain, mode="w:gz") as tar:
            entry = tarfile.TarInfo("config/../../escape")
            entry.size = 4
            tar.addfile(entry, io.BytesIO(b"oops"))
        subprocess.run(["age", "-r", self.recipient, "-o", str(archive)], input=plain.getvalue(), check=True)
        dest = self.base / "unsafe-restore"
        with self.assertRaises(ValueError):
            backup.restore(archive, dest, self.identity)
        self.assertFalse(dest.exists())
        self.assertFalse((self.base / "escape").exists())


class MonitorTests(unittest.TestCase):
    def test_reports_privacy_safe_status_and_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            data.mkdir()
            (data / "heartbeat").touch()
            (data / "status.json").write_text(json.dumps({
                "state": "stopped", "lastError": "sensitive error", "lastCycle": {"failed": 2},
            }))
            containers = [{"Config": {"Labels": {"com.docker.compose.service": name}},
                           "State": {"Running": True}} for name in ("postmaster", "ui")]
            with patch.object(monitor.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, "one two", ""),
                subprocess.CompletedProcess([], 0, json.dumps(containers), ""),
            ]):
                result = monitor.check(root, now=time.time())
            self.assertEqual(result["issues"], ["processing_stopped", "cycle_error", "message_failures"])
            self.assertNotIn("sensitive", json.dumps(result))
            os.utime(data / "heartbeat", (1, 1))
            with patch.object(monitor.subprocess, "run", side_effect=OSError("docker unavailable")):
                result = monitor.check(root, now=time.time())
            self.assertIn("container_check_failed", result["issues"])
            self.assertIn("heartbeat_stale", result["issues"])


if __name__ == "__main__":
    unittest.main()
