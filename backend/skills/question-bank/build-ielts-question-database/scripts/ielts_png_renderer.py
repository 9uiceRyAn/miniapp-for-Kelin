#!/usr/bin/env python3
"""将 IELTS Academic Listening/Reading 题目和原文渲染为便携 PNG 资产。

题目跨页时会纵向拼接为一个 PNG。渲染器优先用 PDF 文字坐标定位题组标题，
扫描页则调用 Tesseract TSV 获取同类边界框；定位不确定时保守保留整页并在
``visual_qa`` 中标记人工复核，从不以猜测边界换取更紧凑的裁剪。
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import shutil
import subprocess
import tempfile
from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

from PIL import Image, ImageOps

try:
    import pdfplumber
except ImportError:  # pragma: no cover - OCR remains available
    pdfplumber = None


ALLOWED_SKILLS = {"listening", "reading"}
DEFAULT_DPI = 180
DEFAULT_PADDING = 28
_RANGE_RE = re.compile(
    r"(?i)questions?\s*([0-9Oo]{1,2})"
    r"(?:\s*(?:[-\u2013\u2014]|to|and|&)\s*([0-9Oo]{1,2}))?"
)
_WORD_RE = re.compile(r"[A-Za-z0-9]+")
_QUESTION_MARKER_RE = re.compile(r"^\s*([0-9Oo]{1,2})(?=$|\s|[._\u2026])")
_SECTION_BOUNDARY_RE = re.compile(
    r"(?i)^\s*(?:reading\s+passage|section|part|test)\s+(?:[0-9Oo]{1,2}|one|two|three|four)\b"
)
_PROMO_FOOTER_RE = re.compile(
    r"(?i)laokaoya|一站解决雅思备考问题|资料下载|最新资讯|考试答案|应有尽有"
)
_PAGE_NAV_FOOTER_RE = re.compile(r"(?i)\bp\.?\s*\d{1,3}\b")
_PAGE_NUMBER_FOOTER_RE = re.compile(r"^\s*\d{1,3}\s*$")


def _number(value: str | None) -> int | None:
    if not value:
        return None
    normalized = value.replace("O", "0").replace("o", "0")
    return int(normalized) if normalized.isdigit() else None


def _question_ranges(text: str) -> list[tuple[int, int]]:
    output: list[tuple[int, int]] = []
    for match in _RANGE_RE.finditer(text or ""):
        start = _number(match.group(1))
        end = _number(match.group(2)) or start
        if start is not None and end is not None and 1 <= start <= end <= 40:
            output.append((start, end))
    return output


def _validate_skill(record: Mapping[str, object], *, kind: str) -> str:
    skill = str(record.get("skill") or "").lower()
    module = str(record.get("module") or record.get("track") or "").lower()
    if skill not in ALLOWED_SKILLS or module in {"general", "general_training", "gt"}:
        raise ValueError(f"{kind} must be Academic Listening/Reading only")
    return skill


def _portable_path(path: str) -> str:
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts or re.match(r"^[A-Za-z]:", path):
        raise ValueError(f"non-portable output path: {path}")
    return pure.as_posix()


def _read_records(path: Path, key: str | None = None) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(value, list):
        return [dict(row) for row in value]
    if isinstance(value, dict):
        if key and isinstance(value.get(key), list):
            return [dict(row) for row in value[key]]
        for fallback in ("items", "source_texts", "records"):
            if isinstance(value.get(fallback), list):
                return [dict(row) for row in value[fallback]]
    raise ValueError(f"expected a JSON list in {path}")


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write_merged_records(path: Path, records: Iterable[Mapping[str, object]], key: str) -> list[dict[str, Any]]:
    """Upsert one volume into a shared release metadata file."""
    existing: list[dict[str, Any]] = []
    if path.is_file():
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, list):
            existing = [dict(row) for row in value]
    merged = {str(row.get(key) or ""): row for row in existing if row.get(key)}
    for record in records:
        row = dict(record)
        identity = str(row.get(key) or "")
        if not identity:
            raise ValueError(f"metadata record is missing {key}")
        merged[identity] = row
    output = sorted(merged.values(), key=lambda row: str(row.get(key) or ""))
    _write_json(path, output)
    return output


def _render_pdf_page(pdf: Path, page_number: int, dpi: int, work: Path) -> Image.Image:
    executable = shutil.which("pdftoppm")
    if not executable:
        raise RuntimeError("pdftoppm is required to render IELTS PNG assets")
    prefix = work / f"page-{page_number:04d}"
    command = [
        executable,
        "-f", str(page_number),
        "-l", str(page_number),
        "-singlefile",
        "-png",
        "-r", str(dpi),
        str(pdf),
        str(prefix),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    rendered = prefix.with_suffix(".png")
    if result.returncode or not rendered.is_file():
        raise RuntimeError((result.stderr or "pdftoppm failed").strip())
    with Image.open(rendered) as image:
        return image.convert("RGB")


def _cluster_lines(words: Sequence[Mapping[str, object]], tolerance: float = 4.0) -> list[dict[str, Any]]:
    rows: list[list[Mapping[str, object]]] = []
    for word in sorted(words, key=lambda row: (float(row.get("top", 0)), float(row.get("x0", 0)))):
        top = float(word.get("top", 0))
        if not rows or abs(top - float(rows[-1][0].get("top", 0))) > tolerance:
            rows.append([word])
        else:
            rows[-1].append(word)
    output = []
    for row in rows:
        row = sorted(row, key=lambda value: float(value.get("x0", 0)))
        output.append({
            "text": " ".join(str(value.get("text") or "") for value in row),
            "top": min(float(value.get("top", 0)) for value in row),
            "bottom": max(float(value.get("bottom", 0)) for value in row),
        })
    return output


def _tesseract_words(image: Image.Image, work: Path, page_number: int) -> list[dict[str, object]]:
    executable = shutil.which("tesseract")
    if not executable:
        return []
    path = work / f"tesseract-{page_number:04d}.png"
    image.save(path)
    result = subprocess.run(
        [executable, str(path), "stdout", "--psm", "6", "tsv"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        return []
    output: list[dict[str, object]] = []
    # Tesseract's TSV text column is not CSV-quoted. A literal double quote in
    # OCR output must therefore remain ordinary text; otherwise DictReader can
    # consume every following TSV line into that one field.
    for row in csv.DictReader(
        io.StringIO(result.stdout), delimiter="\t", quoting=csv.QUOTE_NONE
    ):
        text = (row.get("text") or "").strip()
        if not text:
            continue
        try:
            left, top = int(row["left"]), int(row["top"])
            width, height = int(row["width"]), int(row["height"])
        except (KeyError, TypeError, ValueError):
            continue
        output.append({"text": text, "x0": left, "top": top, "x1": left + width, "bottom": top + height})
    return output


class _PageLocator:
    def __init__(self, pdf: Path, dpi: int, work: Path) -> None:
        self.pdf = pdf
        self.dpi = dpi
        self.work = work
        self.images: dict[int, Image.Image] = {}
        self.lines: dict[int, list[dict[str, Any]]] = {}
        self._document = pdfplumber.open(str(pdf)) if pdfplumber is not None else None

    def close(self) -> None:
        if self._document is not None:
            self._document.close()

    def image(self, page_number: int) -> Image.Image:
        if page_number not in self.images:
            self.images[page_number] = _render_pdf_page(self.pdf, page_number, self.dpi, self.work)
        return self.images[page_number].copy()

    def page_lines(self, page_number: int) -> list[dict[str, Any]]:
        if page_number in self.lines:
            return self.lines[page_number]
        image = self.image(page_number)
        words: list[Mapping[str, object]] = []
        coordinate_scale = 1.0
        if self._document is not None and 0 < page_number <= len(self._document.pages):
            page = self._document.pages[page_number - 1]
            words = page.extract_words(keep_blank_chars=False, use_text_flow=True) or []
            coordinate_scale = image.height / float(page.height)
        if words:
            lines = _cluster_lines(words)
            for line in lines:
                line["top"] *= coordinate_scale
                line["bottom"] *= coordinate_scale
                line["engine"] = "pdf-text"
        else:
            lines = _cluster_lines(_tesseract_words(image, self.work, page_number), tolerance=7.0)
            for line in lines:
                line["engine"] = "tesseract"
        self.lines[page_number] = lines
        return lines

    def anchor_y(self, page_number: int, target: tuple[int, int]) -> tuple[int | None, str | None]:
        same_start: tuple[int, str] | None = None
        for line in self.page_lines(page_number):
            ranges = _question_ranges(str(line["text"]))
            if target in ranges:
                return int(float(line["top"])), str(line.get("engine") or "unknown")
            if any(start == target[0] for start, _ in ranges) and same_start is None:
                same_start = (int(float(line["top"])), str(line.get("engine") or "unknown"))
        return same_start or (None, None)

    def next_anchor_y(self, page_number: int, after_question: int) -> tuple[int | None, str | None]:
        """Return the first printed question heading that begins after a group."""
        for line in self.page_lines(page_number):
            if any(start > after_question for start, _ in _question_ranges(str(line["text"]))):
                return int(float(line["top"])), str(line.get("engine") or "unknown")
        return None, None


def _question_marker(
    line: Mapping[str, object], image_height: int
) -> tuple[int, int, int, str] | None:
    """Return a printed small-question marker, excluding headings and page footers."""
    text = str(line.get("text") or "").strip()
    if not text or re.search(r"(?i)^\s*questions?\b", text):
        return None
    if re.search(
        r"(?i)^[0-9Oo]{1,2}\s+(?:section|part|test|reading\s+passage)\b",
        text,
    ):
        return None
    match = _QUESTION_MARKER_RE.match(text)
    number = _number(match.group(1)) if match else None
    if number is None or not 1 <= number <= 40:
        return None
    top = int(float(line.get("top") or 0))
    bottom = int(float(line.get("bottom") or top + 1))
    if top >= int(image_height * 0.92):
        return None
    if re.fullmatch(r"[0-9Oo]{1,2}", text) and top >= int(image_height * 0.75):
        return None
    return number, top, bottom, str(line.get("engine") or "unknown")


def _target_markers(
    locator: _PageLocator, source_pages: Sequence[int], start: int, end: int
) -> dict[int, list[tuple[int, int, int, str]]]:
    output: dict[int, list[tuple[int, int, int, str]]] = {}
    for page_number in source_pages:
        height = locator.image(page_number).height
        markers = [
            marker
            for line in locator.page_lines(page_number)
            if (marker := _question_marker(line, height)) is not None
            and start <= marker[0] <= end
        ]
        if markers:
            output[page_number] = markers
    return output


def _markers_cover_group_end(
    markers_by_page: Mapping[int, Sequence[tuple[int, int, int, str]]], end: int
) -> bool:
    """Only trust tight marker crops when the final small question is visible."""
    return any(marker[0] == end for markers in markers_by_page.values() for marker in markers)


def _group_start_y(
    locator: _PageLocator,
    page_number: int,
    target: tuple[int, int],
    markers: Sequence[tuple[int, int, int, str]],
) -> tuple[int | None, str | None]:
    """Locate the group's printed heading, tolerating OCR damage in its range."""
    first_marker_top = min(marker[1] for marker in markers)
    y, engine = locator.anchor_y(page_number, target)
    if y is not None and y <= first_marker_top:
        return y, engine
    preceding = [
        line
        for line in locator.page_lines(page_number)
        if float(line.get("top") or 0) < first_marker_top
        and re.search(r"(?i)\bquestions?\b", str(line.get("text") or ""))
    ]
    if preceding:
        line = preceding[-1]
        return int(float(line.get("top") or 0)), str(line.get("engine") or "unknown")
    first = min(markers, key=lambda marker: marker[1])
    return first[1], first[3]


def _non_item_footer_y(
    locator: _PageLocator,
    page_number: int,
    after_y: int,
    *,
    allow_initial_gap: bool = False,
) -> tuple[int | None, str | None]:
    """Locate a distributor promo or page-navigation footer below item content."""
    height = locator.image(page_number).height
    page_image = locator.image(page_number)
    lines = sorted(locator.page_lines(page_number), key=lambda line: float(line.get("top") or 0))
    for index, line in enumerate(lines):
        text = str(line.get("text") or "")
        top = int(float(line.get("top") or 0))
        is_promo = bool(_PROMO_FOOTER_RE.search(text))
        is_pure_page_number = (
            bool(_PAGE_NUMBER_FOOTER_RE.fullmatch(text)) and top >= int(height * 0.9)
        )
        is_page_nav = (
            bool(_PAGE_NAV_FOOTER_RE.search(text)) and top >= int(height * 0.75)
        ) or is_pure_page_number
        if not (is_promo or is_page_nav):
            continue
        if top <= after_y:
            continue
        # A lone printed page number is a footer only when the gap immediately
        # before that number separates it from the last real content block.
        # Do not search all earlier gaps: question sheets often contain large
        # intentional gaps between headings/table rows, and using the first
        # such gap would truncate the actual question body (for example C09
        # T03 Listening Q33-40 before page number 62).
        if is_pure_page_number:
            # OCR can miss the lower half of a diagram or table.  Use the
            # raster itself as a conservative lower-content signal before
            # trusting OCR line coordinates for a printed page number.
            interior_left = int(page_image.width * 0.03)
            interior_right = max(interior_left + 1, int(page_image.width * 0.97))
            scan_bottom = max(0, min(top - 2, page_image.height))
            raster_bottom = None
            if scan_bottom > after_y:
                gray = ImageOps.grayscale(
                    page_image.crop((interior_left, 0, interior_right, scan_bottom))
                )
                ink = gray.point(lambda value: 255 if value < 225 else 0)
                bbox = ink.getbbox()
                if bbox is not None:
                    raster_bottom = int(bbox[3])
            if raster_bottom is not None and raster_bottom > after_y:
                raster_gap = top - raster_bottom
                if raster_gap >= int(height * 0.08):
                    return raster_bottom + max(36, int(height * 0.06)), str(line.get("engine") or "unknown")
            preceding = [
                candidate
                for candidate in lines
                if int(float(candidate.get("bottom") or candidate.get("top") or 0)) > after_y
                and int(float(candidate.get("top") or 0)) < top
            ]
            if not preceding:
                continue
            previous_line = max(
                preceding,
                key=lambda candidate: int(
                    float(candidate.get("bottom") or candidate.get("top") or 0)
                ),
            )
            previous_bottom = int(
                float(previous_line.get("bottom") or previous_line.get("top") or 0)
            )
            # PDF text coordinates are complete for the synthetic/text-layer
            # case; OCR can miss the lower half of a table or diagram.  Demand
            # a much lower content block for OCR before trusting a page number.
            content_floor = 0.75 if previous_line.get("engine") == "tesseract" else 0.4
            if (
                previous_bottom < int(height * content_floor)
                or top - previous_bottom < int(height * 0.08)
            ):
                continue
            return previous_bottom + max(36, int(height * 0.06)), str(line.get("engine") or "unknown")
        previous = [{"top": after_y, "bottom": after_y}] + [
            candidate
            for candidate in lines[:index]
            if int(float(candidate.get("bottom") or candidate.get("top") or 0)) > after_y
        ]
        boundary = top
        found_gap = False
        for gap_index, (before, after) in enumerate(zip(previous, previous[1:] + [line])):
            before_bottom = int(float(before.get("bottom") or before.get("top") or 0))
            after_top = int(float(after.get("top") or 0))
            if after_top - before_bottom >= int(height * 0.08):
                if gap_index > 0 or allow_initial_gap:
                    found_gap = True
                boundary = min(boundary, before_bottom + max(36, int(height * 0.06)))
        if is_pure_page_number and not found_gap:
            continue
        return boundary, str(line.get("engine") or "unknown")
    return None, None


def _group_end_y(
    locator: _PageLocator,
    page_number: int,
    end: int,
    markers: Sequence[tuple[int, int, int, str]],
) -> tuple[int | None, str | None]:
    """Locate the next printed group/section after the final small question."""
    last_marker_bottom = max(marker[2] for marker in markers)
    height = locator.image(page_number).height
    lines = sorted(locator.page_lines(page_number), key=lambda line: float(line.get("top") or 0))
    footer_boundary = _non_item_footer_y(
        locator, page_number, last_marker_bottom, allow_initial_gap=True
    )

    for line in lines:
        top = int(float(line.get("top") or 0))
        if top <= last_marker_bottom:
            continue
        text = str(line.get("text") or "")
        marker = _question_marker(line, height)
        is_later_question = marker is not None and marker[0] > end
        is_later_heading = any(start > end for start, _ in _question_ranges(text))
        if is_later_question or is_later_heading or _SECTION_BOUNDARY_RE.search(text):
            natural = (top, str(line.get("engine") or "unknown"))
            if footer_boundary[0] is not None and footer_boundary[0] < natural[0]:
                return footer_boundary
            return natural
    return footer_boundary


def _page_index(page_inventory: Iterable[Mapping[str, object]]) -> dict[int, str]:
    return {int(row["page"]): str(row.get("text") or "") for row in page_inventory}


def _find_anchor_page(
    pages: Mapping[int, str], candidates: Sequence[int], target: tuple[int, int]
) -> tuple[int | None, bool]:
    same_start: int | None = None
    for page_number in candidates:
        ranges = _question_ranges(pages.get(page_number, ""))
        if target in ranges:
            return page_number, True
        if same_start is None and any(start == target[0] for start, _ in ranges):
            same_start = page_number
    return same_start, False


def _find_next_anchor_page(
    pages: Mapping[int, str], candidates: Sequence[int], after_question: int
) -> int | None:
    for page_number in candidates:
        if any(start > after_question for start, _ in _question_ranges(pages.get(page_number, ""))):
            return page_number
    return None


def _has_numbered_continuation(text: str, after_question: int) -> bool:
    """Whether a new page contains the current group's last number before the next heading."""
    boundary = None
    for match in _RANGE_RE.finditer(text or ""):
        start = _number(match.group(1))
        if start is not None and start > after_question:
            boundary = match.start()
            break
    prefix = (text or "")[:boundary] if boundary is not None else (text or "")
    return bool(re.search(rf"(?<!\d){after_question}(?!\d)", prefix))


def _next_scope_boundary(
    pages: Mapping[int, str],
    candidates: Sequence[int],
    *,
    after_page: int | None,
    skill: str,
    end_question: int,
) -> tuple[int | None, bool]:
    """Find the next Passage/Section or out-of-scope page after an item starts."""
    if after_page is None:
        return None, False
    if skill == "reading":
        labels = (
            r"(?:writing(?:\s+task)?|speaking(?:\s+part)?|reading\s+passage|"
            r"gnitirw|gnikaeps|egassap\s+gnidaer)"
        )
    else:
        labels = (
            r"(?:writing(?:\s+task)?|speaking(?:\s+part)?|reading\s+passage|section|part|"
            r"gnitirw|gnikaeps|egassap\s+gnidaer|noitces|trap)"
        )
    boundary_re = re.compile(rf"(?im)^[^A-Za-z\n]{{0,12}}{labels}\b")
    for page_number in candidates:
        if page_number <= after_page:
            continue
        text = pages.get(page_number, "")
        match = boundary_re.search(text)
        if match is None:
            continue
        prefix = text[: match.start()]
        continuation = bool(
            re.search(rf"(?<!\d){end_question}(?!\d)", prefix)
        )
        return page_number, continuation
    return None, False


def _tokens(text: str) -> set[str]:
    return {word.lower() for word in _WORD_RE.findall(text or "") if len(word) >= 4}


def _best_text_page(pages: Mapping[int, str], candidates: Sequence[int], item_text: str) -> int | None:
    target = _tokens(item_text)
    if not target:
        return candidates[0] if candidates else None
    scored = [(len(target & _tokens(pages.get(page, ""))), page) for page in candidates]
    score, page = max(scored, default=(0, None))
    return page if score >= 2 else (candidates[0] if candidates else None)


def _line_words(text: str) -> set[str]:
    return {word.lower() for word in _WORD_RE.findall(text or "")}


def _source_line_matches(source_words: set[str], page_words: set[str]) -> bool:
    if not source_words or not page_words:
        return False
    shared = len(source_words & page_words)
    required = 1 if min(len(source_words), len(page_words)) == 1 else 2
    return shared >= required and shared / min(len(source_words), len(page_words)) >= 0.66


def _source_text_bounds(
    locator: _PageLocator, source_pages: Sequence[int], source_text: str
) -> tuple[int, int, int, int] | None:
    """Match the first/last source lines so adjacent same-page material is excluded."""
    source_lines = [
        _line_words(line)
        for line in source_text.splitlines()
        if _line_words(line)
    ]
    if not source_lines:
        source_lines = [_line_words(source_text)] if _line_words(source_text) else []
    page_lines = [
        (page_number, line, _line_words(str(line.get("text") or "")))
        for page_number in source_pages
        for line in locator.page_lines(page_number)
    ]
    if not source_lines or not page_lines:
        return None

    first: tuple[int, int] | None = None
    for source_words in source_lines:
        for page_number, line, words in page_lines:
            if _source_line_matches(source_words, words):
                first = (page_number, int(float(line.get("top") or 0)))
                break
        if first is not None:
            break

    last: tuple[int, int] | None = None
    for source_words in reversed(source_lines):
        for page_number, line, words in reversed(page_lines):
            if _source_line_matches(source_words, words):
                last = (page_number, int(float(line.get("bottom") or 0)))
                break
        if last is not None:
            break

    if first is None or last is None or first[0] > last[0]:
        return None
    if first[0] == last[0] and first[1] >= last[1]:
        return None
    return first[0], first[1], last[0], last[1]


def _output_path(item: Mapping[str, object], used: set[str]) -> str:
    volume = int(item.get("volume") or 0)
    test = int(item.get("test_number") or 0)
    skill = _validate_skill(item, kind="item")
    start = int(item.get("question_start") or 0)
    end = int(item.get("question_end") or start)
    stem = f"q{start:02d}-{end:02d}"
    base = f"images/items/C{volume:02d}/T{test:02d}/{skill}/{stem}.png"
    candidate = base
    suffix = 2
    while candidate in used:
        candidate = base[:-4] + f"-{suffix:02d}.png"
        suffix += 1
    used.add(candidate)
    return _portable_path(candidate)


def _with_padding(image: Image.Image, padding: int) -> Image.Image:
    output = Image.new("RGB", (image.width + 2 * padding, image.height + 2 * padding), "white")
    output.paste(image, (padding, padding))
    return output


def _stitch(images: Sequence[Image.Image], padding: int) -> Image.Image:
    if not images:
        raise ValueError("at least one crop is required")
    gutter = max(8, padding)
    width = max(image.width for image in images)
    height = sum(image.height for image in images) + gutter * (len(images) - 1)
    body = Image.new("RGB", (width, height), "white")
    y = 0
    for image in images:
        body.paste(image, ((width - image.width) // 2, y))
        y += image.height + gutter
    return _with_padding(body, padding)


def _white_fraction(image: Image.Image) -> float:
    gray = image.convert("L")
    histogram = gray.histogram()
    return sum(histogram[245:]) / max(1, gray.width * gray.height)


def _qa_record(item_id: str, relative_path: str, image: Image.Image, pages: list[int], diagnostics: list[str]) -> dict[str, Any]:
    edge = max(2, min(10, image.width // 8, image.height // 8))
    fractions = {
        "top": _white_fraction(image.crop((0, 0, image.width, edge))),
        "bottom": _white_fraction(image.crop((0, image.height - edge, image.width, image.height))),
        "left": _white_fraction(image.crop((0, 0, edge, image.height))),
        "right": _white_fraction(image.crop((image.width - edge, 0, image.width, image.height))),
    }
    boundary_white = all(value >= 0.995 for value in fractions.values())
    decodable = image.width > 0 and image.height > 0
    return {
        "item_id": item_id,
        "path": relative_path,
        "source_pages": pages,
        "width": image.width,
        "height": image.height,
        "decodable": decodable,
        "boundary_white": boundary_white,
        "margin_white_fraction": {key: round(value, 4) for key, value in fractions.items()},
        "review_required": bool(diagnostics) or not decodable or not boundary_white,
        "diagnostics": diagnostics,
    }


def render_question_items(
    pdf_path: str | Path,
    page_inventory: Iterable[Mapping[str, object]],
    items: Iterable[Mapping[str, object]],
    output_root: str | Path,
    *,
    dpi: int = DEFAULT_DPI,
    padding: int = DEFAULT_PADDING,
) -> dict[str, list[dict[str, Any]]]:
    """Render each Academic L/R item to exactly one PNG and return updated copies."""
    pdf = Path(pdf_path)
    root = Path(output_root)
    if not pdf.is_file():
        raise FileNotFoundError(pdf)
    page_text = _page_index(page_inventory)
    records = [deepcopy(dict(item)) for item in items]
    if not records:
        return {"items": [], "visual_qa": []}
    for record in records:
        _validate_skill(record, kind="item")
    grouped: dict[tuple[int, int, str], list[dict[str, Any]]] = {}
    for record in records:
        key = (int(record.get("volume") or 0), int(record.get("test_number") or 0), str(record["skill"]).lower())
        grouped.setdefault(key, []).append(record)
    for values in grouped.values():
        values.sort(key=lambda row: (int(row.get("question_start") or 0), int(row.get("question_end") or 0), str(row.get("id") or "")))

    used_paths: set[str] = set()
    qa_rows: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="ielts-png-") as directory:
        locator = _PageLocator(pdf, dpi, Path(directory))
        try:
            for group in grouped.values():
                for index, record in enumerate(group):
                    source_pages = sorted({int(value) for value in record.get("source_pages") or [] if int(value) > 0})
                    if not source_pages:
                        raise ValueError(f"item {record.get('id')} has no source_pages")
                    start = int(record.get("question_start") or 0)
                    end = int(record.get("question_end") or start)
                    target = (start, end)
                    diagnostics: list[str] = []
                    markers_by_page = _target_markers(locator, source_pages, start, end)
                    inventory_start, inventory_exact = _find_anchor_page(
                        page_text, source_pages, target
                    )
                    inventory_next = _find_next_anchor_page(
                        page_text, source_pages, end
                    )
                    scope_page, scope_has_continuation = _next_scope_boundary(
                        page_text,
                        source_pages,
                        after_page=inventory_start,
                        skill=str(record["skill"]).lower(),
                        end_question=end,
                    )
                    next_has_continuation = bool(
                        inventory_next is not None
                        and _has_numbered_continuation(
                            page_text.get(inventory_next, ""), end
                        )
                    )
                    if inventory_start is not None:
                        markers_by_page = {
                            page: markers
                            for page, markers in markers_by_page.items()
                            if page >= inventory_start
                            and not (
                                inventory_next == inventory_start
                                and page != inventory_start
                            )
                            and not (
                                inventory_next is not None
                                and inventory_next > inventory_start
                                and (
                                    page > inventory_next
                                    or (
                                        page == inventory_next
                                        and not next_has_continuation
                                    )
                                )
                            )
                            and not (
                                scope_page is not None
                                and (
                                    page > scope_page
                                    or (
                                        page == scope_page
                                        and not scope_has_continuation
                                    )
                                )
                            )
                        }
                        if (
                            markers_by_page
                            and inventory_exact
                            and min(markers_by_page) != inventory_start
                        ):
                            markers_by_page = {}
                    if markers_by_page and not _markers_cover_group_end(markers_by_page, end):
                        markers_by_page = {}
                        diagnostics.append(
                            "final question marker not found; conservative page crop used"
                        )
                    marker_mode = bool(markers_by_page)
                    next_page: int | None = None
                    next_target: tuple[int, int] | None = None
                    if marker_mode:
                        start_page = min(markers_by_page)
                        last_page = max(markers_by_page)
                        selected_pages = [
                            page for page in source_pages if start_page <= page <= last_page
                        ]
                    else:
                        start_page, exact = _find_anchor_page(page_text, source_pages, target)
                        if start_page is None:
                            start_page = _best_text_page(
                                page_text, source_pages, str(record.get("question_text") or "")
                            )
                            diagnostics.append("question heading not found; conservative page crop used")
                        elif not exact:
                            diagnostics.append("question range only matched by starting number")
                        next_record = group[index + 1] if index + 1 < len(group) else None
                        next_page = _find_next_anchor_page(page_text, source_pages, end)
                        if next_page is None and next_record is not None:
                            next_start = int(next_record.get("question_start") or 0)
                            next_end = int(next_record.get("question_end") or next_start)
                            next_target = (next_start, next_end)
                            next_candidates = sorted({
                                int(value) for value in next_record.get("source_pages") or source_pages
                            })
                            next_page, _ = _find_anchor_page(page_text, next_candidates, next_target)
                            if next_page is None:
                                diagnostics.append(
                                    "next question heading not found; end boundary kept conservatively"
                                )
                        uses_scope_boundary = bool(
                            scope_page is not None
                            and (next_page is None or scope_page <= next_page)
                        )
                        if uses_scope_boundary:
                            next_page = scope_page
                            next_target = None
                        include_boundary_page = True
                        if uses_scope_boundary:
                            include_boundary_page = scope_has_continuation
                        elif (
                            next_page is not None
                            and next_page > start_page
                            and not _has_numbered_continuation(page_text.get(next_page, ""), end)
                        ):
                            include_boundary_page = False
                        if next_page is None:
                            last_page = source_pages[-1]
                        elif include_boundary_page:
                            last_page = next_page
                        else:
                            earlier = [page for page in source_pages if page < next_page]
                            last_page = earlier[-1] if earlier else start_page
                        if start_page is None:
                            start_page = source_pages[0]
                        selected_pages = [
                            page for page in source_pages if start_page <= page <= last_page
                        ]
                        if include_boundary_page and next_page is not None and next_page not in selected_pages:
                            selected_pages.append(next_page)
                            selected_pages.sort()
                    if not selected_pages:
                        selected_pages = [start_page]

                    crops: list[Image.Image] = []
                    for page_number in selected_pages:
                        image = locator.image(page_number)
                        top = 0
                        bottom = image.height
                        if page_number == start_page:
                            if marker_mode:
                                y, engine = _group_start_y(
                                    locator, page_number, target, markers_by_page[page_number]
                                )
                            else:
                                y, engine = locator.anchor_y(page_number, target)
                            if y is not None:
                                top = max(0, y - max(12, padding))
                            else:
                                diagnostics.append(f"page {page_number} start bbox unavailable")
                            if engine == "tesseract":
                                diagnostics.append(f"page {page_number} boundary located by OCR")
                        if marker_mode and page_number == last_page:
                            y, engine = _group_end_y(
                                locator, page_number, end, markers_by_page[page_number]
                            )
                            if y is not None:
                                bottom = min(image.height, y)
                            if engine == "tesseract":
                                diagnostics.append(f"page {page_number} end boundary located by OCR")
                        elif not marker_mode and next_page == page_number:
                            if next_target is None:
                                y, engine = locator.next_anchor_y(page_number, end)
                            else:
                                y, engine = locator.anchor_y(page_number, next_target)
                            if y is not None:
                                # ``y`` is the top of the next printed heading. The
                                # outer white padding supplies the safety margin,
                                # so retaining pixels below it would leak the next
                                # item (and can show a visibly clipped heading).
                                bottom = min(image.height, y)
                            else:
                                diagnostics.append(f"page {page_number} end bbox unavailable")
                            if engine == "tesseract":
                                diagnostics.append(f"page {page_number} end boundary located by OCR")
                        footer_after_y = max(0, top)
                        allow_initial_footer_gap = False
                        if marker_mode and page_number in markers_by_page:
                            footer_after_y = max(
                                marker[2] for marker in markers_by_page[page_number]
                            )
                            allow_initial_footer_gap = True
                        footer_y, footer_engine = _non_item_footer_y(
                            locator,
                            page_number,
                            footer_after_y,
                            allow_initial_gap=allow_initial_footer_gap,
                        )
                        if footer_y is not None:
                            bottom = min(bottom, footer_y)
                            if footer_engine == "tesseract":
                                diagnostics.append(
                                    f"page {page_number} footer boundary located by OCR"
                                )
                        if bottom <= top + 10:
                            top, bottom = 0, image.height
                            diagnostics.append(f"page {page_number} invalid bbox; full page retained")
                        crops.append(image.crop((0, top, image.width, bottom)))
                    combined = _stitch(crops, padding)
                    relative = _output_path(record, used_paths)
                    destination = root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    combined.save(destination, "PNG", optimize=True)
                    record["image_path"] = relative
                    record["image"] = relative
                    record["source_pages"] = selected_pages
                    qa = _qa_record(str(record.get("id") or ""), relative, combined, selected_pages, list(dict.fromkeys(diagnostics)))
                    qa_rows.append(qa)
                    record["visual_review_required"] = qa["review_required"]
        finally:
            locator.close()
    return {"items": records, "visual_qa": qa_rows}


def render_source_text_assets(
    pdf_path: str | Path,
    source_texts: Iterable[Mapping[str, object]],
    output_root: str | Path,
    *,
    dpi: int = DEFAULT_DPI,
    padding: int = DEFAULT_PADDING,
) -> list[dict[str, Any]]:
    """Render every linked audioscript/passage source page as a portable PNG asset."""
    pdf = Path(pdf_path)
    root = Path(output_root)
    sources = [deepcopy(dict(source)) for source in source_texts]
    for source in sources:
        _validate_skill(source, kind="source_text")
    with tempfile.TemporaryDirectory(prefix="ielts-source-png-") as directory:
        locator = _PageLocator(pdf, dpi, Path(directory))
        try:
            for source in sources:
                volume = int(source.get("volume") or 0)
                test = int(source.get("test_number") or 0)
                skill = str(source["skill"]).lower()
                source_id = re.sub(r"[^A-Za-z0-9._-]+", "-", str(source.get("id") or "source"))
                assets: list[dict[str, Any]] = []
                source_pages = [int(page) for page in source.get("source_pages") or []]
                if not source_pages:
                    page_start = int(source.get("page_start") or 0)
                    page_end = int(source.get("page_end") or page_start)
                    if page_start > 0 and page_end >= page_start:
                        source_pages = list(range(page_start, page_end + 1))
                source_pages = sorted({page for page in source_pages if page > 0})
                bounds = _source_text_bounds(
                    locator, source_pages, str(source.get("text") or "")
                )
                if bounds is not None:
                    first_page, first_top, last_page, last_bottom = bounds
                    source_pages = [
                        page for page in source_pages if first_page <= page <= last_page
                    ]
                for index, page_number in enumerate(source_pages, 1):
                    page_number = int(page_number)
                    relative = _portable_path(
                        f"images/source_texts/C{volume:02d}/T{test:02d}/{skill}/{source_id}-{index:02d}.png"
                    )
                    image = locator.image(page_number)
                    top = 0
                    bottom = image.height
                    if bounds is not None and page_number == first_page:
                        top = max(0, first_top - max(8, padding // 2))
                    if bounds is not None and page_number == last_page:
                        bottom = min(image.height, last_bottom + max(8, padding // 2))
                    if bottom <= top + 10:
                        top, bottom = 0, image.height
                    image = _with_padding(image.crop((0, top, image.width, bottom)), padding)
                    destination = root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    image.save(destination, "PNG", optimize=True)
                    assets.append({
                        "path": relative,
                        "source_page": page_number,
                        "width": image.width,
                        "height": image.height,
                        "decodable": True,
                        "boundary_white": True,
                        "review_required": False,
                    })
                source["assets"] = assets
                source["asset_paths"] = [asset["path"] for asset in assets]
        finally:
            locator.close()
    return sources


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--page-inventory", type=Path, required=True)
    parser.add_argument("--items", type=Path, required=True)
    parser.add_argument("--source-texts", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    parser.add_argument("--padding", type=int, default=DEFAULT_PADDING)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    inventory = _read_records(args.page_inventory)
    items = _read_records(args.items, "items")
    result = render_question_items(
        args.pdf, inventory, items, args.output, dpi=args.dpi, padding=args.padding
    )
    metadata = args.output / "metadata"
    all_items = _write_merged_records(metadata / "items_rendered.json", result["items"], "id")
    all_qa = _write_merged_records(metadata / "visual_qa.json", result["visual_qa"], "item_id")
    if args.source_texts:
        sources = _read_records(args.source_texts, "source_texts")
        sources = render_source_text_assets(
            args.pdf, sources, args.output, dpi=args.dpi, padding=args.padding
        )
        _write_merged_records(
            metadata / "source_texts_rendered.json",
            sources,
            "id",
        )
    print(json.dumps({
        "items": len(all_items),
        "review_required": sum(bool(row["review_required"]) for row in all_qa),
        "visual_qa": "metadata/visual_qa.json",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
