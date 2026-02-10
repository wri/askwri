"""
Adapter to convert AskWRI answer golden dataset to RAGAS evaluation format.

RAGAS expects:
  - question: str
  - answer: str (the generated answer)
  - contexts: list[str] (the passages/contexts used)
  - ground_truth: str (the reference/canonical answer)
"""

import json
from pathlib import Path
from typing import Optional

from datasets import Dataset


def load_golden_dataset(path: Optional[str] = None) -> dict:
    """Load the AskWRI answer golden dataset JSON."""
    if path is None:
        path = str(Path(__file__).parent.parent / "answer-golden-dataset.json")
    with open(path) as f:
        return json.load(f)


def to_ragas_dataset(
    golden: dict,
    generated_answers: dict[str, str],
    contexts: dict[str, list[str]],
) -> Dataset:
    """
    Convert golden dataset + generated answers into a RAGAS-compatible Dataset.

    Args:
        golden: The loaded golden dataset dict
        generated_answers: Map of test_case_id -> generated answer string
        contexts: Map of test_case_id -> list of passage text strings
    """
    rows: dict[str, list] = {
        "question": [],
        "answer": [],
        "contexts": [],
        "ground_truth": [],
    }

    for tc in golden["test_cases"]:
        tc_id = tc["id"]
        if tc_id not in generated_answers:
            continue

        rows["question"].append(tc["question"])
        rows["answer"].append(generated_answers[tc_id])
        rows["contexts"].append(contexts.get(tc_id, []))
        rows["ground_truth"].append(tc["synthesis_ground_truth"]["canonical_answer"])

    return Dataset.from_dict(rows)


def golden_passages_as_contexts(golden: dict) -> dict[str, list[str]]:
    """Extract golden passage snippets as context strings (for isolated mode)."""
    contexts: dict[str, list[str]] = {}
    for tc in golden["test_cases"]:
        contexts[tc["id"]] = [
            p["text_snippet"]
            for p in tc["retrieval_ground_truth"]["expected_passages"]
            if p.get("text_snippet")
        ]
    return contexts
