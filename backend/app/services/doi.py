"""DOIs as PureMind keeps them: the bare, lower-cased form stored in a citation, and the doi.org address."""

import re
from urllib.parse import unquote

# The prefix is "10." and a registrant number; the suffix is whatever the publisher made up.
DOI = re.compile(r"10\.\d{4,9}/\S+", re.I)
PREFIXES = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.I)
MAX_DOI = 300


class InvalidDoi(Exception):
    pass


def parse(raw: str) -> str:
    """The bare DOI in what the user pasted: "10.1000/x", "doi:10.1000/x" or a doi.org link."""
    value = unquote(PREFIXES.sub("", (raw or "").strip()))
    match = DOI.fullmatch(value)
    if not match or len(value) > MAX_DOI:
        raise InvalidDoi
    return value.rstrip(".,;").lower()  # DOIs are case-insensitive; punctuation comes along from a sentence
