"""Offline checks for evaluation scoring; do not load app/database test fixtures."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from app.services.doc_chat import Chunk
from evals import run_pdf_retrieval
from evals.run_pdf_retrieval import score_ranking


def test_recall_uses_all_gold_chunks_and_rank_order():
    chunks = [Chunk(i, None, None, "abcdefghi", 4) for i in (1, 2, 3)]
    scores = score_ranking([(3, 0.9), (1, 0.8), (2, 0.7)], {1, 2}, chunks, budget=8)
    assert scores["recall"] == {"1": 0, "3": 1, "5": 1, "8": 1}
    assert scores["first_relevant_rank"] == 2
    assert scores["budget_recall"] == 0.5
    assert scores["budget_used_estimated_tokens"] == 8


def test_budget_does_not_skip_an_oversized_first_result():
    chunks = [Chunk(1, None, None, "x" * 30, 11), Chunk(2, None, None, "short", 2)]
    scores = score_ranking([(1, 0.9), (2, 0.8)], {2}, chunks, budget=8)
    assert scores["budget_chunks"] == 0
    assert scores["budget_recall"] == 0


def test_budget_includes_heading_cost():
    chunks = [Chunk(1, None, "A long section heading", "tiny", 2)]
    assert score_ranking([(1, 1)], {1}, chunks, budget=3)["budget_chunks"] == 0


@pytest.mark.parametrize("gold", [set(), {99}])
def test_invalid_gold_cannot_produce_a_score(gold):
    with pytest.raises(ValueError):
        score_ranking([(1, 1)], gold, [Chunk(1, None, None, "text", 2)])


def test_validation_rejects_a_short_dataset_before_any_api(tmp_path, monkeypatch):
    source = tmp_path / "input.pdf"
    source.write_bytes(b"placeholder")
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps({"note": "test", "cases": [{"q": "question", "span": "fact"}]}))
    monkeypatch.setattr(
        run_pdf_retrieval,
        "extract_pdf",
        lambda *_: SimpleNamespace(content="fact", page_count=1, word_count=1),
    )
    with pytest.raises(ValueError, match="requires at least 20"):
        asyncio.run(
            run_pdf_retrieval.main(
                source, tmp_path / "out", True, labels_path=labels, sizes=(800,), min_chunks=20
            )
        )
