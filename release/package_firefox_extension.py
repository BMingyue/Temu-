"""Build the complete Temu workbench WebExtension as a Firefox XPI.

The source directory is shared with Chrome and Edge.  The manifest contains
both the Chrome service-worker entry point and the Firefox background-script
fallback, so the generated XPI contains the full collector, daily audit,
image helper, listing, activity, price, and local-workbench features.
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "browser_extension"
RELEASE = ROOT / "release"


def main() -> None:
    manifest_path = EXTENSION / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = str(manifest.get("version", "")).strip()
    gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
    if not version or not gecko.get("id"):
        raise SystemExit("manifest.json 缺少 Firefox 版本或 Gecko 扩展 ID")
    if "scripts" not in manifest.get("background", {}) or "service_worker" not in manifest.get("background", {}):
        raise SystemExit("manifest.json 必须同时包含 Firefox scripts 和 Chrome service_worker")

    RELEASE.mkdir(parents=True, exist_ok=True)
    output = RELEASE / f"Temu-data-collector-firefox-{version}.xpi"
    if output.exists():
        output.unlink()
    firefox_manifest = dict(manifest)
    firefox_background = dict(firefox_manifest.get("background", {}))
    firefox_background.pop("service_worker", None)
    firefox_manifest["background"] = firefox_background
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(EXTENSION.rglob("*")):
            if not path.is_file() or path.name.endswith(".xpi") or path.name.endswith(".zip"):
                continue
            if path.name == "manifest.json":
                continue
            archive.write(path, path.relative_to(EXTENSION).as_posix())
        archive.writestr("manifest.json", json.dumps(firefox_manifest, ensure_ascii=False, indent=2))
    print(json.dumps({"path": str(output), "version": version, "gecko_id": gecko["id"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
