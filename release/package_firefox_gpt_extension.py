"""Build the GPT image helper WebExtension as a Firefox XPI."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "gpt_chrome_extension"
RELEASE = ROOT / "release"


def main() -> None:
    manifest_path = EXTENSION / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = str(manifest.get("version", "")).strip()
    gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
    background = manifest.get("background", {})
    if not version or not gecko.get("id"):
        raise SystemExit("gpt_chrome_extension/manifest.json 缺少 Firefox 版本或 Gecko 扩展 ID")
    if "scripts" not in background or "service_worker" not in background:
        raise SystemExit("GPT manifest 必须同时包含 Firefox scripts 和 Chrome service_worker")

    RELEASE.mkdir(parents=True, exist_ok=True)
    output = RELEASE / f"Temu-gpt-image-helper-firefox-{version}.xpi"
    if output.exists():
        output.unlink()
    firefox_manifest = dict(manifest)
    firefox_background = dict(firefox_manifest.get("background", {}))
    firefox_background.pop("service_worker", None)
    firefox_manifest["background"] = firefox_background
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(EXTENSION.rglob("*")):
            if not path.is_file() or path.name.endswith((".xpi", ".zip")):
                continue
            if path.name == "manifest.json":
                continue
            archive.write(path, path.relative_to(EXTENSION).as_posix())
        archive.writestr("manifest.json", json.dumps(firefox_manifest, ensure_ascii=False, indent=2))
    try:
        from firefox_local_channel import publish_registered
    except ImportError:
        from release.firefox_local_channel import publish_registered
    channels = publish_registered(output, RELEASE)
    print(json.dumps({"path": str(output), "version": version, "gecko_id": gecko["id"],
                      "local_update_channels": channels}, ensure_ascii=False))


if __name__ == "__main__":
    main()
