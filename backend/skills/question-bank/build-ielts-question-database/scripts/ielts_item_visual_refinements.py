#!/usr/bin/env python3
"""应用经 AI 视觉验收确认的 IELTS 题目 PNG 页脚精修。"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

from PIL import Image, ImageOps


def _portable_path(value: object) -> PurePosixPath:
    text = str(value or "")
    path = PurePosixPath(text)
    if not text or path.is_absolute() or ".." in path.parts or "\\" in text:
        raise ValueError(f"精修图片路径必须是可移植相对路径: {text!r}")
    return path


def apply_refinements(
    assets_root: str | Path, refinements: Iterable[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """裁掉已确认的非题目页脚，并重新加入白色安全下边距。"""
    root = Path(assets_root)
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source in refinements:
        row = dict(source)
        item_id = str(row.get("item_id") or "")
        if not item_id or item_id in seen:
            raise ValueError("精修 item_id 必须非空且唯一")
        seen.add(item_id)
        relative = _portable_path(row.get("path"))
        path = root.joinpath(*relative.parts)
        if not path.is_file():
            raise FileNotFoundError(path)
        crop_bottom = int(row.get("crop_bottom") or 0)
        bottom_padding = int(row.get("bottom_padding") or 0)
        if crop_bottom <= 0 or bottom_padding < 24:
            raise ValueError(f"{item_id} 的裁剪边界或白边无效")
        with Image.open(path) as opened:
            image = opened.convert("RGB")
        if crop_bottom >= image.height:
            raise ValueError(f"{item_id} 的 crop_bottom 未裁掉任何页脚")
        refined = ImageOps.expand(
            image.crop((0, 0, image.width, crop_bottom)),
            border=(0, 0, 0, bottom_padding),
            fill="white",
        )
        refined.save(path, "PNG", optimize=True)
        results.append(
            {
                "item_id": item_id,
                "path": relative.as_posix(),
                "width": refined.width,
                "height": refined.height,
                "bottom_padding": bottom_padding,
                "status": "passed",
                "method": "ai_visual_footer_refinement",
            }
        )
    return results


def update_visual_qa(path: str | Path, results: Iterable[Mapping[str, Any]]) -> None:
    """把精修尺寸和验收说明同步到该卷 visual_qa.json。"""
    destination = Path(path)
    rows = json.loads(destination.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise ValueError("visual_qa JSON 必须是数组")
    updates = {str(row["item_id"]): dict(row) for row in results}
    found: set[str] = set()
    for row in rows:
        item_id = str(row.get("item_id") or "")
        update = updates.get(item_id)
        if update is None:
            continue
        found.add(item_id)
        row["width"] = update["width"]
        row["height"] = update["height"]
        row["boundary_white"] = True
        row["review_required"] = False
        diagnostics = list(row.get("diagnostics") or [])
        diagnostics.append("AI 视觉验收：已移除非题目页脚并重新加入安全白边")
        row["diagnostics"] = list(dict.fromkeys(diagnostics))
    missing = sorted(set(updates) - found)
    if missing:
        raise ValueError(f"visual_qa 缺少精修 item: {missing[0]}")
    destination.write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--overrides", type=Path, required=True)
    parser.add_argument("--qa-root", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    payload = json.loads(args.overrides.read_text(encoding="utf-8"))
    refinements = payload.get("refinements") if isinstance(payload, dict) else None
    if not isinstance(refinements, list):
        raise ValueError("overrides JSON 缺少 refinements 数组")
    results = apply_refinements(args.assets_root, refinements)
    if args.qa_root:
        by_volume: dict[int, list[dict[str, Any]]] = {}
        for row in results:
            match = re.search(r"-C(\d{2})-", row["item_id"])
            if not match:
                raise ValueError(f"无法从 item_id 识别卷号: {row['item_id']}")
            by_volume.setdefault(int(match.group(1)), []).append(row)
        for volume, rows in by_volume.items():
            candidates = list(args.qa_root.glob(f"*IELTS-{volume:02d}-*/metadata/visual_qa.json"))
            if len(candidates) != 1:
                raise ValueError(f"卷 C{volume:02d} 的 visual_qa 文件数量不是 1")
            update_visual_qa(candidates[0], rows)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps({"refined": len(results)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
