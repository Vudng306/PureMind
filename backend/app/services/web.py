"""Save-by-link fetching with SSRF protection and article extraction (SRS FR-DOC-03, NFR-SEC-05)."""

import asyncio
import ipaddress
import json
import re
import socket
from dataclasses import dataclass
from datetime import datetime

import httpx
from bs4 import BeautifulSoup, Tag

from app.services.html_markdown import absolutize_images, clean_soup, html_to_markdown, word_count

TIMEOUT_SECONDS = 20
MAX_REDIRECTS = 5
MAX_BYTES = 20 * 1024 * 1024
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0 Safari/537.36 PureMindReader/1.0"
)
# The site refuses the request itself (not a network problem): retrying will not help.
REFUSED_STATUSES = {401, 403, 407, 429, 451}


def user_agent(contact: str = "") -> str:
    """Wikimedia and others block crawlers that give no way to contact their operator."""
    contact = re.sub(r"[\x00-\x1f()]", "", contact).strip()
    return f"{USER_AGENT} (+{contact})" if contact else USER_AGENT


class InvalidUrl(Exception):  # MSG-16
    pass


class BlockedAddress(Exception):  # MSG-17
    pass


class FetchFailed(Exception):  # MSG-18
    pass


class FetchRefused(FetchFailed):  # MSG-18, with a hint to upload the page as a PDF instead
    pass


@dataclass
class FetchResult:
    url: str
    content_type: str
    body: bytes


def validate_url(raw: str) -> httpx.URL:
    raw = (raw or "").strip()
    if not raw or len(raw) > 2048:
        raise InvalidUrl
    try:
        url = httpx.URL(raw)
    except Exception as e:
        raise InvalidUrl from e
    if url.scheme not in ("http", "https") or not url.host or url.userinfo:
        raise InvalidUrl
    return url


def is_public_ip(value: str) -> bool:
    ip = ipaddress.ip_address(value.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


async def resolve_host(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise FetchFailed from e
    return list(dict.fromkeys(info[4][0] for info in infos))


def make_transport() -> httpx.AsyncBaseTransport:
    return httpx.AsyncHTTPTransport(retries=0)


async def _checked_ips(url: httpx.URL) -> list[str]:
    host = url.host
    try:
        ipaddress.ip_address(host)
        ips = [host]
    except ValueError:
        ips = await resolve_host(host, url.port or (443 if url.scheme == "https" else 80))
    if not ips:
        raise FetchFailed
    # Every resolved address must be public, otherwise a DNS answer could mix in an internal one.
    if not all(is_public_ip(ip) for ip in ips):
        raise BlockedAddress
    # Prefer IPv4: many hosts (and Docker networks) have no IPv6 route.
    return sorted(ips, key=lambda ip: ":" in ip)


async def _send_pinned(
    client: httpx.AsyncClient, url: httpx.URL, ips: list[str], agent: str
) -> httpx.Response:
    """Connect to a vetted IP (no second DNS lookup, so no DNS rebinding) while keeping Host and TLS SNI."""
    host_header = url.host if url.port is None else f"{url.host}:{url.port}"
    last_error: Exception | None = None
    for ip in ips:
        request = client.build_request(
            "GET",
            url.copy_with(host=ip),
            headers={
                "Host": host_header,
                "User-Agent": agent,
                "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
                "Accept-Language": "vi,en;q=0.8",
            },
            extensions={"sni_hostname": url.host} if url.scheme == "https" else {},
        )
        try:
            return await client.send(request, stream=True)
        except httpx.ConnectError as e:
            last_error = e
    raise FetchFailed from last_error


async def fetch_url(raw_url: str, contact: str = "") -> FetchResult:
    url = validate_url(raw_url)
    agent = user_agent(contact)
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async with httpx.AsyncClient(transport=make_transport(), follow_redirects=False) as client:
                for _ in range(MAX_REDIRECTS + 1):
                    response = await _send_pinned(client, url, await _checked_ips(url), agent)
                    try:
                        if response.is_redirect:
                            location = response.headers.get("location")
                            if not location:
                                raise FetchFailed
                            url = validate_url(str(url.join(location)))
                            continue
                        if response.status_code in REFUSED_STATUSES:
                            raise FetchRefused
                        if response.status_code >= 400:
                            raise FetchFailed
                        declared = int(response.headers.get("content-length") or 0)
                        if declared > MAX_BYTES:
                            raise FetchFailed
                        body = bytearray()
                        async for chunk in response.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > MAX_BYTES:
                                raise FetchFailed
                        return FetchResult(
                            url=str(url),
                            content_type=response.headers.get("content-type", "")
                            .split(";")[0]
                            .strip()
                            .lower(),
                            body=bytes(body),
                        )
                    finally:
                        await response.aclose()
                raise FetchFailed  # too many redirects
    except InvalidUrl:
        raise
    except BlockedAddress:
        raise
    except (httpx.HTTPError, TimeoutError, OSError, ValueError) as e:
        raise FetchFailed from e


def is_pdf(result: FetchResult) -> bool:
    return (
        result.content_type == "application/pdf"
        or httpx.URL(result.url).path.lower().endswith(".pdf")
        or result.body.startswith(b"%PDF")
    )


# ---------------------------------------------------------------- article extraction

NEGATIVE = re.compile(
    r"comment|sidebar|footer|foot|menu|nav|share|social|related|advert|\bad-|promo|cookie|popup|modal|subscribe|"
    r"newsletter|breadcrumb|widget|banner|sponsor|recommend|"
    # "read also" boxes, e.g. vnexpress.net <div class="list_link"> (titles only, links added by script)
    r"list[_-]?(links?|news)|more[_-]?(news|stories|articles)|read[_-]?(more|also)|lien[_-]?quan|xem[_-]?them|"
    # Encyclopaedia and journal furniture: the citation list is longer than the article on Wikipedia,
    # and "noprint" is what a page itself calls the parts nobody wants on paper.
    r"\breferences?\b|\breflist|\bbibliograph|\bnoprint|\bnavbox|\bcatlinks|editsection|sistersite",
    re.I,
)
POSITIVE = re.compile(r"article|content|post|entry|story|main|body|text|blog", re.I)


@dataclass
class Article:
    title: str
    content: str
    word_count: int
    published_at: datetime | None


def _hint(tag: Tag) -> str:
    return " ".join([*(tag.get("class") or []), tag.get("id") or ""])


def _link_density(tag: Tag) -> float:
    text_len = len(tag.get_text(" ", strip=True))
    if not text_len:
        return 1.0
    link_len = sum(len(a.get_text(" ", strip=True)) for a in tag.find_all("a"))
    return link_len / text_len


def _paragraph_chars(tag: Tag) -> int:
    """Length of the prose (paragraphs of 25+ chars) inside `tag`."""
    lengths = (len(p.get_text(" ", strip=True)) for p in tag.find_all(["p", "pre", "blockquote"]))
    return sum(n for n in lengths if n >= 25)


HIDDEN_CLASSES = {"hidden", "d-none", "is-hidden", "visually-hidden", "sr-only"}
HIDDEN_STYLE = re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden", re.I)


def _is_hidden(tag: Tag) -> bool:
    return (
        tag.has_attr("hidden")
        or tag.get("aria-hidden") == "true"
        or not HIDDEN_CLASSES.isdisjoint(tag.get("class") or [])
        or bool(HIDDEN_STYLE.search(tag.get("style") or ""))
    )


def _drop_link_lists(container: Tag) -> None:
    """Removes "related articles" blocks inside the article: lists/boxes made mostly of links."""
    total = len(container.get_text(" ", strip=True))
    for tag in container.find_all(["ul", "ol", "div", "section"]):
        if tag.decomposed:
            continue
        text = len(tag.get_text(" ", strip=True))
        if text and text < total / 2 and tag.find("a") and _link_density(tag) > 0.5:
            tag.decompose()


def _same_text(a: str, b: str) -> bool:
    """Equal ignoring case, punctuation and Markdown escapes."""

    def norm(s: str) -> str:
        return re.sub(r"\W+", " ", s.replace("\\", "")).strip().casefold()

    return norm(a) == norm(b)


def _meta(soup: BeautifulSoup, *names: str) -> str | None:
    for name in names:
        el = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
        if el and el.get("content"):
            return el["content"].strip()
    return None


MIN_WORDS = 150
MIN_SHARE = 0.25  # of the page's own prose, below which the extraction looks like a failure


def _ld_body(soup: BeautifulSoup) -> str:
    """The article text a page publishes as schema.org metadata, if any.

    A last resort for pages whose markup defeats the scoring: no images and no headings, but the whole
    article instead of a fragment. Must be read before `clean_soup`, which strips every <script>.
    """
    best = ""
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "")
        except (ValueError, TypeError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                stack.extend(v for v in node.values() if isinstance(v, dict | list))
                body = node.get("articleBody")
                if isinstance(body, str) and len(body) > len(best):
                    best = body
    paragraphs = (re.sub(r"[ \t]+", " ", line).strip() for line in best.splitlines())
    # The text is plain, so the Markdown characters in it are literal.
    return "\n\n".join(re.sub(r"[*_`\[\]|]", lambda m: "\\" + m.group(), para) for para in paragraphs if para)


def _widen(tag: Tag) -> Tag:
    """Rise from the winning block to the one that holds the whole article.

    Some sites wrap every paragraph in its own div (arXiv's LaTeXML) and others cut the article into
    sibling chunks with advertisements between them (Wired). The winner is then one piece of the article,
    and its parent is the article: we keep rising while the parent brings real prose and no navigation.
    """
    best, prose = tag, _paragraph_chars(tag)
    parent = tag.parent
    while isinstance(parent, Tag) and parent.name not in ("body", "html"):
        wider = _paragraph_chars(parent)
        if _link_density(parent) > 0.5:
            break  # navigation around the article
        if wider >= prose * 1.25:
            best, prose = parent, wider  # the parent brings the rest of the article
        elif wider > prose * 1.02:
            break  # it only adds a line or two: that is the page around the article, not the article
        # else: a wrapper holding the same text — keep rising to look for the real container
        parent = parent.parent
    return best


def _best_container(soup: BeautifulSoup) -> Tag:
    scores: dict[int, tuple[float, Tag]] = {}
    total = _paragraph_chars(soup)

    def add(tag: Tag | None, points: float):
        if tag is None or not isinstance(tag, Tag):
            return
        if id(tag) not in scores:
            base = {"article": 10, "main": 8, "section": 3, "div": 5}.get(tag.name, 0)
            hint = _hint(tag)
            if POSITIVE.search(hint):
                base += 25
            # A name is a hint, the text is evidence: 24h.com.vn calls its article body
            # "cate-24h-foot-arti-deta-info", and the block holding most of the page's prose is the
            # article whatever it is called.
            if NEGATIVE.search(hint) and not (total and _paragraph_chars(tag) > total * 0.4):
                base -= 25
            scores[id(tag)] = (base, tag)
        current, t = scores[id(tag)]
        scores[id(tag)] = (current + points, t)

    for p in soup.find_all(["p", "pre", "blockquote"]):
        text = p.get_text(" ", strip=True)
        if len(text) < 25:
            continue
        points = 1 + text.count(",") + text.count("،") + min(len(text) / 100, 3)
        add(p.parent, points)
        if p.parent is not None:
            add(p.parent.parent, points / 2)

    best: Tag | None = None
    best_score = 0.0
    for score, tag in scores.values():
        # A container made mostly of links (> 50%) is navigation, not content.
        density = _link_density(tag)
        if density > 0.5:
            continue
        final = score * (1 - density)
        if final > best_score:
            best, best_score = tag, final
    return _widen(best) if best is not None else (soup.body or soup)


def _content(html: bytes, url: str, title: str, *, drop_hidden: bool, drop_named: bool) -> tuple[str, float]:
    """Prune the page, pick the article out of what is left, and say how much of the page it holds."""
    soup = BeautifulSoup(html, "html.parser")
    clean_soup(soup)
    total = _paragraph_chars(soup)
    for tag in soup.find_all(True):
        if tag.decomposed or tag.name in ("html", "body"):
            continue
        if drop_hidden and _is_hidden(tag):
            tag.decompose()
            continue
        hint = _hint(tag)
        if drop_named and hint and NEGATIVE.search(hint) and not POSITIVE.search(hint):
            # Some sites wrap the whole article in e.g. "sidebar-1": keep a wrapper holding most of the text.
            if total and _paragraph_chars(tag) > total / 2:
                continue
            tag.decompose()

    container = _best_container(soup)
    share = _paragraph_chars(container) / total if total else 1.0
    _drop_link_lists(container)
    absolutize_images(container, url)
    content = html_to_markdown(container)
    # The reader already shows the title: drop a leading "# Title" repeating it.
    first, _, rest = content.partition("\n\n")
    if re.fullmatch(r"#{1,3} (.+)", first) and _same_text(first.lstrip("# "), title):
        content = rest
    return content, share


def extract_article(html: bytes, url: str) -> Article:
    soup = BeautifulSoup(html, "html.parser")
    ld_body = _ld_body(soup)  # read before clean_soup drops the <script> tags
    title = _meta(soup, "og:title", "twitter:title")
    if not title and soup.title and soup.title.string:
        title = soup.title.string.strip()
    if not title:
        h1 = soup.find("h1")
        title = h1.get_text(" ", strip=True) if h1 else httpx.URL(url).host

    published_at = None
    if raw := _meta(soup, "article:published_time", "datePublished"):
        try:
            published_at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            published_at = None

    # Pruning is a guess, and on a few sites it throws the article away: LessWrong wraps the post in
    # <div class="commentOnSelection">, React streams the body inside <div hidden id="S:1">, others
    # animate a display:none wrapper into view. When being strict leaves us with nothing, loosen one
    # rule at a time and let the scoring decide instead.
    content, share = _content(html, url, title, drop_hidden=True, drop_named=True)
    for hidden, named in ((False, True), (True, False), (False, False)):
        # A short article is fine as long as it is most of what the page has to say; it is holding
        # almost none of the page's prose that means the pruning took the article with it.
        if word_count(content) >= MIN_WORDS or share >= MIN_SHARE:
            break
        looser, wider = _content(html, url, title, drop_hidden=hidden, drop_named=named)
        if word_count(looser) > word_count(content):
            content, share = looser, wider
    # Still nothing readable in the markup: take the plain text the page publishes about itself
    # rather than saving an empty document.
    if word_count(content) < MIN_WORDS and word_count(ld_body) > word_count(content):
        content = ld_body
    return Article(
        title=title[:500], content=content, word_count=word_count(content), published_at=published_at
    )
