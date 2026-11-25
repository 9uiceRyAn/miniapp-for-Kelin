#!/usr/bin/env python3
"""解析雅思 Academic Listening/Reading 答案页。

该模块只使用 PDF 文本层或 OCR 已保存的页面文本。遇到 ``IN ANY ORDER`` 等
原书没有逐题映射的情况，保留原始分组说明并附带 diagnostics；绝不从题干、
听力原文或常识推断答案。旧版 Writing 解析函数仅为兼容旧工作区保留，CLI
和正式导出均不会调用或输出 Writing/Speaking 记录。
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping


_ORDER_RE = re.compile(r"(?i)\b(IN\s*(?:ANY|EITHER)\s*O\s*RDER)\b")
_QUESTION_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])(?P<start>\d{1,2})\s*(?:(?P<sep>[-–—&])\s*(?P<end>\d{1,2}))?\s*[.):]?(?=\s|$)"
)
_TEST_RE = re.compile(r"(?i)\bTEST\s*([0-9]{1,2})\b")
_LISTENING_RE = re.compile(r"(?i)\bLISTENING\b")
_READING_RE = re.compile(r"(?i)\bREADING\b")
_UNIT_RE = re.compile(r"(?i)\b(?:section|part)\s*([1-4])\s*,?\s*questions?\s*([0-9]{1,2})\s*(?:[-–—]|to)\s*([0-9]{1,2})")
_PASSAGE_RE = re.compile(r"(?i)\breading\s+passage\s*([1-3])\s*,?\s*questions?\s*([0-9]{1,2})\s*(?:[-–—]|to)\s*([0-9]{1,2})")
_WRITING_HEADING_RE = re.compile(r"(?im)^\s*TEST\s*([0-9]{1,2})\s*[,.:\-]?\s*WRITING\s+TASK\s*([12])\b")
_BAND_RE = re.compile(r"(?i)\bBAND\s*([0-9]+(?:[.,][0-9]+)?)")


def _clean(value: object) -> str:
    text = str(value or "").replace("\x00", "")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\s*\f\s*", "\n", text)
    return text.strip(" \n\t·•﹒")


def _volume(structure: Mapping[str, Any]) -> int:
    for key in ("volume", "book"):
        value = structure.get(key)
        if value is not None:
            match = re.search(r"(?:cambridge[_ -]ielts[_ -])?(\d{1,2})", str(value), re.I)
            if match:
                number = int(match.group(1))
                if 8 <= number <= 21:
                    return number
    match = re.search(r"(?:IELTS|剑桥)[^0-9]*(\d{1,2})", str(structure.get("source_file") or ""), re.I)
    if match:
        return int(match.group(1))
    return 0


def _page_number(page: Mapping[str, Any]) -> int | None:
    try:
        number = int(page.get("page"))
        return number if number > 0 else None
    except (TypeError, ValueError):
        return None


def _source_file(page: Mapping[str, Any], structure: Mapping[str, Any]) -> str | None:
    value = page.get("source_file") or structure.get("source_file")
    return Path(str(value)).name if value else None


def _split_variants(value: str) -> tuple[str, list[str]]:
    """Return canonical answer and slash-separated accepted variants.

    Slashes in an answer key are the publisher's explicit alternatives. We do
    not split ``and/or`` or punctuation, so the original answer remains
    recoverable in ``raw_answer_text``.
    """
    value = _clean(value)
    if not value:
        return "", []
    if re.fullmatch(r"[«»=_~]*[|Il1][«»=_~|]*", value):
        value = "I"
    value = re.sub(r"^[~=_|_]*—s(?=[a-z])", "", value)
    # Answer-key tables frequently leave rules/bullets attached to OCR tokens.
    # Treat them as decoration only at the outer edge; currency inside a real
    # answer such as ``(£)115`` is preserved.
    value = re.sub(r"^[\s~=_|—_‘“”!;?<>©]+", "", value)
    value = re.sub(r"[\s~=_|—_‘“”!;?<>©]+$", "", value)
    corrections = {
        "Cc": "C", "cE": "E", "OD": "D", "O*F": "F", "OC": "C",
        "Oi": "i", "Ovi": "vi", "Ov": "v", "Civ": "iv", "sii": "ii",
        "svi": "vi", "WV": "iv", "itil": "iii", "Vv": "v",
        "NOTGIVEN": "NOT GIVEN",
    }
    value = corrections.get(value, value)
    truth_with_spill = re.fullmatch(r"(TRUE|FALSE|NOT\s+GIVEN|YES|NO)\s+[A-Za-z]", value, re.I)
    if truth_with_spill:
        value = re.sub(r"\s+", " ", truth_with_spill.group(1).upper())
    if value != "I":
        choice = re.fullmatch(r"[^A-Za-z0-9]*[468]?[^A-Za-z0-9]*([A-Ha-h])[^A-Za-z0-9]*", value)
        if choice:
            value = choice.group(1).upper()
        elif re.fullmatch(r"([A-Ha-h])\1", value, re.I):
            value = value[0].upper()
    parts = [part.strip(" .") for part in re.split(r"\s*/\s*", value) if part.strip(" .")]
    if not parts:
        return value, []
    return parts[0], [part for part in parts[1:] if part != parts[0]]


def _order_match(value: str) -> tuple[str, str] | None:
    """Recognise normal and OCR-split ``IN EITHER/ANY ORDER`` phrases."""
    match = _ORDER_RE.search(value)
    if match:
        compact_match = re.sub(r"[^a-z]", "", match.group(1).lower())
        phrase = "IN ANY ORDER" if "any" in compact_match else "IN EITHER ORDER"
        return phrase, _clean(value[match.end() :])
    compact = re.sub(r"[^a-z]", "", value.lower())
    if compact.startswith("ineitherorder"):
        # The exact spacing is an OCR artefact; retain the remainder as raw
        # source text and use a stable note for downstream diagnostics.
        remainder = re.sub(r"(?i)^\s*in\s*either\s*o?\s*rder", "", value)
        return "IN EITHER ORDER", _clean(remainder)
    if compact.startswith("inanyorder"):
        remainder = re.sub(r"(?i)^\s*in\s*any\s*o?\s*rder", "", value)
        return "IN ANY ORDER", _clean(remainder)
    return None


def _is_answer_page(text: str) -> bool:
    lowered = text.lower()
    compact = re.sub(r"\s+", "", lowered)
    if "answerkey" not in compact and "answerkeys" not in compact:
        return False
    return bool((_LISTENING_RE.search(text) or _READING_RE.search(text)) and _is_key_content_page(text))


def answer_key_page_numbers(page_texts: Iterable[Mapping[str, Any]], structure: Mapping[str, Any]) -> list[int]:
    """Return the contiguous post-test answer-key block for OCR.

    Contents pages are excluded by requiring the block to occur after the last
    discovered Academic test. Continuation pages are retained even when their
    running header omits ``Answer Keys``.
    """
    pages = sorted((dict(page) for page in page_texts), key=lambda value: int(value.get("page", 0)))
    last_test_page = max((int(test.get("page_end", 0)) for test in structure.get("tests", [])), default=0)
    selected: list[int] = []
    started = False
    for page in pages:
        number = int(page.get("page", 0))
        if number <= last_test_page:
            continue
        text = str(page.get("text") or "")
        compact = re.sub(r"\s+", "", text.lower())
        if not started:
            if ("answerkey" in compact or "answerkeys" in compact) and (_LISTENING_RE.search(text) or _READING_RE.search(text)):
                started = True
            else:
                continue
        if re.search(r"(?is)\b(?:sample.{0,35}writing|writing.{0,35}sample|model\s+and\s+sample|audioscripts?|tapescripts?)\b", text):
            break
        if re.search(r"(?i)\bGENERAL\s+TRAINING\b", text):
            break
        if number > 0:
            selected.append(number)
        # Four Academic tests, each with one Listening and one Reading key page.
        if len(selected) == 8:
            break
    return selected


def ocr_answer_key_pages(
    pdf: str | Path,
    page_texts: Iterable[Mapping[str, Any]],
    structure: Mapping[str, Any],
    output_dir: str | Path,
    *,
    dpi: int = 300,
) -> list[dict[str, Any]]:
    """Replace answer-key page text with layout-aware Tesseract OCR text."""
    pdf_path = Path(pdf)
    output = Path(output_dir)
    pdftoppm = shutil.which("pdftoppm")
    tesseract = shutil.which("tesseract")
    if not pdftoppm or not tesseract:
        raise RuntimeError("answer-key OCR requires pdftoppm and tesseract")
    selected = set(answer_key_page_numbers(page_texts, structure))
    result_pages: list[dict[str, Any]] = []
    for original in page_texts:
        page = dict(original)
        number = int(page.get("page", 0))
        if number not in selected:
            result_pages.append(page)
            continue
        image = output / f"page-{number:04d}.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        prefix = image.with_suffix("")
        render = None
        if not image.exists():
            render = subprocess.run(
                [pdftoppm, "-f", str(number), "-l", str(number), "-png", "-r", str(dpi), "-singlefile", str(pdf_path), str(prefix)],
                capture_output=True,
                text=True,
                check=False,
            )
        if (render is not None and render.returncode) or not image.exists():
            page["answer_ocr_status"] = "failed"
            page["answer_ocr_diagnostics"] = [((render.stderr if render else "") or "pdftoppm failed").replace(str(pdf_path), pdf_path.name)]
            result_pages.append(page)
            continue
        ocr = subprocess.run(
            [tesseract, str(image), "stdout", "--psm", "4", "-l", "eng"],
            capture_output=True,
            text=True,
            check=False,
        )
        if not ocr.returncode and ocr.stdout.strip():
            column_texts: list[str] = []
            try:
                from PIL import Image

                with Image.open(image) as source_image:
                    width, height = source_image.size
                    crops = {
                        "left46": (0, 0, int(width * 0.46), height),
                        # Keep a small centre overlap so two-digit question
                        # numbers printed against the gutter are not clipped.
                        "right40": (int(width * 0.40), 0, width, height),
                    }
                    for suffix, box in crops.items():
                        crop_path = image.with_name(f"{image.stem}-{suffix}.png")
                        if not crop_path.exists():
                            source_image.crop(box).save(crop_path)
                        column = subprocess.run(
                            [tesseract, str(crop_path), "stdout", "--psm", "6", "-l", "eng"],
                            capture_output=True,
                            text=True,
                            check=False,
                        )
                        if not column.returncode and column.stdout.strip():
                            column_texts.append(column.stdout)
            except (ImportError, OSError) as exc:
                page.setdefault("answer_ocr_diagnostics", []).append(f"column OCR unavailable: {exc}")
            # Column OCR is more reliable for the two-column key table. Keep
            # full-page OCR last so it supplies headings/fallback rows without
            # overriding clean column values during deterministic deduplication.
            texts = [*column_texts, ocr.stdout]
            page["text"] = "\n\n".join(texts)
            page["text_chars"] = len(re.sub(r"\s+", "", page["text"]))
            page["answer_ocr_status"] = "success"
        else:
            page["answer_ocr_status"] = "failed"
            page["answer_ocr_diagnostics"] = [(ocr.stderr or "tesseract failed").replace(str(image), image.name)]
        result_pages.append(page)
    return result_pages


def _is_key_content_page(text: str) -> bool:
    """Recognise continuation key pages whose running title is omitted."""
    flat = " ".join(text.split())
    if re.search(r"(?i)\b(?:section|part)\s*[1-4].*questions?", flat) and _LISTENING_RE.search(text):
        return True
    return bool(re.search(r"(?i)reading\s+passage\s*[1-3].*questions?", flat) and _READING_RE.search(text))


def _page_skill(text: str) -> str | None:
    # A page contains one answer table. Prefer the explicit heading over the
    # book's running ``Listening and Reading Answer Keys`` title.
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines[:14]:
        if re.fullmatch(r"(?i)(?:academic\s+)?listening", line) or re.fullmatch(r"(?i)listening", line):
            return "listening"
        if re.fullmatch(r"(?i)(?:academic\s+)?reading", line) or re.fullmatch(r"(?i)reading", line):
            return "reading"
    if re.search(r"(?i)\b(?:section|part)\s*[1-4].*questions?", text) and not re.search(r"(?i)reading\s+passage", text):
        return "listening"
    if re.search(r"(?i)reading\s+passage\s*[1-3].*questions?", text):
        return "reading"
    return None


def _explicit_test(text: str) -> int | None:
    # Only inspect the heading area; a question's passage may mention Test 1.
    prefix = "\n".join(text.splitlines()[:18])
    match = _TEST_RE.search(prefix)
    return int(match.group(1)) if match else None


def _unit_ranges(text: str, skill: str) -> list[tuple[int, int, int]]:
    pattern = _UNIT_RE if skill == "listening" else _PASSAGE_RE
    return [(int(match.group(1)), int(match.group(2)), int(match.group(3))) for match in pattern.finditer(text)]


def _looks_like_header(line: str) -> bool:
    lowered = line.lower()
    if re.match(r"^\s*\d{1,2}\s*[.):]?\s+\S", line):
        return False
    return bool(
        "questions" in lowered
        or re.search(r"^\s*(?:section|part|reading\s+passage)\b", lowered)
        or "if you score" in lowered
        or re.fullmatch(r"\s*\d+\s*[-–—]\s*\d+\s+\d+\s*[-–—]\s*\d+.*", line)
    )


def _extract_numbered_lines(lines: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract answer rows and unresolved order groups from one key page."""
    direct: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    for line_index, original in enumerate(lines):
        line = original.strip()
        if not line or _looks_like_header(line):
            continue
        matches = [match for match in _QUESTION_TOKEN_RE.finditer(line) if 1 <= int(match.group("start")) <= 40]
        if not matches:
            continue
        for index, match in enumerate(matches):
            start = int(match.group("start"))
            end = int(match.group("end") or start)
            if end < start or end > 40:
                continue
            value_end = matches[index + 1].start() if index + 1 < len(matches) else len(line)
            value = _clean(line[match.end() : value_end])
            # A row with an order phrase describes a set, not one answer.
            order = _order_match(value)
            if order:
                phrase, suffix = order
                groups.append({"start": start, "end": end, "note": phrase, "values": ([suffix] if suffix else []), "line_index": line_index})
                continue
            if not value or value.lower() in {"academic", "listening", "reading"}:
                continue
            direct.append({"start": start, "end": end, "value": value, "line_index": line_index})
    # Captured values on lines without question tokens often follow a group
    # marker (e.g. ``16-18 IN ANY ORDER`` then C/F/G). Preserve them.
    for group in groups:
        next_group_line = min(
            (int(other["line_index"]) for other in groups if int(other["line_index"]) > int(group["line_index"])),
            default=len(lines),
        )
        for line_index in range(int(group["line_index"]) + 1, next_group_line):
            line = lines[line_index].strip()
            if not line:
                continue
            if _looks_like_header(line):
                if line_index > int(group["line_index"]) + 1:
                    break
                continue
            matches = [m for m in _QUESTION_TOKEN_RE.finditer(line) if 1 <= int(m.group("start")) <= 40]
            if matches:
                # Values for a group can be printed in a neighbouring column;
                # direct rows in the same range are collected below.
                continue
            value = _clean(line)
            if value and not re.search(r"(?i)^(?:if you score|listening|reading|academic)$", value):
                group["values"].append(value)
                if len(group["values"]) >= group["end"] - group["start"] + 1:
                    break
    # In two-column text extraction, the answer for a group on the right can
    # appear as a trailing token on a normal left-column row (``2 weather B``).
    # Move only a final single token while the group is still awaiting values;
    # this keeps the left answer ``weather`` intact and records B as source
    # material for the order group.
    for group in groups:
        next_group_line = min(
            (int(other["line_index"]) for other in groups if int(other["line_index"]) > int(group["line_index"])),
            default=len(lines),
        )
        capacity = int(group["end"]) - int(group["start"]) + 1
        for row in direct:
            if not int(group["line_index"]) < int(row["line_index"]) < next_group_line:
                continue
            if int(group["start"]) <= int(row["start"]) <= int(group["end"]):
                continue
            if len(group["values"]) >= capacity:
                break
            match = re.match(r"^(.*?)(?:\s+)([A-Za-z])$", str(row["value"]).strip())
            if match and len(match.group(1).strip()) >= 1:
                row["value"] = match.group(1).strip()
                group["values"].append(match.group(2))
    return direct, groups


def _item_id(volume: int, test: int, skill: str, unit: int, start: int, end: int) -> str:
    code = "L" if skill == "listening" else "R"
    unit_code = "S" if skill == "listening" else "P"
    return f"IELTS-C{volume:02d}-T{test:02d}-{code}-{unit_code}{unit:02d}-Q{start:02d}-{end:02d}"


def _candidate_item_id(
    generated: str,
    *,
    items: Iterable[Mapping[str, Any]] | None,
    volume: int,
    test: int,
    skill: str,
    question: int,
) -> str:
    if items:
        for item in items:
            if str(item.get("skill", "")).lower() != skill:
                continue
            if int(item.get("volume", volume)) != volume or int(item.get("test_number", test)) != test:
                continue
            start = item.get("question_start", item.get("question_number_start"))
            end = item.get("question_end", item.get("question_number_end", start))
            try:
                if start is not None and end is not None and int(start) <= question <= int(end):
                    return str(item.get("id", generated))
            except (TypeError, ValueError):
                pass
    return generated


def parse_listening_reading_keys(
    page_texts: Iterable[Mapping[str, Any]],
    structure: Mapping[str, Any],
    *,
    items: Iterable[Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Parse every numbered Listening/Reading key row into answer records."""
    volume = _volume(structure)
    all_pages = sorted((dict(page) for page in page_texts), key=lambda value: int(value.get("page", 0)))
    # Start at the first answer-key title and include adjacent continuation
    # pages until Audioscripts/Sample Writing begins. Older books print the
    # title only on the first page of each Listening/Reading pair.
    pages: list[dict[str, Any]] = []
    in_key_block = False
    for page in all_pages:
        text = str(page.get("text") or "")
        title = _is_answer_page(text)
        if title:
            in_key_block = True
        if in_key_block and re.search(r"(?i)\b(?:audioscripts?|sample\s+writing\s+answers?)\b", text) and not title:
            in_key_block = False
        if in_key_block and (title or _is_key_content_page(text)):
            pages.append(page)
    answers: list[dict[str, Any]] = []
    inferred_test = 5 if volume == 12 else 1
    previous_skill: str | None = None
    for page in pages:
        text = str(page.get("text") or "")
        # C8–C10 contain General Training answer keys after the four Academic
        # tests. They remain in the source PDF but are intentionally excluded
        # from this Academic Listening/Reading database.
        if re.search(r"(?i)general\s+training|TEST\s*[AB]\b", text):
            continue
        skill = _page_skill(text)
        if skill is None:
            continue
        test = _explicit_test(text)
        if volume == 12 and test is not None and 1 <= test <= 4:
            test += 4
        if test is None:
            if previous_skill == "reading":
                inferred_test += 1
            test = inferred_test
        else:
            inferred_test = test
        previous_skill = skill
        unit_ranges = _unit_ranges(text, skill)
        current_unit = unit_ranges[0][0] if unit_ranges else 1
        current_range = unit_ranges[0][1:] if unit_ranges else (1, 40)
        lines = text.splitlines()
        direct, groups = _extract_numbered_lines(lines)
        page_answers: list[dict[str, Any]] = []
        for row in direct:
            for unit, start, end in unit_ranges:
                if start <= row["start"] <= end:
                    current_unit, current_range = unit, (start, end)
                    break
            canonical, variants = _split_variants(row["value"])
            generated = _item_id(volume, test, skill, current_unit, int(current_range[0]), int(current_range[1]))
            record = {
                "id": f"{generated}-A{row['start']:02d}",
                "item_id": _candidate_item_id(generated, items=items, volume=volume, test=test, skill=skill, question=int(row["start"])),
                "volume": volume,
                "book": f"cambridge_ielts_{volume:02d}",
                "test_number": test,
                "test": f"{test:02d}",
                "skill": skill,
                "question_number": int(row["start"]),
                "answer_text": canonical,
                "accepted_variants": variants,
                "raw_answer_text": row["value"],
                "source_page": _page_number(page),
                "source_file": _source_file(page, structure),
                "diagnostics": [],
            }
            page_answers.append(record)
        # Materialise missing members of an order group. Existing direct rows
        # are used only as source values and retain their own raw rows.
        for group in groups:
            existing = {int(row["start"]): row for row in direct if int(group["start"]) <= int(row["start"]) <= int(group["end"])}
            values = [str(value) for value in group.get("values", []) if str(value).strip()]
            values.extend(row["value"] for row in direct if int(group["start"]) <= int(row["start"]) <= int(group["end"]) and row["value"] not in values)
            for number in range(int(group["start"]), int(group["end"]) + 1):
                if number in existing:
                    continue
                raw = values[number - int(group["start"])] if number - int(group["start"]) < len(values) else group["note"]
                canonical, variants = _split_variants(raw)
                generated = _item_id(volume, test, skill, current_unit, int(current_range[0]), int(current_range[1]))
                page_answers.append({
                    "id": f"{generated}-A{number:02d}",
                    "item_id": _candidate_item_id(generated, items=items, volume=volume, test=test, skill=skill, question=number),
                    "volume": volume,
                    "book": f"cambridge_ielts_{volume:02d}",
                    "test_number": test,
                    "test": f"{test:02d}",
                    "skill": skill,
                    "question_number": number,
                    "answer_text": canonical,
                    "accepted_variants": variants,
                    "raw_answer_text": group["note"],
                    "note": f"{group['note']}; source answer order is unspecified",
                    "source_page": _page_number(page),
                    "source_file": _source_file(page, structure),
                    "diagnostics": ([] if values else ["order-group has no visible answer values"]),
                })
        answers.extend(page_answers)
    answers.sort(key=lambda record: (int(record.get("volume", 0)), int(record.get("test_number", 0)), str(record.get("skill")), int(record.get("question_number", 0)), int(record.get("source_page") or 0)))
    # A two-column extraction can expose the same question twice. Keep one
    # source row for deterministic linking and retain a portable diagnostic;
    # the raw page remains authoritative for later visual review.
    unique: dict[tuple[int, int, str, int], dict[str, Any]] = {}
    for record in answers:
        key = (int(record.get("volume", 0)), int(record.get("test_number", 0)), str(record.get("skill")), int(record.get("question_number", 0)))
        if key not in unique:
            unique[key] = record
        else:
            diagnostics = unique[key].setdefault("diagnostics", [])
            diagnostics.append("duplicate numbered row in source answer page; first row retained")
    return list(unique.values())


def build_answer_diagnostics(answers: Iterable[Mapping[str, Any]], *, expected_question_count: int = 40) -> list[dict[str, Any]]:
    """Summarise missing/duplicate scope without inventing answer values."""
    rows = list(answers)
    grouped: defaultdict[tuple[int, int, str], list[int]] = defaultdict(list)
    for answer in rows:
        try:
            grouped[(int(answer.get("volume", 0)), int(answer.get("test_number", 0)), str(answer.get("skill")))].append(int(answer["question_number"]))
        except (TypeError, ValueError, KeyError):
            continue
    diagnostics: list[dict[str, Any]] = []
    for (volume, test, skill), numbers in sorted(grouped.items()):
        unique = set(numbers)
        missing = [number for number in range(1, expected_question_count + 1) if number not in unique]
        if missing:
            diagnostics.append({
                "volume": volume,
                "book": f"cambridge_ielts_{volume:02d}",
                "test_number": test,
                "skill": skill,
                "kind": "missing_answer_numbers",
                "question_numbers": missing,
                "message": "source answer key text/OCR did not expose these numbered rows; no values were fabricated",
                "review_required": True,
            })
    return diagnostics


def merge_answer_sources(
    items: Iterable[Mapping[str, Any]],
    primary_answers: Iterable[Mapping[str, Any]],
    fallback_answers: Iterable[Mapping[str, Any]],
    visual_overrides: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Merge OCR/text-layer rows and source-image verified answer overrides.

    Primary layout OCR wins over the original text layer. Visual overrides are
    applied last because they are transcribed directly from the supplied answer
    page image. Every output row is re-linked to the current item range.
    """
    item_index: dict[tuple[int, int, str, int], Mapping[str, Any]] = {}
    for item in items:
        skill = str(item.get("skill") or "").lower()
        if skill not in {"listening", "reading"}:
            continue
        start = int(item.get("question_start") or 0)
        end = int(item.get("question_end") or start)
        for number in range(start, end + 1):
            key = (int(item.get("volume") or 0), int(item.get("test_number") or 0), skill, number)
            if key in item_index:
                raise ValueError(f"overlapping item ranges for {key}")
            item_index[key] = item

    def normalized(row: Mapping[str, Any]) -> tuple[tuple[int, int, str, int], dict[str, Any]] | None:
        try:
            key = (
                int(row.get("volume") or 0), int(row.get("test_number") or 0),
                str(row.get("skill") or "").lower(), int(row.get("question_number") or 0),
            )
        except (TypeError, ValueError):
            return None
        item = item_index.get(key)
        if item is None:
            return None
        canonical, parsed_variants = _split_variants(str(row.get("answer_text") or ""))
        variants = list(dict.fromkeys([*parsed_variants, *[str(value) for value in row.get("accepted_variants", [])]]))
        source_page = row.get("source_page")
        record = dict(row)
        record.update({
            "id": f"{item['id']}-A{key[3]:02d}",
            "item_id": str(item["id"]),
            "volume": key[0],
            "book": f"cambridge_ielts_{key[0]:02d}",
            "test_number": key[1],
            "test": f"{key[1]:02d}",
            "skill": key[2],
            "question_number": key[3],
            "answer_text": canonical,
            "accepted_variants": variants,
        })
        if source_page is not None:
            page_number = int(source_page)
            record["assets"] = [{
                "path": f"images/answers/C{key[0]:02d}/page-{page_number:04d}.png",
                "page_number": page_number,
                "sequence": 1,
            }]
        return key, record

    merged: dict[tuple[int, int, str, int], dict[str, Any]] = {}
    for collection in (fallback_answers, primary_answers, visual_overrides):
        for row in collection:
            result = normalized(row)
            if result is not None:
                key, record = result
                merged[key] = record
    return [merged[key] for key in sorted(merged)]


def _writing_segments(page_texts: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for page in sorted((dict(page) for page in page_texts), key=lambda value: int(value.get("page", 0))):
        text = str(page.get("text") or "")
        matches = list(_WRITING_HEADING_RE.finditer(text))
        if not matches:
            if current is not None and text.strip():
                current["parts"].append((page, text))
            continue
        for index, match in enumerate(matches):
            if current is not None:
                segments.append(current)
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            current = {"test": int(match.group(1)), "task": int(match.group(2)), "parts": [(page, text[match.start():end])]}
    if current is not None:
        segments.append(current)
    return segments


def parse_writing_samples(page_texts: Iterable[Mapping[str, Any]], structure: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Parse model/sample writing text and visible examiner comments."""
    volume = _volume(structure)
    answers: list[dict[str, Any]] = []
    for segment in _writing_segments(page_texts):
        pages = segment["parts"]
        full_text = "\n\n".join(str(text) for _, text in pages)
        if re.search(r"(?i)GENERAL\s+TRAINING", full_text):
            continue
        heading = f"IELTS-C{volume:02d}-T{segment['test']:02d}-W-T{segment['task']:02d}"
        kind = "model" if re.search(r"(?i)\bMODEL\s+ANSWER\b", full_text) else "sample" if re.search(r"(?i)\bSAMPLE\s+ANSWER\b|candidate\s+who\s+achieved", full_text) else None
        if kind is None:
            continue
        comment_match = re.search(r"(?i)examiner(?:['’]s|s)?\s+comment(?:s)?\s*:", full_text)
        band_match = _BAND_RE.search(full_text)
        band = float(band_match.group(1).replace(",", ".")) if band_match else None
        source_pages = [_page_number(page) for page, _ in pages if _page_number(page) is not None]
        source_file = next((_source_file(page, structure) for page, _ in pages if _source_file(page, structure)), None)
        common = {
            "volume": volume,
            "book": f"cambridge_ielts_{volume:02d}",
            "test_number": int(segment["test"]),
            "test": f"{int(segment['test']):02d}",
            "task": int(segment["task"]),
            "skill": "writing",
            "source_pages": source_pages,
            "source_page": source_pages[0] if source_pages else None,
            "source_file": source_file,
            "band_score": band,
            "diagnostics": [],
        }
        answers.append({
            **common,
            "id": f"{heading}-ANSWER",
            "item_id": heading,
            "answer_kind": kind,
            "answer_text": _clean(full_text),
            "accepted_variants": [],
        })
        if comment_match:
            comment_text = _clean(full_text[comment_match.end() :])
            answers.append({
                **common,
                "id": f"{heading}-EXAMINER-COMMENT",
                "item_id": heading,
                "answer_kind": "examiner_comment",
                "answer_text": comment_text,
                "accepted_variants": [],
                "diagnostics": ["comment/essay boundary retained as source text"],
            })
    return answers


def _item_scope(item: Mapping[str, Any]) -> tuple[int, int, str]:
    volume = int(item.get("volume", item.get("book", 0)) or 0)
    test = int(item.get("test_number", item.get("test", 0)) or 0)
    return volume, test, str(item.get("skill", "")).lower()


def validate_answer_links(items: Iterable[Mapping[str, Any]], answers: Iterable[Mapping[str, Any]]) -> list[str]:
    """Validate direct links, scope and completeness; return portable diagnostics."""
    item_values = items.values() if isinstance(items, Mapping) else items
    item_map = {str(item.get("id")): item for item in item_values if item.get("id")}
    answer_rows = list(answers)
    diagnostics: list[str] = []
    seen: set[tuple[str, int | None, str | None]] = set()
    for answer in answer_rows:
        item_id = answer.get("item_id")
        if not isinstance(item_id, str) or item_id not in item_map:
            diagnostics.append(f"answer item_id does not reference an item: {item_id}")
            continue
        item = item_map[item_id]
        item_volume, item_test, item_skill = _item_scope(item)
        if answer.get("skill") and str(answer.get("skill")).lower() != item_skill:
            diagnostics.append(f"answer skill does not match item: {item_id}")
        for field, expected in (("volume", item_volume), ("test_number", item_test)):
            if answer.get(field) is not None:
                try:
                    if int(answer[field]) != expected:
                        diagnostics.append(f"answer {field} does not match item: {item_id}")
                except (TypeError, ValueError):
                    diagnostics.append(f"answer {field} is invalid: {item_id}")
        question = answer.get("question_number")
        if item_skill in {"listening", "reading"}:
            try:
                start = int(item.get("question_start", item.get("question_number_start")))
                end = int(item.get("question_end", item.get("question_number_end", start)))
                number = int(question)
                if number < start or number > end:
                    diagnostics.append(f"answer question_number is outside item range: {item_id} q{number}")
            except (TypeError, ValueError):
                diagnostics.append(f"answer question_number is invalid: {item_id}")
        elif item_skill == "writing" and answer.get("task") is not None and str(answer.get("task")) != str(item.get("task", item.get("task_number"))):
            diagnostics.append(f"answer task does not match item: {item_id}")
        key = (item_id, int(question) if isinstance(question, int) else None, str(answer.get("answer_kind")) if answer.get("answer_kind") else None)
        if key in seen:
            diagnostics.append(f"duplicate answer link: {item_id}")
        seen.add(key)
    by_item: defaultdict[str, set[int]] = defaultdict(set)
    for answer in answer_rows:
        if answer.get("item_id") and isinstance(answer.get("question_number"), int):
            by_item[str(answer["item_id"])].add(int(answer["question_number"]))
    for item_id, item in item_map.items():
        if str(item.get("skill", "")).lower() not in {"listening", "reading"}:
            continue
        try:
            start = int(item.get("question_start", item.get("question_number_start")))
            end = int(item.get("question_end", item.get("question_number_end", start)))
        except (TypeError, ValueError):
            diagnostics.append(f"item has no question range for answer completeness: {item_id}")
            continue
        missing = [str(number) for number in range(start, end + 1) if number not in by_item.get(item_id, set())]
        if missing:
            diagnostics.append(f"missing answers for {item_id}: {','.join(missing)}")
    return diagnostics


def write_answer_metadata(answers: Iterable[Mapping[str, Any]], output: str | Path) -> None:
    """Write JSON/JSONL/CSV exchange files with paths relative to output."""
    root = Path(output)
    metadata = root / "metadata"
    metadata.mkdir(parents=True, exist_ok=True)
    # The current deliverable is Academic Listening/Reading only. Silently
    # exclude any legacy Writing/Speaking records that may be present in an
    # older work manifest so they cannot enter the release by accident.
    rows = [dict(answer) for answer in answers if str(answer.get("skill", "")).lower() in {"listening", "reading"}]
    (metadata / "answers.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (metadata / "answers.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    fields = sorted({key for row in rows for key in row})
    with (metadata / "answers.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, ensure_ascii=False) if isinstance(value, (list, dict)) else value for key, value in row.items()})


def main() -> int:
    parser = argparse.ArgumentParser(description="解析雅思听力/阅读答案键与写作范文")
    parser.add_argument("--pages", type=Path, required=True, help="page_inventory.json")
    parser.add_argument("--structure", type=Path, required=True, help="book structure JSON")
    parser.add_argument("--output", type=Path, required=True, help="answers 输出目录")
    args = parser.parse_args()
    pages = json.loads(args.pages.read_text(encoding="utf-8"))
    structure = json.loads(args.structure.read_text(encoding="utf-8"))
    rows = parse_listening_reading_keys(pages, structure)
    write_answer_metadata(rows, args.output)
    diagnostics_path = args.output / "metadata" / "answer_diagnostics.json"
    diagnostics_path.write_text(json.dumps(build_answer_diagnostics(rows), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"answers": len(rows), "output": "metadata/answers.json"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
