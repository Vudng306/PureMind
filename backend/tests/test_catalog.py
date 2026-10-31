import json

import pytest
from fastapi import HTTPException

from app.api.routes import catalog


@pytest.fixture
def shared_catalog(tmp_path, monkeypatch):
    path = tmp_path / "catalog.json"
    path.write_text(
        json.dumps(
            {
                "updated_at": "2026-10-28",
                "articles": [
                    {
                        "id": "a",
                        "title": "Climate",
                        "topic": "Environment",
                        "kind": "research",
                        "authors": "Alice",
                        "description": "Biodiversity",
                        "content": "Full body",
                        "abstract": "Abstract",
                    },
                    {
                        "id": "b",
                        "title": "Learning",
                        "topic": "Education",
                        "kind": "knowledge",
                        "authors": "Bob",
                        "description": "Memory",
                        "content": "Another body",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "CATALOG", path)
    catalog._load.cache_clear()


def test_search_and_pagination_do_not_return_full_text(shared_catalog):
    result = catalog.list_articles(q="ALICE", topic="Environment", kind="research", offset=0, limit=1)
    assert result["total"] == 1
    assert result["articles"][0]["id"] == "a"
    assert "content" not in result["articles"][0]
    assert "abstract" not in result["articles"][0]
    assert catalog.list_articles(q="", topic="", kind="", offset=1, limit=1)["articles"][0]["id"] == "b"


def test_shared_article_and_unknown_id(shared_catalog):
    assert catalog.get_article("a")["content"] == "Full body"
    with pytest.raises(HTTPException) as exc:
        catalog.get_article("missing")
    assert exc.value.status_code == 404


def test_missing_catalog_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog, "CATALOG", tmp_path / "missing.json")
    assert catalog.catalog()["articles"] == []
