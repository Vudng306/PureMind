"""Read-only shared catalog, independent of user uploads and accounts."""

import json
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/catalog", tags=["catalog"])
CATALOG = Path(__file__).resolve().parents[2] / "data" / "catalog.json"


@lru_cache(maxsize=1)
def _load(modified: int):
    return json.loads(CATALOG.read_text(encoding="utf-8"))


def catalog():
    if not CATALOG.exists():
        return {"updated_at": None, "articles": []}
    return _load(CATALOG.stat().st_mtime_ns)


@router.get("")
def list_articles(
    q: str = Query("", max_length=200),
    topic: str = "",
    kind: str = "",
    offset: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=100),
):
    data = catalog()
    articles = data["articles"]
    topics = sorted({a["topic"] for a in articles})
    needle = q.strip().casefold()
    filtered = [
        a
        for a in articles
        if (not topic or a["topic"] == topic)
        and (not kind or a["kind"] == kind)
        and (
            not needle
            or needle
            in (
                a["title"] + " " + a.get("description", "") + " " + a["topic"] + " " + a["authors"]
            ).casefold()
        )
    ]
    return {
        "total": len(filtered),
        "topics": topics,
        "updated_at": data["updated_at"],
        "articles": [
            {k: v for k, v in a.items() if k not in {"content", "abstract", "license_statement"}}
            for a in filtered[offset : offset + limit]
        ],
    }


@router.get("/{article_id}")
def get_article(article_id: str):
    article = next((a for a in catalog()["articles"] if a["id"] == article_id), None)
    if article is None:
        raise HTTPException(404, "Không tìm thấy bài viết")
    return article
