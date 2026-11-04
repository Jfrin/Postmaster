"""Offline synthetic tests: python3 -m unittest discover -s test -p '*_test.py'."""

import hashlib
import io
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import beta_backup  # noqa: E402


@unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"), "age required")
class BetaBackupTest(unittest.TestCase):
    def test_encrypted_wal_backup_restore_and_unsafe_archives(self):
        with tempfile.TemporaryDirectory(prefix="beta-backup-test-") as temp:
            base = Path(temp)
            root = base / "app"
            root.mkdir(mode=0o700)
            (root / "secrets").mkdir(mode=0o700)
            (root / "data").mkdir(mode=0o700)
            for name in beta_backup.FILES:
                (root / name).write_text("synthetic-only", encoding="utf-8")
            db = sqlite3.connect(root / beta_backup.DATABASE)
            try:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE sample (value TEXT)")
                db.execute("INSERT INTO sample VALUES (?)", ("synthetic-secret-sentinel",))
                db.commit()
                identity = base / "identity.txt"
                subprocess.run(["age-keygen", "-o", str(identity)], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True,
                                           capture_output=True, text=True).stdout.strip()
                archive = base / "backup.age"
                restored = base / "restored"
                beta_backup.backup(root, archive, recipient)
                data = archive.read_bytes()
                self.assertNotIn(b"synthetic-secret-sentinel", data)
                digest = hashlib.sha256(data).digest()
                with self.assertRaises(FileExistsError):
                    beta_backup.backup(root, archive, recipient)
                self.assertEqual(hashlib.sha256(archive.read_bytes()).digest(), digest)
                beta_backup.restore(archive, restored, identity)
                with sqlite3.connect(restored / beta_backup.DATABASE) as recovered:
                    self.assertEqual(recovered.execute("SELECT value FROM sample").fetchone()[0],
                                     "synthetic-secret-sentinel")
                with self.assertRaises(FileExistsError):
                    beta_backup.restore(archive, restored, identity)

                wrong = base / "wrong.txt"
                subprocess.run(["age-keygen", "-o", str(wrong)], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                failed = base / "failed"
                with self.assertRaises((RuntimeError, tarfile.TarError, EOFError)):
                    beta_backup.restore(archive, failed, wrong)
                self.assertFalse(failed.exists())

                badtar = base / "bad.tar.gz"
                with tarfile.open(badtar, "w:gz") as tar:
                    info = tarfile.TarInfo("../escaped")
                    info.size = 3
                    tar.addfile(info, io.BytesIO(b"bad"))
                badarchive = base / "bad.age"
                with badarchive.open("wb") as output:
                    subprocess.run(["age", "-r", recipient, str(badtar)], check=True,
                                   stdout=output, stderr=subprocess.DEVNULL)
                failed2 = base / "failed2"
                with self.assertRaises(ValueError):
                    beta_backup.restore(badarchive, failed2, identity)
                self.assertFalse(failed2.exists())
                self.assertFalse((base / "escaped").exists())
            finally:
                db.close()

    def test_rejects_symlinked_input_and_in_tree_backup(self):
        with tempfile.TemporaryDirectory(prefix="beta-backup-test-") as temp:
            root = Path(temp) / "app"
            root.mkdir()
            (root / "secrets").mkdir()
            (root / "data").mkdir()
            for name in beta_backup.FILES:
                (root / name).write_text("synthetic", encoding="utf-8")
            (root / beta_backup.DATABASE).touch()
            with self.assertRaises(ValueError):
                beta_backup.backup(root, root / "backup.age", "unused")
            target = root / "secrets/beta.env"
            target.unlink()
            os.symlink(root / "docker-compose.beta.yml", target)
            with self.assertRaises(ValueError):
                beta_backup.backup(root, Path(temp) / "backup.age", "unused")


if __name__ == "__main__":
    unittest.main()
