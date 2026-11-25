#!/usr/bin/env python3
"""构建、整理并校验 Cambridge 9709 数学大题图片工作库。"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any

try:
    import pdfplumber
    from PIL import Image
    import numpy as np
except ImportError as exc:
    raise SystemExit("Run this script with the bundled Codex Python runtime (pdfplumber and Pillow required).") from exc

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "Data/真题/Mathematics (9709)_20260422_13434"
DEFAULT_OUTPUT = ROOT / "output/math_question_bank"
DEFAULT_CLASSIFICATIONS = [ROOT / "work/classification_p1.jsonl", ROOT / "work/classification_other.jsonl"]
DEFAULT_OVERRIDES = [ROOT / "work/classification_p1_overrides.jsonl", ROOT / "work/classification_overrides_other.jsonl", ROOT / "work/classification_p15_overrides.jsonl"]
# Verified manually against rendered source pages. These five papers contain a
# centred page number which was incorrectly read as the next question number,
# leaving an empty automatic range.
MANUAL_CROP_PAGES = {
    "9709-52-2021-FM-Q04": 5,
    "9709-61-2021-MJ-Q03": 4,
    "9709-12-2023-ON-Q01": 2,
    "9709-12-2024-MJ-Q01": 3,
    "9709-31-2024-ON-Q01": 3,
}
PDF_DPI = 220
POINTS_PER_INCH = 72
QUESTION_RE = re.compile(r"\b(?:Question\s+paper|question\s+paper)\s+(\d{2})\b", re.I)
SCHEME_RE = re.compile(r"\b(?:Mark\s+Scheme|mark\s+scheme)\s+(\d{2})\b", re.I)
YEAR_RE = re.compile(r"\b(20\d{2})\b")
TERMINAL_PAGE_RE = re.compile(r"\b(?:additional\s+page|blank\s+page)\b", re.I)


def session_from_path(path: Path) -> str:
    name = path.parent.name.lower() + " " + path.name.lower()
    if "march" in name:
        return "FM"
    if "may" in name or "june" in name:
        return "MJ"
    if "nov" in name or "oct" in name:
        return "ON"
    return "UNKNOWN"


def parse_pdf(path: Path) -> dict[str, Any] | None:
    lower = path.name.lower()
    kind = "qp" if "question paper" in lower else "ms" if "mark scheme" in lower else None
    if not kind:
        return None
    m = (QUESTION_RE if kind == "qp" else SCHEME_RE).search(path.name)
    year = YEAR_RE.search(path.name)
    if not m or not year:
        return None
    return {"path": str(path.resolve()), "kind": kind, "paper": m.group(1), "year": int(year.group(1)), "session": session_from_path(path)}


def inventory(source: Path) -> tuple[list[dict[str, Any]], dict[tuple[int, str, str], dict[str, str]]]:
    records = [r for p in source.rglob("*.pdf") if (r := parse_pdf(p))]
    records.sort(key=lambda r: (r["year"], r["session"], r["paper"], r["kind"]))
    pairs: dict[tuple[int, str, str], dict[str, str]] = defaultdict(dict)
    for r in records:
        pairs[(r["year"], r["session"], r["paper"])][r["kind"]] = r["path"]
    return records, pairs


def words_for_pdf(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    pages, words = [], []
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages, 1):
            pages.append({"page": index, "width": page.width, "height": page.height})
            for item in page.extract_words(keep_blank_chars=False, use_text_flow=True, extra_attrs=["fontname", "size"]):
                words.append({"page": index, **{k: item.get(k) for k in ("text", "x0", "top", "x1", "bottom", "fontname", "size")}})
    return pages, words


def question_starts(words: list[dict[str, Any]], pages: list[dict[str, Any]], max_x: float = 65) -> list[dict[str, Any]]:
    """Find left-margin large question numbers, rejecting headers/page numbers.

    Cambridge 9709 QPs consistently put the large question number near the
    left content margin.  A strict x-coordinate and a top/bottom guard makes
    this far safer than a plain text search.  Any uncertain document is marked
    for review rather than silently cropped incorrectly.
    """
    page_heights = {p["page"]: p["height"] for p in pages}
    candidates: list[dict[str, Any]] = []
    for word in words:
        text = str(word["text"]).strip().rstrip(".")
        if not text.isascii() or not text.isdigit() or not 1 <= int(text) <= 30:
            continue
        height = page_heights[word["page"]]
        # Main question numbers appear at x~50; page numbers are centred at
        # x~295.  Some papers place Q1 just below a 60-point header, so retain
        # that line while excluding the physical page header/footer regions.
        # True large-question numbers in the 9709 question papers occupy the
        # x~50 margin.  Digits at x>=70 are body text (coefficients, list
        # values, graph labels) and previously created false question starts.
        if word["x0"] > max_x or word["top"] < 48 or word["top"] > height - 70:
            continue
        candidates.append({"number": int(text), "page": word["page"], "top": round(float(word["top"]), 2), "x0": round(float(word["x0"]), 2)})
    # A cover page can contain an unrelated left-margin ``1`` (for example an
    # instruction-list bullet). Start a candidate sequence at *every* 1 and
    # retain the longest monotonic 1,2,... chain, rather than trusting the
    # earliest one. This also discards duplicate text-layer hits.
    ordered = sorted(candidates, key=lambda x: (x["page"], x["top"], x["x0"]))
    best: list[dict[str, Any]] = []
    best_margin_distance = float("inf")
    for first_index, first in enumerate(ordered):
        if first["number"] != 1:
            continue
        chain = [first]
        expected = 2
        for item in ordered[first_index + 1:]:
            if item["number"] == expected:
                chain.append(item)
                expected += 1
        margin_distance = sum(abs(item["x0"] - 50) for item in chain)
        if len(chain) > len(best) or (len(chain) == len(best) and margin_distance < best_margin_distance):
            best = chain
            best_margin_distance = margin_distance
    return best


def last_question_page(words: list[dict[str, Any]], pages: list[dict[str, Any]], start_page: int) -> int:
    """Stop the last question before clearly labelled non-question pages."""
    page_text: dict[int, list[str]] = defaultdict(list)
    for word in words:
        page_text[int(word["page"])].append(str(word["text"]))
    markers = ("additional page", "blank page")
    for page in pages:
        page_no = int(page["page"])
        if page_no <= start_page:
            continue
        text = " ".join(page_text[page_no]).lower()
        if any(marker in text for marker in markers):
            return page_no - 1
    return int(pages[-1]["page"])


def trim_terminal_crop_plan(
    crop_plan: list[dict[str, Any]],
    page_texts: dict[int, str],
) -> tuple[list[dict[str, Any]], int]:
    """从既有裁剪计划尾部移除 Additional Page 和 BLANK PAGE。"""
    retained: list[dict[str, Any]] = []
    for part in crop_plan:
        page_no = int(part["source_page"])
        if TERMINAL_PAGE_RE.search(page_texts.get(page_no, "")):
            break
        retained.append(part)
    if not retained:
        raise ValueError("裁剪计划的第一页就是 Additional Page 或 BLANK PAGE")
    return retained, len(crop_plan) - len(retained)


@lru_cache(maxsize=None)
def pdf_page_texts(pdf_path: str) -> dict[int, str]:
    """按页缓存 PDF 文本，供旧清单的尾页边界修复使用。"""
    with pdfplumber.open(pdf_path) as pdf:
        return {
            index: page.extract_text(x_tolerance=2, y_tolerance=2) or ""
            for index, page in enumerate(pdf.pages, 1)
        }


def build_question_plans(qp: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    pages, words = words_for_pdf(Path(qp["path"]))
    starts = question_starts(words, pages)
    page_map = {p["page"]: p for p in pages}
    plans = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else None
        parts = []
        final_page = end["page"] if end else last_question_page(words, pages, start["page"])
        for page_no in range(start["page"], final_page + 1):
            height = page_map[page_no]["height"]
            y0 = start["top"] - 12 if page_no == start["page"] else 35
            y1 = (end["top"] - 12 if end and page_no == end["page"] else height - 35)
            if y1 - y0 >= 18:
                parts.append({"source_page": page_no, "bbox_points": [20, round(max(0, y0), 2), round(page_map[page_no]["width"] - 20, 2), round(min(height, y1), 2)]})
        ident = f"9709-{qp['paper']}-{qp['year']}-{qp['session']}-Q{start['number']:02d}"
        plans.append({"id": ident, "year": qp["year"], "session": qp["session"], "paper": qp["paper"], "question_number": start["number"], "tags": [], "primary_tag": None, "question_pdf": qp["path"], "mark_scheme_pdf": None, "question_crops": [], "mark_scheme_crops": [], "crop_plan": parts, "review_required": False})
    metadata = {"pages": pages, "question_starts": starts, "detected_question_count": len(starts), "needs_boundary_review": len(starts) == 0}
    return plans, metadata


def render_page(pdf: Path, page_no: int, destination: Path, dpi: int) -> None:
    prefix = destination.with_suffix("")
    cmd = ["pdftoppm", "-f", str(page_no), "-l", str(page_no), "-png", "-r", str(dpi), "-singlefile", str(pdf), str(prefix)]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def crop_pdf_plan(source_pdf: str, crop_plan: list[dict[str, Any]], ident: str, output: Path, dpi: int, kind: str) -> list[str]:
    paths = []
    temp = output / "tmp_render" / f"{kind}_{ident}"
    temp.mkdir(parents=True, exist_ok=True)
    # Canonical images are separate from the old pilot area. This prevents a
    # resumable full run from accidentally reusing a crop made before a
    # boundary-detector correction.
    dest_dir = output / ("canonical/questions" if kind == "questions" else "canonical/mark_schemes")
    dest_dir.mkdir(parents=True, exist_ok=True)
    scale = dpi / POINTS_PER_INCH
    for part_no, part in enumerate(crop_plan, 1):
        rendered = temp / f"page_{part['source_page']:02d}.png"
        render_page(Path(source_pdf), part["source_page"], rendered, dpi)
        x0, y0, x1, y1 = part["bbox_points"]
        # Poppler can finish its subprocess just ahead of the final write on
        # network-backed workspaces. Retry a partially-written PNG instead of
        # losing an otherwise resumable multi-hour job.
        image = None
        for attempt in range(3):
            try:
                image = Image.open(rendered)
                image.load()
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(0.25)
        assert image is not None
        with image:
            crop = image.crop((round(x0 * scale), round(y0 * scale), round(x1 * scale), round(y1 * scale)))
            suffix = "_ms" if kind == "mark_schemes" else ""
            final = dest_dir / f"{ident}{suffix}_p{part_no:02d}.png"
            crop.save(final, optimize=True)
        paths.append(str(final.relative_to(output)))
    return paths


def crop_question(question: dict[str, Any], output: Path, dpi: int) -> list[str]:
    return crop_pdf_plan(question["question_pdf"], question["crop_plan"], question["id"], output, dpi, "questions")


def mark_scheme_plan(pdf_path: str, question_number: int) -> list[dict[str, Any]]:
    """Return the same coordinate crop-plan for one question in a mark scheme.

    Mark schemes use question numbers in a table rather than a paper margin,
    but the shared sequence detector handles their normal x~68 table column.
    An empty result means the answer must be manually reviewed, never guessed.
    """
    pages, words = words_for_pdf(Path(pdf_path))
    starts = question_starts(words, pages, max_x=95)
    page_map = {p["page"]: p for p in pages}
    for index, start in enumerate(starts):
        if start["number"] != question_number:
            continue
        end = starts[index + 1] if index + 1 < len(starts) else None
        final_page = end["page"] if end else pages[-1]["page"]
        plan = []
        for page_no in range(start["page"], final_page + 1):
            height = page_map[page_no]["height"]
            y0 = start["top"] - 10 if page_no == start["page"] else 25
            y1 = end["top"] - 10 if end and page_no == end["page"] else height - 25
            if y1 - y0 >= 18:
                plan.append({"source_page": page_no, "bbox_points": [15, round(max(0, y0), 2), round(page_map[page_no]["width"] - 15, 2), round(min(height, y1), 2)]})
        return plan
    return []


def crop_mark_scheme(question: dict[str, Any], output: Path, dpi: int) -> list[str]:
    if not question.get("mark_scheme_pdf"):
        return []
    plan = mark_scheme_plan(question["mark_scheme_pdf"], question["question_number"])
    if not plan:
        question["review_required"] = True
        return []
    return crop_pdf_plan(question["mark_scheme_pdf"], plan, question["id"], output, dpi, "mark_schemes")


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, questions: list[dict[str, Any]]) -> None:
    fields = ["id", "year", "session", "paper", "question_number", "primary_tag", "tags", "question_pdf", "mark_scheme_pdf", "question_crops", "review_required"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for q in questions:
            row = {k: q.get(k) for k in fields}
            row["tags"] = "; ".join(q["tags"])
            row["question_crops"] = "; ".join(q["question_crops"])
            writer.writerow(row)


def component_tag_mismatches(questions: list[dict[str, Any]]) -> list[str]:
    """Return IDs whose normalized topic prefix differs from the paper group."""
    mismatches = []
    for question in questions:
        expected = str(question["paper"])[0]
        values = [question.get("primary_tag"), *question.get("tags", [])]
        codes = []
        for value in values:
            match = re.match(r"^(\d)\.\d", str(value or "").strip())
            if match:
                codes.append(match.group(1))
        if not codes or any(code != expected for code in codes):
            mismatches.append(question["id"])
    return mismatches


def build(args: argparse.Namespace) -> None:
    records, pairs = inventory(args.source)
    qps = [r for r in records if r["kind"] == "qp"]
    output = args.output
    metadata = output / "metadata"
    manifest_path = metadata / "questions_manifest.json"
    diagnostic_path = metadata / "extraction_diagnostics.json"
    # Checkpoint after every source paper.  Full extraction is deliberately
    # resumable: a malformed third-party PDF cannot discard earlier work.
    questions = json.loads(manifest_path.read_text(encoding="utf-8")) if args.resume and manifest_path.exists() else []
    extraction = json.loads(diagnostic_path.read_text(encoding="utf-8")) if args.resume and diagnostic_path.exists() else {}
    done = {q["question_pdf"] for q in questions}
    write_json(metadata / "pdf_inventory.json", {"records": records, "pair_count": len(pairs), "question_paper_count": len(qps), "mark_scheme_count": len(records) - len(qps)})
    for qp in qps:
        if qp["path"] in done:
            continue
        plans, diagnostic = build_question_plans(qp)
        key = (qp["year"], qp["session"], qp["paper"])
        scheme = pairs[key].get("ms")
        for plan in plans:
            plan["mark_scheme_pdf"] = scheme
            plan["review_required"] = not bool(scheme)
        questions.extend(plans)
        extraction[f"{qp['year']}-{qp['session']}-{qp['paper']}"] = diagnostic
        write_json(diagnostic_path, extraction)
        write_json(manifest_path, questions)
        print(f"Extracted {qp['year']}-{qp['session']}-{qp['paper']}: {len(plans)} questions", flush=True)
    write_json(diagnostic_path, extraction)
    write_json(manifest_path, questions)
    write_csv(metadata / "questions_manifest.csv", questions)
    print(f"Inventory: {len(qps)} QP PDFs, {len(records) - len(qps)} MS PDFs, {len(questions)} detected large questions")
    print(f"Manifest: {metadata / 'questions_manifest.json'}")
    if args.crop:
        selected = [q for q in questions if (not args.paper or q["paper"] == args.paper) and (not args.year or q["year"] == args.year)]
        for q in selected:
            q["question_crops"] = crop_question(q, output, args.dpi)
            q["mark_scheme_crops"] = crop_mark_scheme(q, output, args.dpi)
        write_json(metadata / "questions_manifest.json", questions)
        write_csv(metadata / "questions_manifest.csv", questions)
        print(f"Cropped {len(selected)} large questions to {output / 'unclassified/questions'}")


def validate(args: argparse.Namespace) -> None:
    manifest = args.output / "metadata/questions_manifest.json"
    if not manifest.exists():
        raise SystemExit(f"No manifest: {manifest}. Run build first.")
    questions = json.loads(manifest.read_text(encoding="utf-8"))
    missing_crops = [q["id"] for q in questions if q["question_crops"] and any(not (args.output / p).exists() for p in q["question_crops"])]
    duplicates = len(questions) - len({q["id"] for q in questions})
    component_mismatches = component_tag_mismatches(questions)
    print(json.dumps({"questions": len(questions), "cropped_questions": sum(bool(q["question_crops"]) for q in questions), "missing_crop_files": missing_crops, "duplicate_ids": duplicates, "component_tag_mismatches": component_mismatches, "unpaired_mark_schemes": sum(q["mark_scheme_pdf"] is None for q in questions)}, indent=2))
    if missing_crops or duplicates or component_mismatches:
        raise SystemExit(1)


def tag_directory(tag: str) -> Path:
    """Stable syllabus-folder route, preserving the classifier's syllabus code."""
    prefix = tag.split(".", 1)[0]
    groups = {
        "1": "1_Pure_Mathematics_1", "2": "2_Pure_Mathematics_2",
        "3": "3_Pure_Mathematics_3", "4": "4_Mechanics",
        "5": "5_Probability_and_Statistics_1", "6": "6_Probability_and_Statistics_2",
    }
    clean = re.sub(r"[^A-Za-z0-9._ -]+", "_", tag).strip().replace(" ", "_")
    return Path(groups.get(prefix, "review")) / clean


def load_classifications(paths: list[Path]) -> dict[tuple[str, int], dict[str, Any]]:
    merged: dict[tuple[str, int], dict[str, Any]] = {}
    for path in paths:
        if not path.exists():
            raise SystemExit(f"Classification file not found: {path}")
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            source = item.get("pdf") or item.get("source_pdf")
            if not source:
                continue
            resolved = str((ROOT / source).resolve()) if not Path(source).is_absolute() else str(Path(source).resolve())
            merged[(resolved, int(item["question_number"]))] = item
    return merged


def load_overrides(paths: list[Path]) -> dict[str, dict[str, Any]]:
    overrides: dict[str, dict[str, Any]] = {}
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                item = json.loads(line)
                if item.get("id"):
                    overrides[item["id"]] = item
    return overrides


def link_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return
    try:
        os.link(source, destination)
    except FileExistsError:
        # A concurrent/resumed pass created the same hard-link between the
        # exists check and link call; it is already the desired artifact.
        return
    except OSError:
        shutil.copy2(source, destination)


def organize(args: argparse.Namespace) -> None:
    manifest_path = args.output / "metadata/questions_manifest.json"
    if not manifest_path.exists():
        raise SystemExit("No manifest. Run build before organize.")
    questions = json.loads(manifest_path.read_text(encoding="utf-8"))
    classified = load_classifications(args.classifications)
    overrides = load_overrides(args.overrides)
    matched = 0
    for q in questions:
        if not q.get("crop_plan") and q["id"] in MANUAL_CROP_PAGES:
            # 20pt side margins, 50pt above the visible question number, and
            # 35pt above the footer. All five have standard A4 PDF dimensions.
            q["crop_plan"] = [{"source_page": MANUAL_CROP_PAGES[q["id"]], "bbox_points": [20, 50, 575.28, 806.89], "manual_recovery": True}]
        item = classified.get((str(Path(q["question_pdf"]).resolve()), int(q["question_number"])))
        if item is None:
            q["tags"] = []
            q["primary_tag"] = None
            q["review_required"] = True
        else:
            matched += 1
            q["tags"] = item.get("tags", [])
            q["primary_tag"] = item.get("primary_tag")
            q["confidence"] = item.get("confidence")
            q["review_required"] = bool(item.get("review_required", False))
            q["classification_basis"] = item.get("classification_basis", "classification index")
        if q["id"] in overrides:
            q.update({k: v for k, v in overrides[q["id"]].items() if k != "id"})
    if args.crop:
        for n, q in enumerate(questions, 1):
            existing = [args.output / p for p in q.get("question_crops", [])]
            canonical = existing and all(str(p).startswith(str(args.output / "canonical/questions")) for p in existing)
            if not canonical or any(not p.exists() for p in existing):
                recovered = [args.output / "canonical/questions" / f"{q['id']}_p{i:02d}.png" for i in range(1, len(q["crop_plan"]) + 1)]
                if recovered and all(path.exists() for path in recovered):
                    q["question_crops"] = [str(path.relative_to(args.output)) for path in recovered]
                else:
                    q["question_crops"] = crop_question(q, args.output, args.dpi)
            # Canonical crops live in canonical/questions; tags get cheap
            # hard links so multi-tag questions do not duplicate image bytes.
            for rel in q.get("question_crops", []):
                source = args.output / rel
                if not q["tags"]:
                    link_or_copy(source, args.output / "review/no_tags/questions" / source.name)
                for tag in q["tags"]:
                    link_or_copy(source, args.output / tag_directory(tag) / "questions" / source.name)
                if q.get("review_required"):
                    link_or_copy(source, args.output / "review/needs_review/questions" / source.name)
            if n % 20 == 0:
                write_json(manifest_path, questions)
                print(f"Organized {n}/{len(questions)} questions", flush=True)
    write_json(manifest_path, questions)
    write_csv(args.output / "metadata/questions_manifest.csv", questions)
    summary = {"questions": len(questions), "matched_classifications": matched, "overrides_applied": sum(q["id"] in overrides for q in questions), "unmatched": len(questions) - matched, "tagged": sum(bool(q["tags"]) for q in questions), "review_required": sum(bool(q["review_required"]) for q in questions), "cropped": sum(bool(q.get("question_crops")) for q in questions)}
    write_json(args.output / "metadata/organization_summary.json", summary)
    print(json.dumps(summary, indent=2))


def stitch(args: argparse.Namespace) -> None:
    """Make exactly one vertically stacked PNG per large question.

    Existing page-part crops remain the source until every new stitch has been
    written and verified. Only then are task-generated ``_pNN`` images/links
    removed and the manifest switched to the singleton crop path.
    """
    manifest_path = args.output / "metadata/questions_manifest.json"
    if not manifest_path.exists():
        raise SystemExit("No manifest. Run build before stitch.")
    questions = json.loads(manifest_path.read_text(encoding="utf-8"))
    failures = []
    for index, q in enumerate(questions, 1):
        parts = [args.output / p for p in q.get("question_crops", [])]
        final = args.output / "canonical/questions" / f"{q['id']}.png"
        if final.exists():
            try:
                with Image.open(final) as image:
                    image.verify()
                continue
            except Exception:
                final.unlink()
        if not parts or any(not p.exists() for p in parts):
            failures.append(q["id"])
            continue
        try:
            images = []
            for part in parts:
                with Image.open(part) as opened:
                    images.append(opened.convert("RGB"))
            width = max(image.width for image in images)
            height = sum(image.height for image in images) + args.separator * (len(images) - 1)
            combined = Image.new("RGB", (width, height), "white")
            y = 0
            for image in images:
                combined.paste(image, ((width - image.width) // 2, y))
                y += image.height + args.separator
            temporary = final.with_suffix(".tmp.png")
            combined.save(temporary, optimize=True)
            combined.close()
            for image in images:
                image.close()
            with Image.open(temporary) as check:
                check.verify()
            temporary.replace(final)
        except Exception as exc:
            print(f"Stitch failed for {q['id']}: {exc}", flush=True)
            failures.append(q["id"])
        if index % 50 == 0:
            print(f"Stitched {index}/{len(questions)} questions", flush=True)
    if failures:
        raise SystemExit(f"Stitch incomplete; retaining old parts. Failed IDs: {', '.join(failures)}")

    # Switch to one canonical image and create new tag/review links before
    # removing the old parts. Tags are already present in the manifest.
    for q in questions:
        final = args.output / "canonical/questions" / f"{q['id']}.png"
        q["question_crops"] = [str(final.relative_to(args.output))]
        if not q["tags"]:
            link_or_copy(final, args.output / "review/no_tags/questions" / final.name)
        for tag in q["tags"]:
            link_or_copy(final, args.output / tag_directory(tag) / "questions" / final.name)
        if q.get("review_required"):
            link_or_copy(final, args.output / "review/needs_review/questions" / final.name)

    # Persist the singleton manifest before cleanup. If a long cleanup is
    # interrupted, rerunning stitch only resumes deletion; consumers already
    # see the verified one-image-per-question model.
    write_json(manifest_path, questions)
    write_csv(args.output / "metadata/questions_manifest.csv", questions)

    # The pattern contains the full immutable question ID, so only this
    # pipeline's prior split artifacts are removed.
    removed = 0
    ids = {q["id"] for q in questions}
    part_name = re.compile(r"^(.*)_p\d{2}\.png$")
    for old in args.output.rglob("*.png"):
        match = part_name.match(old.name)
        if match and match.group(1) in ids:
            old.unlink()
            removed += 1
    print(json.dumps({"questions": len(questions), "stitched": len(questions), "removed_old_part_files": removed}, indent=2))


def dotted_answer_blocks(image: Image.Image) -> list[tuple[int, int]]:
    """Locate answer lines as repeated tiny 2D dot components.

    A candidate must contain at least 130 separate 1-4px blobs whose local
    2D extent is also tiny and which span most of the usable page width. That
    rejects ordinary text, formulae, axes, tables and diagram strokes.
    """
    gray = np.asarray(image.convert("L"))
    height, width = gray.shape
    left, right = int(width * 0.07), int(width * 0.94)
    # Cambridge dotted answer lines are made from many short repeated segments.
    # Vertical persistence distinguishes them from text glyphs and diagrams.
    dark = gray[:, left:right] < 200
    candidates = []
    for y, row in enumerate(dark):
        count = int(row.sum())
        if count < 120 or count > 550:
            continue
        starts = int((row[1:] & ~row[:-1]).sum()) + int(row[0])
        positions = np.flatnonzero(row)
        edges = np.flatnonzero(np.diff(np.r_[False, row, False]))
        runs = edges[1::2] - edges[::2]
        if not (starts >= 55 and runs.size and int(runs.max()) <= 12 and (runs <= 5).mean() >= 0.85 and positions.size and positions[-1] - positions[0] >= int(row.size * 0.72)):
            continue
        nearby = np.zeros_like(row)
        if y >= 9:
            nearby |= dark[y - 9:y - 4].any(axis=0)
        if y + 10 <= height:
            nearby |= dark[y + 5:y + 10].any(axis=0)
        persistence = float((row & nearby).sum()) / max(1, count)
        if persistence < 0.15:
            candidates.append(y)
    bands: list[list[int]] = []
    for y in candidates:
        if bands and y <= bands[-1][-1] + 3:
            bands[-1].append(y)
        else:
            bands.append([y])
    normalized = [(band[0], band[-1] + 1) for band in bands]
    if not normalized:
        return []
    # Merge only adjacent dotted lines whose gap contains no meaningful ink;
    # this preserves text, formulae and diagrams placed between answer blocks.
    ink = (gray[:, left:right] < 180).sum(axis=1)
    blocks: list[list[int]] = [[normalized[0][0], normalized[0][1], 1]]
    for start, end in normalized[1:]:
        previous = blocks[-1]
        gap = ink[previous[1]:start]
        meaningful = bool((gap > 35).sum() > 3)
        if start - previous[1] <= 125 and not meaningful:
            previous[1] = end
            previous[2] += 1
        else:
            blocks.append([start, end, 1])
    # Preserve a small visual gap at either end of every collapsed block.
    result = []
    for start, end, count in blocks:
        if count >= 2:
            result.append((max(0, start - 10), min(height, end + 10)))
            continue
        # A single answer line is removed only at the terminal end of a page
        # part, after all real question ink. This preserves lines separating
        # parts (i)/(ii), diagrams and later subquestions.
        tail = ink[end:]
        if (tail > 35).sum() <= 3:
            result.append((max(0, start - 10), min(height, end + 10)))
    return result


def collapse_answer_blocks(image: Image.Image) -> tuple[Image.Image, int]:
    blocks = dotted_answer_blocks(image)
    if not blocks:
        return image.copy(), 0
    retained = []
    cursor = 0
    for start, end in blocks:
        if start > cursor:
            retained.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < image.height:
        retained.append((cursor, image.height))
    new_height = sum(end - start for start, end in retained)
    compact = Image.new("RGB", (image.width, new_height), "white")
    y = 0
    for start, end in retained:
        compact.paste(image.crop((0, start, image.width, end)), (0, y))
        y += end - start
    return compact, image.height - new_height


def trim_edge_barcodes(page: Image.Image, top: int, bottom: int) -> tuple[int, int]:
    """Reserved for future barcode detection; content takes precedence.

    Density alone cannot distinguish a dense mathematical expression from a
    barcode, so this intentionally performs no generic edge deletion.
    """
    return top, bottom


def source_supports_crop_plan(image_height: int, crop_plan: list[dict[str, Any]] | None) -> bool:
    """判断历史原图是否仍保留裁剪计划第一页的完整像素高度。"""
    if not crop_plan:
        return True
    _, y0, _, y1 = crop_plan[0]["bbox_points"]
    expected_first_height = round(y1 * PDF_DPI / POINTS_PER_INCH) - round(y0 * PDF_DPI / POINTS_PER_INCH)
    return image_height >= expected_first_height * 0.8


def compact_image(source: Path, destination: Path, crop_plan: list[dict[str, Any]] | None = None) -> tuple[int, int]:
    with Image.open(source) as opened:
        full = opened.convert("RGB")
    scale = PDF_DPI / POINTS_PER_INCH
    parts: list[Image.Image] = []
    offset = 0
    if crop_plan:
        for index, plan in enumerate(crop_plan):
            _, y0, _, y1 = plan["bbox_points"]
            height = round(y1 * scale) - round(y0 * scale)
            if offset >= full.height:
                break
            page = full.crop((0, offset, full.width, min(full.height, offset + height)))
            # Be conservative: first-page content can begin immediately at the
            # crop boundary, while continuation pages have a small header zone.
            # Tiny continuation fragments contain only page numbering and are
            # discarded rather than accidentally retained as a loose footer.
            top = round((0 if index == 0 else 18) * scale)
            bottom = round(42 * scale)
            top, bottom = trim_edge_barcodes(page, top, bottom)
            if page.height <= top + bottom + 20:
                continue
            page = page.crop((0, top, page.width, page.height - bottom))
            compact_part, _ = collapse_answer_blocks(page)
            parts.append(compact_part)
            offset += height + (24 if index + 1 < len(crop_plan) else 0)
    else:
        compact_part, _ = collapse_answer_blocks(full)
        parts.append(compact_part)
    if not parts:
        # A defensive fallback - keep the source rather than creating an empty
        # question image if a malformed crop plan contains only tiny fragments.
        parts = [full.copy()]
    padding_x, padding_y = 24, 42
    width = max(part.width for part in parts)
    height = sum(part.height for part in parts) + 16 * (len(parts) - 1)
    combined = Image.new("RGB", (width + padding_x * 2, height + padding_y * 2), "white")
    y = padding_y
    for part in parts:
        combined.paste(part, (padding_x + (width - part.width) // 2, y))
        y += part.height + 16
        part.close()
    removed = full.height - combined.height
    destination.parent.mkdir(parents=True, exist_ok=True)
    combined.save(destination, optimize=True)
    combined.close()
    return removed, height


def compact(args: argparse.Namespace) -> None:
    """Stage and atomically promote concise question images.

    Originals are moved to ``original/questions`` only after every staged PNG
    opens successfully. Existing tag links are then replaced with links to the
    new canonical compact images.
    """
    manifest_path = args.output / "metadata/questions_manifest.json"
    questions = json.loads(manifest_path.read_text(encoding="utf-8"))
    canonical = args.output / "canonical/questions"
    originals = args.output / "original/questions"
    staging = args.output / "compact_staging_v4/questions"
    failures, stats = [], {}
    for index, q in enumerate(questions, 1):
        canonical_source = args.output / q["question_crops"][0]
        original_source = originals / f"{q['id']}.png"
        source = original_source if original_source.exists() else canonical_source
        stage = staging / f"{q['id']}.png"
        crop_plan = q.get("crop_plan") or []
        terminal_pages = 0
        if crop_plan and q.get("question_pdf"):
            crop_plan, terminal_pages = trim_terminal_crop_plan(
                crop_plan,
                pdf_page_texts(str(q["question_pdf"])),
            )
            q["crop_plan"] = crop_plan
        if not source.exists():
            failures.append(q["id"])
        elif not stage.exists():
            try:
                with Image.open(source) as source_image:
                    supports_plan = source_supports_crop_plan(source_image.height, crop_plan)
                reused_compact_source = not supports_plan
                if reused_compact_source:
                    fallback = canonical_source if canonical_source.exists() else source
                    stage.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(fallback, stage)
                    with Image.open(fallback) as image:
                        height = image.height
                    removed = 0
                else:
                    removed, height = compact_image(source, stage, crop_plan)
                stats[q["id"]] = {
                    "removed_pixels": removed,
                    "compact_height": height,
                    "removed_terminal_pages": terminal_pages,
                    "reused_compact_source": reused_compact_source,
                }
            except Exception as exc:
                print(f"Compact failed for {q['id']}: {exc}", flush=True)
                failures.append(q["id"])
        else:
            with Image.open(source) as source_image, Image.open(stage) as staged_image:
                stats[q["id"]] = {
                    "removed_pixels": max(0, source_image.height - staged_image.height),
                    "compact_height": staged_image.height,
                    "removed_terminal_pages": terminal_pages,
                    "reused_compact_source": not source_supports_crop_plan(source_image.height, crop_plan),
                }
        if index % 50 == 0:
            print(f"Compacted {index}/{len(questions)} questions", flush=True)
    for q in questions:
        stage = staging / f"{q['id']}.png"
        try:
            with Image.open(stage) as check:
                check.verify()
        except Exception:
            failures.append(q["id"])
    if failures:
        raise SystemExit(f"Compact incomplete; canonical images unchanged. Failed IDs: {', '.join(sorted(set(failures)))}")
    for q in questions:
        source = canonical / f"{q['id']}.png"
        original = originals / source.name
        stage = staging / source.name
        original.parent.mkdir(parents=True, exist_ok=True)
        if source.exists() and not original.exists():
            source.replace(original)
        if stage.exists():
            stage.replace(source)
        elif not source.exists():
            raise SystemExit(f"Promotion missing both source and staged compact image: {q['id']}")
        q["question_crops"] = [str(source.relative_to(args.output))]
        if q["id"] in stats:
            q["compact"] = stats[q["id"]]
        targets = []
        if not q["tags"]:
            targets.append(args.output / "review/no_tags/questions" / source.name)
        for tag in q["tags"]:
            targets.append(args.output / tag_directory(tag) / "questions" / source.name)
        if q.get("review_required"):
            targets.append(args.output / "review/needs_review/questions" / source.name)
        for target in targets:
            if target.exists():
                target.unlink()
            link_or_copy(source, target)
    write_json(manifest_path, questions)
    write_csv(args.output / "metadata/questions_manifest.csv", questions)
    summary = {
        "questions": len(questions),
        "staged": len(questions),
        "images_with_removed_content_space": sum(v.get("removed_pixels", 0) > 0 for v in stats.values()),
        "removed_pixels": sum(max(0, v.get("removed_pixels", 0)) for v in stats.values()),
        "images_with_removed_terminal_pages": sum(v.get("removed_terminal_pages", 0) > 0 for v in stats.values()),
        "removed_terminal_pages": sum(v.get("removed_terminal_pages", 0) for v in stats.values()),
    }
    write_json(args.output / "metadata/compact_summary.json", summary)
    print(json.dumps(summary, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="构建、整理并校验 Cambridge 9709 数学题目工作库。")
    sub = parser.add_subparsers(dest="cmd", required=True, title="可用命令")
    build_p = sub.add_parser("build", help="扫描 PDF 并创建未分类题目清单", description="扫描 PDF 并创建未分类题目清单。")
    build_p.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="源 PDF 目录")
    build_p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="工作题库目录")
    build_p.add_argument("--crop", action="store_true", help="渲染并裁剪所选试卷")
    build_p.add_argument("--paper", help="两位试卷号筛选器，与 --crop 配合使用")
    build_p.add_argument("--year", type=int, help="年份筛选器，与 --crop 配合使用")
    build_p.add_argument("--dpi", type=int, default=PDF_DPI)
    build_p.add_argument("--resume", action="store_true", help="保留已完成 PDF，并在每份试卷后保存检查点")
    validate_p = sub.add_parser("validate", help="校验题目清单与图片", description="校验题目清单与图片。")
    validate_p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="工作题库目录")
    organize_p = sub.add_parser("organize", help="合并分类并整理标签目录", description="合并分类并整理标签目录。")
    organize_p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="工作题库目录")
    organize_p.add_argument("--classifications", type=Path, nargs="+", default=DEFAULT_CLASSIFICATIONS, help="分类 JSONL 文件")
    organize_p.add_argument("--overrides", type=Path, nargs="*", default=DEFAULT_OVERRIDES)
    organize_p.add_argument("--crop", action="store_true", help="render missing canonical question PNGs before linking")
    organize_p.add_argument("--dpi", type=int, default=PDF_DPI)
    stitch_p = sub.add_parser("stitch", help="拼接每道题的分页图片", description="拼接每道题的分页图片。")
    stitch_p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="工作题库目录")
    stitch_p.add_argument("--separator", type=int, default=24, help="分隔空白高度（像素）")
    compact_p = sub.add_parser("compact", help="压缩答题空间并修复尾页", description="压缩答题空间并修复尾页。")
    compact_p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="工作题库目录")
    args = parser.parse_args()
    if args.cmd == "build": build(args)
    elif args.cmd == "validate": validate(args)
    elif args.cmd == "organize": organize(args)
    elif args.cmd == "stitch": stitch(args)
    else: compact(args)


if __name__ == "__main__":
    main()
