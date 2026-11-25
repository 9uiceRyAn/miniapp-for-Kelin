#!/usr/bin/env python3
"""将 IELTS Academic Listening/Reading 原文拆成可复用的来源记录。

本模块只使用已经提取的 ``page_inventory`` 文本和书卷结构，不翻译、不补写，
也不会把 Writing、Speaking 或 General Training 内容提升为数据库来源记录。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable, Mapping


_OCR_LINE_PREFIX = r"[^A-Za-z\n]{0,8}(?:[A-Za-z][^A-Za-z\n]{1,3})?"
_TEST_LINE_RE = re.compile(rf"(?im)^{_OCR_LINE_PREFIX}TEST\s*([1-8])\b")
_AUDIO_UNIT_RE = re.compile(
    rf"(?im)^{_OCR_LINE_PREFIX}(?:(?:SECTION|ECTION|PART)\s*([1-4])\b|(?:SECTION|ECTION|PART)[ \t]*$)"
)
_PASSAGE_RE = re.compile(
    rf"(?im)^{_OCR_LINE_PREFIX}(?:(?:ACADEMIC\s+)?READING\s+)?PASSAGE\s*([1-3])\b"
)
_QUESTION_BLOCK_RE = re.compile(
    r"(?im)^[^\n]{0,24}\bQUESTIONS?\s*[0-9]"
)
_SCRIPT_QUESTION_RE = re.compile(r"(?i)(?:Q|O|0)\s*([0-9]{1,2})(?:\s*/\s*[0-9]{1,2})?")
_SPEAKER_RE = re.compile(r"(?m)^[^A-Za-z\n]{0,8}[A-Z][A-Z .'-]{1,24}\s*[:：]")
_ALLOWED_SKILLS = {"listening", "reading"}
_MIN_READING_BODY_CHARS = 500
_PARAGRAPH_A_RE = re.compile(
    r"(?m)^[ \t]*A(?:[ \t]+[^A-Za-z\n]{0,8}[A-Z][^\n]{30,}|[ \t]*\n(?=[^\n]{30,}))"
)


def _page_number(page: Mapping[str, Any]) -> int:
    return int(page.get("page", 0))


def _page_text(page: Mapping[str, Any]) -> str:
    text = str(page.get("text") or "").replace("\x00", "").strip()
    if re.search(r"(?i)stpircsoidua|^[ \t]*[1-8]\s+(?:tset|tset)\b|^[ \t]*[1-4]\s+trap\b", text, re.MULTILINE):
        # A few PDFs expose every text-layer line in reverse character order.
        # Reversing each line restores the exact extracted glyph sequence.
        text = "\n".join(line[::-1] for line in text.splitlines())
    text = re.sub(
        r"(?im)^([^\n]*?)T\s*E\s*S\s*T(\s*[1-8]?\s*)$",
        lambda match: f"{match.group(1)}TEST{match.group(2)}",
        text,
    )
    text = re.sub(
        r"(?im)^([^\n]*?)S\s*E\s*C\s*T\s*I\s*O\s*N(\s*[1-4]?\s*)$",
        lambda match: f"{match.group(1)}SECTION{match.group(2)}",
        text,
    )
    return text


def _combine_pages(
    pages: Iterable[Mapping[str, Any]],
) -> tuple[str, list[tuple[int, int, int]]]:
    """Join pages while retaining character offsets for exact page provenance."""
    pieces: list[str] = []
    spans: list[tuple[int, int, int]] = []
    cursor = 0
    for page in sorted(pages, key=_page_number):
        text = _page_text(page)
        if pieces:
            pieces.append("\n\n")
            cursor += 2
        start = cursor
        pieces.append(text)
        cursor += len(text)
        spans.append((start, cursor, _page_number(page)))
    return "".join(pieces), spans


def _pages_for_slice(
    spans: list[tuple[int, int, int]], start: int, end: int
) -> list[int]:
    return [
        page
        for page_start, page_end, page in spans
        if page_end > start and page_start < end
    ]


def _span_for_offset(
    spans: list[tuple[int, int, int]], offset: int
) -> tuple[int, int, int] | None:
    return next((span for span in spans if span[0] <= offset < span[1]), None)


def _passage_marker_score(text: str, match: re.Match[str]) -> int:
    """Rank a real passage heading above references inside question instructions."""
    line_end = text.find("\n", match.end())
    if line_end < 0:
        line_end = len(text)
    line = text[match.start() : line_end].strip()
    following = text[match.end() : min(len(text), match.end() + 1200)]
    score = 0
    if re.fullmatch(
        rf"(?i){_OCR_LINE_PREFIX}(?:(?:ACADEMIC\s+)?READING\s+)?PASSAGE\s*[1-3][^A-Za-z0-9]*",
        line,
    ):
        score += 12
    if re.search(r"(?is)\byou\s+should\s+spend\b.{0,180}\bquestions?\b", following):
        score += 12
    if _PARAGRAPH_A_RE.search(following):
        score += 4
    if re.search(r"(?i)\bhas\s+(?:six|seven|[0-9]+)\s+paragraphs?\b", line):
        score -= 16
    if re.search(r"(?i)\b(?:according\s+to|in)\s+(?:the\s+)?(?:reading\s+)?passage\b", line):
        score -= 8
    return score


def _best_passage_markers(text: str) -> list[tuple[int, int, int]]:
    """Keep one highest-confidence heading for each passage number."""
    best: dict[int, tuple[int, int, int, int]] = {}
    for match in _PASSAGE_RE.finditer(text):
        unit = int(match.group(1))
        candidate = (match.start(), match.end(), unit, _passage_marker_score(text, match))
        current = best.get(unit)
        if current is None or candidate[3] > current[3]:
            best[unit] = candidate
    return sorted(
        ((start, end, unit) for start, end, unit, _ in best.values()),
        key=lambda marker: marker[0],
    )


def _article_start_after_questions(
    text: str,
    spans: list[tuple[int, int, int]],
    question_end: int,
    end: int,
) -> int | None:
    """Find a substantive paragraph A after questions printed before an article."""
    candidates: list[tuple[int, int]] = []
    for match in _PARAGRAPH_A_RE.finditer(text, question_end, end):
        next_question = _QUESTION_BLOCK_RE.search(text, match.end(), end)
        body_end = next_question.start() if next_question else end
        body = re.sub(r"\s+", "", text[match.start() : body_end])
        if len(body) < _MIN_READING_BODY_CHARS:
            continue
        preview = text[match.start() : min(body_end, match.start() + 900)]
        option_lines = len(
            re.findall(r"(?m)^[ \t]*[B-E][ _—-]+[^\n]{5,100}$", preview)
        )
        standalone = bool(re.match(r"^[ \t]*A[ \t]*\n", match.group(0)))
        score = min(len(body) // 250, 12) + (5 if standalone else 0) - option_lines * 4
        candidates.append((score, match.start()))
    if not candidates:
        return None
    _, anchor = max(candidates, key=lambda candidate: (candidate[0], -candidate[1]))
    paragraph_span = _span_for_offset(spans, anchor)
    question_span = _span_for_offset(spans, question_end)
    if paragraph_span is None:
        return anchor
    if question_span is None or paragraph_span[2] > question_span[2]:
        return paragraph_span[0]
    between = text[question_end:anchor]
    blank_lines = list(re.finditer(r"\n[ \t]*\n", between))
    if blank_lines:
        if len(blank_lines) >= 2:
            previous_end = blank_lines[-2].end()
            title_block = between[previous_end : blank_lines[-1].start()]
            stripped_title = title_block.strip()
            if (
                stripped_title
                and len(stripped_title) <= 240
                and len(stripped_title.splitlines()) <= 3
                and not re.match(r"(?i)^questions?\b", stripped_title)
                and not re.match(r"^[0-9]{1,2}\s+", stripped_title)
            ):
                leading = len(title_block) - len(title_block.lstrip())
                return question_end + previous_end + leading
        return question_end + blank_lines[-1].end()
    return anchor


def _question_only_page_boundary(
    text: str,
    spans: list[tuple[int, int, int]],
    content_start: int,
    end: int,
) -> int | None:
    """Detect a later question page even when OCR separates every letter."""
    content_span = _span_for_offset(spans, content_start)
    content_page = content_span[2] if content_span else 0
    for page_start, page_end, page_number in spans:
        if page_number <= content_page or page_start >= end:
            continue
        compact = re.sub(
            r"[^a-z0-9]+", "", text[page_start : min(page_end, end)].lower()
        )
        question_positions = [
            position
            for marker in ("questions", "uestions")
            if (position := compact.find(marker)) >= 0
        ]
        question_at = min(question_positions, default=-1)
        if not 0 <= question_at < 160:
            continue
        prefix = compact[:question_at]
        digit_ratio = (
            sum(character.isdigit() for character in prefix) / len(prefix)
            if prefix
            else 0.0
        )
        if question_at >= 20 and digit_ratio < 0.2:
            # A normal continuation sentence can precede a question block on
            # the same page; the regular text boundary keeps that article tail.
            continue
        nearby = compact[question_at : question_at + 900]
        signals = sum(
            marker in nearby
            for marker in (
                "choose",
                "writeyouranswers",
                "answersheet",
                "completethe",
                "readingpassage",
            )
        )
        if signals >= 1:
            return page_start
    return None


def _heading_boundary(
    text: str, spans: list[tuple[int, int, int]], marker_start: int
) -> int:
    """Include a shared page only when it contains real preceding unit text."""
    for page_start, page_end, _ in spans:
        if page_start <= marker_start < page_end:
            prefix = text[page_start:marker_start].strip()
            lines = [line.strip() for line in prefix.splitlines() if line.strip()]
            if lines and all(
                re.fullmatch(r"(?i)(?:audio\s*scripts?|tapescripts?|test\s*[1-8]|[0-9]{1,3})", line)
                for line in lines
            ):
                return page_start
            break
    return marker_start


def _asset_records(
    source_id: str, pages: list[int], asset_prefix: str, *, volume: int
) -> list[dict[str, Any]]:
    prefix = Path(asset_prefix)
    if prefix.is_absolute() or ".." in prefix.parts:
        raise ValueError("asset_prefix must be a portable relative path")
    assets: list[dict[str, Any]] = []
    for sequence, page in enumerate(pages, 1):
        assets.append(
            {
                "id": f"{source_id}-A{sequence:02d}",
                "path": (prefix / f"C{volume:02d}" / f"{source_id}-{sequence:02d}.png").as_posix(),
                "page_number": page,
                "sequence": sequence,
            }
        )
    return assets


def _source_record(
    *,
    volume: int,
    test_number: int,
    skill: str,
    unit_number: int,
    text: str,
    pages: list[int],
    asset_prefix: str,
) -> dict[str, Any]:
    if skill == "listening":
        source_id = f"IELTS-C{volume:02d}-T{test_number:02d}-L-S{unit_number:02d}-SOURCE"
        kind = "audioscript"
    else:
        source_id = f"IELTS-C{volume:02d}-T{test_number:02d}-R-P{unit_number:02d}-SOURCE"
        kind = "reading_passage"
    return {
        "id": source_id,
        "skill": skill,
        "volume": volume,
        "test_number": test_number,
        "unit_number": unit_number,
        "kind": kind,
        "text": text.strip(),
        "page_start": min(pages),
        "page_end": max(pages),
        "assets": _asset_records(source_id, pages, asset_prefix, volume=volume),
    }


def _reference_start(
    structure: Mapping[str, Any], name: str, *, after: int
) -> list[int]:
    references = structure.get("references") or {}
    values = references.get(name) if isinstance(references, Mapping) else []
    output: list[int] = []
    for value in values or []:
        if not isinstance(value, Mapping):
            continue
        start = int(value.get("page_start", 0))
        if start > after:
            output.append(start)
    return output


def _audioscript_records(
    structure: Mapping[str, Any],
    page_texts: list[Mapping[str, Any]],
    *,
    volume: int,
    asset_prefix: str,
) -> list[dict[str, Any]]:
    tests = [test for test in structure.get("tests", []) if isinstance(test, Mapping)]
    if not tests:
        return []
    allowed_tests = sorted({int(test["number"]) for test in tests})
    academic_end = max(int(test.get("page_end", 0)) for test in tests)
    starts = _reference_start(structure, "audioscripts", after=academic_end - 1)
    if not starts:
        starts = [
            _page_number(page)
            for page in page_texts
            if _page_number(page) > academic_end
            and re.search(r"(?im)^\s*(?:audio\s*scripts?|tapescripts?)\b", _page_text(page))
        ]
    if not starts:
        return []
    referenced_start = min(starts)
    # Structure discovery can place the last Speaking page on the same physical
    # page as the first audioscript, so permit a tightly bounded overlap.
    lookback_start = max(1, referenced_start - 3)
    lookback_units = [
        _page_number(page)
        for page in page_texts
        if lookback_start <= _page_number(page) <= referenced_start
        and (
            _page_number(page) > academic_end
            or re.search(r"(?i)\b(?:audio\s*scripts?|tapescripts?)\b", _page_text(page))
        )
        and any(match.group(1) in {None, "1"} for match in _AUDIO_UNIT_RE.finditer(_page_text(page)))
    ]
    audio_start = min(lookback_units) if lookback_units else referenced_start
    answer_starts = _reference_start(structure, "answer_keys", after=audio_start)
    other_starts = _reference_start(structure, "writing_samples", after=audio_start)
    stops = answer_starts + other_starts
    audio_end = min(stops) - 1 if stops else max(_page_number(page) for page in page_texts)
    zone_pages = [
        page for page in page_texts if audio_start <= _page_number(page) <= audio_end
    ]
    text, spans = _combine_pages(zone_pages)
    units: list[tuple[int, int, int]] = []
    test_index = 0
    seen_units: set[int] = set()
    last_unit: int | None = None
    for match in _AUDIO_UNIT_RE.finditer(text):
        unit_number = int(match.group(1)) if match.group(1) else (1 if last_unit in {None, 4} else last_unit + 1)
        if last_unit == unit_number:
            # A continuation page may repeat its running unit heading.
            continue
        if last_unit is not None and (unit_number < last_unit or unit_number in seen_units):
            test_index += 1
            seen_units = set()
        if test_index >= len(allowed_tests):
            continue
        test_number = allowed_tests[test_index]
        units.append((match.start(), test_number, unit_number))
        seen_units.add(unit_number)
        last_unit = unit_number

    # When OCR drops a middle SECTION/PART heading, recover its boundary from
    # the original Q-number annotations and the first following speaker turn.
    # This only slices existing text; it never creates transcript content.
    inferred: list[tuple[int, int, int]] = []
    for test_number in allowed_tests:
        present = {unit for _, test, unit in units if test == test_number}
        for missing_unit in sorted(set(range(1, 5)) - present):
            previous = [entry for entry in units if entry[1] == test_number and entry[2] < missing_unit]
            following = [entry for entry in units if entry[1] == test_number and entry[2] > missing_unit]
            if not previous or not following:
                continue
            previous_entry = max(previous, key=lambda entry: entry[2])
            following_entry = min(following, key=lambda entry: entry[2])
            if previous_entry[2] != missing_unit - 1 or following_entry[2] != missing_unit + 1:
                continue
            interval_start, interval_end = previous_entry[0], following_entry[0]
            markers: list[tuple[Any, int]] = []
            for marker in _SCRIPT_QUESTION_RE.finditer(text, interval_start, interval_end):
                value = int(marker.group(1))
                if 1 <= value <= 40:
                    markers.append((marker, value))
            low, high = (missing_unit - 1) * 10 + 1, missing_unit * 10
            target = next((marker for marker, value in markers if low <= value <= high), None)
            if target is None:
                continue
            prior_low, prior_high = low - 10, high - 10
            prior = [marker for marker, value in markers if prior_low <= value <= prior_high and marker.start() < target.start()]
            if not prior:
                continue
            last_prior = prior[-1]
            between = text[last_prior.end() : target.start()]
            paragraph_break = re.search(r"\n[ \t]*\n", between)
            search_start = last_prior.end() + (paragraph_break.end() if paragraph_break else 0)
            speaker = _SPEAKER_RE.search(text, search_start, target.start())
            boundary = speaker.start() if speaker else search_start
            if interval_start < boundary < interval_end:
                inferred.append((boundary, test_number, missing_unit))
    units.extend(inferred)
    units.sort(key=lambda entry: entry[0])

    records: list[dict[str, Any]] = []
    for index, (start, test_number, unit_number) in enumerate(units):
        end = len(text)
        for next_start, next_test, next_unit in units[index + 1 :]:
            if (next_test, next_unit) != (test_number, unit_number):
                end = _heading_boundary(text, spans, next_start)
                break
        pages = _pages_for_slice(spans, start, end)
        source_text = text[start:end].strip()
        if not source_text or not pages:
            continue
        records.append(
            _source_record(
                volume=volume,
                test_number=test_number,
                skill="listening",
                unit_number=unit_number,
                text=source_text,
                pages=pages,
                asset_prefix=asset_prefix,
            )
        )
    return records


def _reading_records(
    structure: Mapping[str, Any],
    page_texts: list[Mapping[str, Any]],
    *,
    volume: int,
    asset_prefix: str,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for test in structure.get("tests", []):
        if not isinstance(test, Mapping):
            continue
        test_number = int(test["number"])
        for section in test.get("sections", []):
            if not isinstance(section, Mapping) or str(section.get("name") or "").lower() != "reading":
                continue
            start_page = int(section.get("page_start", 0))
            end_page = int(section.get("page_end", 0))
            pages_in_section = [
                page for page in page_texts if start_page <= _page_number(page) <= end_page
            ]
            text, spans = _combine_pages(pages_in_section)
            markers = _best_passage_markers(text)
            for index, (start, heading_end, unit_number) in enumerate(markers):
                end = markers[index + 1][0] if index + 1 < len(markers) else len(text)
                question_matches = list(_QUESTION_BLOCK_RE.finditer(text, heading_end, end))
                content_start = start
                if question_matches:
                    body_before_questions = re.sub(
                        r"\s+", "", text[start : question_matches[0].start()]
                    )
                    if len(body_before_questions) < _MIN_READING_BODY_CHARS:
                        inferred_start = _article_start_after_questions(
                            text, spans, question_matches[0].end(), end
                        )
                        if inferred_start is not None:
                            # Some books print the first question group before
                            # the article, sometimes even on the same page.
                            content_start = inferred_start
                question_page = _question_only_page_boundary(
                    text, spans, content_start, end
                )
                if question_page is not None:
                    end = min(end, question_page)
                    question_matches = [
                        match for match in question_matches if match.start() < end
                    ]
                for question_match in question_matches:
                    if question_match.start() < content_start:
                        continue
                    body = re.sub(r"\s+", "", text[content_start : question_match.start()])
                    nearby = text[question_match.start() : min(end, question_match.start() + 180)]
                    if len(body) < _MIN_READING_BODY_CHARS and re.search(r"(?is)questions?.{0,90}based\s+on", nearby):
                        continue
                    # The standard passage preamble itself mentions the full
                    # question range before the article begins. Only a question
                    # heading after a substantive article body is an end marker.
                    if len(body) >= 20:
                        boundary = question_match.start()
                        question_span = _span_for_offset(spans, boundary)
                        if question_span is not None:
                            page_prefix = text[question_span[0] : boundary]
                            substantive_words = re.findall(
                                r"[A-Za-z]{3,}", page_prefix
                            )
                            if len(substantive_words) < 4:
                                boundary = question_span[0]
                        end = boundary
                        break
                pages = _pages_for_slice(spans, content_start, end)
                source_text = text[content_start:end].strip()
                if not source_text or not pages:
                    continue
                records.append(
                    _source_record(
                        volume=volume,
                        test_number=test_number,
                        skill="reading",
                        unit_number=unit_number,
                        text=source_text,
                        pages=pages,
                        asset_prefix=asset_prefix,
                    )
                )
    return records


def build_source_texts(
    structure: Mapping[str, Any],
    page_texts: list[Mapping[str, Any]],
    *,
    asset_prefix: str = "images/sources",
) -> list[dict[str, Any]]:
    """Return normalized Academic Listening audioscripts and Reading passages.

    Missing boundaries are omitted rather than guessed. The caller can compare the
    returned units with the expected 4 Listening and 3 Reading units per Test.
    """
    volume = int(structure.get("volume") or 0)
    if volume <= 0:
        raise ValueError("structure.volume is required")
    pages = sorted(page_texts, key=_page_number)
    records = _audioscript_records(
        structure, pages, volume=volume, asset_prefix=asset_prefix
    )
    records.extend(
        _reading_records(structure, pages, volume=volume, asset_prefix=asset_prefix)
    )
    return sorted(
        records,
        key=lambda record: (
            int(record["test_number"]),
            0 if record["skill"] == "listening" else 1,
            int(record["unit_number"]),
        ),
    )


def source_text_id_for_item(item: Mapping[str, Any]) -> str:
    """Derive the stable source ID for one Listening/Reading item."""
    skill = str(item.get("skill") or "").lower()
    if skill not in _ALLOWED_SKILLS:
        raise ValueError("item skill must be Academic Listening/Reading")
    volume = int(item.get("volume") or 0)
    test_number = int(item.get("test_number") or 0)
    if volume <= 0 or test_number <= 0:
        raise ValueError("item volume and test_number are required")
    if skill == "listening":
        unit = int(item.get("unit_number") or item.get("section_number") or 0)
        if not unit:
            question_start = int(item.get("question_start") or 0)
            unit = (question_start - 1) // 10 + 1 if question_start else 0
        if unit not in range(1, 5):
            raise ValueError("listening item requires section 1-4")
        return f"IELTS-C{volume:02d}-T{test_number:02d}-L-S{unit:02d}-SOURCE"
    unit = int(item.get("unit_number") or item.get("section_number") or 0)
    if not unit:
        question_start = int(item.get("question_start") or 0)
        unit = 1 if 1 <= question_start <= 13 else 2 if question_start <= 26 else 3 if question_start <= 40 else 0
    if unit not in range(1, 4):
        raise ValueError("reading item requires passage 1-3")
    return f"IELTS-C{volume:02d}-T{test_number:02d}-R-P{unit:02d}-SOURCE"


def link_items_to_source_texts(
    items: Iterable[Mapping[str, Any]], source_texts: Iterable[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Copy items and attach an existing, skill-matched ``source_text_id``."""
    sources = {str(source.get("id") or ""): source for source in source_texts}
    output: list[dict[str, Any]] = []
    for item in items:
        source_id = source_text_id_for_item(item)
        source = sources.get(source_id)
        if source is None:
            raise ValueError(f"item {item.get('id', '<missing>')} has missing source_text {source_id}")
        skill = str(item.get("skill") or "").lower()
        for field in ("volume", "test_number"):
            if int(source.get(field) or 0) != int(item.get(field) or 0):
                raise ValueError(f"item {item.get('id', '<missing>')} source_text {field} mismatch")
        if str(source.get("skill") or "").lower() != skill:
            raise ValueError(f"item {item.get('id', '<missing>')} source_text skill mismatch")
        output.append(dict(item, source_text_id=source_id))
    return output


__all__ = [
    "build_source_texts",
    "link_items_to_source_texts",
    "source_text_id_for_item",
]
