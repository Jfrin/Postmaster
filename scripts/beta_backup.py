#!/usr/bin/env python3
"""Encrypted beta backup and isolated restore; requires Python 3 and age."""

import argparse
from contextlib import closing
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

from backup import snapshot_database


FILES = (
    "docker-compose.beta.yml",
    "secrets/beta.env",
    "secrets/admin-subject",
    "secrets/google-sign-in-client-secret.json",
    "secrets/google-client-secret-gmail-web.json",
)
DATABASE = "data/beta.db"
MAX_DATABASE_BYTES = 1024 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024


def max_size(name):
    return MAX_DATABASE_BYTES if name == DATABASE else MAX_CONFIG_BYTES


def checked_file(root, name):
    path = root
    for part in PurePosixPath(name).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("Symlinks are not supported in beta backup inputs")
    if not path.is_file():
        raise ValueError(f"Missing beta backup input: {name}")
    if path.stat().st_size > max_size(name):
        raise ValueError(f"Beta backup input exceeds size limit: {name}")
    return path


def backup(root, output, recipient):
    root = Path(root).resolve(strict=True)
    output = Path(output)
    if output.resolve().is_relative_to(root):
        raise ValueError("Store encrypted backups outside the application directory")
    inputs = [(checked_file(root, name), name) for name in FILES]
    database = checked_file(root, DATABASE)
    with tempfile.TemporaryDirectory(prefix="postmaster-beta-backup-") as tmp:
        # This temporary snapshot is plaintext. TMPDIR must be protected and encrypted or tmpfs.
        snapshot = Path(tmp) / "beta.db"
        snapshot_database(database, snapshot)
        if snapshot.stat().st_size > MAX_DATABASE_BYTES:
            raise ValueError("Beta database snapshot exceeds size limit")
        inputs.append((snapshot, DATABASE))
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as encrypted:
                process = subprocess.Popen(
                    ["age", "--encrypt", "-r", recipient], stdin=subprocess.PIPE, stdout=encrypted
                )
                try:
                    with process.stdin, tarfile.open(fileobj=process.stdin, mode="w|gz") as archive:
                        for source, name in inputs:
                            archive.add(source, arcname=name, recursive=False)
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
                if process.wait() != 0:
                    raise RuntimeError("age encryption failed")
        except BaseException:
            output.unlink(missing_ok=True)
            raise


def restore(archive_path, destination, identity):
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    process = None
    try:
        process = subprocess.Popen(
            ["age", "--decrypt", "-i", str(identity), str(archive_path)], stdout=subprocess.PIPE
        )
        seen = set()
        with process.stdout:
            with tarfile.open(fileobj=process.stdout, mode="r|gz") as archive:
                for member in archive:
                    name = PurePosixPath(member.name)
                    if (str(name) not in (*FILES, DATABASE) or name.is_absolute() or
                            ".." in name.parts or not member.isfile() or str(name) in seen or
                            member.size > max_size(str(name))):
                        raise ValueError("Backup contains an unsafe or duplicate entry")
                    seen.add(str(name))
                    target = destination.joinpath(*name.parts)
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, target.open("xb") as output:
                        os.chmod(target, 0o600)
                        shutil.copyfileobj(source, output)
            # Complete decryption so age validates the entire ciphertext.
            while process.stdout.read(1024 * 1024):
                pass
        if process.wait() != 0:
            raise RuntimeError("age decryption failed")
        if seen != set((*FILES, DATABASE)):
            raise ValueError("Backup is missing required files")
        db = destination / DATABASE
        with closing(sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Restored SQLite database failed integrity check")
    except BaseException:
        if process and process.poll() is None:
            process.kill()
            process.wait()
        shutil.rmtree(destination)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("backup")
    create.add_argument("--root", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--recipient", required=True, help="age public recipient, not private key")
    extract = commands.add_parser("restore")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--destination", type=Path, required=True)
    extract.add_argument("--identity", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "backup":
        backup(args.root, args.output, args.recipient)
        print("Encrypted beta backup created.")
    else:
        restore(args.archive, args.destination, args.identity)
        print("Beta backup restored to an isolated directory; no service was started.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, sqlite3.Error, tarfile.TarError):
        print("Beta backup operation failed; review input paths and protected resources.", file=sys.stderr)
        sys.exit(1)
