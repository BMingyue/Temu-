"""Detect and safely quarantine outputs that are byte-identical to their input image.

Run without --apply for a dry run. Applying keeps the original file as evidence and
requeues sent jobs through their original browser account when an existing chat exists.
"""
import argparse
import hashlib
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import gpt_extension_bridge as bridge


def repair(data_root: Path, *, apply: bool, prefix: str = ""):
    data_root = data_root.resolve()
    root = data_root / "image-jobs"
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for path in sorted(root.glob("*/job.json")):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if prefix and not str(job.get("task_no", "")).startswith(prefix):
                continue
            ref_hash = hashlib.sha256(Path(job["reference"]).read_bytes()).hexdigest()
        except (OSError, KeyError, ValueError):
            continue
        bad = [step for step in job.get("steps", [])
               if step.get("phase") == "saved" and step.get("sha256") == ref_hash]
        if not bad:
            continue
        browser = job.get("assigned_browser") or job.get("preferred_browser") or "edge"
        if browser not in bridge.BROWSERS:
            browser = "edge"
        row = {"task_no": job.get("task_no"), "job_id": job.get("id"),
               "browser": browser, "steps": len(bad), "quarantined": 0}
        if apply:
            moved = []
            quarantine = Path(job.get("result_folder") or path.parent / "results") / "invalid-input-downloads"
            quarantine.mkdir(parents=True, exist_ok=True)
            for step in bad:
                output = Path(str(step.get("output", "")))
                if output.is_file():
                    target = quarantine / (output.stem + ".input-original" + output.suffix.lower())
                    if target.exists():
                        target = quarantine / (output.stem + ".input-original-" + uuid.uuid4().hex[:6] + output.suffix.lower())
                    shutil.move(str(output), str(target))
                    moved.append({"number": step.get("number"), "from": str(output), "to": str(target),
                                  "sha256": step.get("sha256")})
                for key in ("phase", "status", "output", "sha256", "saved_at", "download_source"):
                    step.pop(key, None)
                step["status"] = "待执行"
            job.setdefault("repair_history", []).append({
                "at": now, "kind": "input_original_download", "count": len(bad),
                "quarantined": moved, "message": "历史下载与参考印花相同，已隔离并准备续传",
            })
            job.update(batch_phase="needs_review", runner=None, claim_session="",
                       resume_existing_chat=True, error="检测到历史下载为参考印花原图，已隔离，等待原对话重新收取生成图",
                       status="待复核，可续传；误收原图已隔离", retry_count=0, retry_after=0)
            job.pop("assigned_worker", None)
            bridge._trace(job, "repair_quarantine", f"已隔离 {len(moved)} 个与参考印花相同的历史下载文件，准备续传",
                           quarantined=len(moved), browser=browser)
            bridge._write(str(data_root), job)
            bridge.enqueue(str(data_root), job["id"], browsers=[browser])
            row["quarantined"] = len(moved)
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="data", type=Path, help="工作台 data 目录")
    parser.add_argument("--prefix", default="", help="只处理指定任务号前缀")
    parser.add_argument("--apply", action="store_true", help="实际隔离并回队列；默认仅检查")
    args = parser.parse_args()
    rows = repair(args.data, apply=args.apply, prefix=args.prefix)
    print(json.dumps({"apply": args.apply, "jobs": len(rows),
                      "steps": sum(row["steps"] for row in rows),
                      "quarantined": sum(row["quarantined"] for row in rows),
                      "items": rows}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
