#!/usr/bin/env python3
"""从最终题目 PNG 纠正异常过长的 IELTS 题干文本。"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

try:
    from tools.ielts_question_bank import clean_question_text
except ModuleNotFoundError:  # 独立 skill 脚本目录运行
    from ielts_question_bank import clean_question_text


DEFAULT_OCR_THRESHOLD = 3000


def _portable_image(root: Path, value: object) -> Path:
    text = str(value or "")
    pure = PurePosixPath(text)
    if not text or pure.is_absolute() or ".." in pure.parts or "\\" in text:
        raise ValueError(f"题目图片路径必须是可移植相对路径: {text!r}")
    path = root.joinpath(*pure.parts)
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def _ocr_png(path: Path) -> str:
    executable = shutil.which("tesseract")
    if not executable:
        raise RuntimeError("需要安装 tesseract 才能从最终 PNG 纠正题干文本")
    completed = subprocess.run(
        [executable, str(path), "stdout", "-l", "eng", "--psm", "6"],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Tesseract OCR 失败: {path.name}: {completed.stderr.strip()}")
    return completed.stdout


def normalize_prompt_texts(
    items: Iterable[Mapping[str, Any]],
    assets_root: str | Path,
    *,
    ocr_threshold: int = DEFAULT_OCR_THRESHOLD,
) -> list[dict[str, Any]]:
    """清理题干；异常过长时以最终裁剪 PNG 的 OCR 文本替换跨页污染。"""
    root = Path(assets_root)
    output: list[dict[str, Any]] = []
    for source in items:
        item = deepcopy(dict(source))
        cleaned = clean_question_text(
            str(item.get("prompt_text") or item.get("question_text") or "")
        )
        if len(cleaned) > ocr_threshold:
            image = _portable_image(root, item.get("image") or item.get("image_path"))
            image_text = clean_question_text(_ocr_png(image))
            if not image_text:
                raise ValueError(f"{item.get('id')} 的最终题目 PNG OCR 为空")
            cleaned = image_text
            item["prompt_text_source"] = "final_png_ocr"
        else:
            item["prompt_text_source"] = "pdf_text_cleaned"
        if not cleaned:
            raise ValueError(f"{item.get('id')} 的题干文本为空")
        item["prompt_text"] = cleaned
        output.append(item)
    return output


def _load(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("items JSON 必须是数组")
    return [dict(row) for row in value]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--items", type=Path, required=True)
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ocr-threshold", type=int, default=DEFAULT_OCR_THRESHOLD)
    args = parser.parse_args()
    records = normalize_prompt_texts(
        _load(args.items), args.assets_root, ocr_threshold=args.ocr_threshold
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
