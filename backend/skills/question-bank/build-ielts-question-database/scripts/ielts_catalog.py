#!/usr/bin/env python3
"""盘点、校验并安全统一剑桥雅思真题 PDF 文件名。"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import uuid
from pathlib import Path
from typing import Any


VOLUME_RE = re.compile(r"(?<!\d)(?:1[0-9]|20|21|8|9)(?!\d)")
REQUIREMENTS_FILENAME = "IELTS-Question-Bank-Classification-Requirements.docx"


def planned_filename(volume: int) -> str:
    if not 8 <= volume <= 21:
        raise ValueError(f"volume must be between 8 and 21: {volume}")
    scope = "Academic-and-General-Training" if volume <= 10 else "Academic"
    return f"Cambridge-IELTS-{volume:02d}-{scope}-With-Answers.pdf"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def pdf_diagnostics(path: Path) -> dict[str, Any]:
    pages: int | None = None
    info = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True, check=False)
    match = re.search(r"^Pages:\s*(\d+)", info.stdout, re.MULTILINE)
    if match:
        pages = int(match.group(1))
    text = subprocess.run(["pdftotext", str(path), "-"], capture_output=True, text=True, check=False)
    text_chars = len(re.sub(r"\s+", "", text.stdout))
    return {"pages": pages, "text_chars": text_chars, "text_layer_available": text_chars > 0}


def volume_from_name(name: str) -> int:
    matches = [int(value) for value in VOLUME_RE.findall(name)]
    if not matches:
        normalized = re.search(r"Cambridge-IELTS-(0?[8-9]|1[0-9]|2[01])(?:-|\s)", name, re.I)
        if normalized:
            matches = [int(normalized.group(1))]
    valid = [value for value in matches if 8 <= value <= 21]
    if len(valid) != 1:
        raise ValueError(f"cannot determine one IELTS volume from filename: {name}")
    return valid[0]


def inventory_sources(source: Path) -> list[dict[str, Any]]:
    source = source.resolve()
    paths = sorted(source.glob("*.pdf"), key=lambda path: path.name.casefold())
    records: list[dict[str, Any]] = []
    seen: dict[int, str] = {}
    for path in paths:
        volume = volume_from_name(path.name)
        if volume in seen:
            raise ValueError(f"duplicate volume {volume}: {seen[volume]} and {path.name}")
        seen[volume] = path.name
        diagnostics = pdf_diagnostics(path)
        records.append({
            "volume": volume,
            "source_file": path.relative_to(source).as_posix(),
            "normalized_name": planned_filename(volume),
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
            **diagnostics,
        })
    return sorted(records, key=lambda record: record["volume"])


def inventory_requirements_document(source: Path) -> dict[str, Any] | None:
    """Describe the single classification-requirements DOCX using portable names."""
    source = source.resolve()
    paths = sorted(source.glob("*.docx"), key=lambda path: path.name.casefold())
    if not paths:
        return None
    if len(paths) != 1:
        raise ValueError("expected at most one IELTS classification requirements DOCX")
    path = paths[0]
    return {
        "source_file": path.name,
        "normalized_name": REQUIREMENTS_FILENAME,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
    }


def rename_requirements_document(
    source: Path, apply: bool = False
) -> dict[str, Any] | None:
    """Preview or safely rename the requirements DOCX without changing bytes."""
    source = source.resolve()
    record = inventory_requirements_document(source)
    if record is None or not apply:
        return record
    old = source / record["source_file"]
    target = source / record["normalized_name"]
    if target.exists() and target.resolve() != old.resolve():
        raise FileExistsError(f"normalized target already exists: {target.name}")
    if old.name != target.name:
        old.rename(target)
    return record


def rename_sources(source: Path, apply: bool = False) -> list[dict[str, Any]]:
    source = source.resolve()
    records = inventory_sources(source)
    targets = {record["normalized_name"] for record in records}
    if len(targets) != len(records):
        raise ValueError("normalized filename collision")
    for record in records:
        old = source / record["source_file"]
        target = source / record["normalized_name"]
        if target.exists() and target.resolve() != old.resolve():
            raise FileExistsError(f"normalized target already exists: {target.name}")
    if not apply:
        return records

    staged: list[tuple[Path, Path]] = []
    for record in records:
        old = source / record["source_file"]
        if old.name == record["normalized_name"]:
            continue
        temporary = source / f".{old.name}.ielts-renaming-{uuid.uuid4().hex}"
        old.rename(temporary)
        staged.append((temporary, source / record["normalized_name"]))
    for temporary, target in staged:
        temporary.rename(target)
    for record in records:
        record["source_file"] = record["normalized_name"]
    return records


def write_manifest(
    records: list[dict[str, Any]],
    output: Path,
    requirements_document: dict[str, Any] | None = None,
) -> None:
    destination = output / "metadata/source_manifest.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {"schema_version": "1.0"}
    if requirements_document is not None:
        payload["requirements_document"] = requirements_document
    payload["volumes"] = records
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory_parser = subparsers.add_parser("inventory", help="盘点雅思卷册并写入诊断清单")
    inventory_parser.add_argument("--source", type=Path, required=True, help="雅思 PDF 所在目录")
    inventory_parser.add_argument("--output", type=Path, required=True, help="工作题库输出目录")
    rename_parser = subparsers.add_parser("rename", help="预览或应用统一文件名")
    rename_parser.add_argument("--source", type=Path, required=True, help="雅思 PDF 所在目录")
    rename_parser.add_argument("--output", type=Path, required=True, help="工作题库输出目录")
    rename_parser.add_argument("--apply", action="store_true", help="实际执行重命名；默认仅预览")
    args = parser.parse_args()
    if args.command == "inventory":
        records = inventory_sources(args.source)
        requirements = inventory_requirements_document(args.source)
    else:
        records = rename_sources(args.source, apply=args.apply)
        requirements = rename_requirements_document(args.source, apply=args.apply)
    write_manifest(records, args.output, requirements)
    print(json.dumps({"volumes": len(records), "records": records}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
