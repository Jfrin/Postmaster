"""Synthetic upload tests; no network requests or Azure credentials are used."""

import base64
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import beta_backup_upload  # noqa: E402


class FakeConnection:
    instances = []
    status = 201

    def __init__(self, host, timeout):
        self.host = host
        self.timeout = timeout
        self.headers = {}
        self.body = bytearray()
        self.closed = False
        self.instances.append(self)

    def putrequest(self, method, path):
        self.method = method
        self.path = path

    def putheader(self, key, value):
        self.headers[key] = value

    def endheaders(self):
        pass

    def send(self, chunk):
        self.body.extend(chunk)

    def getresponse(self):
        return type("Response", (), {"status": self.status})()

    def close(self):
        self.closed = True


class BetaBackupUploadTest(unittest.TestCase):
    def setUp(self):
        FakeConnection.instances = []
        FakeConnection.status = 201

    def test_streams_encrypted_archive_with_checksum_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "synthetic.age"
            data = b"age-encryption.org/v1\n" + b"synthetic-only"
            archive.write_bytes(data)
            beta_backup_upload.upload(archive, "account123", "beta-backups", "test.age",
                                      lambda: "fake-token", FakeConnection)
            conn = FakeConnection.instances[0]
            self.assertEqual(conn.host, "account123.blob.core.windows.net")
            self.assertEqual((conn.method, conn.path), ("PUT", "/beta-backups/test.age"))
            self.assertEqual(conn.headers["If-None-Match"], "*")
            self.assertEqual(conn.headers["Content-Length"], str(len(data)))
            self.assertEqual(conn.headers["Content-MD5"],
                             base64.b64encode(hashlib.md5(data).digest()).decode("ascii"))
            self.assertEqual(conn.body, data)
            self.assertTrue(conn.closed)

    def test_refuses_plaintext_unsafe_names_and_existing_blob(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "synthetic.age"
            archive.write_bytes(b"plaintext")
            with self.assertRaises(ValueError):
                beta_backup_upload.upload(archive, "account123", "beta-backups", "test.age",
                                          lambda: "fake-token", FakeConnection)
            archive.write_bytes(b"age-encryption.org/v1\nsynthetic")
            for account, container, blob in (("host.example", "beta-backups", "test.age"),
                                             ("account123", "../bad", "test.age"),
                                             ("account123", "beta-backups", "../test.age")):
                with self.assertRaises(ValueError):
                    beta_backup_upload.upload(archive, account, container, blob,
                                              lambda: "fake-token", FakeConnection)
            FakeConnection.status = 412
            with self.assertRaises(RuntimeError):
                beta_backup_upload.upload(archive, "account123", "beta-backups", "test.age",
                                          lambda: "fake-token", FakeConnection)
            self.assertTrue(FakeConnection.instances[-1].closed)


if __name__ == "__main__":
    unittest.main()
