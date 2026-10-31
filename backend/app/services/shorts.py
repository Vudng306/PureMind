"""Short posts: one-minute Vietnamese reads the AI writes from an openly licensed article in the feed.

The feed shows them one after another, like a stream of posts, for readers who want to see what a topic
holds before settling into a long read. A short is a door to its article: a question, the few points that
answer it and one thing to keep, then "read on" opens the article (or the guide written from it). The same
licences as the guides apply (services/guides): CC BY-ND articles are never shortened.
"""

import json
import re

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import Article, Short
from app.services import guides
from app.services.guides import _strict
from app.services.openai_client import AIError, chat

MAX_SOURCE_WORDS = 3000  # of the original, given to the model


class Draft(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    hook: str = Field(min_length=1, max_length=600)
    points: list[str] = Field(min_length=2, max_length=4)
    takeaway: str = Field(min_length=1, max_length=400)


SHORT_SCHEMA = {
    "name": "short",
    "strict": True,
    "schema": _strict(
        {
            "title": {"type": "string"},
            "hook": {"type": "string"},
            "points": {"type": "array", "items": {"type": "string"}},
            "takeaway": {"type": "string"},
        }
    ),
}

SYSTEM = """You write short posts in Vietnamese for PureMind, a reading app for curious Vietnamese adults \
who would rather read something worthwhile than scroll videos. You are given one openly licensed article \
(it may be in English) and write a post that can be read in under a minute and makes the reader want the \
whole article.

Facts:
- Use only the facts, numbers, names and findings in the article. Never invent a study, a statistic, an \
expert, a quote or a date. Keep the article's claims as strong as the article makes them, no stronger, and \
do not turn a correlation into a cause.

Shape (JSON):
- title: a question or a striking statement, at most 80 characters; intriguing but honest, no clickbait.
- hook: one or two sentences that open with something concrete (an everyday situation or a striking fact \
from the article), addressing the reader as "bạn".
- points: exactly three, each one sentence of at most 30 words, each a fact or idea from the article that \
answers the title; plain text, no Markdown.
- takeaway: one sentence, the one thing to keep.

At most 170 words in all, in plain, warm Vietnamese. Do not mention "the article" or "bài viết"."""


def _prompt(article: Article) -> str:
    words = article.content.split()
    text = " ".join(words[:MAX_SOURCE_WORDS]) + (" […]" if len(words) > MAX_SOURCE_WORDS else "")
    return f"Title: {article.title}\nBy: {article.credit}\n\n{text}"


def _line(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("**", "")).strip()


def parse(text: str) -> Draft:
    try:
        draft = Draft.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as e:
        raise AIError(f"unusable short: {e}") from e
    return Draft(
        title=_line(draft.title),
        hook=_line(draft.hook),
        points=[_line(p) for p in draft.points if p.strip()],
        takeaway=_line(draft.takeaway),
    )


async def write(settings: Settings, original: Article) -> Short:
    """A short written from `original` (its content loaded), not yet added to a session."""
    res = await chat(
        settings,
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(original)}],
        purpose="short",
        json_schema=SHORT_SCHEMA,
        max_tokens=1500,
        model=settings.openai_guide_model,
    )
    draft = parse(res.text)
    return Short(
        article_id=original.id,
        title=draft.title[:200],
        hook=draft.hook,
        points=draft.points,
        takeaway=draft.takeaway,
    )


async def originals(session: AsyncSession, per_topic: int, topics: list[str] | None = None) -> list[Article]:
    """Articles to write shorts from: those that may be adapted and have no short yet."""
    return await guides.adaptable(
        session, per_topic, topics, select(Short.id).where(Short.article_id == Article.id).exists()
    )
