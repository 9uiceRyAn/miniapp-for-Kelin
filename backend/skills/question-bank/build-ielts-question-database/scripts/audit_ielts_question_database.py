#!/usr/bin/env python3
"""Audit the self-contained IELTS Academic Listening/Reading CSV/JSON release."""
from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping

from PIL import Image


ALLOWED_SKILLS = {"listening", "reading"}
ITEM_FIELDS = (
    "id", "skill", "volume", "book", "test_number", "test", "unit_number",
    "section", "passage", "question_start", "question_end", "prompt_text",
    "question_image", "source_text_id", "source_text_kind", "source_title",
    "source_text", "source_images", "audio_paths", "answers", "primary_tag",
    "tags", "tag_names", "classification_confidence", "review_required",
    "quality_status", "reason",
)
REQUIRED = (
    "README.md", "release.json", "metadata/items.json", "metadata/items.csv",
    "metadata/taxonomy.json", "schema/item.schema.json",
)
TEXT_SUFFIXES = {".json", ".csv", ".md"}
NONPORTABLE_RE = re.compile(
    r"/Users/|Programming Project|file://|(?<![A-Za-z0-9])[A-Za-z]:\\\\(?:[^\\]|$)"
)
COMPLEX_FIELDS = {"source_images", "audio_paths", "answers", "tags", "tag_names"}
INTEGER_FIELDS = {
    "volume", "test_number", "unit_number", "section", "passage",
    "question_start", "question_end",
}


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _relative(value: object) -> bool:
    text = str(value or "")
    path = Path(text)
    return bool(text and not path.is_absolute() and ".." not in path.parts and "\\" not in text)


def _csv_value(field: str, value: str) -> Any:
    if field in COMPLEX_FIELDS:
        return json.loads(value)
    if field in INTEGER_FIELDS:
        return None if value == "" else int(value)
    if field == "classification_confidence":
        return None if value == "" else float(value)
    if field == "review_required":
        return value.strip().lower() == "true"
    if field == "source_title":
        return None if value == "" else value
    return value


def _csv_records(path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        fields = list(reader.fieldnames or [])
        return fields, [
            {field: _csv_value(field, value) for field, value in row.items()}
            for row in reader
        ]


def _asset_paths(item: Mapping[str, Any]) -> list[tuple[str, str]]:
    paths = [(f"item {item.get('id')} question", str(item.get("question_image") or ""))]
    for asset in item.get("source_images", []):
        paths.append((f"item {item.get('id')} source", str(asset.get("path") or "")))
    for answer in item.get("answers", []):
        for asset in answer.get("images", []):
            paths.append((f"item {item.get('id')} answer", str(asset.get("path") or "")))
    return paths


def _record_errors(items: list[dict[str, Any]], taxonomy: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    tags_raw = taxonomy.get("tags", [])
    tags = {str(tag.get("code")): tag for tag in tags_raw if isinstance(tag, Mapping)}
    ids = [str(item.get("id") or "") for item in items]
    if any(not value for value in ids) or len(ids) != len(set(ids)):
        errors.append("item IDs must be non-empty and unique")

    coverage: dict[tuple[int, int, str], list[tuple[int, str]]] = defaultdict(list)
    for item in items:
        ident = str(item.get("id") or "<missing>")
        if tuple(item) != ITEM_FIELDS:
            errors.append(f"item {ident} fields/order do not match the unified contract")
        skill = str(item.get("skill") or "")
        if skill not in ALLOWED_SKILLS:
            errors.append(f"item {ident} is outside Listening/Reading scope")
            continue
        if skill == "reading" and (item.get("passage") is None or item.get("section") is not None):
            errors.append(f"item {ident} must have passage and null section")
        if skill == "listening" and (item.get("section") is None or item.get("passage") is not None):
            errors.append(f"item {ident} must have section and null passage")
        expected_kind = "reading_passage" if skill == "reading" else "audioscript"
        if item.get("source_text_kind") != expected_kind or not str(item.get("source_text") or "").strip():
            errors.append(f"item {ident} does not embed its complete {expected_kind}")
        if not str(item.get("prompt_text") or "").strip():
            errors.append(f"item {ident} has empty prompt_text")
        if skill == "listening":
            next_section = int(item["section"]) + 1
            if re.search(
                rf"(?:SECTION|PART)\s*{next_section}\b",
                str(item.get("prompt_text") or ""), re.IGNORECASE,
            ):
                errors.append(f"item {ident} prompt_text includes the next Section/Part heading")
            if re.search(
                r"Listening\s*(?:a\s*nd|and)\s*Reading\s*Answer\s*Keys",
                str(item.get("source_text") or ""), re.IGNORECASE,
            ):
                errors.append(f"item {ident} audioscript includes an answer-key page")
        if not isinstance(item.get("source_images"), list) or not item["source_images"]:
            errors.append(f"item {ident} has no embedded source images")
        primary = item.get("primary_tag")
        item_tags = item.get("tags")
        prefix = "R." if skill == "reading" else "L."
        if not isinstance(primary, str) or not primary.startswith(prefix):
            errors.append(f"item {ident} primary_tag does not match skill")
        if not isinstance(item_tags, list) or primary not in item_tags:
            errors.append(f"item {ident} primary_tag is absent from tags")
            item_tags = []
        unknown = [tag for tag in item_tags if tag not in tags]
        if unknown:
            errors.append(f"item {ident} has unknown tags: {unknown}")
        expected_status = "review_recommended" if item.get("review_required") else "ready"
        if item.get("quality_status") != expected_status:
            errors.append(f"item {ident} quality_status disagrees with review_required")
        try:
            start, end = int(item["question_start"]), int(item["question_end"])
        except (KeyError, TypeError, ValueError):
            errors.append(f"item {ident} has invalid question range")
            continue
        answers = item.get("answers")
        if not isinstance(answers, list):
            errors.append(f"item {ident} answers must be a list")
            answers = []
        numbers = [answer.get("question_number") for answer in answers if isinstance(answer, Mapping)]
        if numbers != list(range(start, end + 1)):
            errors.append(f"item {ident} does not embed exactly one answer for every question")
        for answer in answers:
            if not str(answer.get("answer_text") or "").strip():
                errors.append(f"item {ident} has an empty embedded answer")
        for number in range(start, end + 1):
            coverage[(int(item["volume"]), int(item["test_number"]), skill)].append((number, ident))

    for key, numbered in coverage.items():
        counts = Counter(number for number, _ident in numbered)
        if len(counts) < 10:
            # Unit-test and partial-library releases may intentionally contain a
            # small sample. Full Cambridge tests always reach this gate.
            continue
        missing = sorted(set(range(1, 41)) - set(counts))
        overlap = sorted(number for number, count in counts.items() if count != 1)
        if missing or overlap:
            errors.append(f"{key} question coverage invalid; missing={missing}, overlap={overlap}")
    return errors


def _image_errors(root: Path, items: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for item in items:
        for label, relative in _asset_paths(item):
            if relative in seen:
                continue
            seen.add(relative)
            if not _relative(relative):
                errors.append(f"{label} path is absolute or non-portable: {relative}")
                continue
            path = root / relative
            if path.is_symlink() or not path.is_file():
                errors.append(f"{label} image is missing or a symlink: {relative}")
                continue
            try:
                with Image.open(path) as image:
                    image.verify()
                if label.endswith(" question"):
                    with Image.open(path) as image:
                        if image.height >= 1000:
                            mask = image.convert("L").point(lambda value: 0 if value >= 245 else 255)
                            box = mask.getbbox()
                            bottom_blank = image.height if box is None else image.height - box[3]
                            if bottom_blank >= 500 and bottom_blank / image.height > 0.30:
                                errors.append(
                                    f"{label} has a probable blank-page tail: {bottom_blank}px"
                                )
            except Exception as exc:
                errors.append(f"{label} image cannot be decoded: {relative}: {exc}")
    return errors


def audit_release(root: Path | str) -> dict[str, Any]:
    release_root = Path(root)
    errors: list[str] = []
    warnings: list[str] = []
    for relative in REQUIRED:
        if not (release_root / relative).is_file():
            errors.append(f"required file is missing: {relative}")
    forbidden = [
        path.relative_to(release_root).as_posix()
        for path in release_root.rglob("*")
        if path.is_file() and (path.suffix.lower() in {".sql", ".jsonl"} or path.name == ".DS_Store")
    ]
    if forbidden:
        errors.append(f"release contains forbidden delivery artifacts: {forbidden}")
    if errors:
        return {"error_count": len(errors), "warning_count": 0, "errors": errors, "warnings": warnings}

    for path in release_root.rglob("*"):
        if path.is_symlink():
            errors.append(f"release contains a symlink: {path.relative_to(release_root).as_posix()}")
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            text = path.read_text(encoding="utf-8", errors="replace")
            if NONPORTABLE_RE.search(text):
                errors.append(f"text artifact contains an absolute workspace path: {path.relative_to(release_root).as_posix()}")

    try:
        items = _read_json(release_root / "metadata/items.json")
        taxonomy = _read_json(release_root / "metadata/taxonomy.json")
        release = _read_json(release_root / "release.json")
        csv_fields, csv_items = _csv_records(release_root / "metadata/items.csv")
    except Exception as exc:
        errors.append(f"core metadata cannot be parsed: {exc}")
        return {"error_count": len(errors), "warning_count": 0, "errors": errors, "warnings": warnings}
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        errors.append("metadata/items.json must be an array of objects")
        items = []
    if csv_fields != list(ITEM_FIELDS):
        errors.append("CSV fields/order do not match the JSON field contract")
    if csv_items != items:
        errors.append("metadata/items.csv content does not match metadata/items.json")
    if release.get("formats") != ["json", "csv"] or release.get("record_model") != "self_contained_large_question":
        errors.append("release.json does not declare the self-contained CSV/JSON model")
    if release.get("scope") != ["listening", "reading"]:
        errors.append("release.json scope must contain only listening and reading")
    counts = release.get("counts", {})
    unique_sources = {item.get("source_text_id") for item in items}
    answer_count = sum(len(item.get("answers", [])) for item in items)
    actual_counts = {
        "items": len(items), "source_texts": len(unique_sources),
        "answers": answer_count, "tags": len(taxonomy.get("tags", [])),
    }
    for key, value in actual_counts.items():
        if counts.get(key) != value:
            errors.append(f"release.json count mismatch for {key}")
    errors.extend(_record_errors(items, taxonomy))
    errors.extend(_image_errors(release_root, items))
    return {
        "error_count": len(errors), "warning_count": len(warnings),
        "errors": errors, "warnings": warnings, "counts": actual_counts,
    }


def _cli() -> int:
    parser = argparse.ArgumentParser(description="审计 IELTS 自包含听力/阅读 CSV/JSON 题库")
    parser.add_argument("release", type=Path)
    args = parser.parse_args()
    report = audit_release(args.release)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["error_count"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(_cli())
