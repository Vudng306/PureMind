"""Quick Reads: what a shared catalog article says, in Vietnamese, in under a minute.

The first level of reading an article on /explore; the original is the other. They are written ahead of time
for the hand-curated catalog only (scripts/write_quick_reads), once, and read by everyone, so the catalog's
articles (CC BY) are credited and the reader is told an AI wrote this and can report a mistake.

A short (services/shorts) is a door to an article and is given its first pages. A Quick Read speaks for the
whole study, so it is given the whole text: in most catalog articles the results come after those first pages.
"""

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from app.core.config import Settings
from app.services.guides import _strict
from app.services.openai_client import AIError, chat

OUTPUT = Path(__file__).resolve().parents[1] / "data" / "catalog-quick.json"
NUMBER = re.compile(r"\d[\d.,]*")
MAX_WORDS = 200  # as a space counts them, so Vietnamese syllables: about 45 seconds
LONG_ENOUGH = 2200  # words, ten minutes: shorter than this needs no summary
ATTEMPTS = 2  # the model sometimes overruns the shape; once more usually keeps to it


class Draft(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    problem: str = Field(min_length=1, max_length=600)
    points: list[str] = Field(min_length=3, max_length=3)
    conclusion: str = Field(min_length=1, max_length=400)
    results_complete: bool


QUICK_READ_SCHEMA = {
    "name": "quick_read",
    "strict": True,
    "schema": _strict(
        {
            "title": {"type": "string"},
            "problem": {"type": "string"},
            "points": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 3},
            "conclusion": {"type": "string"},
            "results_complete": {"type": "boolean"},
        }
    ),
}

SYSTEM = """You write Quick Reads in Vietnamese for PureMind, a reading app for curious Vietnamese adults. You \
are given the text of one openly licensed research article, usually in English, and say what it found in \
something that can be read in under a minute.

Facts:
- Use only what the text states. Add no number, name, finding, cause, advice or conclusion of your own, and \
copy every number exactly as the text gives it.
- Say who and what was studied, and do not stretch a finding beyond them. Keep each claim as strong as the \
authors make it, no stronger, and do not turn a correlation into a cause. A small or qualitative study \
reports what its participants said or did: say so, and write "decisive" or "a large effect" only if the \
authors do.
- The text leaves out images, formulas and supplements. A finding that the text only points to ("see Figure \
2") without stating it is unknown to you: do not guess it. If that leaves you unable to report the main \
results, say what was studied and how instead of presenting a result, and set results_complete to false.

Shape (JSON):
- title: the question the study asks or what it found, at most 80 characters; honest, no clickbait.
- problem: one sentence of at most 30 words: what was asked and why it matters.
- points: exactly three, each one sentence of at most 28 words: who was studied and how, then the main \
findings; plain text, no Markdown.
- conclusion: one sentence of at most 25 words, the authors' conclusion as far as they take it.
- results_complete: true if the main results are stated in the text and you reported them.

A word is whatever a space separates, so Vietnamese takes these limits fast: be brief, in plain, natural \
Vietnamese. Do not mention "the article" or "bài viết"."""

REMINDER = """That is the whole article. Now write its Quick Read in Vietnamese: a problem of at most 30 words, \
exactly three points of at most 28 words each, a conclusion of at most 25 words, nothing the text does not \
state."""


def _line(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("**", "")).strip()


def parse(text: str) -> Draft:
    try:
        draft = Draft.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as e:
        raise AIError(f"unusable quick read: {e}") from e
    return Draft(
        title=_line(draft.title),
        problem=_line(draft.problem),
        points=[_line(p) for p in draft.points],
        conclusion=_line(draft.conclusion),
        results_complete=draft.results_complete,
    )


def _written(draft: Draft) -> str:
    return " ".join([draft.title, draft.problem, *draft.points, draft.conclusion])


def _numbers(text: str) -> set[str]:
    """The numbers in a text, whichever way it groups digits: 2,798 and 2.798 are one number."""
    return {re.sub(r"\D", "", n) for n in NUMBER.findall(text)}


def added_numbers(draft: Draft, source: str) -> set[str]:
    """The numbers in a draft that its source never states, which the model must have made up."""
    return _numbers(_written(draft)) - _numbers(source)


def words(draft: Draft) -> int:
    return len(_written(draft).split())


def check(draft: Draft, source: str) -> Draft:
    """The draft, if it can stand as a Quick Read of `source`."""
    if added := added_numbers(draft, source):
        raise AIError(f"numbers not in the article: {', '.join(sorted(added))}")
    if words(draft) > MAX_WORDS:
        raise AIError(f"too long: {words(draft)} words")
    return draft


def _source(article: dict) -> str:
    return f"Title: {article['title']}\nBy: {article['authors']}\n\n{article['content']}"


async def write(settings: Settings, article: dict) -> dict:
    """The Quick Read of a catalog article, as the catalog keeps it."""
    source = _source(article)
    messages = [
        {"role": "system", "content": SYSTEM},
        # After thousands of words of article the shape needs saying again.
        {"role": "user", "content": f"{source}\n\n---\n{REMINDER}"},
    ]
    last: AIError | None = None
    for _ in range(ATTEMPTS):
        try:
            res = await chat(
                settings,
                messages,
                purpose="quick_read",
                json_schema=QUICK_READ_SCHEMA,
                max_tokens=1000,
                model=settings.openai_guide_model,
            )
            draft = check(parse(res.text), source)
        except AIError as e:
            last = e
            continue
        return {**draft.model_dump(), "written_at": datetime.now(UTC).date().isoformat()}
    assert last is not None
    raise last


def wanted_for(article: dict) -> bool:
    """Whether an article should have a Quick Read: too long to read at once, under a licence that allows one."""
    return article["word_count"] > LONG_ENOUGH and "ND" not in article["license"]


def load(path: Path = OUTPUT) -> dict[str, dict]:
    """The Quick Reads written so far, by the id of their article."""
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def save(quick: dict[str, dict], path: Path = OUTPUT) -> None:
    # Whole or not at all: the API may read this file at any moment.
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(quick, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
