"""The checks before a post goes public (Publish flow). Errors stop publishing; warnings are for the author.

These look for mistakes of form and of licence. They do not judge whether a post is true, and a passed check does
not mean a post is free of copyright problems, which is why the author still confirms their rights.
"""

import re
from dataclasses import dataclass

from app.core.messages import MSG
from app.models import MAX_POST_CARDS, MIN_POST_CARDS, Post
from app.services.rights import no_derivatives

OVERLAP_WORDS = 40  # consecutive words: long past a fair quotation
_WORD = re.compile(r"\w+")


@dataclass(frozen=True)
class Issue:
    code: str
    level: str  # "error" stops publishing, "warning" does not
    message: str


def _error(code: str, **kw) -> Issue:
    return Issue(code, "error", MSG[code].format(**kw))


def _warning(code: str, **kw) -> Issue:
    return Issue(code, "warning", MSG[code].format(**kw))


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text)]


def longest_overlap(text: str, source: str, *, at_least: int = OVERLAP_WORDS) -> int:
    """The most consecutive words `text` shares with `source`, or 0 if fewer than `at_least`."""
    words, other = _words(text), _words(source)
    if len(words) < at_least or len(other) < at_least:
        return 0
    seen = {tuple(other[i : i + at_least]) for i in range(len(other) - at_least + 1)}
    best = 0
    i = 0
    while i <= len(words) - at_least:
        if tuple(words[i : i + at_least]) not in seen:
            i += 1
            continue
        # A match: walk it forward a word at a time.
        n = at_least
        while i + n < len(words) and tuple(words[i + n - at_least + 1 : i + n + 1]) in seen:
            n += 1
        best = max(best, n)
        i += n
    return best


def post_text(post: Post) -> str:
    cards = " ".join(f"{c.get('heading', '')} {c.get('body', '')}" for c in post.cards or [])
    return f"{post.title} {cards} {post.body}"


def check(post: Post, source_texts: dict) -> list[Issue]:
    """`source_texts` holds the clean text of each source still in the library, by document id."""
    issues: list[Issue] = []
    cards = post.cards or []
    if not post.title.strip():
        issues.append(_error("CHECK-TITLE"))
    if not post.topic:
        issues.append(_error("CHECK-TOPIC"))
    if post.kind == "link":
        if len(cards) != 1 or not str(cards[0].get("body", "")).strip():
            issues.append(_error("CHECK-LINK-CARD"))
        if not any(s.url and s.shown for s in post.sources):
            issues.append(_error("CHECK-LINK-URL"))
    else:
        if not MIN_POST_CARDS <= len(cards) <= MAX_POST_CARDS:
            issues.append(_error("CHECK-CARD-COUNT"))
        if any(not str(c.get("body", "")).strip() for c in cards):
            issues.append(_error("CHECK-CARD-EMPTY"))
    if post.kind == "summary" and not any(s.shown for s in post.sources):
        issues.append(_error("CHECK-SOURCE-REQUIRED"))

    text = post_text(post)
    for source in post.sources:
        nd = no_derivatives(source.license)
        if source.license and not source.shown:
            issues.append(_error("CHECK-CREDIT-REQUIRED", title=source.title))
        if nd and post.kind == "summary":
            issues.append(_error("CHECK-SUMMARY-ND", title=source.title))
        elif nd and post.ai_assisted and post.kind != "link":
            issues.append(_error("CHECK-AI-ND", title=source.title))
        elif nd and post.kind != "link":
            issues.append(_warning("CHECK-ND-SOURCE", title=source.title))
        if words := longest_overlap(text, source_texts.get(source.document_id, "")):
            make = _error if nd else _warning
            issues.append(make("CHECK-OVERLAP-ND" if nd else "CHECK-OVERLAP", words=words, title=source.title))
    return issues
