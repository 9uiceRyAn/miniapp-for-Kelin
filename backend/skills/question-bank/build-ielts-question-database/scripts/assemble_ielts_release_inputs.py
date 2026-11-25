#!/usr/bin/env python3
"""聚合各卷结果，应用 AI 分类并生成 IELTS 发布包的标准输入。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable, Mapping

try:
    from tools.ielts_classification import apply_classifications
    from tools.ielts_prompt_text import normalize_prompt_texts
except ModuleNotFoundError:  # 独立 skill 脚本目录运行
    from ielts_classification import apply_classifications
    from ielts_prompt_text import normalize_prompt_texts


def _load(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"{path.name} 必须是 JSON 数组")
    return [dict(row) for row in value]


def _load_many(paths: Iterable[Path]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for path in sorted(paths):
        output.extend(_load(path))
    return output


def _book(volume: object) -> str:
    return f"cambridge_ielts_{int(volume):02d}"


def normalize_item(item: Mapping[str, Any]) -> dict[str, Any]:
    row = dict(item)
    skill = str(row.get("skill") or "").lower()
    if skill not in {"listening", "reading"}:
        raise ValueError(f"{row.get('id')} 不属于听力或阅读")
    unit = int(row.get("unit_number") or row.get("section_number") or 0)
    if not 1 <= unit <= 4:
        raise ValueError(f"{row.get('id')} 缺少有效单元号")
    row["unit_number"] = unit
    row["book"] = _book(row["volume"])
    row["test"] = f"{int(row['test_number']):02d}"
    if skill == "listening":
        row["section"] = unit
        row.pop("passage", None)
    else:
        row["passage"] = unit
        row.pop("section", None)
    row["image"] = str(row.get("image") or row.get("image_path") or "")
    row["classification_confidence"] = float(
        row.get("classification_confidence", row.get("confidence", 0.0))
    )
    return row


def normalize_source(source: Mapping[str, Any]) -> dict[str, Any]:
    row = dict(source)
    row["book"] = _book(row["volume"])
    row["test"] = f"{int(row['test_number']):02d}"
    assets = []
    for index, source_asset in enumerate(row.get("assets") or [], 1):
        asset = dict(source_asset)
        asset["sequence"] = int(asset.get("sequence") or index)
        page = asset.get("page_number", asset.get("source_page"))
        if page is not None:
            asset["page_number"] = int(page)
        assets.append(asset)
    row["assets"] = assets
    return row


def normalize_answer(answer: Mapping[str, Any]) -> dict[str, Any]:
    row = dict(answer)
    row["book"] = _book(row["volume"])
    row["test"] = f"{int(row['test_number']):02d}"
    assets = []
    for index, source_asset in enumerate(row.get("assets") or [], 1):
        asset = dict(source_asset)
        asset["sequence"] = int(asset.get("sequence") or index)
        page = asset.get("page_number", asset.get("source_page"))
        if page is not None:
            asset["page_number"] = int(page)
        assets.append(asset)
    row["assets"] = assets
    return row


def assemble(
    books_root: str | Path,
    answers_path: str | Path,
    classifications_path: str | Path,
    assets_root: str | Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    root = Path(books_root)
    items = _load_many(root.glob("*/metadata/items_rendered.json"))
    sources = _load_many(root.glob("*/metadata/source_texts_rendered.json"))
    answers = _load(Path(answers_path))
    classifications = _load(Path(classifications_path))
    for label, records in (("item", items), ("source", sources), ("answer", answers)):
        ids = [str(row.get("id") or "") for row in records]
        if any(not value for value in ids) or len(ids) != len(set(ids)):
            raise ValueError(f"{label} ID 必须非空且唯一")
    classified = apply_classifications(items, classifications)
    normalized_items = [normalize_item(row) for row in classified]
    normalized_items = normalize_prompt_texts(normalized_items, assets_root)
    normalized_sources = [normalize_source(row) for row in sources]
    normalized_answers = [normalize_answer(row) for row in answers]
    source_ids = {row["id"] for row in normalized_sources}
    if any(row.get("source_text_id") not in source_ids for row in normalized_items):
        raise ValueError("存在无法关联原文的题组")
    return normalized_items, normalized_sources, normalized_answers


def _write(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books-root", type=Path, required=True)
    parser.add_argument("--answers", type=Path, required=True)
    parser.add_argument("--classifications", type=Path, required=True)
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    items, sources, answers = assemble(
        args.books_root, args.answers, args.classifications, args.assets_root
    )
    _write(args.output_dir / "items.json", items)
    _write(args.output_dir / "source_texts.json", sources)
    _write(args.output_dir / "answers.json", answers)
    summary = {"items": len(items), "source_texts": len(sources), "answers": len(answers)}
    (args.output_dir / "assembly_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
