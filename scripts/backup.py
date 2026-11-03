#!/usr/bin/env python3
"""Encrypted Postmaster backup and isolated restore; requires Python 3 and age."""

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


def files_under(root, name):
    base = root / name
    if not base.is_dir() or base.is_symlink():
        raise ValueError(f"Missing or unsafe directory: {name}")
    for path in sorted(base.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Symlinks are not supported in {name}")
        if path.is_file():
            yield path, path.relative_to(root).as_posix()
        elif not path.is_dir():
            raise ValueError(f"Unsupported file type in {name}")


def snapshot_database(source, destination):
    if not source.is_file() or source.is_symlink():
        raise ValueError("Missing or unsafe data/state.db")
    # SQLite's backup API includes committed WAL transactions and produces a consistent snapshot.
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)) as src:
        with closing(sqlite3.connect(destination)) as dst:
            src.backup(dst)
            if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("SQLite snapshot failed integrity check")
    os.chmod(destination, 0o600)


def backup(root, output, recipient):
    root = root.resolve()
    if Path(output).resolve().is_relative_to(root):
        raise ValueError("Store encrypted backups outside the application directory")
    env = root / ".env"
    if not env.is_file() or env.is_symlink():
        raise ValueError("Missing or unsafe .env")
    inputs = [(env, ".env"), *files_under(root, "config"), *files_under(root, "secrets")]
    names = {name for _, name in inputs}
    if not {"config/categories.yaml", "secrets/credentials.json", "secrets/token.json"} <= names:
        raise ValueError("Configuration or Gmail credentials/token missing")
    if (root / "data").is_symlink():
        raise ValueError("Symlinked data directory is not supported")
    with tempfile.TemporaryDirectory(prefix="postmaster-backup-") as tmp:
        snapshot = Path(tmp) / "state.db"
        snapshot_database(root / "data" / "state.db", snapshot)
        inputs.append((snapshot, "data/state.db"))
        # Exclusive creation avoids replacing an existing backup, even on failure.
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as encrypted:
                process = subprocess.Popen(["age", "--encrypt", "-r", recipient], stdin=subprocess.PIPE, stdout=encrypted)
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
            Path(output).unlink(missing_ok=True)
            raise


def restore(archive_path, destination, identity):
    # Restore only to a new directory; never overwrite a running deployment.
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    process = None
    try:
        process = subprocess.Popen(["age", "--decrypt", "-i", str(identity), str(archive_path)], stdout=subprocess.PIPE)
        seen = set()
        with process.stdout:
            with tarfile.open(fileobj=process.stdout, mode="r|gz") as archive:
                for member in archive:
                    name = PurePosixPath(member.name)
                    parts = name.parts
                    allowed = (parts == (".env",) or parts == ("data", "state.db") or
                               (len(parts) >= 2 and parts[0] in ("config", "secrets")))
                    if (not allowed or name.is_absolute() or ".." in parts or not member.isfile()
                            or str(name) in seen):
                        raise ValueError("Backup contains an unsafe or duplicate entry")
                    seen.add(str(name))
                    target = destination.joinpath(*parts)
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, target.open("xb") as output:
                        os.chmod(target, 0o600)
                        shutil.copyfileobj(source, output)
            # Drain the decryptor so age validates the entire ciphertext, including its last chunk.
            while process.stdout.read(1024 * 1024):
                pass
        if process.wait() != 0:
            raise RuntimeError("age decryption failed")
        if not {".env", "data/state.db", "config/categories.yaml", "secrets/credentials.json", "secrets/token.json"} <= seen:
            raise ValueError("Backup is missing required files")
        db = destination / "data" / "state.db"
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
    create.add_argument("--root", type=Path, default=Path.cwd())
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--recipient", required=True, help="age public recipient, not the private key")
    extract = commands.add_parser("restore")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--destination", type=Path, required=True, help="new, isolated directory")
    extract.add_argument("--identity", type=Path, required=True, help="age identity file")
    args = parser.parse_args()
    if args.command == "backup":
        backup(args.root, args.output, args.recipient)
        print(f"Encrypted backup created: {args.output}")
    else:
        restore(args.archive, args.destination, args.identity)
        print(f"Restored to {args.destination}; deployment remains stopped.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, sqlite3.Error, tarfile.TarError) as error:
        print(f"Backup operation failed: {error}", file=sys.stderr)
        sys.exit(1)
