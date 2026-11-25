#!/usr/bin/env python3
"""Apply the manually confirmed IELTS Listening/Reading large-question repairs."""
from __future__ import annotations

import argparse
import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Mapping


READING_MERGE_IDS = (
    "IELTS-C09-T04-R-P02-Q14-14",
    "IELTS-C09-T04-R-P02-Q15-19",
)
READING_MERGED_ID = "IELTS-C09-T04-R-P02-Q14-19"
READING_SPLIT_ID = "IELTS-C19-T02-R-P02-Q14-22"
LISTENING_WRONG_IMAGE_IDS = {
    "IELTS-C08-T01-L-S01-Q03-10": "images/items/C08/T01/listening/q03-10-reviewed.png",
    "IELTS-C08-T02-L-S01-Q01-03": "images/items/C08/T02/listening/q01-03-reviewed.png",
    "IELTS-C11-T01-L-S01-Q01-10": "images/items/C11/T01/listening/q01-10-reviewed.png",
    "IELTS-C11-T02-L-S01-Q01-10": "images/items/C11/T02/listening/q01-10-reviewed.png",
    "IELTS-C15-T03-L-S01-Q01-10": "images/items/C15/T03/listening/q01-10-reviewed.png",
    "IELTS-C17-T02-L-S01-Q08-10": "images/items/C17/T02/listening/q08-10-reviewed.png",
    "IELTS-C19-T03-L-S01-Q07-10": "images/items/C19/T03/listening/q07-10-reviewed.png",
    "IELTS-C19-T04-L-S01-Q07-10": "images/items/C19/T04/listening/q07-10-reviewed.png",
    "IELTS-C21-T04-L-S01-Q01-10": "images/items/C21/T04/listening/q01-10-reviewed.png",
}
ANSWER_OVERRIDES: dict[tuple[str, int], dict[str, Any]] = {
    ("IELTS-C08-T01-L-S01-Q03-10", 7): {
        "answer_text": "(the/a) pianist", "accepted_variants": ["piano player"],
    },
    ("IELTS-C08-T02-L-S01-Q01-03", 3): {"answer_text": "28 November"},
    ("IELTS-C08-T04-L-S01-Q01-10", 5): {
        "answer_text": "dark", "accepted_variants": ["dark coloured", "dark colored"],
    },
    ("IELTS-C08-T04-L-S01-Q01-10", 7): {"answer_text": "28 June"},
    ("IELTS-C09-T02-L-S01-Q01-10", 8): {"accepted_variants": ["older"]},
    ("IELTS-C10-T03-L-S01-Q01-10", 4): {"answer_text": "8.30"},
    ("IELTS-C11-T01-L-S01-Q01-10", 2): {
        "accepted_variants": [
            "a hundred and fifteen", "one hundred and fifteen", "one hundred fifteen",
        ],
    },
    ("IELTS-C11-T02-L-S01-Q01-10", 9): {
        "answer_text": "4.30 (pm)", "accepted_variants": ["half past four"],
    },
    ("IELTS-C14-T01-L-S01-Q01-10", 3): {"answer_text": "Park"},
    ("IELTS-C15-T03-L-S01-Q01-10", 5): {
        "answer_text": "1", "accepted_variants": ["one year"],
    },
    ("IELTS-C16-T02-L-S01-Q01-10", 9): {"accepted_variants": ["10 days"]},
    ("IELTS-C16-T02-L-S01-Q01-10", 10): {"answer_text": "plastic"},
    ("IELTS-C18-T01-L-S02-Q11-13", 11): {"answer_text": "C"},
    ("IELTS-C18-T02-L-S01-Q06-10", 10): {"answer_text": "Sunday"},
    ("IELTS-C18-T04-L-S01-Q01-10", 7): {"answer_text": "confident"},
    ("IELTS-C18-T04-L-S01-Q01-10", 9): {"answer_text": "1.15"},
    ("IELTS-C19-T03-L-S01-Q01-06", 3): {
        "answer_text": "3.30",
        "accepted_variants": ["three thirty", "½", "half 3", "three"],
    },
    ("IELTS-C20-T03-L-S01-Q01-10", 1): {
        "answer_text": "($)239",
        "accepted_variants": ["($) two hundred (and) thirty-nine"],
    },
    ("IELTS-C21-T04-L-S02-Q11-12", 11): {"accepted_variants": ["E"]},
    ("IELTS-C21-T04-L-S02-Q11-12", 12): {"accepted_variants": ["C"]},
    ("IELTS-C21-T04-L-S02-Q13-14", 13): {"accepted_variants": ["B"]},
    ("IELTS-C21-T04-L-S02-Q13-14", 14): {"accepted_variants": ["A"]},
}
SOURCE_TRIM_ID = "IELTS-C08-T04-L-S04-SOURCE"
DEFAULT_AI_PATCH = Path(__file__).with_name("ielts_v2_low_confidence_review_C_patch.json")
SOURCE_TEXT_SUBSTITUTIONS = {
    "IELTS-C19-T03-L-S01-SOURCE": [
        ("there's a minibus that\ngoes to the supermarket if you need it.I t's � and the number is 289.",
         "there's a minibus that\ngoes to the supermarket if you need it. It's purple and the number is 289."),
    ],
    "IELTS-C20-T03-L-S01-SOURCE": [
        ("Saisie OK.\nMAN: | don’t have any information",
         "SHELLEY: OK.\nMAN: I don’t have any information"),
    ],
    "IELTS-C21-T04-L-S01-SOURCE": [
        ("MAN: Yeah. Well, I've got to go and pick up my @m.QRIt. broke a couple of days 05",
         "MAN: Yeah. Well, I've got to go and pick up my laptop. It broke a couple of days Q5"),
    ],
}
LISTENING_RANGE_PROMPT_ID = "IELTS-C11-T03-L-S03-Q21-26"
PROMPT_OVERRIDES = {
    "IELTS-C08-T02-L-S01-Q01-03": (
        "Questions 1-3\nComplete the form below.\n"
        "Write NO MORE THAN THREE WORDS AND/OR A NUMBER for each answer.\n\n"
        "TOTAL INSURANCE INCIDENT REPORT\n"
        "Example: Name — Michael Alexander\n"
        "Address: 24 Manly Street, 1 __________, Sydney\n"
        "Shipping agent: 2 __________\nPlace of origin: China\n"
        "Date of arrival: 3 __________\nReference number: 601 ACK"
    ),
    "IELTS-C17-T02-L-S01-Q08-10": (
        "Questions 8-10\nComplete the table below.\n"
        "Write ONE WORD ONLY for each answer.\n\nVillage social events\n"
        "Date | Event | Location | Help needed\n"
        "19 Oct | 8 __________ | Village hall | providing refreshments\n"
        "18 Nov | dance | Village hall | checking 9 __________\n"
        "31 Dec | New Year's Eve party | Mountfort Hotel | designing the 10 __________"
    ),
    "IELTS-C11-T03-L-S03-Q21-26": (
        "Questions 21-26\nComplete the table below.\n"
        "Write ONE WORD ONLY for each answer.\n\n"
        "Subject of drawing | Change to be made\n"
        "A 21 __________ surrounded by trees | Add Malcolm and a 22 __________ noticing him\n"
        "People who are 23 __________ and 24 __________ outside the forest | "
        "Add Malcolm sitting on a tree trunk\n"
        "Ice-skaters on 25 __________ covered with ice | Add a 26 __________ for each person"
    ),
}
LISTENING_NEXT_SECTION_IDS = {
    "IELTS-C08-T02-L-S01-Q04-10",
    "IELTS-C08-T04-L-S02-Q14-20",
    "IELTS-C10-T01-L-S01-Q07-10",
    "IELTS-C10-T01-L-S02-Q13-20",
    "IELTS-C10-T02-L-S01-Q01-10",
    "IELTS-C10-T02-L-S02-Q15-20",
    "IELTS-C10-T03-L-S01-Q01-10",
    "IELTS-C10-T03-L-S02-Q16-20",
    "IELTS-C10-T04-L-S01-Q07-10",
    "IELTS-C10-T04-L-S02-Q16-20",
    "IELTS-C10-T04-L-S03-Q25-30",
    "IELTS-C14-T01-L-S01-Q01-10",
    "IELTS-C14-T01-L-S02-Q15-20",
    "IELTS-C14-T01-L-S03-Q26-30",
    "IELTS-C14-T02-L-S02-Q16-20",
    "IELTS-C14-T02-L-S03-Q25-30",
    "IELTS-C14-T04-L-S01-Q08-10",
    "IELTS-C14-T04-L-S02-Q19-20",
    "IELTS-C14-T04-L-S03-Q26-30",
    "IELTS-C15-T02-L-S01-Q05-10",
    "IELTS-C15-T04-L-S01-Q01-10",
    "IELTS-C17-T01-L-S01-Q01-10",
    "IELTS-C17-T01-L-S02-Q19-20",
    "IELTS-C17-T02-L-S01-Q08-10",
    "IELTS-C17-T02-L-S02-Q15-20",
    "IELTS-C17-T03-L-S01-Q01-10",
    "IELTS-C17-T03-L-S02-Q16-20",
    "IELTS-C17-T03-L-S03-Q25-30",
    "IELTS-C17-T04-L-S01-Q01-10",
    "IELTS-C17-T04-L-S02-Q15-20",
}


def _replace_primary(item: dict[str, Any], primary: str) -> None:
    previous = str(item["primary_tag"])
    tags = [primary if tag == previous else tag for tag in item["tags"]]
    if primary not in tags:
        tags.insert(0, primary)
    item["primary_tag"] = primary
    item["tags"] = list(dict.fromkeys(tags))


def _trim_next_section(item: dict[str, Any]) -> None:
    next_section = int(item["section"]) + 1
    pattern = re.compile(
        rf"\n[^\n]{{0,40}}(?:SECTION|PART)\s*{next_section}\b", re.IGNORECASE
    )
    prompt = str(item.get("prompt_text") or "")
    match = pattern.search(prompt)
    if not match:
        raise ValueError(f"{item['id']} has no detectable next Section/Part heading")
    item["prompt_text"] = prompt[: match.start()].rstrip()


def _answer_for_item(answer: Mapping[str, Any], item_id: str) -> dict[str, Any]:
    repaired = deepcopy(dict(answer))
    number = int(repaired["question_number"])
    repaired["item_id"] = item_id
    repaired["id"] = f"{item_id}-A{number:02d}"
    return repaired


def repair_records(
    items: Iterable[Mapping[str, Any]], answers: Iterable[Mapping[str, Any]],
    *, prompt_overrides: Mapping[str, str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return repaired metadata after the two independent human/AI boundary audits."""
    repaired_items = {str(row["id"]): deepcopy(dict(row)) for row in items}
    repaired_answers = [deepcopy(dict(row)) for row in answers]

    required = set(READING_MERGE_IDS) | {READING_SPLIT_ID, LISTENING_RANGE_PROMPT_ID}
    required |= set(LISTENING_WRONG_IMAGE_IDS) | LISTENING_NEXT_SECTION_IDS
    missing = sorted(required - set(repaired_items))
    if missing:
        raise ValueError(f"missing confirmed repair items: {missing}")

    # Cambridge 9 Test 4 Reading Passage 2: Questions 14-19 share one instruction.
    merged = repaired_items.pop(READING_MERGE_IDS[1])
    repaired_items.pop(READING_MERGE_IDS[0])
    merged.update({
        "id": READING_MERGED_ID,
        "question_start": 14,
        "question_end": 19,
        "image": "images/items/C09/T04/reading/q14-19-reviewed.png",
        "classification_confidence": 0.98,
        "review_required": False,
        "reason": "人工与分批 AI 复核确认：Questions 14-19 受同一作答说明控制，合并为一个完整大题。",
    })
    repaired_items[merged["id"]] = merged

    # Cambridge 19 Test 2 Reading Passage 2: two explicit instruction blocks.
    original = repaired_items.pop(READING_SPLIT_ID)
    marker = "Questions 19-22"
    if marker not in str(original.get("prompt_text") or ""):
        raise ValueError(f"{READING_SPLIT_ID} has no split marker {marker!r}")
    prompt_14_18, prompt_19_22 = str(original["prompt_text"]).split(marker, 1)
    first = deepcopy(original)
    first.update({
        "id": "IELTS-C19-T02-R-P02-Q14-18",
        "question_start": 14,
        "question_end": 18,
        "prompt_text": prompt_14_18.rstrip(),
        "image": "images/items/C19/T02/reading/q14-18-reviewed.png",
        "classification_confidence": 0.98,
        "review_required": False,
        "reason": "人工与分批 AI 复核确认：Questions 14-18 是段落信息匹配完整大题。",
    })
    _replace_primary(first, "R.PARAGRAPH_INFORMATION_MATCHING")
    second = deepcopy(original)
    second.update({
        "id": "IELTS-C19-T02-R-P02-Q19-22",
        "question_start": 19,
        "question_end": 22,
        "prompt_text": f"{marker}{prompt_19_22}".strip(),
        "image": "images/items/C19/T02/reading/q19-22-reviewed.png",
        "classification_confidence": 0.98,
        "review_required": False,
        "reason": "人工与分批 AI 复核确认：Questions 19-22 是句子填空完整大题。",
    })
    _replace_primary(second, "R.SENTENCE_COMPLETION")
    repaired_items[first["id"]] = first
    repaired_items[second["id"]] = second

    for item_id in LISTENING_NEXT_SECTION_IDS:
        _trim_next_section(repaired_items[item_id])
    for item_id, image in LISTENING_WRONG_IMAGE_IDS.items():
        repaired_items[item_id]["image"] = image

    for item_id, prompt in PROMPT_OVERRIDES.items():
        repaired_items[item_id]["prompt_text"] = prompt
    for item_id, prompt in (prompt_overrides or {}).items():
        if item_id not in repaired_items:
            raise ValueError(f"AI prompt patch item does not exist: {item_id}")
        repaired_items[item_id]["prompt_text"] = str(prompt)

    # All records previously marked review_required were inspected in three AI batches.
    for item in repaired_items.values():
        if item.get("review_required"):
            item["classification_confidence"] = 0.98
            item["review_required"] = False
            prior = str(item.get("reason") or "").rstrip()
            item["reason"] = (
                prior + (" " if prior else "")
                + "分批 AI 复核确认题型、大题边界、完整原文与答案关系。"
            )

    remapped_answers: list[dict[str, Any]] = []
    for answer in repaired_answers:
        old = str(answer["item_id"])
        number = int(answer["question_number"])
        if old in READING_MERGE_IDS:
            remapped_answers.append(_answer_for_item(answer, READING_MERGED_ID))
        elif old == READING_SPLIT_ID:
            target = (
                "IELTS-C19-T02-R-P02-Q14-18" if number <= 18
                else "IELTS-C19-T02-R-P02-Q19-22"
            )
            remapped_answers.append(_answer_for_item(answer, target))
        else:
            remapped_answers.append(answer)

    for answer in remapped_answers:
        override = ANSWER_OVERRIDES.get((str(answer["item_id"]), int(answer["question_number"])))
        if override:
            answer.update(deepcopy(override))

    return (
        sorted(repaired_items.values(), key=lambda row: str(row["id"])),
        sorted(remapped_answers, key=lambda row: (str(row["item_id"]), int(row["question_number"]))),
    )


def repair_source_texts(source_texts: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Remove one confirmed answer-key page appended after a complete audioscript."""
    sources = {str(row["id"]): deepcopy(dict(row)) for row in source_texts}
    if SOURCE_TRIM_ID not in sources:
        raise ValueError(f"missing confirmed source repair item: {SOURCE_TRIM_ID}")
    source = sources[SOURCE_TRIM_ID]
    marker = re.compile(
        r"\n151\s*\n\s*Listeninga nd ReadingA nswer Keys[\s\S]*$", re.IGNORECASE
    )
    text, replacements = marker.subn("", str(source.get("text") or ""), count=1)
    if replacements != 1:
        raise ValueError(f"{SOURCE_TRIM_ID} has no confirmed answer-key tail marker")
    source["text"] = text.rstrip()
    source["page_end"] = 150
    source["assets"] = [
        asset for asset in source.get("assets", [])
        if int(asset.get("page_number", asset.get("source_page", 0))) <= 150
    ]
    for source_id, substitutions in SOURCE_TEXT_SUBSTITUTIONS.items():
        if source_id not in sources:
            continue
        text = str(sources[source_id].get("text") or "")
        for old, new in substitutions:
            if text.count(old) != 1:
                raise ValueError(f"{source_id} expected one OCR substring: {old!r}")
            text = text.replace(old, new, 1)
        sources[source_id]["text"] = text
    return sorted(sources.values(), key=lambda row: str(row["id"]))


def _load(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"{path} must contain a JSON array")
    return [dict(row) for row in value]


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _prompt_overrides_from_patch(path: Path) -> dict[str, str]:
    patch = json.loads(path.read_text(encoding="utf-8"))
    rows = patch.get("prompt_text_updates", [])
    result = {str(row["item_id"]): str(row["expected_prompt_text"]) for row in rows}
    if len(result) != len(rows):
        raise ValueError(f"duplicate item_id in AI patch: {path}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--items", type=Path, required=True)
    parser.add_argument("--answers", type=Path, required=True)
    parser.add_argument("--output-items", type=Path, required=True)
    parser.add_argument("--output-answers", type=Path, required=True)
    parser.add_argument("--source-texts", type=Path)
    parser.add_argument("--output-source-texts", type=Path)
    parser.add_argument("--ai-patch", type=Path, default=DEFAULT_AI_PATCH)
    args = parser.parse_args()
    prompt_overrides = (
        _prompt_overrides_from_patch(args.ai_patch) if args.ai_patch and args.ai_patch.is_file()
        else {}
    )
    items, answers = repair_records(
        _load(args.items), _load(args.answers), prompt_overrides=prompt_overrides
    )
    _write(args.output_items, items)
    _write(args.output_answers, answers)
    if bool(args.source_texts) != bool(args.output_source_texts):
        parser.error("--source-texts and --output-source-texts must be supplied together")
    if args.source_texts and args.output_source_texts:
        _write(args.output_source_texts, repair_source_texts(_load(args.source_texts)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
