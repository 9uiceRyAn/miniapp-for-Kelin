#!/usr/bin/env python3
"""审计仅交付 JSON、CSV 与图片的 Cambridge 9709 题库发布包。"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image

from math_question_contract import RECORD_FIELDS, record_from_csv_row


ID_RE = re.compile(r"^9709-([1-6][1-5])-(20\d{2})-(FM|MJ|ON)-Q(\d{2})$")
TAG_RE = re.compile(r"^([1-6])\.[1-9]$")
ABSOLUTE_OR_SCRATCH = re.compile(
    r"/Users/|[A-Za-z]:\\|Programming Project|tmp_render|compact_staging|"
    r"crop_plan|bbox_points|question_pdf|mark_scheme_pdf|original/questions"
)
TEXT_SUFFIXES = {".json", ".csv", ".md"}
REQUIRED = (
    "metadata/questions.json",
    "metadata/questions.csv",
    "metadata/taxonomy.json",
    "schema/question.schema.json",
    "release.json",
    "README.md",
)
EXPECTED_FORMATS = ["metadata/questions.json", "metadata/questions.csv"]


class ChineseHelpFormatter(argparse.HelpFormatter):
    def start_section(self, heading: str | None) -> None:
        names = {"positional arguments": "位置参数", "optional arguments": "选项", "options": "选项"}
        super().start_section(names.get(heading, heading))

    def _format_usage(self, usage: str | None, actions: Any, groups: Any, prefix: str | None) -> str:
        return super()._format_usage(usage, actions, groups, prefix or "用法：")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def record_contract_errors(record: dict[str, Any]) -> list[str]:
    ident = str(record.get("id", "<missing-id>"))
    errors: list[str] = []
    if tuple(record) != RECORD_FIELDS:
        errors.append(f"{ident}：字段或字段顺序不符合统一契约")
    paper = str(record.get("paper", ""))
    match = ID_RE.fullmatch(ident)
    if not match:
        errors.append(f"{ident}：稳定 ID 无效")
    elif paper and match.group(1) != paper:
        errors.append(f"{ident}：ID 中的试卷号与记录不一致")
    image = Path(str(record.get("image", "")))
    if image.is_absolute() or ".." in image.parts or not image.parts:
        errors.append(f"{ident}：图片路径必须是相对于发布包根目录的相对路径")
    elif image.as_posix() != f"images/questions/{ident}.png":
        errors.append(f"{ident}：图片路径与稳定 ID 不匹配")
    tags = record.get("tags")
    primary = record.get("primary_tag")
    if not isinstance(tags, list) or not tags:
        errors.append(f"{ident}：tags 必须是非空列表")
        tags = []
    if primary not in tags:
        errors.append(f"{ident}：primary_tag 必须属于 tags")
    if len(tags) != len(set(map(str, tags))):
        errors.append(f"{ident}：tags 包含重复值")
    expected_prefix = paper[:1]
    for tag in tags:
        tag_match = TAG_RE.fullmatch(str(tag))
        if not tag_match:
            errors.append(f"{ident}：主题代码无效：{tag}")
        elif expected_prefix and tag_match.group(1) != expected_prefix:
            errors.append(f"{ident}：主题 {tag} 不属于试卷组件 {expected_prefix}")
    pages = record.get("question_pages")
    if not isinstance(pages, list) or not pages or not all(isinstance(page, int) and page > 0 for page in pages):
        errors.append(f"{ident}：question_pages 必须是非空正整数数组")
    return errors


def read_csv_records(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    errors: list[str] = []
    records: list[dict[str, Any]] = []
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != RECORD_FIELDS:
                return [], ["questions.csv 表头字段或顺序不符合统一契约"]
            for line_number, row in enumerate(reader, 2):
                try:
                    records.append(record_from_csv_row(row))
                except Exception as exc:
                    errors.append(f"questions.csv 第 {line_number} 行无法按统一契约解析：{exc}")
    except Exception as exc:
        errors.append(f"questions.csv 无法读取：{exc}")
    return records, errors


def audit_release(root: Path) -> dict[str, Any]:
    root = root.resolve()
    errors: list[str] = []
    missing = [name for name in REQUIRED if not (root / name).is_file()]
    errors.extend(f"缺少必需文件：{name}" for name in missing)
    if missing:
        return {"release": str(root), "questions": 0, "csv": 0, "images": 0, "errors": errors, "error_count": len(errors)}

    records = read_json(root / "metadata/questions.json")
    csv_records, csv_errors = read_csv_records(root / "metadata/questions.csv")
    errors.extend(csv_errors)
    taxonomy = read_json(root / "metadata/taxonomy.json")
    release = read_json(root / "release.json")

    if not isinstance(records, list):
        errors.append("questions.json 必须包含数组")
        records = []
    errors.extend(error for record in records for error in record_contract_errors(record))
    if records != csv_records:
        errors.append("CSV 还原后的字段和值与 JSON 不一致（questions.csv / questions.json）")

    ids = [str(record.get("id")) for record in records]
    if len(ids) != len(set(ids)):
        errors.append("questions.json 包含重复 ID")

    topic_map = {
        str(topic.get("code")): str(topic.get("name"))
        for component in taxonomy.get("components", [])
        for topic in component.get("topics", [])
    }
    for record in records:
        expected_names = {str(tag): topic_map.get(str(tag)) for tag in record.get("tags", [])}
        if record.get("tag_names") != expected_names:
            errors.append(f"{record.get('id')}：tag_names 与 taxonomy.json 不一致")

    images = sorted((root / "images/questions").glob("*.png"))
    if len(images) != len(records):
        errors.append(f"图片数 {len(images)} 与记录数 {len(records)} 不一致")
    referenced = {str(record.get("image")) for record in records}
    actual = {str(path.relative_to(root)) for path in images}
    if referenced != actual:
        errors.append("元数据引用的图片集合与实际规范图片集合不一致")
    for path in images:
        try:
            with Image.open(path) as image:
                image.verify()
        except Exception as exc:
            errors.append(f"无法读取 PNG {path.relative_to(root)}：{exc}")

    for code, name in topic_map.items():
        indexes = list((root / "by_tag").glob(f"*/{code}_*/index.json"))
        if len(indexes) != 1:
            errors.append(f"主题 {code} 有 {len(indexes)} 个索引文件")
            continue
        index = read_json(indexes[0])
        expected_ids = [record["id"] for record in records if code in record.get("tags", [])]
        if index.get("tag") != code or index.get("name") != name:
            errors.append(f"主题 {code} 的索引标识与分类体系不一致")
        if index.get("question_count") != len(expected_ids) or index.get("question_ids") != expected_ids:
            errors.append(f"主题 {code} 的索引成员与元数据不一致")
        linked = sorted(path.stem for path in (indexes[0].parent / "questions").glob("*.png"))
        if linked != sorted(expected_ids):
            errors.append(f"主题 {code} 的图片集合与元数据不一致")

    if release.get("formats") != EXPECTED_FORMATS:
        errors.append(f"release.json 的 formats 必须为 {EXPECTED_FORMATS}")
    if release.get("question_count") != len(records) or release.get("image_count") != len(images):
        errors.append("release.json 中的数量与审计结果不一致")
    if release.get("taxonomy_topic_count") != len(topic_map):
        errors.append("release.json 中的主题数量与 taxonomy.json 不一致")

    allowed_top = {"README.md", "by_tag", "images", "metadata", "release.json", "schema"}
    unexpected_top = sorted(path.name for path in root.iterdir() if path.name not in allowed_top)
    if unexpected_top:
        errors.append(f"存在意外的顶层条目：{unexpected_top}")
    allowed_metadata = {"questions.json", "questions.csv", "taxonomy.json"}
    unexpected_metadata = sorted(path.name for path in (root / "metadata").iterdir() if path.name not in allowed_metadata)
    if unexpected_metadata:
        errors.append(f"metadata 中存在非交付文件：{unexpected_metadata}")

    for path in root.rglob("*"):
        if path.is_symlink():
            errors.append(f"发布包包含符号链接：{path.relative_to(root)}")
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            text = path.read_text(encoding="utf-8", errors="replace")
            if ABSOLUTE_OR_SCRATCH.search(text):
                errors.append(f"文件含有禁止的路径或临时字段：{path.relative_to(root)}")

    question_tags = sum(len(record.get("tags", [])) for record in records)
    return {
        "release": str(root),
        "questions": len(records),
        "csv": len(csv_records),
        "images": len(images),
        "tags": len(topic_map),
        "question_tags": question_tags,
        "taxonomy_topics": len(topic_map),
        "errors": errors,
        "error_count": len(errors),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="审计可移植的 Cambridge 9709 数学题库发布包。",
        add_help=False,
        formatter_class=ChineseHelpFormatter,
    )
    parser.add_argument("-h", "--help", action="help", help="显示此帮助信息并退出")
    parser.add_argument("release", type=Path, nargs="?", default=Path("output/math_question_database_v1"), help="发布包根目录")
    args = parser.parse_args()
    result = audit_release(args.release)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
