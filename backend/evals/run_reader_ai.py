"""Reader v2 AI evaluation (TSD 10.3): runs the reader's real AI pipeline on a fixed set of documents and
questions, and measures the results instead of judging them from a screenshot.

    cd backend
    .venv/Scripts/python.exe -m evals.run_reader_ai            # all documents
    .venv/Scripts/python.exe -m evals.run_reader_ai paper      # one of them

It calls OpenAI with the key in backend/.env (the same models as the app) and touches no database: the
documents are cut into passages, summarised and asked about exactly as `reader_ai` and the chat route do.
What it writes: evals/reader_ai/results.md (the scores) and results.json (every output, for checking by hand).

The checks are mechanical, so they are a floor, not a verdict:
- groundedness: each point names a passage, and its content words are found in the passages it names;
  no number is written that the document does not contain;
- citation correctness: an answer cites a passage that holds the expected fact;
- abstention: a question the document cannot answer gets the refusal and no citation;
- type adaptation: an essay is not given a method or a sample, a paper's findings keep its own figures;
  the research analysis (phase 4) is refused for an essay, keeps the paper's own sample and results, and
  leaves empty what the document does not report;
- explaining a selection (phase 4): the passage the reader selected is answered from where it is, and the
  answer cites a passage that holds it;
- completeness disclosure: with a page missing, whether the AI's own text names the gap. This is shown,
  not scored: the reader puts its coverage notice next to every summary and answer of such a document
  (`AiCoverage`), and a summary point must rest on a passage, which a missing page is not.
"""

import argparse
import asyncio
import json
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import get_settings
from app.services import doc_chat, embeddings, reader_ai
from app.services.openai_client import Usage
from app.services.summarizer import detect_language
from evals.progress import Progress

HERE = Path(__file__).parent / "reader_ai"
SUPPORT_MIN = 0.4  # share of a point's content words found in the passages it cites
STOP = set(
    [
        "that",
        "this",
        "with",
        "from",
        "have",
        "were",
        "their",
        "there",
        "which",
        "when",
        "what",
        "about",
        "into",
        "than",
        "then",
        "them",
        "they",
        "your",
        "will",
        "also",
        "more",
        "most",
        "only",
        "such",
        "some",
        "each",
        "other",
        "these",
        "those",
        "been",
        "being",
        "does",
        "over",
        "after",
        "before",
        "because",
        "while",
        "document",
        "study",
        "author",
        "text",
        "passage",
        "passages",
        "tài",
        "liệu",
        "bài",
        "viết",
        "tác",
        "giả",
        "những",
        "được",
        "trong",
        "một",
        "các",
        "này",
        "của",
        "cho",
        "với",
        "không",
        "như",
        "theo",
        "khi",
        "thì",
        "là",
        "và",
        "có",
        "để",
        "ta",
    ]
)


@dataclass
class Tally:
    usage: Usage = field(default_factory=Usage)
    calls: int = 0


def words(text: str) -> set[str]:
    return {
        w for w in re.findall(r"\w+", text.casefold()) if len(w) >= 3 and w not in STOP and not w.isdigit()
    }


SPELLED = {
    word: str(n)
    for n, word in enumerate(
        [
            "zero",
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
            "thirteen",
            "fourteen",
            "fifteen",
            "sixteen",
            "seventeen",
            "eighteen",
            "nineteen",
            "twenty",
        ]
    )
} | {
    "thirty": "30",
    "forty": "40",
    "fifty": "50",
    "sixty": "60",
    "seventy": "70",
    "eighty": "80",
    "ninety": "90",
}
# Vietnamese numbers one to ten ("mười phút" holds 10). "năm" is also "year", so 5 is accepted more readily.
SPELLED_VI = {
    w: str(n)
    for n, w in enumerate(["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười"])
}


def numbers(text: str) -> set[str]:
    """Figures in a text, without thousands separators (212,000 → 212000; 0.71 stays 0.71). A number the text
    spells out counts too ("fifteen minutes" holds 15), so writing it in digits is not taken for inventing it."""
    found = re.findall(r"\w+", text.casefold())
    out = {SPELLED[w] for w in found if w in SPELLED} | {SPELLED_VI[w] for w in found if w in SPELLED_VI}
    for n in re.findall(r"\d+(?:[.,]\d+)*", doc_chat.without_refs(text)):
        n = re.sub(r",(?=\d{3}\b)", "", n)
        out.add(n.replace(",", "."))
    return out


def support(claim: str, cited: list[str]) -> float:
    claim_words = words(claim)
    if not claim_words:
        return 1.0
    found = words(" ".join(cited))
    return len(claim_words & found) / len(claim_words)


def points_of(kind: str, payload: dict) -> list[tuple[str, list[int]]]:
    if kind == "quick":
        return [(payload["tldr"], payload["tldr_sources"])] + [
            (p["text"], p["sources"]) for p in payload["takeaways"]
        ]
    if kind == "deep":
        return [(p["text"], p["sources"]) for s in reader_ai.DEEP_SECTIONS for p in payload[s]]
    if kind == "analysis":
        return [(p["text"], p["sources"]) for s in reader_ai.ANALYSIS_FIELDS for p in payload[s]]
    return [(f"{n['label']}. {n['detail']}", n["sources"]) for n in payload["nodes"] if n.get("parent")]


def score_summary(kind: str, payload: dict, doc_text: str) -> dict:
    by_position = {c["position"]: c["text"] for c in payload["citations"]}
    points = points_of(kind, payload)
    cited = [p for p in points if p[1]]
    supports = [support(text, [by_position[n] for n in ns if n in by_position]) for text, ns in cited]
    doc_numbers = numbers(doc_text)
    written = set().union(*(numbers(text) for text, _ in points)) if points else set()
    return {
        "points": len(points),
        "with_source": len(cited),
        "supported": sum(s >= SUPPORT_MIN for s in supports),
        "mean_support": round(sum(supports) / len(supports), 2) if supports else None,
        "unsupported_numbers": sorted(written - doc_numbers),
    }


async def ask(settings, tally: Tally, title, chunks, language, coverage, question, quote=None) -> dict:
    """One question, answered as the chat route answers it (the nearest passages, then the stream). With a
    `quote` the selection and the passages around it come first, as in the reader."""
    picked = chunks
    if len(chunks) > settings.chat_context_chunks:
        query_text = f"{quote}\n{question}" if quote else question
        vectors = await embeddings.embed(
            settings, [c.labelled() for c in chunks] + [query_text], purpose="eval_index", usage=tally.usage
        )
        query = vectors[-1]
        ranked = sorted(
            zip(chunks, vectors[:-1], strict=True), key=lambda cv: -embeddings.cosine(query, cv[1])
        )
        picked = sorted((c for c, _ in ranked[: settings.chat_context_chunks]), key=lambda c: c.position)
    if quote:
        near = doc_chat.around_quote(chunks, quote)
        picked = doc_chat.merge_passages(near, picked, settings.chat_context_chunks)
    messages = doc_chat.build_messages(title, question, picked, [], language, quote=quote, coverage=coverage)
    parts = [delta async for delta in doc_chat.answer(settings, messages, tally.usage)]
    tally.calls += 1
    raw = "".join(parts).strip()
    refused = doc_chat.abstained(raw)
    answer = doc_chat.without_refs(raw) if refused else raw
    used = doc_chat.cited(answer)
    return {
        "question": question,
        "quote": quote,
        "answer": answer,
        "raw_citations": sorted(doc_chat.cited(raw)),
        "abstained": refused,
        "citations": [{"n": n, "text": c.text} for n, c in enumerate(picked, 1) if n in used],
    }


def judge_answer(case: dict, result: dict, disclose: list[str]) -> dict:
    text = result["answer"].casefold()
    if case.get("abstain"):
        ok = result["abstained"] and not result["citations"]
        verdict = {"kind": "abstain", "ok": ok, "cited_before_guard": bool(result["raw_citations"])}
        if case.get("disclose"):
            verdict["disclosed"] = any(k in text for k in disclose)
        return verdict
    wanted = [k.casefold() for k in case["expect"]["any"]]
    has = any(k in text for k in wanted)
    cites_it = any(any(k in c["text"].casefold() for k in wanted) for c in result["citations"])
    return {
        "kind": "answer",
        "ok": has and cites_it and not result["abstained"],
        "has_fact": has,
        "cites_fact": cites_it,
    }


async def run_document(settings, tally: Tally, doc: dict, progress=None) -> dict:
    progress = progress or Progress()
    progress.log(f"Read document={doc['id']}")
    text = (HERE / doc["file"]).read_text(encoding="utf-8")
    title = text.splitlines()[0].lstrip("# ").strip()
    language = detect_language(text)
    chunks = doc_chat.split_chunks(text, settings.chat_chunk_tokens, doc["page_count"])
    progress.log(f"Split document={doc['id']}; chunks={len(chunks)}; target={settings.chat_chunk_tokens}")
    coverage = doc_chat.coverage_note(doc["issues"])
    out: dict = {
        "id": doc["id"],
        "language": language,
        "passages": len(chunks),
        "summaries": {},
        "answers": [],
    }

    for kind in doc["summaries"]:
        progress.log(f"START generate document={doc['id']}; kind={kind}")
        started = time.monotonic()
        if kind == "analysis":
            try:
                payload, usage = await reader_ai.generate(settings, kind, title, chunks, language, coverage)
            except reader_ai.NotResearch as e:
                progress.log(f"DONE document={doc['id']}; analysis refused for non-research type")
                tally.usage.add(e.usage)
                tally.calls += 1
                out["summaries"][kind] = {
                    "refused": True,
                    "document_type": e.document_type,
                    "type_ok": doc["type"] not in reader_ai.RESEARCH_TYPES,
                    "seconds": round(time.monotonic() - started, 1),
                }
                continue
        else:
            payload, usage = await reader_ai.generate(settings, kind, title, chunks, language, coverage)
        tally.usage.add(usage)
        tally.calls += 1
        entry = {
            "payload": payload,
            "seconds": round(time.monotonic() - started, 1),
            **score_summary(kind, payload, text),
        }
        if kind == "deep":
            body = " ".join(t for t, _ in points_of("deep", payload)).casefold()
            entry["document_type"] = payload["document_type"]
            if doc["type"] == "essay":
                entry["type_ok"] = payload["document_type"] != "research" and not any(
                    w.casefold() in body for w in doc.get("deep_must_not", [])
                )
            elif doc["type"] == "research":
                entry["type_ok"] = payload["document_type"] == "research" and all(
                    w in body for w in doc.get("deep_must_mention", [])
                )
            if doc.get("disclose"):
                entry["disclosed"] = any(k in body for k in doc["disclose"])
        if kind == "analysis":
            entry["document_type"] = payload["document_type"]
            fields = {
                name: " ".join(p["text"] for p in payload[name]).casefold()
                for name in reader_ai.ANALYSIS_FIELDS
            }
            expect = doc.get("analysis_expect", {})
            empty = doc.get("analysis_empty", [])
            entry["field_checks"] = {
                **{
                    f"{name} has {'/'.join(words)}": any(w.casefold() in fields[name] for w in words)
                    for name, words in expect.items()
                },
                **{f"{name} left empty": not fields[name] for name in empty},
            }
            entry["type_ok"] = doc["type"] in reader_ai.RESEARCH_TYPES and all(entry["field_checks"].values())
        out["summaries"][kind] = entry
        progress.log(
            f"DONE document={doc['id']}; kind={kind}; points={entry['points']}; with_source={entry['with_source']}; supported={entry['supported']}"
        )

    for i, case in enumerate(doc["questions"], 1):
        with progress.step(f"answer document={doc['id']}; question={i}/{len(doc['questions'])}"):
            result = await ask(
                settings, tally, title, chunks, language, coverage, case["q"], case.get("quote")
            )
        result["verdict"] = judge_answer(case, result, doc.get("disclose", []))
        progress.log(f"Score kind={result['verdict']['kind']}; passed={result['verdict']['ok']}")
        out["answers"].append(result)
    return out


def report(results: list[dict], settings, tally: Tally, seconds: float) -> str:
    lines = [
        "# Reader v2 — AI evaluation results",
        "",
        f"Run {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')} UTC · summaries `{settings.openai_model}` · "
        f"answers `{settings.openai_chat_model}` · prompt revision {reader_ai.PROMPT_REVISION} · "
        f"{tally.calls} AI requests · {tally.usage.prompt_tokens} prompt + {tally.usage.completion_tokens} "
        f"completion tokens · {seconds:.0f} s",
        "",
        "Produced by `evals/run_reader_ai.py` from `evals/reader_ai/cases.json`; every output is in "
        "`results.json`. The checks are mechanical (see the script's docstring), so they are a floor.",
        "",
        "## Summaries",
        "",
        "| Document | Result | Points | With a source | Supported (≥40% words) | Numbers not in the document | Type / disclosure |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in results:
        for kind, s in r["summaries"].items():
            if s.get("refused"):
                verdict = "ok" if s["type_ok"] else "FAIL"
                lines.append(
                    f"| {r['id']} | {kind} | — | — | — | — | refused: type `{s['document_type']}` {verdict} |"
                )
                continue
            extra = []
            if "field_checks" in s:
                checks = ", ".join(
                    f"{name} {'ok' if ok else 'FAIL'}" for name, ok in s["field_checks"].items()
                )
                extra.append(checks)
            if "type_ok" in s:
                extra.append(f"type `{s['document_type']}` {'ok' if s['type_ok'] else 'FAIL'}")
            if "disclosed" in s:
                extra.append(f"gap named by the AI: {'yes' if s['disclosed'] else 'no'} (shown, not scored)")
            lines.append(
                f"| {r['id']} | {kind} | {s['points']} | {s['with_source']} | {s['supported']}/{s['with_source']} "
                f"| {', '.join(s['unsupported_numbers']) or 'none'} | {'; '.join(extra) or '—'} |"
            )
    lines += [
        "",
        "## Questions",
        "",
        "| Document | Question | Expected | Result | Detail |",
        "|---|---|---|---|---|",
    ]
    for r in results:
        for a in r["answers"]:
            v = a["verdict"]
            if v["kind"] == "abstain":
                detail = (
                    "refused, no citation"
                    if v["ok"]
                    else f"abstained={a['abstained']}, citations={len(a['citations'])}"
                )
                if v.get("cited_before_guard"):
                    detail += " (model cited before the guard)"
                if "disclosed" in v:
                    detail += f"; gap {'named' if v['disclosed'] else 'not named'}"
            else:
                detail = f"fact {'found' if v['has_fact'] else 'missing'}, {'cites' if v['cites_fact'] else 'does not cite'} its passage"
            q = a["question"].replace("|", "\\|")
            lines.append(f"| {r['id']} | {q} | {v['kind']} | {'pass' if v['ok'] else 'FAIL'} | {detail} |")

    answers = [a["verdict"] for r in results for a in r["answers"]]
    abstain = [v for v in answers if v["kind"] == "abstain"]
    answer = [v for v in answers if v["kind"] == "answer"]
    summaries = [s for r in results for s in r["summaries"].values() if not s.get("refused")]
    analyses = [s for r in results for k, s in r["summaries"].items() if k == "analysis"]
    explained = [a["verdict"] for r in results for a in r["answers"] if a.get("quote")]
    with_source = sum(s["with_source"] for s in summaries)
    lines += [
        "",
        "## Totals",
        "",
        f"- Answerable questions answered with the fact and its passage: {sum(v['ok'] for v in answer)}/{len(answer)}",
        f"- Unanswerable questions refused without a citation: {sum(v['ok'] for v in abstain)}/{len(abstain)}"
        f" (model cited before the guard: {sum(v['cited_before_guard'] for v in abstain)})",
        f"- Summary points with a source: {with_source}/{sum(s['points'] for s in summaries)}; of those supported by "
        f"the cited passage's words: {sum(s['supported'] for s in summaries)}/{with_source}",
        f"- Numbers written that the document does not contain: {sum(len(s['unsupported_numbers']) for s in summaries)}",
        f"- Research analysis right for the document type (made with the expected fields, or refused): "
        f"{sum(s['type_ok'] for s in analyses)}/{len(analyses)}",
        f"- Selections explained from a passage that holds them: {sum(v['ok'] for v in explained)}/{len(explained)}",
        f"- Missing page named by the AI's own text (shown, not scored): summaries "
        f"{sum(s['disclosed'] for s in summaries if 'disclosed' in s)}/{sum('disclosed' in s for s in summaries)}, "
        f"answers {sum(v['disclosed'] for v in abstain if 'disclosed' in v)}/{sum('disclosed' in v for v in abstain)}",
        "",
    ]
    return "\n".join(lines)


async def main(only: list[str], verbose=False) -> None:
    progress = Progress(verbose)
    settings = get_settings()
    if not settings.openai_api_key:
        sys.exit("OPENAI_API_KEY is not set in backend/.env")
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    docs = [d for d in cases["documents"] if not only or d["id"] in only]
    tally, started = Tally(), time.monotonic()
    progress.log(f"Loaded documents={len(docs)}; real AI calls enabled")
    results = [await run_document(settings, tally, d, progress) for d in docs]
    (HERE / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    text = report(results, settings, tally, time.monotonic() - started)
    (HERE / "results.md").write_text(text, encoding="utf-8")
    progress.log(f"Saved {HERE / 'results.json'} and results.md")
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ids", nargs="*", help="Optional document IDs, e.g. paper")
    parser.add_argument("-v", "--verbose", action="store_true", help="Show document and question progress")
    args = parser.parse_args()
    asyncio.run(main(args.ids, verbose=args.verbose))
