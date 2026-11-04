#!/usr/bin/env python3
"""Upload an encrypted beta backup to Azure Blob Storage using the VM identity."""

import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.request


MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


def managed_identity_token():
    # Do not use proxy environment variables for the link-local identity endpoint.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = ("http://169.254.169.254/metadata/identity/oauth2/token"
           "?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F")
    request = urllib.request.Request(url, headers={"Metadata": "true"})
    with opener.open(request, timeout=5) as response:
        data = json.loads(response.read(65537))
    token = data.get("access_token") if isinstance(data, dict) else None
    if (not isinstance(token, str) or not token or len(token) > 16384 or
            not token.isascii() or any(ord(char) <= 32 or ord(char) == 127 for char in token)):
        raise ValueError("Invalid managed identity response")
    return token


def upload(archive, account, container, blob, token_provider=managed_identity_token,
           connection_factory=http.client.HTTPSConnection):
    if not re.fullmatch(r"[a-z0-9]{3,24}", account):
        raise ValueError("Invalid storage account")
    if (not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])", container) or
            "--" in container):
        raise ValueError("Invalid container")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.age", blob):
        raise ValueError("Invalid archive name")
    path = Path(archive)
    if path.is_symlink():
        raise ValueError("Symlink archive not allowed")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_ARCHIVE_BYTES:
            raise ValueError("Invalid archive")
        if source.read(len(b"age-encryption.org/v1\n")) != b"age-encryption.org/v1\n":
            raise ValueError("Expected an age-encrypted archive")
        source.seek(0)
        # Azure validates this transport checksum; it is not an authenticity signature.
        digest = hashlib.md5(usedforsecurity=False)
        for chunk in iter(lambda: source.read(CHUNK_BYTES), b""):
            digest.update(chunk)
        source.seek(0)
        token = token_provider()
        conn = connection_factory(f"{account}.blob.core.windows.net", timeout=30)
        try:
            conn.putrequest("PUT", f"/{container}/{blob}")
            for key, value in (
                ("Authorization", f"Bearer {token}"),
                ("x-ms-version", "2023-11-03"),
                ("x-ms-blob-type", "BlockBlob"),
                ("Content-Type", "application/octet-stream"),
                ("Content-Length", str(info.st_size)),
                ("Content-MD5", base64.b64encode(digest.digest()).decode("ascii")),
                ("If-None-Match", "*"),
            ):
                conn.putheader(key, value)
            conn.endheaders()
            remaining = info.st_size
            while remaining:
                chunk = source.read(min(CHUNK_BYTES, remaining))
                if not chunk:
                    raise RuntimeError("Archive changed during upload")
                conn.send(chunk)
                remaining -= len(chunk)
            response = conn.getresponse()
            if response.status != 201:
                raise RuntimeError("Azure backup upload failed")
        finally:
            conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--container", required=True)
    parser.add_argument("--blob", required=True)
    args = parser.parse_args()
    upload(args.archive, args.account, args.container, args.blob)
    print("Encrypted backup uploaded without overwriting an existing blob.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Cloud/HTTP errors can contain credentials; never print raw errors.
        print("Backup upload failed; check identity, network, permissions and archive.", file=sys.stderr)
        sys.exit(1)
