"""Minimal, dependency-light HTML -> Markdown conversion shared by EPUB and web extraction.

Output uses only the Markdown subset the frontend clean-text renderer understands:
headings, paragraphs, blockquotes, fenced code, lists, tables, **bold**, *italic*, `code`, [links](http...).
"""

import re

from bs4 import BeautifulSoup, NavigableString, Tag
from bs4.element import PreformattedString

STRIP_TAGS = ["script", "style", "noscript", "template", "svg", "canvas", "nav", "header", "footer", "form",
              "iframe", "button", "input", "select", "textarea", "aside"]
BLOCK_TAGS = {"p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
              "ul", "ol", "li", "table", "figure", "figcaption", "hr", "dl", "dt", "dd", "body", "html"}


NESTED_ITEM = re.compile(r"^\s+(-|\d+\.)\s")


def _escape(text: str) -> str:
    return re.sub(r"([*_`\[\]|])", r"\\\1", text)


def _inline(node, *, in_code: bool = False) -> str:
    if isinstance(node, NavigableString):
        text = str(node)
        if in_code:
            return text
        return _escape(re.sub(r"\s+", " ", text))
    if not isinstance(node, Tag):
        return ""
    name = node.name
    if name == "br":
        return " "
    if name == "img":
        return "*[Hình ảnh]*"
    inner = "".join(_inline(c, in_code=in_code or name == "code") for c in node.children)
    stripped = inner.strip()
    if not stripped:
        return inner
    if name in ("strong", "b"):
        return f"**{stripped}**"
    if name in ("em", "i"):
        return f"*{stripped}*"
    if name == "code" and not in_code:
        return f"`{stripped.replace('`', '')}`"
    if name == "a":
        href = (node.get("href") or "").strip()
        if re.match(r"^https?://", href, re.I):
            return f"[{stripped}]({href.replace(')', '%29').replace(' ', '%20')})"
    return inner


def _has_block_children(tag: Tag) -> bool:
    return any(isinstance(c, Tag) and c.name in BLOCK_TAGS for c in tag.children)


def _table(tag: Tag) -> str:
    rows = []
    for tr in tag.find_all("tr"):
        cells = [_inline(c).strip().replace("\n", " ") for c in tr.find_all(["th", "td"])]
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def _blocks(tag: Tag, out: list[str], list_depth: int = 0) -> None:
    buffer: list[str] = []

    def flush():
        text = re.sub(r"\s+", " ", "".join(buffer)).strip()
        buffer.clear()
        if text:
            out.append(text)

    for child in tag.children:
        if isinstance(child, NavigableString):
            buffer.append(_inline(child))
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name
        if name not in BLOCK_TAGS:
            buffer.append(_inline(child))
            continue
        flush()
        if re.fullmatch(r"h[1-6]", name):
            level = min(int(name[1]), 3)
            text = re.sub(r"\s+", " ", _inline(child)).strip().replace("**", "")
            if text:
                out.append("#" * level + " " + text)
        elif name == "hr":
            continue
        elif name == "pre":
            code = child.get_text().strip("\n")
            if code.strip():
                out.append("```\n" + code.replace("```", "ʼʼʼ") + "\n```")
        elif name == "blockquote":
            inner: list[str] = []
            _blocks(child, inner, list_depth)
            if inner:
                out.append("\n".join("> " + line for block in inner for line in block.split("\n")))
        elif name in ("ul", "ol"):
            items = []
            for i, li in enumerate(child.find_all("li", recursive=False), start=1):
                parts: list[str] = []
                _blocks(li, parts, list_depth + 1)
                nested_prefix = "  " * (list_depth + 1)
                nested = [p for p in parts if p.startswith(nested_prefix) and NESTED_ITEM.match(p)]
                text = " ".join(p for p in parts if p not in nested).strip()
                if text:
                    marker = f"{i}." if name == "ol" else "-"
                    items.append("  " * list_depth + f"{marker} {text}")
                items.extend(nested)
            if items:
                out.append("\n".join(items))
        elif name == "table":
            table = _table(child)
            if table:
                out.append(table)
        elif _has_block_children(child) or name in ("li", "dd", "dt", "figcaption", "p"):
            _blocks(child, out, list_depth)
        else:
            _blocks(child, out, list_depth)
    flush()


PERMALINK_TEXT = {"¶", "#", "§", "🔗"}


def clean_soup(soup: BeautifulSoup) -> None:
    for t in soup.find_all(STRIP_TAGS):
        t.decompose()
    # <!-- comments -->, <!DOCTYPE>, CDATA... are strings too, but never visible text.
    for s in soup.find_all(string=lambda s: isinstance(s, PreformattedString)):
        s.extract()
    # Heading permalink anchors ("¶", "#") are navigation chrome, not content.
    for a in soup.find_all("a"):
        classes = " ".join(a.get("class") or []).lower()
        if a.get_text(strip=True) in PERMALINK_TEXT or "headerlink" in classes or "anchor" in classes:
            a.decompose()


def html_to_markdown(root: Tag) -> str:
    out: list[str] = []
    _blocks(root, out)
    return "\n\n".join(b for b in out if b.strip())


def word_count(markdown: str) -> int:
    return len(re.findall(r"\w+", markdown))
