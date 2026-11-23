import asyncio
from types import SimpleNamespace

import pytest

from app.services import embeddings
from evals.progress import Progress, embed_with_progress


def test_progress_is_optional_and_uses_stderr(capsys):
    with Progress().step("quiet"):
        pass
    assert capsys.readouterr().err == ""
    with Progress(True).step("validation"):
        pass
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "START validation" in captured.err
    assert "DONE validation" in captured.err


def test_failure_is_reported_and_reraised_without_exception_payload(capsys):
    with pytest.raises(ValueError, match="private payload"), Progress(True).step("embedding"):
        raise ValueError("private payload")
    log = capsys.readouterr().err
    assert "FAIL embedding (ValueError)" in log
    assert "private payload" not in log


def test_embedding_progress_preserves_order_and_batch_size(monkeypatch, capsys):
    calls = []

    async def fake_embed(settings, texts, *, purpose, usage):
        calls.append((list(texts), purpose, usage))
        return [[int(text)] for text in texts]

    monkeypatch.setattr(embeddings, "embed", fake_embed)
    inputs = [str(i) for i in range(embeddings.BATCH + 1)]
    usage = object()
    result = asyncio.run(
        embed_with_progress(
            SimpleNamespace(openai_embedding_model="fake-model"),
            inputs,
            purpose="test",
            usage=usage,
            progress=Progress(True),
        )
    )
    assert result == [[i] for i in range(len(inputs))]
    assert [len(call[0]) for call in calls] == [embeddings.BATCH, 1]
    assert all(call[1] == "test" and call[2] is usage for call in calls)
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "batch 1/2" in captured.err and "batch 2/2" in captured.err
