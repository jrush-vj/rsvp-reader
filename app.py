"""
RSVP Reader Backend
====================
Flask API that accepts a PDF upload, extracts its text, tokenizes it into
words, and returns each word annotated with:

  - orp:   character index to highlight red (Optimal Recognition Point)
  - pause: a multiplier on the base per-word delay, so punctuation
           (sentence ends, commas) gets a natural extra beat instead of
           flying past at the same speed as every other word.

Setup:
    pip install flask flask-cors pypdf
    python app.py
    -> serves on http://0.0.0.0:5000

Pair with rsvp_reader.html - open that file directly in a browser and
point its "Backend URL" field at wherever this is running (localhost,
or your homelab's LAN IP if you host this on a container/VM instead).
"""

import os
import re
import string
from io import BytesIO

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from pypdf import PdfReader

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILENAME = "rsvp_reader.html"

app = Flask(__name__)
CORS(app)  # harmless even now that we serve same-origin; keeps file:// usage working too

app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB upload cap

WORD_RE = re.compile(r"\S+")
HYPHEN_BREAK_RE = re.compile(r"(\w)-\s*\n\s*(\w)")
WHITESPACE_RE = re.compile(r"[ \t]+")


def orp_index(word: str) -> int:
    """
    Optimal Recognition Point: which character index in the word to
    highlight. Classic Spritz-style heuristic - the eye's natural focal
    point shifts right as words get longer, but in discrete steps rather
    than linearly.
    """
    core = word.strip(string.punctuation)
    length = len(core) if core else len(word)

    if length <= 1:
        idx = 0
    elif length <= 5:
        idx = 1
    elif length <= 9:
        idx = 2
    elif length <= 13:
        idx = 3
    else:
        idx = 4

    leading_punct = len(word) - len(word.lstrip(string.punctuation))
    idx = min(idx + leading_punct, max(len(word) - 1, 0))
    return idx


def pause_multiplier(word: str) -> float:
    """How much longer than the base per-word delay this word should hold."""
    multiplier = 1.0

    if word.endswith((".", "!", "?")):
        multiplier = 2.6
    elif word.endswith((";", ":")):
        multiplier = 2.0
    elif word.endswith((",", ")", "\u201d", '"')):
        multiplier = 1.5

    core = word.strip(string.punctuation)
    if len(core) >= 10:
        multiplier += 0.3
    if len(core) >= 14:
        multiplier += 0.3

    return round(multiplier, 2)


def extract_text_from_pdf(file_bytes: bytes) -> str:
    reader = PdfReader(BytesIO(file_bytes))
    pages_text = [page.extract_text() or "" for page in reader.pages]
    full_text = "\n".join(pages_text)

    # Rejoin words hyphenated across a line break: "exam-\nple" -> "example"
    full_text = HYPHEN_BREAK_RE.sub(r"\1\2", full_text)
    full_text = full_text.replace("\n", " ")
    full_text = WHITESPACE_RE.sub(" ", full_text)
    return full_text.strip()


def tokenize(text: str):
    return [
        {
            "text": m.group(0),
            "orp": orp_index(m.group(0)),
            "pause": pause_multiplier(m.group(0)),
        }
        for m in WORD_RE.finditer(text)
    ]


@app.route("/", methods=["GET"])
def index():
    """
    Serve the reader UI directly, so http://localhost:5000 is the only
    address you need to remember - no separate file:// tab required.
    Requires rsvp_reader.html to sit next to this app.py.
    """
    html_path = os.path.join(BASE_DIR, HTML_FILENAME)
    if not os.path.exists(html_path):
        return (
            f"{HTML_FILENAME} not found next to app.py. "
            f"Put both files in the same folder ({BASE_DIR}).",
            500,
        )
    return send_from_directory(BASE_DIR, HTML_FILENAME)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file field in request. Send multipart/form-data with key 'file'."}), 400

    f = request.files["file"]
    if f.filename == "":
        return jsonify({"error": "Empty filename."}), 400

    if not f.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only .pdf files are supported."}), 400

    try:
        text = extract_text_from_pdf(f.read())
    except Exception as exc:  # malformed / encrypted / unreadable PDF
        return jsonify({"error": f"Could not read this PDF: {exc}"}), 400

    if not text:
        return jsonify({
            "error": "No extractable text found. This PDF is likely scanned "
                     "images rather than real text, so it would need OCR first."
        }), 422

    words = tokenize(text)

    return jsonify({
        "filename": f.filename,
        "word_count": len(words),
        "words": words,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)