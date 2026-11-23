"""Clean Reader benchmark (SRS PM-CR-SRS-001 section 9, TSD section 13.2): runs a PDF extractor on a fixed set
of PDFs and measures what ends up in the reading flow against labels a person gave the PDF's text.

    cd backend
    .venv/Scripts/python.exe -X utf8 -m evals.run_clean_reader                  # every PDF, the extractor today
    .venv/Scripts/python.exe -X utf8 -m evals.run_clean_reader paper-arxiv-ai   # one of them
    .venv/Scripts/python.exe -X utf8 -m evals.run_clean_reader --adapter NAME   # another extractor (ADAPTERS)

The PDFs are not in git: evals/clean_reader/labels.json names each file, expected in evals/clean_reader/pdfs/,
and the first digits of its SHA-256. A PDF that is missing is skipped and reported. No database, no OpenAI:
OCR of scanned pages needs the user's AI consent in the app, so here scanned pages stay unread.

What it writes: evals/clean_reader/results/<adapter>.md (scores and every miss) and <adapter>.json.
results/baseline.json is the extractor before the Clean Reader work (commit 5987a7a, run 2026-11-16), kept as
it was: every report shows the change from it.

The scores (SRS CR-NFR-01..03, proposed targets in brackets):
- main kept: share of MAIN labels (body, abstract, headings, captions…) found in the reading flow. One minus
  it is the false omission rate [<= 1 %].
- furniture suppressed: share of running headers, footers, page numbers, watermarks and web page chrome not in
  the reading flow [>= 90 %].
- metadata / supplementary separated: share of authors, affiliations, publisher lines, keywords (metadata) and
  references, acknowledgements, funding, declarations, table of contents (supplementary) not interleaved with
  the reading flow. The SRS wants them in their own place, not deleted.
- kept somewhere: share of labels other than MAIN still held in the extractor's output, in the flow or in a side
  store (R1: nothing is thrown away). The current extractor has no side store: what it leaves out of the flow
  it deletes.
- reading order: share of labelled pairs [a, b] found with a before b [>= 95 %]; a pair with a missing end is
  counted apart, not as right or wrong.
- typed right: of the labels found in the side store, the share filed under the right group (for an
  extractor that types its blocks).
- words rejoined: of the words the PDF breaks at a line end with a hyphen ("defi-" / "nition") and prints whole
  elsewhere in the same file, the share that the flow never shows split ("defi-nition", or with a soft
  hyphen U+00AD left inside) (TC-11). Found from the PDF's own text, not from labels.
- source on the PDF: of the body labels in the flow (abstract, headings, body, captions…), the share whose
  block opens a box on the page where the PDF prints those words [>= 95 %, CR-NFR-04]. The words' place is
  found with PyMuPDF's search, not labelled; a label it cannot find is left out and counted apart.
- time to extract: p50 and p95 seconds by group (CR-NFR-07), without OCR or AI.

The checks match text, so they are a floor: a label found means its words are there in that place, not that
the block around it is right. Labels are short and taken from the PDF's own text layer.
"""

import argparse
import hashlib
import json
import math
import re
import sys
import tempfile
import time
import unicodedata
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import pymupdf

from app.services import extraction
from evals.progress import Progress

HERE = Path(__file__).parent / "clean_reader"
PDFS = HERE / "pdfs"
RESULTS = HERE / "results"

# TSD 4.2: what each type of block is, and so where it belongs.
GROUPS = {
    "MAIN": [
        "TITLE", "ABSTRACT", "SECTION_HEADING", "BODY", "LIST", "QUOTE", "FIGURE", "TABLE", "FORMULA",
        "CAPTION", "FOOTNOTE",
    ],
    "METADATA": ["AUTHORS", "AFFILIATIONS", "KEYWORDS", "PUBLISHER_INFO", "BIOGRAPHY", "FRONT_MATTER"],
    "SUPPLEMENTARY": [
        "REFERENCES", "ACKNOWLEDGEMENTS", "FUNDING", "CONFLICT_OF_INTEREST", "AUTHOR_CONTRIBUTIONS",
        "DATA_AVAILABILITY", "DECLARATION", "TABLE_OF_CONTENTS", "APPENDIX",
    ],
    "FURNITURE": ["RUNNING_HEADER", "RUNNING_FOOTER", "PAGE_NUMBER", "WATERMARK", "WEB_CHROME", "DECORATION"],
    # Text drawn inside a figure (axis labels, legends): belongs in the figure's picture, not loose in the text.
    "FIGURE_TEXT": ["FIGURE_TEXT"],
}  # fmt: skip
GROUP_OF = {t: g for g, types in GROUPS.items() for t in types}


@dataclass
class Output:
    """What an extractor gives the reader: the reading flow as blocks in order, and what it kept aside."""

    flow: list[str]
    side: list[tuple[str, str]] = field(default_factory=list)  # (type, text)
    title: str = ""
    ocr_pages: list[int] = field(default_factory=list)
    page_count: int = 0
    error: str | None = None
    # Each block of the flow as the reader has it, with the boxes on the PDF the reader opens for it.
    places: list[tuple[str, list]] = field(default_factory=list)


def places_of(content: str, source_map: list) -> list[tuple[str, list]]:
    """The reader's blocks and their boxes, matched as the reader matches them (lib/documents.ts sourceBoxes):
    the nth block with a key gets the nth source-map entry with that key."""
    entries: dict[str, list] = {}
    for key, boxes in source_map:
        entries.setdefault(key, []).append(boxes)
    seen: dict[str, int] = {}
    out = []
    for raw in extraction.reader_blocks(content):
        key = extraction.block_key(raw)
        n = seen.get(key, 0)
        seen[key] = n + 1
        found = entries.get(key, [])
        out.append((raw, found[n] if n < len(found) else []))
    return out


def current(path: Path) -> Output:
    """The extractor the app runs today (services/extraction.extract_pdf), as run_extraction calls it but
    without OCR: images go to a temporary folder so that figures are cut out of the text as in the app. What
    it keeps out of the reading flow is its side store."""
    with tempfile.TemporaryDirectory() as images:
        try:
            result = extraction.extract_pdf(path, path.stem, Path(images))
        except extraction.ExtractionError as e:
            return Output(flow=[], error=e.code)
    blocks = [b.strip() for b in re.split(r"\n\s*\n", result.content)]
    flow = [b for b in blocks if b and b != "---" and not extraction.OCR_LINE.fullmatch(b)]
    error = None if flow else "MSG-15"  # run_extraction fails a document whose scans could not be read
    side = [(b["type"], b["text"]) for b in (result.aside or {}).get("blocks", [])]
    return Output(
        flow=flow, side=side, title=result.title or "", ocr_pages=result.ocr_pages,
        page_count=result.page_count or 0, error=error,
        places=places_of(result.content, result.source_map),
    )  # fmt: skip


ADAPTERS: dict[str, Callable[[Path], Output]] = {"current": current}


QUOTES = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "−": "-", "‐": "-", "­": None})


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(QUOTES)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)  # a picture's Markdown is not text
    text = re.sub(r"^\s*(?:#{1,6}|>)\s*", "", text, flags=re.M)
    text = text.replace("**", "").replace("\\*", "*").replace("<br>", " ")
    # The extractor writes a numbered heading "2.1. Methods" as "2.1 Methods": the same heading.
    text = re.sub(r"(?<![\w.])(\d{1,2}(?:\.\d{1,2})*)\.(?=\s|$)", r"\1", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def occurrences(blocks: list[str], text: str, whole: bool) -> int:
    if whole:
        return sum(1 for b in blocks if b == text)
    return sum(b.count(text) for b in blocks)


@dataclass
class LabelResult:
    type: str
    group: str
    text: str
    in_flow: int
    in_side: str | None  # the type it was filed under, if found in the side store

    @property
    def ok(self) -> bool:
        if self.group == "MAIN":
            return self.in_flow > 0
        return self.in_flow == 0


def broken_words(path: Path) -> list[tuple[str, str]]:
    """Words the PDF breaks with a hyphen at a line end and also prints whole somewhere else: those are one word
    split for the line, not a compound like "self-supervised" (which never appears as "selfsupervised")."""
    with pymupdf.open(path) as pdf:
        raw = unicodedata.normalize("NFKC", "\n".join(page.get_text() for page in pdf))
    whole = {w.lower() for w in re.findall(r"[^\W\d_]+", raw)}
    pairs = set(re.findall(r"([^\W\d_]{2,})[-­]\n([^\W\d_]{2,})", raw))
    return sorted((a, b) for a, b in pairs if (a + b).lower() in whole)


# Passages whose place on the PDF the reader opens (CR-NFR-04). The title is drawn apart, not as a block.
PLACED = {"ABSTRACT", "SECTION_HEADING", "BODY", "LIST", "QUOTE", "CAPTION", "FOOTNOTE"}


def _covers(box: list, page: int, hit: "pymupdf.Rect", area: "pymupdf.Rect") -> bool:
    """A source-map box [page, x, y, w, h] (fractions of the page) over a place the PDF prints the words."""
    n, x, y, w, h = box
    shown = pymupdf.Rect(
        area.x0 + x * area.width, area.y0 + y * area.height,
        area.x0 + (x + w) * area.width, area.y0 + (y + h) * area.height,
    )  # fmt: skip
    return n == page and shown.intersects(hit)


def provenance(path: Path, doc: dict, places: list[tuple[str, list]]) -> list[dict]:
    """For each body label in the flow: does the box the reader opens for its block lie where the PDF prints
    those words? Where the words are is asked of the PDF itself (search_for), so no page needs labelling; a
    label the PDF's search cannot find (split across a column, ligatures) is not measured."""
    blocks = [(norm(raw), boxes) for raw, boxes in places]
    out = []
    with pymupdf.open(path) as pdf:
        for label in doc["labels"]:
            if label["type"] not in PLACED:
                continue
            text = norm(label["text"])
            block = next((boxes for t, boxes in blocks if text in t), None)
            if block is None:
                continue  # not in the flow: counted under main kept
            hits = [(page.number + 1, r, page.rect) for page in pdf for r in page.search_for(label["text"])]
            if not hits:
                result = "unmeasured"
            elif not block:
                result = "no box"
            else:
                right = any(_covers(box, page, hit, area) for box in block for page, hit, area in hits)
                result = "ok" if right else "wrong"
            out.append({"type": label["type"], "text": label["text"], "result": result})
    return out


def ensure_derived(doc: dict) -> None:
    """Make a PDF the labels derive from another (a scan: every page turned into a picture)."""
    target = PDFS / doc["file"]
    spec = doc.get("derive")
    if not spec or target.exists() or not (PDFS / spec["from"]).exists():
        return
    with pymupdf.open(PDFS / spec["from"]) as src, pymupdf.open() as out:
        for page in src:
            pix = page.get_pixmap(dpi=spec["dpi"], colorspace=pymupdf.csGRAY)
            new = out.new_page(width=page.rect.width, height=page.rect.height)
            new.insert_image(new.rect, pixmap=pix)
        out.save(target, garbage=3, deflate=True)


def evaluate(doc: dict, adapter: Callable[[Path], Output], dump: bool = False) -> dict:
    path = PDFS / doc["file"]
    ensure_derived(doc)
    base = {"id": doc["id"], "group": doc["group"], "lang": doc["lang"]}
    if not path.exists():
        return {**base, "skipped": "missing PDF"}
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if doc.get("sha256_prefix") and not digest.startswith(doc["sha256_prefix"]):
        return {**base, "skipped": f"different file (sha256 {digest[:10]})"}

    started = time.perf_counter()
    out = adapter(path)
    seconds = time.perf_counter() - started
    if dump:  # next to the PDFs, out of git: the text is the document's
        (PDFS / "_flows").mkdir(exist_ok=True)
        text = "\n\n".join(out.flow) + "\n\n=== SIDE ===\n\n" + "\n\n".join(f"[{t}] {s}" for t, s in out.side)
        (PDFS / "_flows" / f"{doc['id']}.{adapter.__name__}.md").write_text(text, encoding="utf-8")
    flow = [norm(b) for b in out.flow]
    side = [(t, norm(s)) for t, s in out.side]
    title = norm(out.title)

    labels = []
    for label in doc["labels"]:
        text, whole = norm(label["text"]), label.get("whole", False)
        found = occurrences(flow, text, whole)
        if label["type"] == "TITLE" and not found and text in title:
            found = 1  # the reader shows the document's title above the text
        found = max(0, found - label.get("max_in_flow", 0)) if GROUP_OF[label["type"]] != "MAIN" else found
        filed = next((t for t, s in side if (s == text if whole else text in s)), None)
        labels.append(LabelResult(label["type"], GROUP_OF[label["type"]], label["text"], found, filed))

    def where(text: str) -> tuple[int, int] | None:
        """(block, offset) of the first place the text is found in the flow."""
        for n, block in enumerate(flow):
            if (i := block.find(text)) >= 0:
                return n, i
        return None

    pairs = []
    for pair in doc.get("order", []):
        a, b = pair[0], pair[1]
        next_block = len(pair) > 2 and pair[2] == "next"
        pa, pb = where(norm(a)), where(norm(b))
        if pa is None or pb is None:
            result = "missing"
        elif next_block:  # b goes on from a: nothing else may come between them
            result = "ok" if pb[0] == pa[0] + 1 or (pb[0] == pa[0] and pb[1] > pa[1]) else "wrong"
        else:
            result = "ok" if pa < pb else "wrong"
        pairs.append({"a": a, "b": b, "next": next_block, "result": result})

    joined = "\n".join(out.flow)
    broken = broken_words(path)
    split = [f"{a}-{b}" for a, b in broken if re.search(rf"{a}[-­]\s*{b}", joined)]
    hyphens = {"broken": len(broken), "left_split": split}

    expect = doc.get("expect", {})
    checks = []
    if "ocr_pages" in expect:
        want = list(range(1, out.page_count + 1)) if expect["ocr_pages"] == "all" else expect["ocr_pages"]
        checks.append({"check": "scanned pages flagged", "want": want, "got": out.ocr_pages,
                       "ok": out.ocr_pages == want and out.page_count > 0})  # fmt: skip

    return {
        **base,
        "seconds": round(seconds, 2),
        "error": out.error,
        "flow_blocks": len(flow),
        "side_blocks": len(side),
        "labels": [asdict(r) | {"ok": r.ok} for r in labels],
        "order": pairs,
        "checks": checks,
        "hyphens": hyphens,
        "provenance": provenance(path, doc, out.places),
    }


def score(docs: list[dict]) -> dict:
    labels = [lab for d in docs if "labels" in d for lab in d["labels"]]
    pairs = [p for d in docs if "order" in d for p in d["order"]]

    def share(items: list, test) -> dict:
        hit = sum(1 for x in items if test(x))
        return {"hit": hit, "of": len(items), "rate": round(hit / len(items), 3) if items else None}

    by = {g: [lab for lab in labels if lab["group"] == g] for g in GROUPS}
    others = by["METADATA"] + by["SUPPLEMENTARY"] + by["FURNITURE"]
    # A main label also printed as something else (the title in the running header) is not a typing error.
    in_side = [lab for lab in labels if lab["in_side"] and (lab["group"] != "MAIN" or lab["in_flow"] == 0)]
    evaluable = [p for p in pairs if p["result"] != "missing"]
    places = [p for d in docs for p in d.get("provenance", [])]
    placed = [p for p in places if p["result"] != "unmeasured"]
    return {
        "main_kept": share(by["MAIN"], lambda x: x["in_flow"] > 0),
        "furniture_suppressed": share(by["FURNITURE"], lambda x: x["in_flow"] == 0),
        "figure_text_suppressed": share(by["FIGURE_TEXT"], lambda x: x["in_flow"] == 0),
        "metadata_separated": share(by["METADATA"], lambda x: x["in_flow"] == 0),
        "supplementary_separated": share(by["SUPPLEMENTARY"], lambda x: x["in_flow"] == 0),
        "kept_somewhere": share(others, lambda x: x["in_flow"] > 0 or x["in_side"]),
        "reading_order": share(evaluable, lambda x: x["result"] == "ok")
        | {"missing": len(pairs) - len(evaluable)},
        "typed_right": share(in_side, lambda x: GROUP_OF.get(x["in_side"]) == x["group"]),
        "checks": share([c for d in docs for c in d.get("checks", [])], lambda x: x["ok"]),
        "words_rejoined": words_rejoined(docs),
        "provenance": share(placed, lambda x: x["result"] == "ok")
        | {"unmeasured": len(places) - len(placed)},
    }


def words_rejoined(docs: list[dict]) -> dict:
    broken = sum(d["hyphens"]["broken"] for d in docs if "hyphens" in d)
    left = sum(len(d["hyphens"]["left_split"]) for d in docs if "hyphens" in d)
    return {
        "hit": broken - left,
        "of": broken,
        "rate": round((broken - left) / broken, 3) if broken else None,
    }


TARGETS = {
    "main_kept": ("≥ 99 %", "CR-NFR-01"),
    "furniture_suppressed": ("≥ 90 %", "CR-NFR-02"),
    "reading_order": ("≥ 95 %", "CR-NFR-03"),
    "provenance": ("≥ 95 %", "CR-NFR-04"),
    "kept_somewhere": ("100 %", "R1"),
    "words_rejoined": ("100 %", "TC-11"),
}
NAMES = {
    "main_kept": "Main content kept in the flow",
    "furniture_suppressed": "Headers, footers, page numbers out of the flow",
    "figure_text_suppressed": "Text inside figures out of the flow",
    "metadata_separated": "Metadata out of the flow",
    "supplementary_separated": "Supplementary parts out of the flow",
    "kept_somewhere": "Non-main labels still held (flow or side store)",
    "reading_order": "Reading order pairs right",
    "typed_right": "Side-store blocks filed under the right group",
    "checks": "Other checks (scanned pages flagged)",
    "words_rejoined": "Words broken at a line end shown whole",
    "provenance": "Body passages that open the right place on the PDF",
}


def pct(s: dict | None) -> str:
    if not s or s["rate"] is None:
        return "—"
    return f"{s['rate'] * 100:.1f} % ({s['hit']}/{s['of']})"


def quantile(values: list[float], q: float) -> float:
    """Nearest rank: with a handful of documents a group's p95 is its slowest one."""
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))]


def timing(run: list[dict]) -> list[str]:
    """CR-NFR-07: seconds to extract, p50 and p95 by group (no OCR, no AI: the app adds those)."""
    groups: dict[str, list[float]] = {}
    for d in run:
        groups.setdefault(d["group"], []).append(d["seconds"])
    groups["all"] = [d["seconds"] for d in run]
    lines = ["", "## Time to extract", "", "| Group | PDFs | p50 s | p95 s |", "|---|---|---|---|"]
    for group, seconds in groups.items():
        lines.append(
            f"| {group} | {len(seconds)} | {quantile(seconds, 0.5):.2f} | {quantile(seconds, 0.95):.2f} |"
        )
    return lines


def report(adapter: str, docs: list[dict], totals: dict, before: dict | None) -> str:
    lines = [
        f"# Clean Reader benchmark — {adapter}",
        "",
        f"Run {datetime.now(UTC):%Y-%m-%d %H:%M} UTC with `python -m evals.run_clean_reader --adapter {adapter}`."
        " Labels: `evals/clean_reader/labels.json` (drafted by Claude from the PDFs' text layer; a person has"
        " not checked them yet). What the scores mean: the docstring of `evals/run_clean_reader.py`.",
        "",
        "| Measure | " + ("Baseline | " if before else "") + "Result | Target |",
        "|---|" + ("---|" if before else "") + "---|---|",
    ]
    for key, name in NAMES.items():
        target = " ".join(TARGETS.get(key, ("", "")))
        row = f"| {name} | " + (f"{pct(before['totals'].get(key))} | " if before else "")
        lines.append(row + f"{pct(totals[key])} | {target} |")
    order = totals["reading_order"]
    lines += ["", f"Order pairs with an end not found in the flow: {order['missing']}.", ""]

    run = [d for d in docs if "skipped" not in d]
    lines += ["## Per document", "", "| Document | Group | Lang | Seconds | Flow blocks | Main kept | Noise out | Order | Error |",
              "|---|---|---|---|---|---|---|---|---|"]  # fmt: skip
    for d in docs:
        if "skipped" in d:
            lines.append(
                f"| {d['id']} | {d['group']} | {d['lang']} | — | — | — | — | — | skipped: {d['skipped']} |"
            )
            continue
        s = score([d])
        noise = {
            "hit": s["furniture_suppressed"]["hit"] + s["metadata_separated"]["hit"]
            + s["supplementary_separated"]["hit"],
            "of": s["furniture_suppressed"]["of"] + s["metadata_separated"]["of"]
            + s["supplementary_separated"]["of"],
        }  # fmt: skip
        noise["rate"] = noise["hit"] / noise["of"] if noise["of"] else None
        lines.append(
            f"| {d['id']} | {d['group']} | {d['lang']} | {d['seconds']} | {d['flow_blocks']} | {pct(s['main_kept'])} "
            f"| {pct(noise)} | {pct(s['reading_order'])} | {d['error'] or ''} |"
        )

    lines += timing(run)
    lines += [
        "",
        "## Misses",
        "",
        "Every label in the wrong place and every order pair not right, by document.",
        "",
    ]
    for d in run:
        misses = [lab for lab in d["labels"] if not lab["ok"]]
        bad = [p for p in d["order"] if p["result"] != "ok"]
        failed = [c for c in d["checks"] if not c["ok"]]
        misplaced = [p for p in d.get("provenance", []) if p["result"] in ("wrong", "no box")]
        if not (misses or bad or failed or misplaced or d["hyphens"]["left_split"]):
            continue
        lines.append(f"### {d['id']}")
        lines.append("")
        for lab in misses:
            where = "missing from the flow" if lab["group"] == "MAIN" else f"in the flow ×{lab['in_flow']}"
            kept = f", side store: {lab['in_side']}" if lab["in_side"] else ""
            lines.append(f"- {lab['type']} ({lab['group'].lower()}): “{lab['text']}” — {where}{kept}")
        for p in bad:
            lines.append(f"- order {p['result']}: “{p['a']}” → “{p['b']}”")
        for c in failed:
            lines.append(f"- {c['check']}: want {c['want']}, got {c['got']}")
        for p in misplaced:
            lines.append(f"- source on the PDF {p['result']}: {p['type']} “{p['text']}”")
        if split := d["hyphens"]["left_split"]:
            more = f" and {len(split) - 12} more" if len(split) > 12 else ""
            lines.append(
                f"- words left split ({len(split)} of {d['hyphens']['broken']}): {', '.join(split[:12])}{more}"
            )
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ids", nargs="*")
    parser.add_argument("--adapter", default="current", choices=sorted(ADAPTERS))
    parser.add_argument("--dump", action="store_true", help="write each reading flow to pdfs/_flows/")
    parser.add_argument("-v", "--verbose", action="store_true", help="Show per-PDF scoring and timing")
    args = parser.parse_args()
    progress = Progress(args.verbose)

    spec = json.loads((HERE / "labels.json").read_text(encoding="utf-8"))
    docs = [d for d in spec["docs"] if not args.ids or d["id"] in args.ids]
    progress.log(f"Loaded PDFs={len(docs)}; adapter={args.adapter}; no AI calls")
    for d in docs:  # a label of an unknown type is a mistake in labels.json, not a miss
        unknown = {lab["type"] for lab in d["labels"]} - set(GROUP_OF)
        if unknown:
            sys.exit(f"{d['id']}: unknown label types {sorted(unknown)}")

    results = []
    for d in docs:
        print(f"{d['id']} …", flush=True)
        with progress.step(f"extract and evaluate PDF={d['id']}"):
            results.append(evaluate(d, ADAPTERS[args.adapter], args.dump))
        result = results[-1]
        if "skipped" in result:
            progress.log(f"SKIP {d['id']}: {result['skipped']}")
        else:
            for key, value in score([result]).items():
                progress.log(f"Score PDF={d['id']}; {key}={pct(value)}")
    totals = score([r for r in results if "skipped" not in r])

    before = None
    if (RESULTS / "baseline.json").exists():
        before = json.loads((RESULTS / "baseline.json").read_text(encoding="utf-8"))
    RESULTS.mkdir(exist_ok=True)
    payload = {
        "adapter": args.adapter,
        "run_at": datetime.now(UTC).isoformat(),
        "totals": totals,
        "docs": results,
    }
    (RESULTS / f"{args.adapter}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    md = report(args.adapter, results, totals, before)
    (RESULTS / f"{args.adapter}.md").write_text(md, encoding="utf-8")
    progress.log(f"Saved {RESULTS / args.adapter}.json and .md")
    for key, name in NAMES.items():
        print(f"{name}: {pct(totals[key])}")


if __name__ == "__main__":
    main()
