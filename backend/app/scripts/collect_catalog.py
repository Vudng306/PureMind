"""Collect a bounded, reusable starter catalog from public content APIs.

Run from backend/: python -m app.scripts.collect_catalog
Only explicitly CC BY / CC0 research full text is retained, with its tables and the captions of its figures; an
article that leans on its figures and tables more than on its words is left out. No user account is used.
Each run starts the catalog over, so it holds what is on the sources now and nothing from an earlier run.
"""

import asyncio
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree

import httpx
from bs4 import BeautifulSoup

from app.services.html_markdown import word_count
from app.services.sources.europepmc import body_markdown, leans_on_visuals

OUTPUT = Path(__file__).resolve().parents[1] / "data" / "catalog.json"
EXCLUDED_TITLES = re.compile(
    r"^(correction\b|erratum\b|retraction\b|retracted\b|expression of concern\b|editorial\b)", re.I
)
SINCE = "2024-01-01"
MIN_WORDS = 600
PER_TOPIC = 4
CANDIDATES = 100
# What a title must say to belong to a topic. A bare search also reads the full text, where "migration" can be
# of cells and any article may mention social media in passing, so a topic is matched on the title alone.
TOPICS = {
    "Tâm lý và các mối quan hệ": (
        "loneliness",
        "lonely",
        "social isolation",
        "social connectedness",
        "friendship",
        "friendships",
        "romantic relationship",
        "romantic relationships",
    ),
    "Mạng xã hội và công nghệ": (
        "social media",
        "social networking",
        "smartphone",
        "smartphones",
        "screen time",
        "digital wellbeing",
        "digital well-being",
    ),
    "Di cư và hòa nhập": (
        "migrant",
        "migrants",
        "immigrant",
        "immigrants",
        "immigration",
        "refugee",
        "refugees",
        "asylum seekers",
        "asylum-seekers",
        "resettlement",
        "acculturation",
        "labour migration",
        "labor migration",
        "forced migration",
        "international migration",
        "late-life migration",
    ),
    "Gia đình và nuôi dạy con": ("parenting", "parent-child", "fatherhood", "motherhood", "grandparents"),
    "Công việc và kinh tế": (
        "labour market",
        "labor market",
        "unemployment",
        "minimum wage",
        "gig workers",
        "gig economy",
        "remote work",
        "workplace",
        "job satisfaction",
        "job burnout",
        "occupational burnout",
        "occupational stress",
        "work stress",
    ),
    "Đô thị và cộng đồng": (
        "neighbourhood",
        "neighbourhoods",
        "neighborhood",
        "neighborhoods",
        "urban planning",
        "urban renewal",
        "urban regeneration",
        "urban revitalization",
        "urban green space",
        "urban parks",
        "gentrification",
        "liveability",
        "walkability",
        "public space",
        "public spaces",
    ),
    "Giáo dục": (
        "higher education",
        "primary school",
        "secondary school",
        "high school",
        "classroom",
        "classrooms",
        "teachers",
        "teaching",
        "online learning",
        "learning outcomes",
        "pedagogy",
    ),
    "Sức khỏe cộng đồng": (
        "public health",
        "health promotion",
        "health inequalities",
        "health equity",
        "population health",
        "tobacco control",
    ),
    "Môi trường": (
        "biodiversity",
        "climate change",
        "deforestation",
        "plastic pollution",
        "ecosystem services",
    ),
}
# Lab and clinical work can name a topic's words without being about the topic for a general reader, and a
# study protocol or a special issue's foreword has no findings to read.
OFF_TOPIC = re.compile(
    r"\b(cells?|stem|neural|neuro\w*|molecular|genes?|genetic|proteins?|metaboli\w*|inflammat\w*|mice|mouse|rats?"
    r"|in vitro|cancers?|tumou?rs?|oncolog\w*|patients?|\w*clinical|hospitals?|surg\w+|therap\w+|treatments?"
    r"|diseases?|disorders?|syndromes?|infections?|dementia|stroke|diabetes|hypertension|atherosclerosis"
    r"|fibrillation|cardio\w*|obesity|adiposity|mortality|autism|protocol|special issue)\b",
    re.I,
)
# Words a topic's own terms often come with when the article is about something else.
OFF_TOPIC_FOR = {
    "Giáo dục": re.compile(r"\b(job satisfaction|burnout|anxiety)\b", re.I),
    "Môi trường": re.compile(r"\b(health|medicines?)\b", re.I),
}


def search_query(topic):
    terms = " OR ".join(f'"{term}"' for term in TOPICS[topic])
    return f"TITLE:({terms}) AND OPEN_ACCESS:Y AND IN_EPMC:Y AND LICENSE:cc-by"


def fits_topic(topic, title):
    terms = "|".join(re.escape(term) for term in TOPICS[topic])
    if not re.search(rf"\b({terms})\b", title, re.I) or OFF_TOPIC.search(title):
        return False
    other = OFF_TOPIC_FOR.get(topic)
    return not (other and other.search(title))


def text(node):
    return node.get_text(" ", strip=True) if node else ""


def record(url, **fields):
    return {
        "id": hashlib.sha256(url.encode()).hexdigest()[:20],
        "url": url,
        "collected_at": datetime.now(UTC).isoformat(),
        **fields,
    }


async def collect():
    articles: dict[str, dict] = {}
    errors = []
    with httpx.Client(
        timeout=20,
        follow_redirects=True,
        headers={"User-Agent": "PureMindCatalog/0.1 (educational open-content collection)"},
    ) as client:

        async def get(url, **params):
            for attempt in range(3):
                print(f"Fetching {url}", flush=True)
                response = await asyncio.to_thread(client.get, url, params=params)
                if response.status_code in (429, 502, 503, 504) and attempt < 2:
                    await asyncio.sleep(min(30, 3 * (attempt + 1)))
                    continue
                response.raise_for_status()
                return response
            raise RuntimeError("Retry limit")

        for topic in TOPICS:
            try:
                response = await get(
                    "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                    query=f"{search_query(topic)} AND FIRST_PDATE:[{SINCE} TO 2100-12-31]",
                    format="json",
                    resultType="core",
                    pageSize=CANDIDATES,
                )
                saved = 0
                for work in response.json().get("resultList", {}).get("result", []):
                    title = work.get("title", "")
                    if EXCLUDED_TITLES.match(title) or not fits_topic(topic, title):
                        continue
                    pmcid = work.get("pmcid")
                    if not pmcid or not re.fullmatch(r"PMC\d+", pmcid):
                        continue
                    url = f"https://europepmc.org/articles/{pmcid}"
                    key = hashlib.sha256(url.encode()).hexdigest()[:20]
                    if key in articles:
                        continue
                    try:
                        response = await get(
                            f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
                        )
                        root = ElementTree.fromstring(response.content)
                        license_nodes = root.findall(".//permissions/license")
                        license_text = " ".join(" ".join(n.itertext()) for n in license_nodes)
                        links = []
                        for license_node in license_nodes:
                            for node in license_node.iter():
                                links.extend(node.attrib.values())
                                links.append((node.text or "").strip())
                        license_url = next(
                            (
                                link
                                for link in links
                                if re.match(
                                    r"https?://creativecommons.org/(licenses/by/|publicdomain/zero/)", link
                                )
                            ),
                            "",
                        )
                        if not license_url:
                            continue
                        body = root.find("body")
                        if body is None:
                            continue
                        content = body_markdown(root)
                        words = word_count(content)
                        if words < MIN_WORDS or leans_on_visuals(body, words):
                            continue
                        abstract = BeautifulSoup(work.get("abstractText", ""), "html.parser").get_text(
                            " ", strip=True
                        )
                        item = record(
                            url,
                            title=work["title"],
                            topic=topic,
                            kind="research",
                            language="en",
                            source="Europe PMC",
                            authors=work.get("authorString", ""),
                            published_at=work.get("firstPublicationDate"),
                            doi=work.get("doi"),
                            content=content,
                            description=(abstract or content)[:1000],
                            abstract=abstract,
                            license="CC0" if "/zero/" in license_url else "CC BY",
                            license_url=license_url,
                            license_statement=license_text,
                            attribution_url=url,
                            content_note="Văn bản thân bài kèm bảng và chú thích hình; ảnh, công thức và tài liệu bổ sung được lược bỏ. Xem bản gốc để đọc đầy đủ.",
                        )
                        articles[item["id"]] = item
                        saved += 1
                        print(f"Saved [{topic}] {pmcid}: {work['title'][:90]}", flush=True)
                        await asyncio.sleep(1)
                        if saved >= PER_TOPIC:
                            break
                    except Exception as exc:
                        print(f"Article error {pmcid}: {exc!r}", flush=True)
                        errors.append({"url": url, "error": str(exc)[:300]})
                if saved < PER_TOPIC:
                    errors.append({"topic": topic, "error": f"only {saved} of {PER_TOPIC} articles fit"})
            except Exception as exc:
                errors.append({"topic": topic, "source": "Europe PMC", "error": str(exc)[:300]})
            payload = {"updated_at": datetime.now(UTC).isoformat(), "articles": list(articles.values())}
            temporary = OUTPUT.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(OUTPUT)
            print(f"Checkpoint: {len(articles)} articles", flush=True)
    report = {
        "total": len(articles),
        "by_topic": dict(Counter(a["topic"] for a in articles.values())),
        "by_kind": dict(Counter(a["kind"] for a in articles.values())),
        "errors": errors,
    }
    OUTPUT.with_name("catalog-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(collect())
