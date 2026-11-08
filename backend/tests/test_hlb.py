import json
from dataclasses import replace
from datetime import UTC, datetime

from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models import TOPICS, Article
from app.services import crawler
from app.services.sources import CC_BY, hlb

PATH = "book/04-dung-lang-phi-thoi-gian.md"
LONG = " ".join(["Câu này đủ dài để mục vượt qua ngưỡng số chữ tối thiểu của bộ đọc."] * 8)

CHAPTER = f"""[← Về mục lục](../README.md)

# 4. Đừng lãng phí thời gian

Lời mở đầu của chương.

### 1. Viết "định làm" thành "mấy giờ, ở đâu"
<!-- nhãn: tiền=0 thời-gian=ít -->
<a name="entry-viet-dinh-lam" data-legacy="4-1"></a>

- Chi phí: Không tốn tiền.
- Nói dễ hiểu: Viết sẵn một câu **nếu gặp X thì làm Y**. {LONG}
- Lợi ích: Phân tích gộp 94 phép kiểm định, d = 0,65.
- Mức bằng chứng: A
- Nguồn: Gollwitzer & Sheeran (2006). <https://doi.org/10.1016/S0065-2601(06)38002-1>
- Ghi chú: Xem [mục 2](04-dung-lang-phi-thoi-gian.md#entry-dieu-kien-dung "refs:dieu-kien-dung"), \
[chương 3 mục 1](03-dung-lang-phi-suc-luc.md#entry-tat-thong-bao) và [mục lục](../README.md).

### 2. Viết sẵn điều kiện dừng
<a name="entry-dieu-kien-dung" data-legacy="4-2"></a>

- Chi phí: Không tốn tiền.
- Nói dễ hiểu: Quyết định trước khi nào thì dừng. {LONG}
- Lợi ích: Ít chìm vào việc không xong.
- Pháp luật Việt Nam: Không có quy định riêng.
- Mức bằng chứng: B
- Nguồn: Một nghiên cứu.
- Ghi chú: Xem lại [mục 1](#entry-viet-dinh-lam).

## Đọc thêm

Phần cuối chương, không thuộc mục nào.
"""

PIN = hlb.Pin(commit="a" * 40, date=datetime(2026, 11, 7, tzinfo=UTC), picks={"viet-dinh-lam": ["mind"]})


def test_parse_chapter_reads_each_entry_and_its_fields():
    first, second = hlb.parse_chapter(CHAPTER, PATH)
    assert (first.id, first.chapter, first.number) == ("viet-dinh-lam", 4, 1)
    assert first.title == 'Viết "định làm" thành "mấy giờ, ở đâu"'
    assert first.chapter_title == "Đừng lãng phí thời gian"
    assert first.fields["Mức bằng chứng"] == "A"
    assert "Pháp luật Việt Nam" not in first.fields  # left out where no law applies
    assert second.fields["Pháp luật Việt Nam"] == "Không có quy định riêng."
    # The chapter's closing section belongs to no entry.
    assert "Phần cuối chương" not in second.fields["Ghi chú"]


def test_links_point_at_github_and_lose_the_books_own_markup():
    first, second = hlb.parse_chapter(CHAPTER, PATH)
    note = first.fields["Ghi chú"]
    blob = "https://github.com/quangpao/HowToLiveBetter/blob/vi"
    assert f"]({blob}/book/04-dung-lang-phi-thoi-gian.md#entry-dieu-kien-dung)" in note
    assert f"]({blob}/book/03-dung-lang-phi-suc-luc.md#entry-tat-thong-bao)" in note
    assert f"]({blob}/README.md)" in note
    assert "refs:" not in note
    assert f"]({blob}/{PATH}#entry-viet-dinh-lam)" in second.fields["Ghi chú"]
    # Absolute links are left as they are.
    assert "<https://doi.org/10.1016/S0065-2601(06)38002-1>" in first.fields["Nguồn"]
    item = hlb.entry_item(first, PATH, PIN)
    assert "<!--" not in item.content and "<a name" not in item.content


def test_an_entry_becomes_an_openly_licensed_vietnamese_article_with_its_credit():
    first, second = hlb.parse_chapter(CHAPTER, PATH)
    item = hlb.entry_item(first, PATH, PIN, ["mind"])
    # Under the branch, not the commit: a newer version updates the same article.
    assert item.url == f"https://github.com/quangpao/HowToLiveBetter/blob/vi/{PATH}#entry-viet-dinh-lam"
    assert (item.source, item.language, item.kind) == ("hlb", "vi", "explainer")
    assert (item.license, item.license_url) == CC_BY
    assert (
        "eternity4719" in item.credit
        and "07/11/2026" in item.credit
        and "PureMind đã tách mục" in item.credit
    )
    assert item.published_at == PIN.date
    assert item.topics == ["mind"]
    assert item.tags == ["mức bằng chứng a", "Đừng lãng phí thời gian"]
    assert item.summary.startswith("Viết sẵn một câu nếu gặp X thì làm Y.")  # emphasis dropped for the card
    assert item.content.startswith("**Chi phí:** Không tốn tiền.")
    assert "commit aaaaaaa" in item.content and "không thay lời khuyên của bác sĩ" in item.content
    # Without topics of its own, an entry takes its chapter's.
    assert hlb.entry_item(second, PATH, PIN).topics == hlb.CHAPTER_TOPICS[4]
    # A long chapter title is tagged by its short name.
    long = replace(first, chapter_title="Học gì thì đáng: trường nghề, chứng chỉ, và cách học")
    assert hlb.entry_item(long, PATH, PIN).tags == ["mức bằng chứng a", "Học gì thì đáng"]


def test_every_chapter_has_feed_topics():
    assert set(hlb.CHAPTER_TOPICS) == set(range(1, 37))
    assert all(t in TOPICS for topics in hlb.CHAPTER_TOPICS.values() for t in topics)


def test_the_pinned_picks_are_readable_and_use_feed_topics():
    pin = hlb.read_pin()
    assert len(pin.commit) == 40 and pin.date.tzinfo is not None
    assert len(pin.picks) == 9
    assert all(t in TOPICS for topics in pin.picks.values() for t in topics)


def _fake_fetch(seen: list[str]):
    index = {
        "version": 1,
        "entries": [{"id": "viet-dinh-lam", "file": PATH}, {"id": "dieu-kien-dung", "file": PATH}],
    }

    async def fetch(url: str, contact: str, accept: str = "") -> bytes:
        seen.append(url)
        if url.endswith("data/entries.json"):
            return json.dumps(index).encode()
        if url.endswith(PATH):
            return CHAPTER.encode()
        raise AssertionError(url)

    return fetch


async def test_collect_reads_only_the_picks_at_the_pinned_commit(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(hlb, "fetch", _fake_fetch(seen))
    monkeypatch.setattr(hlb, "read_pin", lambda: PIN)
    items = await hlb.collect("test")
    assert [i.title for i in items] == ['Viết "định làm" thành "mấy giờ, ở đâu"']
    assert all(f"/{'a' * 40}/" in url for url in seen)


async def test_an_admin_adds_any_entry_by_its_link(monkeypatch):
    monkeypatch.setattr(hlb, "fetch", _fake_fetch([]))
    monkeypatch.setattr(hlb, "read_pin", lambda: PIN)
    url = f"https://github.com/quangpao/HowToLiveBetter/blob/vi/{PATH}#entry-dieu-kien-dung"
    assert crawler.source_of(url).id == "hlb"
    item = await hlb.from_link(url, "test", ["education"])
    assert item.title == "Viết sẵn điều kiện dừng" and item.topics == ["education"]
    # A link to the handbook without an entry, or to an entry not in the book, finds nothing.
    assert await hlb.from_link("https://github.com/quangpao/HowToLiveBetter", "test", []) is None
    assert await hlb.from_link(url.replace("dieu-kien-dung", "khong-co"), "test", []) is None


async def test_a_newer_commit_updates_the_article_instead_of_adding_one():
    first = hlb.parse_chapter(CHAPTER, PATH)[0]
    old = hlb.entry_item(first, PATH, PIN, ["mind"])
    newer = replace(PIN, commit="b" * 40, date=datetime(2026, 12, 1, tzinfo=UTC))
    new = hlb.entry_item(
        replace(first, fields={**first.fields, "Chi phí": "Vẫn không tốn tiền."}), PATH, newer
    )
    try:
        async with SessionLocal() as session:
            assert (await crawler.keep(session, [old]))["added"] == 1
        async with SessionLocal() as session:
            counts = await crawler.keep(session, [new])
            assert (counts["added"], counts["updated"]) == (0, 1)
            article = await session.scalar(select(Article).where(Article.url == old.url))
            await session.refresh(article, ["content"])
            assert "Vẫn không tốn tiền." in article.content and "01/12/2026" in article.credit
    finally:
        async with SessionLocal() as session:
            await session.execute(delete(Article).where(Article.url == old.url))
            await session.commit()
