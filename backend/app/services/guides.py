"""Guides: short Vietnamese reads that the AI writes from an openly licensed article in the feed.

Only CC BY and CC BY-SA articles are adapted: those licences allow a translated, rewritten version as long
as it credits the original and says it was changed (and, for BY-SA, keeps the licence). CC BY-ND articles,
such as The Conversation's, may not be changed, so they are only ever shown as written.

A guide is built for curiosity: an opening from everyday life, a few questions answered with the key
point of each, something to try or to remember, and an open question to talk over. Every fact comes from
the original, which the guide links to and credits (feed's MSG-FEED-CREDIT-GUIDE).
"""

import json
import re
from datetime import UTC, datetime

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, undefer

from app.core.config import Settings
from app.models import TOPICS, Article, ArticleTopic
from app.services.openai_client import AIError, chat
from app.services.sources import CC_BY, CC_BY_SA, Item

SOURCE = "puremind"
NAME = "PureMind"
KIND = "guide"
# Licences that allow an adapted version.
ADAPTABLE = (CC_BY[0], CC_BY_SA[0])
MIN_WORDS = 400  # shorter originals have too little to explain
MAX_SOURCE_WORDS = 5000  # of the original, given to the model
CREDIT = "PureMind biên soạn bằng AI"


class Section(BaseModel):
    heading: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1)
    key_point: str = Field(min_length=1, max_length=500)


class Takeaways(BaseModel):
    kind: str = Field(pattern="^(try|remember)$")
    items: list[str] = Field(min_length=2, max_length=4)


class Guide(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=600)
    hook: str = Field(min_length=1)
    sections: list[Section] = Field(min_length=3, max_length=5)
    takeaways: Takeaways
    discussion: str = Field(min_length=1, max_length=500)
    caution: str


def _strict(properties: dict) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


GUIDE_SCHEMA = {
    "name": "guide",
    "strict": True,
    "schema": _strict(
        {
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "hook": {"type": "string"},
            "sections": {
                "type": "array",
                "items": _strict(
                    {
                        "heading": {"type": "string"},
                        "body": {"type": "string"},
                        "key_point": {"type": "string"},
                    }
                ),
            },
            "takeaways": _strict(
                {
                    "kind": {"type": "string", "enum": ["try", "remember"]},
                    "items": {"type": "array", "items": {"type": "string"}},
                }
            ),
            "discussion": {"type": "string"},
            "caution": {"type": "string"},
        }
    ),
}

SYSTEM = """You write short reads in Vietnamese for PureMind, a reading app for curious Vietnamese adults \
who would rather read something worthwhile than scroll videos. You are given one openly licensed article \
(it may be in English) and write a new piece in natural Vietnamese from it: not a translation, not a summary \
of the article's structure, but an explanation a smart friend would give.

Facts:
- Use only the facts, numbers, names, studies and quotes in the article. Never invent a study, a statistic, \
an expert, a quote or a date. If the article is research, say what was studied, how, what was found and its \
limits, and do not turn a correlation into a cause.
- Keep the article's claims as strong as the article makes them, no stronger.

Shape (JSON):
- title: a question or a striking statement in Vietnamese, at most 90 characters; intriguing but honest, \
no clickbait, nothing the piece does not deliver.
- summary: one or two sentences saying what the reader will understand.
- hook: two to four sentences that open with a concrete situation from everyday life or a striking fact \
from the article, addressing the reader as "bạn".
- sections: three to five; each heading is a question the reader would ask; each body is one to three \
short paragraphs of Markdown (bold at most two key terms; at a technical term's first use, give the English \
in parentheses); key_point is one sentence, the one thing to keep from the section.
- takeaways: kind "try" with two or three small, safe things to do in under five minutes when the article \
supports them; otherwise kind "remember" with three facts worth remembering.
- discussion: one open question with no single right answer, for readers to talk over.
- caution: for health, psychology, law or money, one sentence saying when to see a professional; \
otherwise an empty string.

Write 600 to 900 words in all, in plain, warm Vietnamese. Mention the original article at most once."""


def _prompt(article: Article) -> str:
    words = article.content.split()
    text = " ".join(words[:MAX_SOURCE_WORDS]) + (" […]" if len(words) > MAX_SOURCE_WORDS else "")
    return f"Title: {article.title}\nBy: {article.credit}\n\n{text}"


def render(guide: Guide) -> str:
    """The guide as the reader shows it."""
    parts = [guide.hook.strip()]
    for s in guide.sections:
        parts += [f"## {s.heading.strip()}", s.body.strip(), f"> 💡 **Điểm cốt lõi:** {s.key_point.strip()}"]
    heading = "Thử ngay" if guide.takeaways.kind == "try" else "Điều đáng nhớ"
    parts += [f"## {heading}", "\n".join(f"{i}. {x.strip()}" for i, x in enumerate(guide.takeaways.items, 1))]
    parts += ["## Câu hỏi để bàn luận", guide.discussion.strip()]
    if guide.caution.strip():
        parts.append(f"> ⚠️ **Lưu ý:** {guide.caution.strip()}")
    return "\n\n".join(parts)


def parse(text: str) -> Guide:
    try:
        return Guide.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as e:
        raise AIError(f"unusable guide: {e}") from e


def url_of(original: str) -> str:
    return f"{original.split('#')[0]}#puremind-vi"


def item_of(guide: Guide, original: Article) -> Item:
    return Item(
        source=SOURCE,
        url=url_of(original.url),
        title=re.sub(r"\s+", " ", guide.title).strip(),
        content=render(guide),
        language="vi",
        kind=KIND,
        license=original.license,
        license_url=original.license_url,
        credit=CREDIT,
        topics=sorted(t.topic for t in original.topics),
        summary=guide.summary.strip(),
        image_url=original.image_url,  # an OWID chart, under the same licence as the text
        published_at=datetime.now(UTC),
        based_on=original.url,
    )


async def write(settings: Settings, original: Article) -> Item:
    """A guide written from `original` (its content loaded)."""
    res = await chat(
        settings,
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(original)}],
        purpose="guide",
        json_schema=GUIDE_SCHEMA,
        max_tokens=4000,
        model=settings.openai_guide_model,
    )
    return item_of(parse(res.text), original)


async def adaptable(
    session: AsyncSession, per_topic: int, topics: list[str] | None, without: ColumnElement[bool]
) -> list[Article]:
    """For each topic, the first articles in the feed that may be adapted (content loaded), leaving out
    those matching `without`: the ones already adapted."""
    picked: dict = {}
    for topic in topics or TOPICS:
        stmt = (
            select(Article)
            .where(
                Article.license.in_(ADAPTABLE),
                Article.kind != KIND,
                Article.word_count >= MIN_WORDS,
                Article.id.in_(select(ArticleTopic.article_id).where(ArticleTopic.topic == topic)),
                ~without,
            )
            .options(undefer(Article.content))
            .order_by(Article.rank.desc())
            .limit(per_topic + len(picked))
        )
        fresh = [a for a in await session.scalars(stmt) if a.id not in picked]
        picked.update((a.id, a) for a in fresh[:per_topic])
    return list(picked.values())


async def originals(session: AsyncSession, per_topic: int, topics: list[str] | None = None) -> list[Article]:
    """Articles to write guides from: those that may be adapted and have no guide yet."""
    guide = aliased(Article)
    return await adaptable(
        session, per_topic, topics, select(guide.id).where(guide.based_on_id == Article.id).exists()
    )
