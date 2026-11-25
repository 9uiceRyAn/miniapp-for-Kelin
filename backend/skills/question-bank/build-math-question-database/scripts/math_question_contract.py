"""定义 Cambridge 9709 发布包 JSON 与 CSV 共用字段契约。"""
from __future__ import annotations

import json
from typing import Any, Mapping


RECORD_FIELDS = (
    "id",
    "subject",
    "syllabus_code",
    "year",
    "session",
    "paper",
    "component",
    "question_number",
    "image",
    "primary_tag",
    "tags",
    "tag_names",
    "classification_confidence",
    "quality_status",
    "question_document",
    "mark_scheme_document",
    "question_pages",
)

JSON_VALUE_FIELDS = {"tags", "tag_names", "question_pages"}
INTEGER_FIELDS = {"year", "question_number"}


def csv_row(record: Mapping[str, Any]) -> dict[str, Any]:
    """按统一字段顺序把发布记录编码为一行 CSV。"""
    if tuple(record) != RECORD_FIELDS:
        raise ValueError("发布记录字段或顺序不符合统一契约")
    row: dict[str, Any] = {}
    for field in RECORD_FIELDS:
        value = record[field]
        if field in JSON_VALUE_FIELDS:
            value = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        elif value is None:
            value = ""
        row[field] = value
    return row


def record_from_csv_row(row: Mapping[str, str]) -> dict[str, Any]:
    """把 CSV 行还原成与 questions.json 完全相同的数据类型。"""
    if tuple(row) != RECORD_FIELDS:
        raise ValueError("CSV 表头字段或顺序不符合统一契约")
    record: dict[str, Any] = {}
    for field in RECORD_FIELDS:
        value: Any = row[field]
        if field in JSON_VALUE_FIELDS:
            value = json.loads(value)
        elif field in INTEGER_FIELDS:
            value = int(value)
        elif field == "classification_confidence":
            value = None if value == "" else float(value)
        elif field == "mark_scheme_document" and value == "":
            value = None
        record[field] = value
    return record
