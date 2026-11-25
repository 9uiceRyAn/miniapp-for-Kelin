#!/usr/bin/env python3
"""导出仅含 Academic Listening 与 Reading 的可移植雅思题库。"""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping


ALLOWED_SKILLS = {"listening", "reading"}
PRIMARY_PREFIX = {"listening": "L.", "reading": "R."}
PATH_KEYS = {"image", "question_image", "path", "source_file", "document"}
ITEM_FIELDS = (
    "id", "skill", "volume", "book", "test_number", "test", "unit_number",
    "section", "passage", "question_start", "question_end", "prompt_text",
    "question_image", "source_text_id", "source_text_kind", "source_title",
    "source_text", "source_images", "audio_paths", "answers", "primary_tag",
    "tags", "tag_names", "classification_confidence", "review_required",
    "quality_status", "reason",
)
SOURCE_FIELDS = (
    "id", "skill", "volume", "book", "test_number", "test", "unit_number",
    "kind", "title", "text", "page_start", "page_end", "assets",
)
ANSWER_FIELDS = (
    "id", "item_id", "skill", "volume", "book", "test_number", "test",
    "question_number", "answer_text", "accepted_variants", "source_page",
    "note", "assets",
)
ASSET_FIELDS = ("id", "path", "page_number", "source_page", "sequence")


def _json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _csv(path: Path, records: list[dict[str, Any]], fields: tuple[str, ...]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for record in records:
            row = {}
            for key in fields:
                value = record.get(key)
                if isinstance(value, (list, dict)):
                    value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                row[key] = value
            writer.writerow(row)


def _portable_path(value: object, *, label: str) -> str:
    text = str(value or "")
    path = Path(text)
    if not text or path.is_absolute() or ".." in path.parts or re.match(r"^[A-Za-z]:[\\/]", text):
        raise ValueError(f"{label} path must be a non-empty relative path")
    if "\\" in text or text.startswith("file:"):
        raise ValueError(f"{label} path must use portable relative POSIX syntax")
    return path.as_posix()


def _reject_nonportable_strings(value: object, location: str = "record") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if str(key).startswith("_"):
                raise ValueError(f"{location} contains non-deliverable field: {key}")
            if key in PATH_KEYS and child is not None:
                _portable_path(child, label=f"{location}.{key}")
            _reject_nonportable_strings(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_nonportable_strings(child, f"{location}[{index}]")
    elif isinstance(value, str):
        if "/Users/" in value or "Programming Project" in value or re.search(r"[A-Za-z]:\\", value):
            raise ValueError(f"{location} contains an absolute workspace path")


def _portable_records(records: list[dict[str, Any]], fields: tuple[str, ...]) -> list[dict[str, Any]]:
    """Whitelist stable database fields and discard crop/OCR pipeline state."""
    result: list[dict[str, Any]] = []
    for record in records:
        portable = {key: record[key] for key in fields if key in record}
        if "assets" in portable:
            portable["assets"] = [
                {key: asset[key] for key in ASSET_FIELDS if key in asset}
                for asset in portable["assets"]
            ]
        result.append(portable)
    return result


def _tags_list(tags: object) -> list[dict[str, Any]]:
    if isinstance(tags, Mapping):
        tags = tags.get("tags", [])
    if not isinstance(tags, list):
        raise ValueError("taxonomy tags must be a list")
    result = [dict(tag) for tag in tags if isinstance(tag, Mapping)]
    if len(result) != len(tags):
        raise ValueError("taxonomy tags must contain objects")
    codes = [str(tag.get("code") or "") for tag in result]
    if any(not code for code in codes) or len(codes) != len(set(codes)):
        raise ValueError("taxonomy tag codes must be non-empty and unique")
    return result


def _question_range(item: Mapping[str, Any]) -> tuple[int, int]:
    try:
        start = int(item.get("question_start", item.get("question_number_start")))
        end = int(item.get("question_end", item.get("question_number_end", start)))
    except (TypeError, ValueError):
        raise ValueError(f"{item.get('id', '<missing>')} has no valid question range") from None
    if start < 1 or end < start or end > 40:
        raise ValueError(f"{item.get('id', '<missing>')} has an invalid question range")
    return start, end


def validate_release_inputs(
    items: list[dict[str, Any]],
    source_texts: list[dict[str, Any]],
    answers: list[dict[str, Any]],
    tags: object,
) -> list[dict[str, Any]]:
    """Validate the strict Listening/Reading database contract."""
    tag_records = _tags_list(tags)
    tag_dimensions = {tag["code"]: tag.get("dimension") for tag in tag_records}
    _reject_nonportable_strings(items, "items")
    _reject_nonportable_strings(source_texts, "source_texts")
    _reject_nonportable_strings(answers, "answers")
    _reject_nonportable_strings(tag_records, "taxonomy")

    item_ids = [str(item.get("id") or "") for item in items]
    source_ids = [str(source.get("id") or "") for source in source_texts]
    answer_ids = [str(answer.get("id") or "") for answer in answers]
    for label, values in (("item", item_ids), ("source text", source_ids), ("answer", answer_ids)):
        if any(not value for value in values) or len(values) != len(set(values)):
            raise ValueError(f"{label} IDs must be non-empty and unique")

    sources_by_id = {source["id"]: source for source in source_texts}
    items_by_id = {item["id"]: item for item in items}
    answers_by_item: dict[str, dict[int, dict[str, Any]]] = {item_id: {} for item_id in item_ids}

    for source in source_texts:
        skill = str(source.get("skill") or "").lower()
        if skill not in ALLOWED_SKILLS:
            raise ValueError(f"source_text {source.get('id')} is outside Listening/Reading scope")
        expected_kind = "audioscript" if skill == "listening" else "reading_passage"
        if source.get("kind") != expected_kind:
            raise ValueError(f"source_text {source.get('id')} kind must be {expected_kind}")
        if not str(source.get("text") or "").strip():
            raise ValueError(f"source_text {source.get('id')} must preserve original text")
        for asset in source.get("assets", []):
            _portable_path(asset.get("path"), label=f"source_text {source.get('id')} asset")

    for item in items:
        ident = item.get("id")
        skill = str(item.get("skill") or "").lower()
        if skill not in ALLOWED_SKILLS:
            raise ValueError(f"item {ident} is outside Listening/Reading scope")
        primary = item.get("primary_tag")
        item_tags = item.get("tags")
        if not isinstance(primary, str) or not primary:
            raise ValueError(f"item {ident} is missing primary_tag")
        if not primary.startswith(PRIMARY_PREFIX[skill]):
            raise ValueError(f"item {ident} primary_tag does not match skill")
        if not isinstance(item_tags, list) or not all(isinstance(tag, str) for tag in item_tags):
            raise ValueError(f"item {ident} tags must be a list of strings")
        unknown = [tag for tag in item_tags if tag not in tag_dimensions]
        if unknown:
            raise ValueError(f"item {ident} contains unknown tags: {unknown}")
        primary_members = [tag for tag in item_tags if tag_dimensions.get(tag) == "primary"]
        if primary not in item_tags or primary_members != [primary]:
            raise ValueError(f"item {ident} must have exactly one primary_tag in tags")
        if f"skill:{skill}" not in item_tags:
            raise ValueError(f"item {ident} is missing skill tag")
        _portable_path(item.get("image"), label=f"item {ident} image")
        source = sources_by_id.get(item.get("source_text_id"))
        if source is None:
            raise ValueError(f"item {ident} source_text_id does not exist")
        for field in ("skill", "volume", "test_number"):
            if str(item.get(field)) != str(source.get(field)):
                raise ValueError(f"item {ident} and source_text differ on {field}")
        _question_range(item)

    for answer in answers:
        item = items_by_id.get(answer.get("item_id"))
        if item is None:
            raise ValueError(f"answer {answer.get('id')} item_id does not exist")
        skill = str(answer.get("skill") or "").lower()
        if skill not in ALLOWED_SKILLS:
            raise ValueError(f"answer {answer.get('id')} is outside Listening/Reading scope")
        for field in ("skill", "volume", "test_number"):
            if str(answer.get(field)) != str(item.get(field)):
                raise ValueError(f"answer {answer.get('id')} and item differ on {field}")
        try:
            number = int(answer.get("question_number"))
        except (TypeError, ValueError):
            raise ValueError(f"answer {answer.get('id')} requires question_number") from None
        start, end = _question_range(item)
        if not start <= number <= end:
            raise ValueError(f"answer {answer.get('id')} question_number is outside item range")
        if not str(answer.get("answer_text") or "").strip():
            raise ValueError(f"answer {answer.get('id')} answer_text is empty")
        variants = answer.get("accepted_variants", [])
        if not isinstance(variants, list) or not all(isinstance(value, str) for value in variants):
            raise ValueError(f"answer {answer.get('id')} accepted_variants must be a string list")
        if number in answers_by_item[item["id"]]:
            raise ValueError(f"item {item['id']} has duplicate answer for question {number}")
        answers_by_item[item["id"]][number] = answer
        for asset in answer.get("assets", []):
            _portable_path(asset.get("path"), label=f"answer {answer.get('id')} asset")

    for item in items:
        start, end = _question_range(item)
        missing = sorted(set(range(start, end + 1)) - set(answers_by_item[item["id"]]))
        if missing:
            raise ValueError(f"item {item['id']} has missing answer relationship for questions {missing}")
    return tag_records


def _embedded_asset(asset: Mapping[str, Any]) -> dict[str, Any]:
    """Keep only portable source evidence needed by a self-contained item."""
    result: dict[str, Any] = {"path": _portable_path(asset.get("path"), label="embedded asset")}
    page = asset.get("page_number", asset.get("source_page"))
    if page is not None:
        result["page_number"] = int(page)
    if asset.get("sequence") is not None:
        result["sequence"] = int(asset["sequence"])
    return result


def build_complete_items(
    items: list[dict[str, Any]],
    source_texts: list[dict[str, Any]],
    answers: list[dict[str, Any]],
    taxonomy: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Resolve every relationship so each exported large-question row is usable alone."""
    tag_records = validate_release_inputs(items, source_texts, answers, taxonomy)
    sources_by_id = {source["id"]: source for source in source_texts}
    answers_by_item: dict[str, list[dict[str, Any]]] = {item["id"]: [] for item in items}
    for answer in answers:
        answers_by_item[answer["item_id"]].append(answer)
    tag_names = {
        tag["code"]: str(tag.get("name_en") or tag.get("name_zh") or tag["code"])
        for tag in tag_records
    }

    complete: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda value: value["id"]):
        source = sources_by_id[item["source_text_id"]]
        embedded_answers = []
        for answer in sorted(answers_by_item[item["id"]], key=lambda value: int(value["question_number"])):
            embedded_answers.append({
                "question_number": int(answer["question_number"]),
                "answer_text": answer["answer_text"],
                "accepted_variants": list(answer.get("accepted_variants") or []),
                "source_page": answer.get("source_page"),
                "note": answer.get("note"),
                "images": [_embedded_asset(asset) for asset in answer.get("assets", [])],
            })
        confidence = item.get("classification_confidence", item.get("confidence"))
        record = {
            "id": item["id"],
            "skill": item["skill"],
            "volume": int(item["volume"]),
            "book": item.get("book", f"cambridge_ielts_{int(item['volume']):02d}"),
            "test_number": int(item["test_number"]),
            "test": item.get("test", f"{int(item['test_number']):02d}"),
            "unit_number": int(item["unit_number"]),
            "section": int(item["section"]) if item.get("section") is not None else None,
            "passage": int(item["passage"]) if item.get("passage") is not None else None,
            "question_start": int(item["question_start"]),
            "question_end": int(item["question_end"]),
            "prompt_text": str(item.get("prompt_text") or ""),
            "question_image": _portable_path(item.get("image"), label=f"item {item['id']} image"),
            "source_text_id": source["id"],
            "source_text_kind": source["kind"],
            "source_title": source.get("title"),
            "source_text": source["text"],
            "source_images": [_embedded_asset(asset) for asset in source.get("assets", [])],
            "audio_paths": [
                _portable_path(path, label=f"item {item['id']} audio")
                for path in item.get("audio_paths", [])
            ],
            "answers": embedded_answers,
            "primary_tag": item["primary_tag"],
            "tags": list(item["tags"]),
            "tag_names": {tag: tag_names[tag] for tag in item["tags"]},
            "classification_confidence": float(confidence) if confidence is not None else None,
            "review_required": bool(item.get("review_required")),
            "quality_status": "review_recommended" if item.get("review_required") else "ready",
            "reason": str(item.get("reason") or ""),
        }
        if tuple(record) != ITEM_FIELDS:
            raise ValueError(f"item {item['id']} does not match the unified field contract")
        _reject_nonportable_strings(record, f"complete item {item['id']}")
        complete.append(record)
    return complete


def _copy_assets(staging: Path, source_root: Path | None, records: list[dict[str, Any]], *, item_images: bool = False) -> None:
    paths: set[str] = set()
    if item_images:
        paths.update(str(record["image"]) for record in records)
    for record in records:
        paths.update(str(asset["path"]) for asset in record.get("assets", []))
    for relative in sorted(paths):
        portable = _portable_path(relative, label="asset")
        destination = staging / portable
        if source_root is None:
            if not destination.is_file():
                raise ValueError(f"asset source_root is required for {portable}")
            continue
        source = source_root / portable
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"asset does not exist or is a symlink: {portable}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def _write_schema(path: Path, title: str, required: list[str]) -> None:
    _json(path, {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": title,
        "type": "object",
        "required": required,
        "additionalProperties": True,
    })


def export_release(
    output: Path | str,
    *,
    items: list[dict[str, Any]],
    source_texts: list[dict[str, Any]],
    answers: list[dict[str, Any]],
    taxonomy: Mapping[str, Any],
    source_root: Path | str | None = None,
    source_manifest: object | None = None,
    visual_qa: object | None = None,
) -> Path:
    """Build one immutable, portable Listening/Reading release directory."""
    tag_records = validate_release_inputs(items, source_texts, answers, taxonomy)
    complete_items = build_complete_items(items, source_texts, answers, taxonomy)
    portable_sources = _portable_records(source_texts, SOURCE_FIELDS)
    portable_answers = _portable_records(answers, ANSWER_FIELDS)
    destination = Path(output)
    if destination.exists():
        raise FileExistsError(f"release destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent))
    try:
        _copy_assets(staging, Path(source_root) if source_root is not None else None, items, item_images=True)
        _copy_assets(staging, Path(source_root) if source_root is not None else None, portable_sources)
        _copy_assets(staging, Path(source_root) if source_root is not None else None, portable_answers)

        _json(staging / "metadata/items.json", complete_items)
        _csv(staging / "metadata/items.csv", complete_items, ITEM_FIELDS)
        _json(staging / "metadata/taxonomy.json", dict(taxonomy))
        if source_manifest is not None:
            _reject_nonportable_strings(source_manifest, "source_manifest")
            _json(staging / "metadata/source_manifest.json", source_manifest)
        if visual_qa is not None:
            _reject_nonportable_strings(visual_qa, "visual_qa")
            _json(staging / "metadata/visual_qa.json", visual_qa)
        for tag in tag_records:
            item_ids = sorted(item["id"] for item in complete_items if tag["code"] in item["tags"])
            if item_ids:
                slug = re.sub(r"[^a-z0-9]+", "-", str(tag.get("slug") or tag["code"]).lower()).strip("-")
                _json(staging / f"by_tag/{slug}.json", {"tag": tag["code"], "item_ids": item_ids})

        _write_schema(staging / "schema/item.schema.json", "IELTS self-contained large question", list(ITEM_FIELDS))
        release = {
            "schema_version": "2.0",
            "name": "Cambridge IELTS Academic Listening and Reading Question Database",
            "scope": ["listening", "reading"],
            "excluded": ["writing", "speaking", "general_training"],
            "formats": ["json", "csv"],
            "record_model": "self_contained_large_question",
            "counts": {
                "items": len(complete_items), "source_texts": len(portable_sources),
                "answers": len(portable_answers), "tags": len(tag_records),
            },
        }
        _json(staging / "release.json", release)
        (staging / "README.md").write_text(
            "# 剑桥雅思 Academic 听力与阅读题库\n\n"
            "本发布包只包含 Cambridge IELTS Academic Listening 与 Academic Reading。"
            "Writing、Speaking、写作范文、口语示例和 General Training 不进入题库。\n\n"
            "## 数据规模\n\n"
            f"- 完整大题：{len(complete_items)} 条\n"
            f"- 内嵌原文来源：{len(portable_sources)} 条（Reading Passage 或 Listening Audioscript）\n"
            f"- 内嵌逐题答案：{len(portable_answers)} 条\n"
            f"- 标签：{len(tag_records)} 个\n\n"
            "## 目录说明\n\n"
            "- `metadata/items.json` 与 `metadata/items.csv`：字段完全一致；每条记录内嵌完整原文、"
            "原文图片、完整大题和该范围全部答案。CSV 中数组与对象使用 JSON 字符串。\n"
            "- `images/items/`：每个大题恰好一张 PNG；跨页大题已经纵向拼接。\n"
            "- `images/source_texts/`：阅读原文和听力 Audioscript 的原始页面 PNG。\n"
            "- `images/answers/`：答案来源页 PNG。\n"
            "- `by_tag/`：按标签生成的题组 ID 索引，不复制图片。\n"
            "- `schema/item.schema.json`：JSON 与 CSV 共用字段契约。\n\n"
            "## 记录边界\n\n"
            "Reading 每条记录对应一篇 Passage 下受同一作答说明控制的完整大题，并附完整 Passage。"
            "Listening 每条记录对应一个 Section 内的完整题型大题，并附完整 Audioscript。"
            "不按单个小题或分页继续拆分。\n\n"
            "## 使用与核验\n\n"
            "OCR 文本用于检索；题目、原文和答案的 PNG 是排版与特殊符号的视觉依据。"
            "`review_required=true` 表示分类或边界建议再次复核，不表示关联缺失。"
            "所有资源路径均相对于本目录，不依赖生成机器的绝对路径或中间文件。\n",
            encoding="utf-8",
        )
        staging.replace(destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return destination


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _cli() -> int:
    parser = argparse.ArgumentParser(description="导出 IELTS Academic 听力/阅读题库")
    parser.add_argument("--items", type=Path, required=True)
    parser.add_argument("--source-texts", type=Path, required=True)
    parser.add_argument("--answers", type=Path, required=True)
    parser.add_argument("--taxonomy", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    release = export_release(
        args.output, items=_load(args.items), source_texts=_load(args.source_texts),
        answers=_load(args.answers), taxonomy=_load(args.taxonomy), source_root=args.source_root,
    )
    print(json.dumps({"release": release.as_posix()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
