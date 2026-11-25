#!/usr/bin/env python3
"""导出只包含 JSON、CSV 和题目图片的 Cambridge 9709 发布包。"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
from pathlib import Path

from audit_math_question_database import audit_release
from math_question_contract import RECORD_FIELDS, csv_row


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "output/math_question_bank"
RELEASE = ROOT / "output/math_question_database_v1"
STAGING = ROOT / "output/.math_question_database_v1.staging"

PAPER_COMPONENTS = {
    "1": "Pure Mathematics 1",
    "2": "Pure Mathematics 2",
    "3": "Pure Mathematics 3",
    "4": "Mechanics",
    "5": "Probability and Statistics 1",
    "6": "Probability and Statistics 2",
}

TOPICS = {
    "1.1": "Quadratics", "1.2": "Functions", "1.3": "Coordinate geometry",
    "1.4": "Circular measure", "1.5": "Trigonometry", "1.6": "Series",
    "1.7": "Differentiation", "1.8": "Integration",
    "2.1": "Algebra", "2.2": "Logarithmic and exponential functions",
    "2.3": "Trigonometry", "2.4": "Differentiation", "2.5": "Integration",
    "2.6": "Numerical solution of equations",
    "3.1": "Algebra", "3.2": "Logarithmic and exponential functions",
    "3.3": "Trigonometry", "3.4": "Differentiation", "3.5": "Integration",
    "3.6": "Numerical solution of equations", "3.7": "Vectors",
    "3.8": "Differential equations", "3.9": "Complex numbers",
    "4.1": "Forces and equilibrium", "4.2": "Kinematics of motion in a straight line",
    "4.3": "Momentum", "4.4": "Newton's laws of motion", "4.5": "Energy, work and power",
    "5.1": "Representation of data", "5.2": "Permutations and combinations",
    "5.3": "Probability", "5.4": "Discrete random variables", "5.5": "The normal distribution",
    "6.1": "The Poisson distribution", "6.2": "Linear combinations of random variables",
    "6.3": "Continuous random variables", "6.4": "Sampling and estimation",
    "6.5": "Hypothesis tests",
}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_name(value: str) -> str:
    value = value.replace("&", "and").replace("'", "")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_")


def topic_code(tag: str | None) -> str | None:
    if not tag:
        return None
    match = re.match(r"^(\d\.\d)", tag.strip())
    return match.group(1) if match else None


def link_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def portable_record(raw: dict) -> dict:
    paper_group = str(raw["paper"])[0]
    codes: list[str] = []
    for tag in raw.get("tags", []):
        code = topic_code(tag)
        if code and code not in codes:
            codes.append(code)
    primary = topic_code(raw.get("primary_tag"))
    if primary and primary not in codes:
        codes.insert(0, primary)
    if not codes:
        raise ValueError(f"Question has no normalized tags: {raw['id']}")
    primary = primary or codes[0]
    if any(code[0] != paper_group for code in codes):
        raise ValueError(f"Question has a tag outside paper component {paper_group}: {raw['id']}")

    pages: list[int] = []
    for part in raw.get("crop_plan", []):
        page = int(part["source_page"])
        if page not in pages:
            pages.append(page)
    confidence = raw.get("confidence")
    record = {
        "id": raw["id"],
        "subject": "Mathematics",
        "syllabus_code": "9709",
        "year": int(raw["year"]),
        "session": raw["session"],
        "paper": str(raw["paper"]),
        "component": PAPER_COMPONENTS[paper_group],
        "question_number": int(raw["question_number"]),
        "image": f"images/questions/{raw['id']}.png",
        "primary_tag": primary,
        "tags": codes,
        "tag_names": {code: TOPICS[code] for code in codes},
        "classification_confidence": round(float(confidence), 2) if confidence is not None else None,
        "quality_status": "review_recommended" if raw.get("review_required") else "ready",
        "question_document": Path(raw["question_pdf"]).name,
        "mark_scheme_document": Path(raw["mark_scheme_pdf"]).name if raw.get("mark_scheme_pdf") else None,
        "question_pages": pages,
    }
    if tuple(record) != RECORD_FIELDS:
        raise ValueError(f"Portable record does not follow the field contract: {raw['id']}")
    return record


def build_taxonomy() -> dict:
    return {
        "schema_version": "2.0",
        "syllabus_code": "9709",
        "subject": "Mathematics",
        "components": [
            {
                "code": number,
                "name": name,
                "topics": [
                    {"code": code, "name": topic_name}
                    for code, topic_name in TOPICS.items()
                    if code.startswith(number + ".")
                ],
            }
            for number, name in PAPER_COMPONENTS.items()
        ],
    }


def write_csv(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=RECORD_FIELDS)
        writer.writeheader()
        writer.writerows(csv_row(item) for item in records)


def build_schema() -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "question.schema.json",
        "title": "Cambridge 9709 large question",
        "type": "object",
        "required": list(RECORD_FIELDS),
        "properties": {
            "id": {"type": "string", "pattern": "^9709-[1-6][1-5]-20\\d{2}-(FM|MJ|ON)-Q\\d{2}$"},
            "subject": {"const": "Mathematics"},
            "syllabus_code": {"const": "9709"},
            "year": {"type": "integer"},
            "session": {"enum": ["FM", "MJ", "ON"]},
            "paper": {"type": "string", "pattern": "^[1-6][1-5]$"},
            "component": {"type": "string"},
            "question_number": {"type": "integer", "minimum": 1},
            "image": {"type": "string"},
            "primary_tag": {"type": "string", "pattern": "^[1-6]\\.[1-9]$"},
            "tags": {"type": "array", "minItems": 1, "uniqueItems": True, "items": {"type": "string"}},
            "tag_names": {"type": "object", "additionalProperties": {"type": "string"}},
            "classification_confidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
            "quality_status": {"enum": ["ready", "review_recommended"]},
            "question_document": {"type": "string"},
            "mark_scheme_document": {"type": ["string", "null"]},
            "question_pages": {"type": "array", "minItems": 1, "items": {"type": "integer", "minimum": 1}},
        },
        "additionalProperties": False,
    }


def write_readme(path: Path, count: int) -> None:
    path.write_text(f"""# Cambridge 9709 数学题目数据库

这是一个可移植的题目数据库发布包，共包含 {count} 道大题。

## 目录结构

- `images/questions/`：每道大题对应一张紧凑 PNG 图片。
- `metadata/questions.json`：全部题目记录。
- `metadata/questions.csv`：与 JSON 使用完全相同的字段和顺序；数组与对象使用 JSON 字符串编码。
- `metadata/taxonomy.json`：考试组件和主题定义。
- `by_tag/`：按主题分类的题目图片与索引。
- `schema/question.schema.json`：JSON 与 CSV 共用字段契约。

发布包不包含数据库脚本。下游系统可根据 JSON 或 CSV 自行导入数据库。
所有路径均相对于本发布目录；源 PDF 只保留文件名，不包含在发布包中。
`quality_status=review_recommended` 表示分类建议复核。
""", encoding="utf-8")


def build() -> None:
    raw_records = json.loads((SOURCE / "metadata/questions_manifest.json").read_text(encoding="utf-8"))
    records = sorted((portable_record(raw) for raw in raw_records), key=lambda item: item["id"])

    if STAGING.exists():
        shutil.rmtree(STAGING)
    (STAGING / "images/questions").mkdir(parents=True)

    for item in records:
        filename = f"{item['id']}.png"
        source_image = SOURCE / "canonical/questions" / filename
        if not source_image.exists():
            raise FileNotFoundError(source_image)
        canonical = STAGING / "images/questions" / filename
        link_or_copy(source_image, canonical)
        for code in item["tags"]:
            component = PAPER_COMPONENTS[code[0]]
            topic = TOPICS[code]
            folder = STAGING / "by_tag" / f"{code[0]}_{safe_name(component)}" / f"{code}_{safe_name(topic)}"
            link_or_copy(canonical, folder / "questions" / filename)

    metadata = STAGING / "metadata"
    write_json(metadata / "questions.json", records)
    write_csv(metadata / "questions.csv", records)
    write_json(metadata / "taxonomy.json", build_taxonomy())

    for code, name in TOPICS.items():
        component = PAPER_COMPONENTS[code[0]]
        folder = STAGING / "by_tag" / f"{code[0]}_{safe_name(component)}" / f"{code}_{safe_name(name)}"
        selected = [item["id"] for item in records if code in item["tags"]]
        write_json(folder / "index.json", {"tag": code, "name": name, "question_count": len(selected), "question_ids": selected})

    write_json(STAGING / "schema/question.schema.json", build_schema())
    write_readme(STAGING / "README.md", len(records))
    write_json(STAGING / "release.json", {
        "name": "Cambridge 9709 Mathematics Question Database",
        "version": "1.1.0",
        "schema_version": "2.0",
        "question_count": len(records),
        "image_count": len(records),
        "taxonomy_topic_count": len(TOPICS),
        "formats": ["metadata/questions.json", "metadata/questions.csv"],
    })

    audit = audit_release(STAGING)
    if audit["errors"]:
        raise RuntimeError("发布包审计失败：\n" + "\n".join(audit["errors"]))

    if RELEASE.exists():
        shutil.rmtree(RELEASE)
    STAGING.replace(RELEASE)
    print(RELEASE)
    print(json.dumps({"questions": len(records), "images": audit["images"], "csv": audit["csv"], "audit_errors": 0}, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="导出可移植的 Cambridge 9709 数学题目数据库。", add_help=False)
    parser.add_argument("-h", "--help", action="help", help="显示此帮助信息并退出")
    parser.parse_args()
    build()


if __name__ == "__main__":
    main()
