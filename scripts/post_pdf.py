"""
POST a PDF to the running backend as multipart/form-data.

Prints the HTTP status plus the body, so the OCR rejection (422) can be
told apart from a transport failure or a silent success.
"""

import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5000"
PDF = Path(sys.argv[2] if len(sys.argv) > 2 else "tmp/blank.pdf")


def post_multipart(url: str, field: str, filename: str, blob: bytes):
    boundary = "----rsvp" + uuid.uuid4().hex
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode(),
        b"Content-Type: application/pdf\r\n\r\n",
        blob,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(f"posting {PDF} to {BASE}/api/books")
    status, text = post_multipart(f"{BASE}/api/books", "file", PDF.name, PDF.read_bytes())
    print(f"status: {status}")
    try:
        print(json.dumps(json.loads(text), indent=2, ensure_ascii=False))
    except ValueError:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
