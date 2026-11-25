#!/usr/bin/env python3
"""从剑桥雅思 PDF 提取页面文本、OCR 诊断和可恢复的结构草稿。

本模块只负责 PDF/OCR 和页面边界，不决定题目标签，也不生成答案。所有写入
manifest 的路径都相对于工作题库目录；绝对路径仅用于运行时打开输入 PDF。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

try:
    import pdfplumber
except ImportError:  # pragma: no cover - explained by CLI error below
    pdfplumber = None


MIN_TEXT_CHARS = 40
DEFAULT_DPI = 230
_TEST_RE = re.compile(r"(?i)(?<![A-Za-z0-9])test\s*([1-8])\b")
_SECTION_RE = re.compile(r"(?i)\b(listening|reading|writing|speaking)\b")
_QUESTION_RANGE_RE = re.compile(
    r"(?i)questions?\s*([0-9Oo]\s*[0-9Oo]?)"
    r"(?:\s*(?:[-–—一+~^]|to|and|&)\s*([0-9Oo]\s*[0-9Oo]?))?"
)
_TASK_RE = re.compile(r"(?im)(?:^|\n)\s*task\s*([12])\b")
_PASSAGE_RE = re.compile(r"(?im)(?:^|\n)\s*passage\s*([1-3])\b")


def _section_heading(text: str) -> str | None:
    """Find a standalone section heading, ignoring running page headers."""
    for line in text.splitlines():
        line = line.strip()
        match = re.match(r"(?i)^(?:test\s*[1-8]\s+)?(listening|reading|writing|speaking)(?:\s+(?:section|part|task|passage)\b|\s*$)", line)
        if match:
            return match.group(1).title()
    if re.search(r"(?i)\b(?:section|part)\s*[1-4]\b", text) and re.search(r"(?i)\bquestions?\s*\d", text):
        return "Listening"
    if re.search(r"(?i)reading\s+passage", text):
        return "Reading"
    return None


def _which(command: str) -> str | None:
    return shutil.which(command)


def _clean_text(value: str) -> str:
    return re.sub(r"[ \t\r\f\v]+", " ", value.replace("\x00", "")).strip()


_OUT_OF_SCOPE_ITEM_HEADING_RE = re.compile(
    r"(?im)^\s*(?:[A-Z]\s+)?(?:"
    r"writing(?:\s+task\s*[12])?|speaking(?:\s+part\s*[1-3])?|"
    r"gnitirw|gnikaeps|"
    r"(?:reading\s+)?passage\s*[1-3]"
    r")\s*$"
)
_NEXT_LISTENING_UNIT_RE = re.compile(
    r"(?im)^\s*(?:section|part)\s*[1-4]\s+questions?\s*[0-9Oo]{1,2}\s*(?:[-–—]|to|and|&)\s*[0-9Oo]{1,2}\s*$"
)
_PROMO_RE = re.compile(
    r"(?i)laokaoya|一站解决雅思备考问题|资料下载|最新资讯|考试答案|应有尽有"
)
_PAGE_ARTIFACT_RE = re.compile(
    r"(?i)(?:\bp\.?\s*\d{1,3}\b|^\s*(?:test\s*[1-8]|reading|listening)\s*$)"
)


def _looks_like_promo_noise(line: str) -> bool:
    """Recognise short OCR fragments immediately surrounding a promo footer."""
    text = line.strip()
    if not text:
        return True
    if re.search(r"[\u4e00-\u9fff]", text):
        return True
    if re.match(r"(?i)^[A-D]\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)+\s*$", text):
        return False
    words = re.findall(r"[A-Za-z]+", text)
    letters = sum(len(word) for word in words)
    return len(text) <= 36 and len(words) <= 5 and letters <= 24


def clean_question_text(value: str) -> str:
    """Keep the item prompt while dropping later skills and promo footers.

    Some source scans append the next Writing page or a distributor footer to
    the final Listening/Reading group.  A standalone Passage heading is a
    boundary, while instructional prose such as ``Reading Passage 2 has nine
    paragraphs`` remains part of the question.
    """
    text = (value or "").replace("\r\n", "\n").replace("\r", "\n")
    boundaries = [
        match.start()
        for pattern in (_OUT_OF_SCOPE_ITEM_HEADING_RE, _NEXT_LISTENING_UNIT_RE)
        for match in pattern.finditer(text)
        if match.start() > 0
    ]
    if boundaries:
        text = text[: min(boundaries)]

    lines = text.splitlines()
    promo_indexes = [index for index, line in enumerate(lines) if _PROMO_RE.search(line)]
    remove: set[int] = set()
    for index in promo_indexes:
        remove.add(index)
        cursor = index - 1
        removed = 0
        while cursor >= 0 and removed < 8 and _looks_like_promo_noise(lines[cursor]):
            remove.add(cursor)
            cursor -= 1
            removed += 1
        cursor = index + 1
        removed = 0
        while cursor < len(lines) and removed < 3 and _looks_like_promo_noise(lines[cursor]):
            remove.add(cursor)
            cursor += 1
            removed += 1
    kept = [
        line.rstrip()
        for index, line in enumerate(lines)
        if index not in remove and not _PAGE_ARTIFACT_RE.search(line)
    ]
    # The next Listening section often begins after the last question on the
    # same PDF page.  It is a boundary marker, not part of the current prompt.
    while kept and (
        not kept[-1].strip()
        or re.fullmatch(r"\s*\d{1,3}\s*", kept[-1])
        or re.fullmatch(r"\s*(?:SECTION|PART)\s*[1-4]\s*", kept[-1], re.I)
    ):
        kept.pop()
    cleaned = "\n".join(kept)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _text_chars(value: str) -> int:
    return len(re.sub(r"\s+", "", value or ""))


def _question_number(value: str | None) -> int | None:
    if not value:
        return None
    normalized = re.sub(r"\s+", "", value).replace("O", "0").replace("o", "0")
    return int(normalized) if normalized.isdigit() else None


def _normalise_question_heading_ocr(value: str) -> str:
    value = re.sub(r"(?i)\bQ[iIl1|]?\s*ns(?=\s*\d)", "Questions", value)

    def repair_garbled_start(match: re.Match[str]) -> str:
        glyph = re.sub(r"[^A-Za-z\u4e00-\u9fff]", "", match.group(3)).lower()
        second_digit = {
            "cj": "0",
            "o": "0",
            "q": "0",
            "i": "1",
            "l": "1",
            "丁": "1",
            "仁": "1",
            "fr": "6",
        }.get(glyph)
        if second_digit is None:
            return match.group(0)
        start = f"{match.group(2)}{second_digit}"
        return f"{match.group(1)}{start}-{match.group(4)}"

    value = re.sub(
        r"(?im)(\bquestions?\s+)([0-9Oo])([A-Za-z\u4e00-\u9fff.]{1,5})"
        r"\s*[-–—－一+~^]*\s*([0-9Oo]{1,2})(?=\s|[.,;:]|$)",
        repair_garbled_start,
        value,
    )
    # Some old text layers lose the dash entirely: ``Questions 11 20``.
    # Replacing the separator one-for-one preserves match offsets used below.
    return re.sub(
        r"(?im)(\bquestions?\s*)([0-9Oo]{1,2})\s+([0-9Oo]{1,2})(?=\s|$)",
        lambda match: f"{match.group(1)}{match.group(2)}-{match.group(3)}",
        value,
    )


def _is_lowercase_prose_match(text: str, match: Any) -> bool:
    """Reject ``questions\n14``-style prose followed by a numbered list."""
    raw = match.group(0)
    if not raw or not raw[0].islower():
        return False
    line_start = text.rfind("\n", 0, match.start()) + 1
    return any(character.isalpha() for character in text[line_start:match.start()])


def _select_question_groups(parsed_ranges: list[tuple[Any, int, int]]) -> list[tuple[Any, int, int]]:
    """Prefer precise instruction groups while retaining uncovered container ranges.

    Printed papers often show a broad heading such as ``Questions 1-10`` and
    narrower instructions such as ``Questions 1-4`` and ``Questions 7-10``.
    OCR can lose one narrow heading, so dropping the broad heading wholesale
    would silently lose questions 5-6. This selector subtracts already covered
    narrow ranges from each broader range and keeps only the real gap.
    """
    unique: dict[tuple[int, int], tuple[Any, int, int]] = {}
    for entry in parsed_ranges:
        unique.setdefault((entry[1], entry[2]), entry)
    covered: set[int] = set()
    selected: list[tuple[Any, int, int]] = []
    for match, start, end in sorted(unique.values(), key=lambda value: (value[2] - value[1], value[0].start())):
        uncovered = [number for number in range(start, end + 1) if number not in covered]
        if not uncovered:
            continue
        segment_start = previous = uncovered[0]
        for number in uncovered[1:] + [None]:
            if number is not None and number == previous + 1:
                previous = number
                continue
            selected.append((match, segment_start, previous))
            covered.update(range(segment_start, previous + 1))
            if number is not None:
                segment_start = previous = number
    return sorted(selected, key=lambda value: (value[1], value[2], value[0].start()))


def _looks_garbled_text(value: str) -> bool:
    compact = re.sub(r"\s+", "", value or "")
    if not compact:
        return True
    ascii_letters = sum(char.isascii() and char.isalpha() for char in compact)
    if len(compact) > 80 and ascii_letters / len(compact) < 0.28:
        return True
    # Reversed text and repeated watermark layers seen in scanned books.
    if compact.count("试") >= 3 and compact.count("考") >= 3:
        return True
    return bool(re.search(r"stnetnoC|noitcudortnI|gninetsiL|gnidaeR", compact, re.I))


def page_requires_ocr(page: dict[str, Any], min_text_chars: int = MIN_TEXT_CHARS) -> bool:
    """Return whether a page has too little searchable text for reliable parsing."""
    count = page.get("text_chars")
    if count is None:
        count = _text_chars(str(page.get("text", "")))
    text = str(page.get("text", ""))
    return int(count or 0) < min_text_chars or _looks_garbled_text(text)


def _fallback_text(path: Path, page_number: int) -> str:
    """Use pypdf or pdftotext when pdfplumber cannot read a damaged page."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        return reader.pages[page_number - 1].extract_text() or ""
    except Exception:
        executable = shutil.which("pdftotext")
        if executable:
            result = subprocess.run(
                [executable, "-f", str(page_number), "-l", str(page_number), str(path), "-"],
                capture_output=True,
                text=True,
                check=False,
            )
            return result.stdout or ""
    return ""


def _fallback_all_pages(path: Path) -> list[str]:
    """Extract page-separated text with the Poppler CLI when Python PDF libs are absent."""
    executable = shutil.which("pdftotext")
    if not executable:
        return []
    result = subprocess.run([executable, str(path), "-"], capture_output=True, text=True, check=False)
    if result.returncode and not result.stdout:
        return []
    return [page for page in result.stdout.split("\f") if page.strip() or page == result.stdout.split("\f")[0]]


def _render_page(pdf: Path, page_number: int, destination: Path, dpi: int) -> tuple[Path | None, str | None]:
    executable = shutil.which("pdftoppm")
    if not executable:
        return None, "pdftoppm is not installed"
    destination.parent.mkdir(parents=True, exist_ok=True)
    prefix = destination.with_suffix("")
    result = subprocess.run(
        [executable, "-f", str(page_number), "-l", str(page_number), "-png", "-r", str(dpi), "-singlefile", str(pdf), str(prefix)],
        capture_output=True,
        text=True,
        check=False,
    )
    rendered = prefix.with_suffix(".png")
    if result.returncode or not rendered.exists():
        return None, (result.stderr or "pdftoppm failed").strip()
    return rendered, None


def _run_tesseract(image: Path) -> tuple[str, str | None]:
    executable = _which("tesseract")
    if not executable:
        return "", "tesseract is not installed"
    result = subprocess.run(
        [executable, str(image), "stdout", "--psm", "6", "-l", "eng"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        return result.stdout or "", (result.stderr or "tesseract failed").strip()
    return result.stdout or "", None


def _run_vision(image: Path, script: Path) -> tuple[str, str | None]:
    swift = _which("swift")
    if not swift or not script.exists():
        return "", "macOS Vision OCR fallback is unavailable"
    result = subprocess.run([swift, str(script), str(image)], capture_output=True, text=True, check=False)
    if result.returncode:
        return result.stdout or "", (result.stderr or "Vision OCR failed").strip()
    return result.stdout or "", None


def _ocr_page(pdf: Path, page_number: int, output_dir: Path, engine: str, dpi: int) -> dict[str, Any]:
    diagnostics: list[str] = []
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", pdf.stem).strip("-") or "source"
    image_relative = Path("images/ocr") / stem / f"page-{page_number:04d}.png"
    image, render_error = _render_page(pdf, page_number, output_dir / image_relative, dpi)
    if render_error:
        return {"text": "", "status": "failed", "engine": None, "image_path": None, "diagnostics": [render_error]}

    requested = engine.lower()
    if requested in {"auto", "tesseract"}:
        text, error = _run_tesseract(image)  # type: ignore[arg-type]
        if not error and _text_chars(text) > 0:
            return {"text": text, "status": "success", "engine": "tesseract", "image_path": image_relative.as_posix(), "diagnostics": []}
        if error:
            diagnostics.append(error)
        if requested == "tesseract":
            return {"text": text, "status": "failed", "engine": "tesseract", "image_path": image_relative.as_posix(), "diagnostics": diagnostics}

    script = Path(__file__).with_name("ielts_vision_ocr.swift")
    text, error = _run_vision(image, script)  # type: ignore[arg-type]
    if not error and _text_chars(text) > 0:
        return {"text": text, "status": "success", "engine": "vision", "image_path": image_relative.as_posix(), "diagnostics": diagnostics}
    if error:
        diagnostics.append(error)
    return {"text": text, "status": "failed", "engine": None, "image_path": image_relative.as_posix(), "diagnostics": diagnostics}


def extract_page_text(
    pdf: Path,
    output_dir: Path,
    ocr: str = "auto",
    *,
    dpi: int = DEFAULT_DPI,
    min_text_chars: int = MIN_TEXT_CHARS,
) -> list[dict[str, Any]]:
    """Extract one record per PDF page, optionally OCR-ing low-text pages.

    ``ocr`` accepts ``auto`` (OCR only below the threshold), ``tesseract``,
    ``vision`` or ``off``. A failed OCR attempt is retained in ``diagnostics``;
    it never silently replaces the original text with an invented value.
    """
    pdf = Path(pdf)
    output_dir = Path(output_dir)
    records: list[dict[str, Any]] = []
    if pdfplumber is None:
        fallback_pages = _fallback_all_pages(pdf)
        if not fallback_pages:
            raise RuntimeError("cannot extract PDF text: install pdfplumber or Poppler pdftotext")
        page_iter: Iterable[tuple[int, Any]] = enumerate(fallback_pages, 1)
        document = None
    else:
        try:
            document = pdfplumber.open(str(pdf))
        except Exception as exc:
            raise RuntimeError(f"cannot open PDF: {pdf.name}: {exc}") from exc
        page_iter = enumerate(document.pages, 1)
    try:
        for page_number, page in page_iter:
            diagnostics: list[str] = []
            if isinstance(page, str):
                text = page
            else:
                try:
                    text = page.extract_text() or ""
                except Exception as exc:  # damaged text object; try another reader
                    text = _fallback_text(pdf, page_number)
                    diagnostics.append(f"pdfplumber extraction failed: {exc}")
            text = text or _fallback_text(pdf, page_number) if not text else text
            text_chars = _text_chars(text)
            source_text_chars = text_chars
            source_text_garbled = _looks_garbled_text(text)
            ocr_required = page_requires_ocr({"text": text, "text_chars": source_text_chars}, min_text_chars)
            ocr_status = "not_needed"
            ocr_engine: str | None = None
            ocr_image: str | None = None
            if ocr_required and ocr.lower() != "off":
                result = _ocr_page(pdf, page_number, output_dir, ocr, dpi)
                ocr_status = result["status"]
                ocr_engine = result["engine"]
                ocr_image = result["image_path"]
                diagnostics.extend(result["diagnostics"])
                if result["status"] == "success" and (source_text_garbled or _text_chars(result["text"]) > text_chars):
                    text = result["text"]
                    text_chars = _text_chars(text)
            elif ocr_required:
                ocr_status = "skipped"
                diagnostics.append("text layer below OCR threshold; OCR disabled")
            records.append(
                {
                    "page": page_number,
                    "source_file": pdf.name,
                    "text": text,
                    "text_chars": text_chars,
                    "source_text_chars": source_text_chars,
                    "text_layer_available": source_text_chars >= min_text_chars,
                    "ocr_required": ocr_required,
                    "ocr_status": ocr_status,
                    "ocr_engine": ocr_engine,
                    "ocr_image": ocr_image,
                    # External tools occasionally echo the input filename;
                    # redact it before diagnostics become portable metadata.
                    "diagnostics": [str(message).replace(str(pdf), pdf.name).replace(str(pdf.resolve()), pdf.name) for message in diagnostics],
                }
            )
    finally:
        if document is not None:
            document.close()
    output_dir.joinpath("metadata").mkdir(parents=True, exist_ok=True)
    output_dir.joinpath("metadata/page_inventory.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    diagnostics = {
        "source_file": pdf.name,
        "page_count": len(records),
        "ocr_required_pages": [record["page"] for record in records if record["ocr_required"]],
        "ocr_success_pages": [record["page"] for record in records if record["ocr_status"] == "success"],
        "ocr_failed_pages": [record["page"] for record in records if record["ocr_status"] == "failed"],
        "diagnostics": [{"page": record["page"], "messages": record["diagnostics"]} for record in records if record["diagnostics"]],
    }
    output_dir.joinpath("metadata/extraction_diagnostics.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return records


def _page_text(page: dict[str, Any]) -> str:
    return str(page.get("text") or "")


def _marker_pages(page_texts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    markers: list[dict[str, Any]] = []
    for page in sorted(page_texts, key=lambda value: int(value.get("page", 0))):
        text = _page_text(page)
        match = _TEST_RE.search(text)
        # Contents/Introduction pages mention Test 1-4 too. A real test
        # marker carries an actual skill/question cue.
        contents_like = bool(
            re.search(r"(?i)introduction\s*\d", text)
            and re.search(r"(?i)(?:audio\s*scripts?|sample\s+writing|acknowledg|answer\s+keys?)", text)
        )
        if match and not re.search(r"(?i)contents", text[:2500]) and not contents_like:
            # Do not trust a section word on the same page: contents pages and
            # running headers often contain all four skills. Headings below
            # determine section starts from the page body.
            markers.append({"number": int(match.group(1)), "page": int(page["page"]), "section": None})
    # Test number is repeated in running headers and answer-key tables. Keep
    # only the earliest marker for each number, then use section headings below.
    unique_by_number: dict[int, dict[str, Any]] = {}
    for marker in markers:
        unique_by_number.setdefault(marker["number"], marker)
    return sorted(unique_by_number.values(), key=lambda value: value["page"])


def _ranges(first: int, last: int) -> list[tuple[int, int, int]]:
    return [(first, last, 0)]


def discover_book_structure(page_texts: list[dict[str, Any]], *, volume: int | None = None, source_file: str | None = None) -> dict[str, Any]:
    """Discover coarse Test/skill/reference page ranges from extracted pages."""
    pages = sorted(page_texts, key=lambda value: int(value.get("page", 0)))
    page_numbers = [int(page.get("page", 0)) for page in pages]
    markers = _marker_pages(pages)
    allowed_tests = set(range(5, 9)) if volume == 12 else set(range(1, 5))
    markers = [marker for marker in markers if int(marker["number"]) in allowed_tests]
    diagnostics: list[str] = []
    if not markers:
        diagnostics.append("no Test N marker found; manual boundary review required")
        markers = [{"number": 1, "page": page_numbers[0] if page_numbers else 1, "section": None}]
    for index in range(len(markers)):
        marker_page = int(markers[index]["page"])
        previous_page = int(markers[index - 1]["page"]) if index else marker_page - 4
        candidates = [
            int(page["page"])
            for page in pages
            if max(previous_page + 1, marker_page - 3) <= int(page.get("page", 0)) < marker_page
            and re.search(r"(?i)\b(?:section|part)\s*1\b", _page_text(page))
            and re.search(r"(?i)\bquestions?\s*1\s*[-–—]\s*10\b", _page_text(page))
        ]
        if candidates:
            markers[index]["page"] = min(candidates)
    reference_starts = [
        int(page.get("page", 0))
        for page in pages
        if re.search(
            r"(?im)^\s*(?:audioscripts?|tapescripts?|listening\s+and\s+reading\s+answer\s+keys?|sample\s+writing\s+answers?|model\s+and\s+sample\s+answers?)",
            _page_text(page),
        ) and not re.search(r"(?im)^\s*contents\b", _page_text(page))
    ]
    first_marker_page = markers[0]["page"] if markers else 0
    gt_starts = [
        int(page.get("page", 0))
        for page in pages
        if int(page.get("page", 0)) > first_marker_page + 20
        and re.search(r"(?i)general\s+training\s*:?\s*reading\s+and\s+writing", _page_text(page))
    ]
    reference_starts.extend(gt_starts)
    last_test_page = max(int(marker["page"]) for marker in markers) if markers else 0
    # Intro/contents pages may mention Answer Keys before the first Test. Only
    # references after the last discovered Test can terminate the academic set.
    post_test_references = [page for page in reference_starts if page > last_test_page]
    academic_end = min(post_test_references) - 1 if post_test_references else (page_numbers[-1] if page_numbers else 1)
    tests: list[dict[str, Any]] = []
    for index, marker in enumerate(markers):
        if any(test["number"] == marker["number"] for test in tests) and marker["section"] is None:
            continue
        next_page = markers[index + 1]["page"] - 1 if index + 1 < len(markers) else academic_end
        test = next((test for test in tests if test["number"] == marker["number"]), None)
        if test is None:
            test = {"number": marker["number"], "page_start": marker["page"], "page_end": next_page, "sections": []}
            tests.append(test)
        else:
            test["page_end"] = max(int(test["page_end"]), next_page)
        # A marker with a section starts that section; otherwise inspect every
        # page in the Test range below to find section headings.
        if marker["section"] and not any(section["name"] == marker["section"] and section["page_start"] == marker["page"] for section in test["sections"]):
            test["sections"].append({"name": marker["section"], "page_start": marker["page"], "page_end": next_page, "pages": list(range(marker["page"], next_page + 1))})
    # Add section headings that are not on the same page as Test N.
    for test in tests:
        in_test = [page for page in pages if test["page_start"] <= int(page.get("page", 0)) <= test["page_end"]]
        headings: list[tuple[str, int]] = []
        for page in in_test:
            name = _section_heading(_page_text(page))
            if name and (not headings or headings[-1][0] != name):
                headings.append((name, int(page["page"])))
        if not headings and not test["sections"]:
            diagnostics.append(f"Test {test['number']} has no skill heading")
            continue
        boundaries = headings or [(section["name"], int(section["page_start"])) for section in test["sections"]]
        sections: list[dict[str, Any]] = []
        seen_starts: set[tuple[str, int]] = set()
        for pos, (name, start) in enumerate(boundaries):
            key = (name, start)
            if key in seen_starts:
                continue
            seen_starts.add(key)
            end = boundaries[pos + 1][1] - 1 if pos + 1 < len(boundaries) else int(test["page_end"])
            sections.append({"name": name, "page_start": start, "page_end": end, "pages": list(range(start, end + 1))})
        test["sections"] = sections
    tests.sort(key=lambda value: value["number"])
    references: dict[str, list[dict[str, Any]]] = {"audioscripts": [], "answer_keys": [], "writing_samples": []}
    for page in pages:
        text = _page_text(page)
        page_number = int(page["page"])
        if re.search(r"(?i)\b(?:audio\s*scripts?|tapescripts?)\b", text) and not re.search(r"(?im)^\s*contents\b", text):
            references["audioscripts"].append({"page_start": page_number, "page_end": page_number, "pages": [page_number]})
        if re.search(r"(?i)\banswer\s+keys?\b", text) and not re.search(r"(?im)^\s*contents\b", text):
            references["answer_keys"].append({"page_start": page_number, "page_end": page_number, "pages": [page_number]})
        if re.search(r"(?i)\b(?:sample|model)\s+(?:writing\s+)?answers?\b", text) and not re.search(r"(?im)^\s*contents\b", text):
            references["writing_samples"].append({"page_start": page_number, "page_end": page_number, "pages": [page_number]})
    for values in references.values():
        _merge_ranges(values)
    return {"schema_version": "1.0", "volume": volume, "source_file": source_file or (pages[0].get("source_file") if pages else None), "page_count": len(pages), "tests": tests, "references": references, "diagnostics": diagnostics}


def _merge_ranges(values: list[dict[str, Any]]) -> None:
    if not values:
        return
    values.sort(key=lambda value: int(value["page_start"]))
    merged: list[dict[str, Any]] = [values[0]]
    for current in values[1:]:
        previous = merged[-1]
        if int(current["page_start"]) <= int(previous["page_end"]) + 1:
            previous["page_end"] = max(int(previous["page_end"]), int(current["page_end"]))
            previous["pages"] = list(range(int(previous["page_start"]), int(previous["page_end"]) + 1))
        else:
            merged.append(current)
    values[:] = merged


def _volume_from_source(source_file: str) -> int:
    match = re.search(r"IELTS-(\d{2})", source_file, re.I)
    if not match:
        match = re.search(r"(?:剑|IELTS)[^0-9]*(\d{1,2})", source_file, re.I)
    return int(match.group(1)) if match else 0


def _text_for_pages(page_texts: list[dict[str, Any]], start: int, end: int) -> str:
    return "\n\n".join(_page_text(page) for page in page_texts if start <= int(page.get("page", 0)) <= end).strip()


def build_items(structure: dict[str, Any], page_texts: list[dict[str, Any]], *, source_file: str | None = None) -> list[dict[str, Any]]:
    """Create unclassified item drafts from coarse page ranges.

    The draft intentionally keeps text and page references; Task 4/6 may split
    ambiguous question groups further and assign primary/multi tags later.
    """
    source_file = source_file or structure.get("source_file") or "source.pdf"
    volume = int(structure.get("volume") or _volume_from_source(source_file))
    if not volume:
        raise ValueError("volume is required when source_file has no IELTS volume")
    items: list[dict[str, Any]] = []
    for test in structure.get("tests", []):
        number = int(test["number"])
        for section_index, section in enumerate(test.get("sections", []), 1):
            skill = str(section["name"]).title()
            if skill not in {"Listening", "Reading"}:
                continue
            text = _text_for_pages(page_texts, int(section["page_start"]), int(section["page_end"]))
            if skill in {"Listening", "Reading"}:
                text = _normalise_question_heading_ocr(text)
                parsed_ranges: list[tuple[Any, int, int]] = []
                for candidate in _QUESTION_RANGE_RE.finditer(text):
                    if _is_lowercase_prose_match(text, candidate):
                        continue
                    start_value = _question_number(candidate.group(1))
                    end_value = _question_number(candidate.group(2)) or start_value
                    if start_value is not None and end_value is not None and 1 <= start_value <= end_value <= 40:
                        parsed_ranges.append((candidate, start_value, end_value))
                matches = _select_question_groups(parsed_ranges)
                if not matches:
                    continue
                unit_prefix = "S" if skill == "Listening" else "P"
                source_id = f"IELTS-C{volume:02d}-T{number:02d}-{'L' if skill == 'Listening' else 'R'}-SOURCE"
                for group_index, match_entry in enumerate(matches, 1):
                    match, start, end = match_entry
                    if skill == "Reading" and start:
                        unit_no = 1 if start <= 13 else (2 if start <= 26 else 3)
                    else:
                        unit_no = ((start - 1) // 10 + 1 if skill == "Listening" and start else section_index)
                    code = "L" if skill == "Listening" else "R"
                    range_code = f"Q{start:02d}-{end:02d}" if start else "Q00-00"
                    group_text = text[match.start():] if match else text
                    if match:
                        later_matches = [
                            entry[0]
                            for entry in matches
                            if entry[0].start() > match.start()
                        ]
                        following = min(later_matches, key=lambda value: value.start()) if later_matches else None
                        if following:
                            group_text = text[match.start():following.start()]
                    items.append({"id": f"IELTS-C{volume:02d}-T{number:02d}-{code}-{unit_prefix}{unit_no:02d}-{range_code}", "volume": volume, "test_number": number, "skill": skill.lower(), "section_number": unit_no, "question_start": start or None, "question_end": end or None, "question_text": clean_question_text(group_text), "source_text_id": source_id, "source_file": Path(source_file).name, "source_pages": list(range(int(section["page_start"]), int(section["page_end"]) + 1)), "primary_tag": None, "tags": [], "review_required": not bool(start), "diagnostics": [] if start else ["question range not detected"]})
    return items


def build_source_texts(structure: dict[str, Any], page_texts: list[dict[str, Any]], *, source_file: str | None = None) -> list[dict[str, Any]]:
    source_file = source_file or structure.get("source_file") or "source.pdf"
    volume = int(structure.get("volume") or _volume_from_source(source_file))
    output: list[dict[str, Any]] = []
    for test in structure.get("tests", []):
        for section in test.get("sections", []):
            if section["name"] not in {"Listening", "Reading"}:
                continue
            skill_code = "L" if section["name"] == "Listening" else "R"
            source_id = f"IELTS-C{volume:02d}-T{int(test['number']):02d}-{skill_code}-SOURCE"
            output.append({"id": source_id, "volume": volume, "test_number": int(test["number"]), "skill": section["name"].lower(), "text": _text_for_pages(page_texts, int(section["page_start"]), int(section["page_end"])), "source_file": Path(source_file).name, "source_pages": list(range(int(section["page_start"]), int(section["page_end"]) + 1)), "review_required": True, "diagnostics": ["coarse source boundary; split passages/audioscript sections during Task 4"]})
    return output


def build_reference_assets(structure: dict[str, Any], *, source_file: str | None = None) -> list[dict[str, Any]]:
    source_file = source_file or structure.get("source_file") or "source.pdf"
    volume = int(structure.get("volume") or _volume_from_source(source_file))
    assets: list[dict[str, Any]] = []
    for kind, ranges in structure.get("references", {}).items():
        for index, value in enumerate(ranges, 1):
            assets.append({"id": f"IELTS-C{volume:02d}-{kind.upper()}-{index:02d}", "kind": kind, "volume": volume, "source_file": Path(source_file).name, "source_pages": list(value["pages"]), "relative_path": f"images/references/C{volume:02d}/{kind}/{index:02d}.png", "review_required": True})
    return assets


def _run_cli(args: argparse.Namespace) -> dict[str, Any]:
    source = Path(args.source)
    output = Path(args.output)
    pages = extract_page_text(source, output, ocr=args.ocr, dpi=args.dpi)
    volume_match = re.search(r"IELTS-(\d{2})", source.name)
    volume = int(volume_match.group(1)) if volume_match else None
    structure = discover_book_structure(pages, volume=volume, source_file=source.name)
    manifest = {"schema_version": "1.0", "source_file": source.name, "structure": structure, "items": build_items(structure, pages, source_file=source.name), "source_texts": build_source_texts(structure, pages, source_file=source.name), "source_assets": build_reference_assets(structure, source_file=source.name)}
    output.joinpath("metadata").mkdir(parents=True, exist_ok=True)
    output.joinpath("metadata/question_bank_draft.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="统一命名后的雅思 PDF")
    parser.add_argument("--output", type=Path, required=True, help="工作题库输出目录")
    parser.add_argument("--ocr", choices=("auto", "off", "tesseract", "vision"), default="auto", help="OCR 策略")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI, help="OCR 渲染分辨率")
    args = parser.parse_args()
    manifest = _run_cli(args)
    print(json.dumps({"source_file": manifest["source_file"], "pages": manifest["structure"]["page_count"], "items": len(manifest["items"]), "source_texts": len(manifest["source_texts"])}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
