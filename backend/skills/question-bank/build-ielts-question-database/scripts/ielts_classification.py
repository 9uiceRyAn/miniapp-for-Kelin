#!/usr/bin/env python3
"""Build portable AI contexts and apply IELTS Listening/Reading classifications.

Instruction matching in this module is intentionally advisory: it narrows the
allowed primary-tag candidates supplied to an AI reviewer, but it never makes
the final semantic decision.  ``apply_classifications`` validates and records
that external AI decision.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any


def _load_taxonomy_module() -> Any:
    path = Path(__file__).with_name("ielts_taxonomy.py")
    spec = importlib.util.spec_from_file_location("_ielts_classification_taxonomy", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load taxonomy module: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_TAXONOMY = _load_taxonomy_module()
LISTENING_PRIMARY_TAGS = tuple(_TAXONOMY.LISTENING_PRIMARY_TAGS)
READING_PRIMARY_TAGS = tuple(_TAXONOMY.READING_PRIMARY_TAGS)
ALL_PRIMARY_TAGS = frozenset((*LISTENING_PRIMARY_TAGS, *READING_PRIMARY_TAGS))


_LISTENING_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("L.NOTE_COMPLETION", (r"\bcomplete\s+(?:the\s+)?notes?\b", r"\bnotes?\s+completion\b")),
    ("L.TABLE_COMPLETION", (r"\bcomplete\s+(?:the\s+)?table\b", r"\btable\s+completion\b")),
    ("L.SENTENCE_COMPLETION", (r"\bcomplete\s+(?:the\s+)?sentences?\b", r"\bsentence\s+completion\b")),
    ("L.SUMMARY_COMPLETION", (r"\bcomplete\s+(?:the\s+)?summary\b", r"\bsummary\s+completion\b")),
    ("L.MAP_COMPLETION", (r"\bcomplete\s+(?:the\s+)?map\b",)),
    ("L.MAP_ORIENTATION", (r"\blabel\s+(?:the\s+)?(?:map|plan)\b", r"\b(?:map|plan)\b.*\bcorrect\s+letter\b")),
    ("L.FLOW_CHART_COMPLETION", (r"\bcomplete\s+(?:the\s+)?flow[ -]?chart\b", r"\bflow[ -]?chart\s+completion\b")),
    ("L.MULTIPLE_CHOICE", (r"\bchoose\s+(?:two|three|four|five|2|3|4|5)\b", r"\bwhich\s+(?:two|three|four|five|2|3|4|5)\b")),
    ("L.SINGLE_CHOICE", (r"\bchoose\s+the\s+correct\s+letter\b", r"\bchoose\s+one\b")),
    ("L.INFORMATION_MATCHING", (r"\bmatch\b", r"\bwhich\s+(?:person|speaker|place|course)\b.*\b(?:says?|mentions?|offers?)\b")),
)

_READING_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("R.TRUE_FALSE_NOT_GIVEN", (r"\btrue\s*[,/]\s*false\s*(?:or|[,/])\s*not\s+given\b",)),
    ("R.YES_NO_NOT_GIVEN", (r"\byes\s*[,/]\s*no\s*(?:or|[,/])\s*not\s+given\b",)),
    ("R.WORD_BANK_COMPLETION", (r"\bchoose\s+(?:words?|answers?)\s+from\s+(?:the\s+)?(?:box|list)\b", r"\blist\s+of\s+(?:words|answers)\b")),
    ("R.SUMMARY_COMPLETION", (r"\bcomplete\s+(?:the\s+)?summary\b",)),
    ("R.SENTENCE_COMPLETION", (r"\bcomplete\s+(?:the\s+)?sentences?\b",)),
    ("R.DIAGRAM_COMPLETION", (r"\bcomplete\s+(?:and\s+label\s+)?(?:the\s+)?diagram\b", r"\blabel\s+(?:the\s+)?diagram\b")),
    ("R.TABLE_COMPLETION", (r"\bcomplete\s+(?:the\s+)?table\b",)),
    ("R.SHORT_ANSWER", (r"\banswer\s+(?:the\s+)?questions?\b.*\bno\s+more\s+than\b", r"\bshort[- ]answer\s+questions?\b")),
    ("R.MATCHING_HEADINGS", (r"\bchoose\s+(?:the\s+)?correct\s+heading\b", r"\bmatch\s+(?:each\s+)?heading\b")),
    ("R.PARAGRAPH_INFORMATION_MATCHING", (r"\bwhich\s+(?:paragraph|section)\b.*\bcontains?\b", r"\bparagraph\b.*\bcontains?\s+(?:the\s+)?following\s+information\b")),
    ("R.SENTENCE_ENDING_MATCHING", (r"\bcomplete\s+(?:each|the)\s+sentence\b.*\bcorrect\s+ending\b", r"\bmatch\b.*\bsentence\s+endings?\b")),
    ("R.PERSON_VIEW_MATCHING", (r"\bmatch\b.*\b(?:people|persons?|researchers?|scientists?|writers?|experts?)\b", r"\bwhich\s+(?:person|researcher|scientist|writer|expert)\b.*\b(?:says?|claims?|believes?|suggests?|mentions?)\b")),
    ("R.DETAIL_INFORMATION_MATCHING", (r"\bmatch\b", r"\bwhich\s+(?:option|feature|statement)\b.*\bcorresponds?\b")),
    ("R.MULTIPLE_CHOICE", (r"\bchoose\s+(?:two|three|four|five|2|3|4|5)\b", r"\bwhich\s+(?:two|three|four|five|2|3|4|5)\b")),
    ("R.SINGLE_CHOICE", (r"\bchoose\s+the\s+correct\s+letter\b", r"\bchoose\s+one\b")),
)


def _require_lr_skill(skill: object) -> str:
    normalized = str(skill or "").strip().lower()
    if normalized not in {"listening", "reading"}:
        raise ValueError("only Academic Listening/Reading items may be classified")
    return normalized


def candidate_primary_tags(skill: str, instruction_text: str) -> list[str]:
    """Return allowed rule-matched candidates, or every tag for that skill.

    Returning all skill tags for an unrecognised instruction is deliberate: it
    flags that the AI must inspect the complete question instead of converting
    a weak heuristic into a final classification.
    """
    normalized_skill = _require_lr_skill(skill)
    text = re.sub(r"\s+", " ", instruction_text or "").strip().lower()
    rules = _LISTENING_RULES if normalized_skill == "listening" else _READING_RULES
    matches = [tag for tag, patterns in rules if any(re.search(pattern, text, re.I) for pattern in patterns)]
    if matches:
        return matches
    return list(LISTENING_PRIMARY_TAGS if normalized_skill == "listening" else READING_PRIMARY_TAGS)


def _is_absolute_path(value: str) -> bool:
    return bool(
        value.startswith(("/", "\\\\", "file://"))
        or re.match(r"^[A-Za-z]:[\\/]", value)
        or "/Users/" in value
    )


def validate_relative_paths(value: object, *, location: str = "record") -> None:
    """Reject absolute filesystem paths anywhere in portable records."""
    if isinstance(value, Mapping):
        for key, child in value.items():
            validate_relative_paths(child, location=f"{location}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            validate_relative_paths(child, location=f"{location}[{index}]")
    elif isinstance(value, str):
        if _is_absolute_path(value):
            raise ValueError(f"absolute path is not portable at {location}")
        path_location = any(marker in location.lower() for marker in ("path", "file", "asset", "image"))
        if path_location and ".." in PurePosixPath(value.replace("\\", "/")).parts:
            raise ValueError(f"path traversal is not portable at {location}")


def _instruction_text(item: Mapping[str, object]) -> str:
    explicit = item.get("instruction_text")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    question = str(item.get("question_text") or "").strip()
    if not question:
        return ""
    # The first short paragraph normally contains the shared instruction.  The
    # complete question remains separately available to the AI.
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", question) if part.strip()]
    return paragraphs[0] if paragraphs else question


def _number_from_item(item: Mapping[str, object], direct: str, fallback: str, marker: str) -> int | None:
    for key in (direct, fallback):
        value = item.get(key)
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                pass
    identifier = str(item.get("id") or "")
    match = re.search(marker, identifier)
    return int(match.group(1)) if match else None


def _structural_tags(item: Mapping[str, object], skill: str) -> list[str]:
    volume = _number_from_item(item, "volume", "book", r"-C(\d{2})-")
    if volume is None:
        book = str(item.get("book") or "")
        match = re.search(r"cambridge_ielts_(\d{2})", book)
        volume = int(match.group(1)) if match else None
    test = _number_from_item(item, "test_number", "test", r"-T(\d{2})-")
    if volume is None or test is None:
        raise ValueError(f"item {item.get('id')} is missing volume/test metadata")
    tags = [f"skill:{skill}", f"book:cambridge_ielts_{volume:02d}", f"test:{test:02d}"]
    if skill == "listening":
        section = _number_from_item(item, "section_number", "section", r"-S(\d{2})-")
        if section is None:
            raise ValueError(f"listening item {item.get('id')} is missing section metadata")
        tags.append(f"section:{section:02d}")
    else:
        passage = _number_from_item(item, "passage_number", "passage", r"-P(\d{2})-")
        if passage is None:
            # Older drafts used section_number for both skills.
            passage = _number_from_item(item, "section_number", "section", r"-P(\d{2})-")
        if passage is None:
            raise ValueError(f"reading item {item.get('id')} is missing passage metadata")
        tags.append(f"passage:{passage:02d}")
    return tags


def _copy_source_text(source_text: Mapping[str, object] | str | None) -> dict[str, object] | None:
    if source_text is None:
        return None
    if isinstance(source_text, str):
        return {"text": source_text}
    keep = ("id", "text", "summary", "asset_paths", "source_pages", "review_required", "diagnostics")
    return {key: copy.deepcopy(source_text[key]) for key in keep if key in source_text}


def _answer_evidence(item_id: str, answers: Iterable[Mapping[str, object]]) -> list[dict[str, object]]:
    keep = ("question_number", "answer_text", "accepted_variants", "note")
    result = [
        {key: copy.deepcopy(answer[key]) for key in keep if key in answer}
        for answer in answers
        if answer.get("item_id") == item_id
    ]
    return sorted(result, key=lambda answer: int(answer.get("question_number", 0)))


def build_classification_context(
    item: Mapping[str, object],
    source_text: Mapping[str, object] | str | None,
    answers: Iterable[Mapping[str, object]],
) -> dict[str, object]:
    """Build one complete, portable evidence record for an AI classifier."""
    skill = _require_lr_skill(item.get("skill"))
    item_id = str(item.get("id") or "").strip()
    if not item_id:
        raise ValueError("classification context item is missing id")
    instruction = _instruction_text(item)
    context: dict[str, object] = {
        "schema_version": "1.0",
        "item_id": item_id,
        "skill": skill,
        "question_start": item.get("question_start"),
        "question_end": item.get("question_end"),
        "instruction_text": instruction,
        "question_text": str(item.get("question_text") or ""),
        "diagram_description": str(item.get("diagram_description") or ""),
        "image_path": item.get("image_path") or item.get("relative_path"),
        "source_text_id": item.get("source_text_id"),
        "source_pages": copy.deepcopy(item.get("source_pages") or []),
        "source_text": _copy_source_text(source_text),
        "answers": _answer_evidence(item_id, answers),
        "primary_tag_candidates": candidate_primary_tags(skill, instruction),
        "required_context_tags": _structural_tags(item, skill),
        "allowed_semantic_dimension": "scene" if skill == "listening" else "topic",
        "classification_output_contract": {
            "item_id": "must equal this item_id",
            "primary_tag": "choose exactly one allowed tag for this skill",
            "tags": "include exactly one scene:* or topic:* semantic tag",
            "confidence": "number from 0.0 to 1.0",
            "review_required": "boolean",
            "reason": "non-empty AI classification rationale",
        },
    }
    validate_relative_paths(context)
    return context


def _source_index(source_texts: Mapping[str, Mapping[str, object]] | Iterable[Mapping[str, object]]) -> dict[str, Mapping[str, object]]:
    if isinstance(source_texts, Mapping):
        return {str(key): value for key, value in source_texts.items()}
    return {
        str(source["id"]): source
        for source in source_texts
        if isinstance(source.get("id"), str)
    }


def write_classification_context_jsonl(
    path: str | Path,
    items: Iterable[Mapping[str, object]],
    source_texts: Mapping[str, Mapping[str, object]] | Iterable[Mapping[str, object]],
    answers: Iterable[Mapping[str, object]],
) -> list[dict[str, object]]:
    """Write deterministic, one-item-per-line AI classification evidence."""
    ordered_items = sorted(items, key=lambda item: str(item.get("id") or ""))
    sources = _source_index(source_texts)
    answer_rows = list(answers)
    contexts: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in ordered_items:
        item_id = str(item.get("id") or "")
        if item_id in seen:
            raise ValueError(f"duplicate item id in classification context: {item_id}")
        seen.add(item_id)
        source_id = str(item.get("source_text_id") or "")
        contexts.append(build_classification_context(item, sources.get(source_id), answer_rows))
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        "".join(json.dumps(context, ensure_ascii=False, sort_keys=True) + "\n" for context in contexts),
        encoding="utf-8",
    )
    return contexts


def _classification_index(classifications: Iterable[Mapping[str, object]]) -> dict[str, Mapping[str, object]]:
    result: dict[str, Mapping[str, object]] = {}
    for classification in classifications:
        item_id = str(classification.get("item_id") or "")
        if item_id in result:
            raise ValueError(f"duplicate classification for item_id: {item_id}")
        result[item_id] = classification
    return result


def _deduplicate(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _validate_semantic_tags(skill: str, tags: Sequence[str]) -> None:
    scenes = [tag for tag in tags if tag.startswith("scene:")]
    topics = [tag for tag in tags if tag.startswith("topic:")]
    if skill == "listening":
        if len(scenes) != 1:
            raise ValueError("listening classification must contain exactly one scene tag")
        if topics:
            raise ValueError("listening classification cannot contain topic tags; use a scene tag")
    else:
        if len(topics) != 1:
            raise ValueError("reading classification must contain exactly one topic tag")
        if scenes:
            raise ValueError("reading classification cannot contain scene tags; use a topic tag")


def _normalize_classification(
    item: Mapping[str, object],
    classification: Mapping[str, object],
    confidence_threshold: float,
) -> dict[str, object]:
    skill = _require_lr_skill(item.get("skill"))
    primary = classification.get("primary_tag")
    allowed = LISTENING_PRIMARY_TAGS if skill == "listening" else READING_PRIMARY_TAGS
    if not isinstance(primary, str) or primary not in allowed:
        raise ValueError(f"primary tag skill mismatch or unknown tag for {item.get('id')}: {primary}")
    supplied = classification.get("tags")
    if not isinstance(supplied, list) or not all(isinstance(tag, str) for tag in supplied):
        raise ValueError(f"classification tags must be a list of strings for {item.get('id')}")
    extra_primaries = [tag for tag in supplied if tag in ALL_PRIMARY_TAGS and tag != primary]
    if extra_primaries:
        raise ValueError(f"classification contains multiple primary tags for {item.get('id')}")
    _validate_semantic_tags(skill, supplied)
    reason = classification.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError(f"classification reason is required for {item.get('id')}")
    confidence = classification.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
        raise ValueError(f"classification confidence must be between 0 and 1 for {item.get('id')}")
    review = classification.get("review_required")
    if not isinstance(review, bool):
        raise ValueError(f"classification review_required must be boolean for {item.get('id')}")

    structural = _structural_tags(item, skill)
    tags = _deduplicate([primary, *structural, *supplied])
    result = copy.deepcopy(dict(item))
    result.update(
        {
            "primary_tag": primary,
            "tags": tags,
            "confidence": float(confidence),
            "reason": reason.strip(),
            "classification_reason": reason.strip(),
            "review_required": bool(
                review
                or float(confidence) < confidence_threshold
                or "scene:other" in tags
                or "topic:other" in tags
                or item.get("review_required")
            ),
        }
    )
    validation_record = dict(result)
    volume = _number_from_item(item, "volume", "book", r"-C(\d{2})-")
    test = _number_from_item(item, "test_number", "test", r"-T(\d{2})-")
    validation_record["book"] = f"cambridge_ielts_{volume:02d}" if volume is not None else None
    validation_record["test"] = f"{test:02d}" if test is not None else None
    if skill == "listening":
        validation_record["section"] = _number_from_item(item, "section_number", "section", r"-S(\d{2})-")
    else:
        validation_record["passage"] = _number_from_item(item, "passage_number", "passage", r"-P(\d{2})-")
    errors = _TAXONOMY.validate_item(validation_record)
    if errors:
        raise ValueError(f"invalid classification for {item.get('id')}: {'; '.join(errors)}")
    validate_relative_paths(result)
    return result


def apply_classifications(
    items: Iterable[Mapping[str, object]],
    classifications: Iterable[Mapping[str, object]],
    *,
    confidence_threshold: float = 0.8,
) -> list[dict[str, object]]:
    """Apply exactly one externally supplied AI decision to every L/R item."""
    if not 0 <= confidence_threshold <= 1:
        raise ValueError("confidence_threshold must be between 0 and 1")
    item_rows = list(items)
    item_ids = [str(item.get("id") or "") for item in item_rows]
    if len(item_ids) != len(set(item_ids)):
        raise ValueError("duplicate item id in classification input")
    decisions = _classification_index(classifications)
    unknown = sorted(set(decisions) - set(item_ids))
    if unknown:
        raise ValueError(f"classification references unknown item_id: {unknown[0]}")
    missing = sorted(set(item_ids) - set(decisions))
    if missing:
        raise ValueError(f"missing classification for item_id: {missing[0]}")
    return [
        _normalize_classification(item, decisions[item_id], confidence_threshold)
        for item, item_id in zip(item_rows, item_ids)
    ]


def _read_records(path: Path) -> list[dict[str, object]]:
    if path.suffix.lower() == ".jsonl":
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "source_texts", "answers", "classifications"):
            if isinstance(payload.get(key), list):
                return payload[key]
    raise ValueError(f"expected a JSON list or JSONL records in {path.name}")


def _write_json(path: Path, records: Sequence[Mapping[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(list(records), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _cli() -> int:
    parser = argparse.ArgumentParser(description="生成并应用雅思听力/阅读 AI 分类数据")
    subparsers = parser.add_subparsers(dest="command", required=True)
    context = subparsers.add_parser("context", help="生成 AI 分类上下文 JSONL")
    context.add_argument("--items", type=Path, required=True, help="题组 JSON/JSONL")
    context.add_argument("--source-texts", type=Path, required=True, help="原文 JSON/JSONL")
    context.add_argument("--answers", type=Path, required=True, help="答案 JSON/JSONL")
    context.add_argument("--output", type=Path, required=True, help="上下文 JSONL 输出路径")
    apply_parser = subparsers.add_parser("apply", help="应用 AI 分类 JSONL")
    apply_parser.add_argument("--items", type=Path, required=True, help="题组 JSON/JSONL")
    apply_parser.add_argument("--classifications", type=Path, required=True, help="AI 分类 JSON/JSONL")
    apply_parser.add_argument("--output", type=Path, required=True, help="已分类题组 JSON")
    apply_parser.add_argument("--confidence-threshold", type=float, default=0.8, help="低于该置信度时强制复核")
    args = parser.parse_args()
    if args.command == "context":
        contexts = write_classification_context_jsonl(
            args.output,
            _read_records(args.items),
            _read_records(args.source_texts),
            _read_records(args.answers),
        )
        print(json.dumps({"contexts": len(contexts), "output": args.output.as_posix()}, ensure_ascii=False))
    else:
        records = apply_classifications(
            _read_records(args.items),
            _read_records(args.classifications),
            confidence_threshold=args.confidence_threshold,
        )
        _write_json(args.output, records)
        print(json.dumps({"items": len(records), "output": args.output.as_posix()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
