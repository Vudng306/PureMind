"""Collect a bounded, reusable starter catalog from public content APIs.

Run from backend/: python -m app.scripts.collect_catalog
Only explicitly CC BY / CC0 research full text is retained. No user account is used.
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

OUTPUT = Path(__file__).resolve().parents[1] / "data" / "catalog.json"
EXCLUDED_TITLES = re.compile(
    r"^(correction\b|erratum\b|retraction\b|retracted\b|expression of concern\b)", re.I
)
TOPICS = {
    "Công nghệ và AI": "artificial intelligence",
    "Sức khỏe": "public health",
    "Tâm lý học": "psychology cognition",
    "Môi trường": "climate change biodiversity",
    "Giáo dục": "education learning",
    "Sinh học": "genetics evolution",
    "Kinh tế và xã hội": "health economics",
    "Khoa học tự nhiên": "biophysics",
}


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
    existing = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else {"articles": []}
    articles = {a["id"]: a for a in existing["articles"] if not EXCLUDED_TITLES.match(a["title"])}
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

        for topic, query in TOPICS.items():
            try:
                response = await get(
                    "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                    query=f"({query}) AND OPEN_ACCESS:Y AND IN_EPMC:Y AND LICENSE:cc-by",
                    format="json",
                    resultType="core",
                    pageSize=12,
                )
                saved = 0
                for work in response.json().get("resultList", {}).get("result", []):
                    if EXCLUDED_TITLES.match(work.get("title", "")):
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
                        for parent in body.iter():
                            for child in list(parent):
                                if child.tag in {"fig", "table-wrap", "supplementary-material"}:
                                    parent.remove(child)
                        content = "\n\n".join(
                            " ".join("".join(n.itertext()).split())
                            for n in body.iter()
                            if n.tag in {"title", "p"}
                        )
                        if len(content) < 1000:
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
                            content_note="Văn bản thân bài; hình, bảng và tài liệu bổ sung được lược bỏ. Xem bản gốc để đọc đầy đủ.",
                        )
                        articles[item["id"]] = item
                        saved += 1
                        print(f"Saved [{topic}] {pmcid}: {work['title'][:90]}", flush=True)
                        await asyncio.sleep(1)
                        if saved >= 4:
                            break
                    except Exception as exc:
                        print(f"Article error {pmcid}: {exc!r}", flush=True)
                        errors.append({"url": url, "error": str(exc)[:300]})
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
