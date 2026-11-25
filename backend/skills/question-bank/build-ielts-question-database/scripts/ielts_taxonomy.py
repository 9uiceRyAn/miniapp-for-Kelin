#!/usr/bin/env python3
"""IELTS question-bank taxonomy and portable record validation.

The taxonomy is deliberately data-only: classification code may choose one
primary tag and any number of the declared auxiliary tags.  Validators return
deterministic error strings so the parser/exporter can collect diagnostics
without leaking local filesystem paths into a release.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable, Mapping


LISTENING_PRIMARY_TAGS = (
    "L.NOTE_COMPLETION",
    "L.TABLE_COMPLETION",
    "L.SENTENCE_COMPLETION",
    "L.SUMMARY_COMPLETION",
    "L.MAP_COMPLETION",
    "L.SINGLE_CHOICE",
    "L.MULTIPLE_CHOICE",
    "L.INFORMATION_MATCHING",
    "L.MAP_ORIENTATION",
    "L.FLOW_CHART_COMPLETION",
)
READING_PRIMARY_TAGS = (
    "R.TRUE_FALSE_NOT_GIVEN",
    "R.YES_NO_NOT_GIVEN",
    "R.SUMMARY_COMPLETION",
    "R.SENTENCE_COMPLETION",
    "R.DIAGRAM_COMPLETION",
    "R.TABLE_COMPLETION",
    "R.WORD_BANK_COMPLETION",
    "R.SHORT_ANSWER",
    "R.PARAGRAPH_INFORMATION_MATCHING",
    "R.SENTENCE_ENDING_MATCHING",
    "R.PERSON_VIEW_MATCHING",
    "R.DETAIL_INFORMATION_MATCHING",
    "R.SINGLE_CHOICE",
    "R.MULTIPLE_CHOICE",
    "R.MATCHING_HEADINGS",
)
ALL_PRIMARY_TAGS = (
    *LISTENING_PRIMARY_TAGS,
    *READING_PRIMARY_TAGS,
)

_PRIMARY_SKILL = {
    **{tag: "listening" for tag in LISTENING_PRIMARY_TAGS},
    **{tag: "reading" for tag in READING_PRIMARY_TAGS},
}

_PRIMARY_NAMES: dict[str, tuple[str, str, str]] = {
    # code: (Chinese name, English name, stable slug)
    "L.NOTE_COMPLETION": ("笔记填空", "Note completion", "listening-note-completion"),
    "L.TABLE_COMPLETION": ("表格填空", "Table completion", "listening-table-completion"),
    "L.SENTENCE_COMPLETION": ("句子填空", "Sentence completion", "listening-sentence-completion"),
    "L.SUMMARY_COMPLETION": ("摘要填空", "Summary completion", "listening-summary-completion"),
    "L.MAP_COMPLETION": ("地图填空", "Map completion", "listening-map-completion"),
    "L.SINGLE_CHOICE": ("单选题", "Single choice", "listening-single-choice"),
    "L.MULTIPLE_CHOICE": ("多选题", "Multiple choice", "listening-multiple-choice"),
    "L.INFORMATION_MATCHING": ("信息匹配", "Information matching", "listening-information-matching"),
    "L.MAP_ORIENTATION": ("地图方位", "Map orientation", "listening-map-orientation"),
    "L.FLOW_CHART_COMPLETION": ("流程图填空", "Flow-chart completion", "listening-flow-chart-completion"),
    "R.TRUE_FALSE_NOT_GIVEN": ("判断题（对/错/未提及）", "True/False/Not Given", "reading-true-false-not-given"),
    "R.YES_NO_NOT_GIVEN": ("观点判断（是/否/未提及）", "Yes/No/Not Given", "reading-yes-no-not-given"),
    "R.SUMMARY_COMPLETION": ("摘要填空", "Summary completion", "reading-summary-completion"),
    "R.SENTENCE_COMPLETION": ("句子填空", "Sentence completion", "reading-sentence-completion"),
    "R.DIAGRAM_COMPLETION": ("图示填空", "Diagram completion", "reading-diagram-completion"),
    "R.TABLE_COMPLETION": ("表格填空", "Table completion", "reading-table-completion"),
    "R.WORD_BANK_COMPLETION": ("词库填空", "Word-bank completion", "reading-word-bank-completion"),
    "R.SHORT_ANSWER": ("简答题", "Short answer", "reading-short-answer"),
    "R.PARAGRAPH_INFORMATION_MATCHING": ("段落信息匹配", "Paragraph-information matching", "reading-paragraph-information-matching"),
    "R.SENTENCE_ENDING_MATCHING": ("句子结尾匹配", "Sentence-ending matching", "reading-sentence-ending-matching"),
    "R.PERSON_VIEW_MATCHING": ("人物观点匹配", "Person-view matching", "reading-person-view-matching"),
    "R.DETAIL_INFORMATION_MATCHING": ("细节信息匹配", "Detailed-information matching", "reading-detailed-information-matching"),
    "R.SINGLE_CHOICE": ("单选题", "Single choice", "reading-single-choice"),
    "R.MULTIPLE_CHOICE": ("多选题", "Multiple choice", "reading-multiple-choice"),
    "R.MATCHING_HEADINGS": ("段落标题匹配", "Matching headings", "reading-matching-headings"),
}

_SCENES = {
    "housing": ("住宿", "Housing"),
    "travel": ("旅行", "Travel"),
    "daily_service": ("日常服务", "Daily service"),
    "campus": ("校园", "Campus"),
    "academic_course": ("学术课程", "Academic course"),
    "group_discussion": ("小组讨论", "Group discussion"),
    "research_lecture": ("研究讲座", "Research lecture"),
    "other": ("其他场景", "Other scene"),
}
_TOPICS = {
    "humanities_history": ("人文与历史", "Humanities and history"),
    "social_science": ("社会科学", "Social science"),
    "technology": ("科技", "Technology"),
    "biology": ("生物学", "Biology"),
    "geography": ("地理", "Geography"),
    "environment": ("环境", "Environment"),
    "education": ("教育", "Education"),
    "health": ("健康", "Health"),
    "archaeology": ("考古学", "Archaeology"),
    "society": ("社会", "Society"),
    "government_policy": ("政府与政策", "Government and policy"),
    "culture": ("文化", "Culture"),
    "globalisation": ("全球化", "Globalisation"),
    "other": ("其他主题", "Other topic"),
}
_SKILLS = {
    "listening": ("听力", "Listening"),
    "reading": ("阅读", "Reading"),
}


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _definition(code: str, name_zh: str, name_en: str, skill: str, dimension: str, slug: str | None = None) -> dict:
    return {
        "code": code,
        "slug": slug or _slug(code),
        "name_zh": name_zh,
        "name_en": name_en,
        "skill": skill,
        "dimension": dimension,
    }


def _primary_definitions() -> list[dict]:
    result = []
    for code in ALL_PRIMARY_TAGS:
        zh, en, slug = _PRIMARY_NAMES[code]
        result.append(_definition(code, zh, en, _PRIMARY_SKILL[code], "primary", slug))
    return result


def _auxiliary_definitions() -> list[dict]:
    result: list[dict] = []
    for skill, (zh, en) in _SKILLS.items():
        result.append(_definition(f"skill:{skill}", zh, en, skill, "skill", f"skill-{skill}"))
    for key, (zh, en) in _SCENES.items():
        result.append(_definition(f"scene:{key}", zh, en, "listening", "scene", f"scene-{_slug(key)}"))
    for key, (zh, en) in _TOPICS.items():
        result.append(_definition(f"topic:{key}", zh, en, "reading", "topic", f"topic-{_slug(key)}"))
    for volume in range(8, 22):
        result.append(_definition(
            f"book:cambridge_ielts_{volume:02d}", f"剑桥雅思{volume}", f"Cambridge IELTS {volume}",
            "listening|reading", "book", f"book-cambridge-ielts-{volume:02d}"
        ))
    for test in range(1, 9):
        result.append(_definition(f"test:{test:02d}", f"第{test}套试题", f"Test {test}", "all", "test", f"test-{test:02d}"))
    for section in range(1, 5):
        result.append(_definition(f"section:{section:02d}", f"听力第{section}部分", f"Listening section {section}", "listening", "section", f"section-{section:02d}"))
    for passage in range(1, 4):
        result.append(_definition(f"passage:{passage:02d}", f"阅读文章{passage}", f"Reading passage {passage}", "reading", "passage", f"passage-{passage:02d}"))
    return result


PRIMARY_DEFINITIONS = tuple(_primary_definitions())
AUXILIARY_DEFINITIONS = tuple(_auxiliary_definitions())
_EXACT_AUXILIARY_TAGS = {entry["code"] for entry in AUXILIARY_DEFINITIONS}


def build_taxonomy() -> dict:
    """Return the complete, deterministic taxonomy metadata object."""
    primary_tags = [dict(entry) for entry in PRIMARY_DEFINITIONS]
    auxiliary_tags = [dict(entry) for entry in AUXILIARY_DEFINITIONS]
    return {
        "schema_version": "1.0",
        "subject": "IELTS",
        "exam": "Cambridge IELTS",
        "scope": "Academic",
        "primary_tags": primary_tags,
        "auxiliary_tags": auxiliary_tags,
        # These flat aliases make the contract convenient for SQL/CSV exporters
        # while retaining the dimension-separated representation above.
        "tags": primary_tags + auxiliary_tags,
        "primary_tag_codes": list(ALL_PRIMARY_TAGS),
        "auxiliary_tag_codes": [entry["code"] for entry in auxiliary_tags],
        "tag_rules": {
            "primary_per_item": 1,
            "primary_must_be_in_tags": True,
            "dynamic_patterns": [
                "book:cambridge_ielts_{NN}", "test:{NN}", "section:{NN}",
                "passage:{NN}",
            ],
        },
        "record_contract": {
            "item_required": ["id", "skill", "primary_tag", "tags", "review_required"],
            "answer_required": ["item_id"],
            "review_required_rules": [
                "scene:other or topic:other",
                "classification confidence below configured threshold",
                "OCR or page-boundary diagnostics present",
            ],
        },
    }


def write_taxonomy(path: str | Path) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(build_taxonomy(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _skill_from_record(record: Mapping[str, object]) -> str | None:
    value = record.get("skill")
    if isinstance(value, str) and value:
        return value
    primary = record.get("primary_tag")
    return _PRIMARY_SKILL.get(primary) if isinstance(primary, str) else None


def _valid_auxiliary_tag(tag: str) -> bool:
    if tag in _EXACT_AUXILIARY_TAGS:
        return True
    # These patterns permit future books/tests while keeping the slug shape
    # constrained and prevent arbitrary user text from becoming a taxonomy tag.
    return bool(
        re.fullmatch(r"book:cambridge_ielts_(?:0[8-9]|1[0-9]|2[0-1])", tag)
        or re.fullmatch(r"test:(?:0[1-9]|[1-9][0-9])", tag)
        or re.fullmatch(r"section:0[1-4]", tag)
        or re.fullmatch(r"passage:0[1-3]", tag)
    )


def _question_range(item: Mapping[str, object]) -> tuple[int, int] | None:
    for start_key, end_key in (
        ("question_start", "question_end"),
        ("question_number_start", "question_number_end"),
    ):
        if start_key in item or end_key in item:
            try:
                start = int(item[start_key])
                end = int(item.get(end_key, start))
            except (TypeError, ValueError):
                return None
            return (start, end)
    numbers = item.get("question_numbers")
    if isinstance(numbers, (list, tuple)) and numbers:
        try:
            ints = [int(number) for number in numbers]
        except (TypeError, ValueError):
            return None
        return min(ints), max(ints)
    identifier = item.get("id")
    if isinstance(identifier, str):
        match = re.search(r"-Q(\d+)-(\d+)$", identifier)
        if match:
            return int(match.group(1)), int(match.group(2))
    return None


def validate_item(record: Mapping[str, object]) -> list[str]:
    """Validate one item and return portable, human-readable diagnostics."""
    errors: list[str] = []
    primary = record.get("primary_tag")
    tags = record.get("tags")
    skill = _skill_from_record(record)
    if not isinstance(primary, str) or not primary:
        errors.append("item is missing primary_tag")
    elif primary not in _PRIMARY_SKILL:
        errors.append(f"unknown primary tag: {primary}")
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        errors.append("item tags must be a list of strings")
        tags_list: list[str] = []
    else:
        tags_list = tags
    primary_in_tags = [tag for tag in tags_list if tag in _PRIMARY_SKILL]
    if len(primary_in_tags) != 1:
        errors.append(f"item must contain exactly one primary tag in tags (found {len(primary_in_tags)})")
    if isinstance(primary, str) and primary in _PRIMARY_SKILL and primary not in tags_list:
        errors.append("primary_tag must be included in tags")
    for tag in tags_list:
        if tag not in _PRIMARY_SKILL and not _valid_auxiliary_tag(tag):
            errors.append(f"unknown tag: {tag}")
    if isinstance(primary, str) and primary in _PRIMARY_SKILL and skill and _PRIMARY_SKILL[primary] != skill:
        errors.append(f"primary tag skill mismatch: {primary} is {_PRIMARY_SKILL[primary]}, item is {skill}")
    if {"scene:other", "topic:other"}.intersection(tags_list) and record.get("review_required") is False:
        errors.append("scene:other/topic:other items must set review_required=true")
    if isinstance(skill, str) and skill not in _SKILLS:
        errors.append(f"unknown skill: {skill}")
    skill_tag = f"skill:{skill}" if isinstance(skill, str) else None
    if skill_tag and skill_tag in tags_list and skill_tag not in _EXACT_AUXILIARY_TAGS:
        errors.append(f"unknown skill tag: {skill_tag}")
    # Keep the core relationship explicit when context fields are present.
    if isinstance(skill, str) and skill_tag and skill_tag not in tags_list:
        errors.append(f"item is missing required tag: {skill_tag}")
    for field, prefix in (("book", "book:"), ("test", "test:"), ("section", "section:"), ("passage", "passage:")):
        if field in record and record[field] is not None:
            value = str(record[field])
            if field == "book" and value.isdigit():
                expected = prefix + f"cambridge_ielts_{int(value):02d}"
            elif field == "book" and value.startswith("cambridge_ielts_"):
                expected = prefix + value
            else:
                expected = prefix + (value.zfill(2) if value.isdigit() else value)
            if expected not in tags_list:
                errors.append(f"item is missing context tag: {expected}")
    return errors


def require_valid_item(record: Mapping[str, object]) -> None:
    errors = validate_item(record)
    if errors:
        raise ValueError("; ".join(errors))


def validate_answer(record: Mapping[str, object], items_by_id: Mapping[str, Mapping[str, object]]) -> list[str]:
    """Validate an answer's direct link to an item and question/task scope."""
    errors: list[str] = []
    item_id = record.get("item_id")
    item = items_by_id.get(item_id) if isinstance(item_id, str) else None
    if item is None:
        return ["answer item_id does not reference an item"]
    skill = _skill_from_record(item)
    if skill not in _SKILLS:
        errors.append("answer item has unknown skill")
    answer_skill = record.get("skill")
    if answer_skill is not None and answer_skill != skill:
        errors.append("answer skill does not match item skill")
    for field in ("book", "test"):
        if field in record and record[field] is not None and str(record[field]) != str(item.get(field)):
            errors.append(f"answer {field} does not match item")
    variants = record.get("accepted_variants")
    if variants is not None and (not isinstance(variants, list) or not all(isinstance(value, str) for value in variants)):
        errors.append("accepted_variants must be a list of strings")
    if skill in {"listening", "reading"}:
        question = record.get("question_number")
        if isinstance(question, bool) or not isinstance(question, int):
            errors.append("listening/reading answer requires integer question_number")
        else:
            question_range = _question_range(item)
            if question_range is None:
                errors.append("item has no question range for answer validation")
            elif not question_range[0] <= question <= question_range[1]:
                errors.append("answer question_number is outside item range")
    source_page = record.get("source_page")
    if source_page is not None:
        if isinstance(source_page, bool) or not isinstance(source_page, int) or source_page < 1:
            errors.append("source_page must be a positive integer")
    return errors


def validate_items(records: Iterable[Mapping[str, object]]) -> dict[str, list[str]]:
    return {
        str(record.get("id", "<missing-id>")): errors
        for record in records
        if (errors := validate_item(record))
    }


def _cli() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="生成雅思题库标签 taxonomy.json")
    parser.add_argument("--output", type=Path, required=True, help="taxonomy.json 输出路径")
    args = parser.parse_args()
    write_taxonomy(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
