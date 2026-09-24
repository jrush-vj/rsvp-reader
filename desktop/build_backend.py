from pathlib import Path
import subprocess
import sys
import shutil


ROOT = Path(__file__).resolve().parent.parent
if len(sys.argv) > 2:
    raise SystemExit("Usage: python desktop/build_backend.py [rust-target-triple]")

if len(sys.argv) == 2:
    TARGET = sys.argv[1]
else:
    target_info = subprocess.run(
        ["rustc", "-vV"], capture_output=True, text=True, check=True
    ).stdout
    TARGET = next(
        line.removeprefix("host: ")
        for line in target_info.splitlines()
        if line.startswith("host: ")
    )
OUTPUT = ROOT / "src-tauri" / "binaries"
OUTPUT.mkdir(parents=True, exist_ok=True)
IS_WINDOWS = "windows" in TARGET
EXECUTABLE = f"rsvp-backend-{TARGET}{'.exe' if IS_WINDOWS else ''}"

subprocess.run(
    [
        sys.executable,
        "-m",
        "PyInstaller",
        "--clean",
        "--noconfirm",
        "--onefile",
        "--name",
        "rsvp-backend",
        "--distpath",
        str(ROOT / "build" / "backend"),
        "--workpath",
        str(ROOT / "build" / "pyinstaller-work"),
        "--specpath",
        str(ROOT / "build"),
        str(ROOT / "app.py"),
    ],
    cwd=ROOT,
    check=True,
)

for module in ("clientbuild", "detector", "pdftext", "sections", "tokenizer"):
    source = ROOT / f"{module}.py"
    if not source.exists():
        raise FileNotFoundError(source)

BUILT = ROOT / "build" / "backend" / ("rsvp-backend.exe" if IS_WINDOWS else "rsvp-backend")
shutil.copy2(BUILT, OUTPUT / EXECUTABLE)