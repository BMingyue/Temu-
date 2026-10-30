"""Build Chrome and Edge ZIP packages from the shared Temu extension source."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "browser_extension"
RELEASE = ROOT / "release"
BROWSERS = ("chrome", "edge")


def build(browser: str, version: str) -> Path:
    output = RELEASE / f"Temu-data-collector-{browser}-{version}.zip"
    if output.exists():
        output.unlink()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(EXTENSION.rglob("*")):
            if not path.is_file() or path.suffix.lower() in {".zip", ".xpi"}:
                continue
            archive.write(path, path.relative_to(EXTENSION).as_posix())
    return output


def main() -> None:
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    version = str(manifest.get("version", "")).strip()
    background = manifest.get("background", {})
    if not version:
        raise SystemExit("manifest.json 缺少版本号")
    if not background.get("service_worker"):
        raise SystemExit("Chrome/Edge 包缺少 background.service_worker")
    RELEASE.mkdir(parents=True, exist_ok=True)
    outputs = [str(build(browser, version)) for browser in BROWSERS]
    print(json.dumps({"version": version, "outputs": outputs}, ensure_ascii=False))


if __name__ == "__main__":
    main()
