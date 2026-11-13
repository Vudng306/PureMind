"""Library Dashboard and Notebook Workspace: collections, licences, what removal affects, and notebooks by hand."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from app.db.session import SessionLocal
from app.models import Article, Document, Notebook
from app.services import rights
from tests import test_highlights


async def new_doc(client, h) -> dict:
    doc_id = await test_highlights.new_doc(client, h)
    return (await client.get(f"/api/documents/{doc_id}", headers=h)).json()


async def create(client, h, doc: dict, **kw):
    return await test_highlights.create(client, h, doc["id"], **kw)


async def test_collections_group_documents_and_removing_one_keeps_them(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    shelf = (await client.post("/api/collections", headers=h, json={"name": "  Sinh   học "})).json()
    assert shelf["name"] == "Sinh học"
    assert (await client.post("/api/collections", headers=h, json={"name": "Sinh học"})).status_code == 409
    assert (await client.post("/api/collections", headers=h, json={"name": "   "})).status_code == 422

    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"collection_id": shelf["id"]})
    assert r.status_code == 200
    assert r.json()["collection_id"] == shelf["id"]
    assert (await client.get("/api/collections", headers=h)).json()[0]["document_count"] == 1
    assert (await client.get("/api/documents", headers=h)).json()[0]["collection_id"] == shelf["id"]

    # Other fields can change without moving it, and null takes it off the shelf.
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"title": "Tên mới"})
    assert r.json()["collection_id"] == shelf["id"]
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"collection_id": None})
    assert r.json()["collection_id"] is None

    await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"collection_id": shelf["id"]})
    assert (await client.delete(f"/api/collections/{shelf['id']}", headers=h)).status_code == 204
    docs = (await client.get("/api/documents", headers=h)).json()
    assert [d["id"] for d in docs] == [doc["id"]]
    assert docs[0]["collection_id"] is None


async def test_collections_of_others_look_missing(client, auth):
    h, other = auth(), auth()
    doc = await new_doc(client, h)
    theirs = (await client.post("/api/collections", headers=other, json={"name": "Của họ"})).json()
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"collection_id": theirs["id"]})
    assert r.status_code == 404
    assert (await client.delete(f"/api/collections/{theirs['id']}", headers=h)).status_code == 404
    assert (
        await client.patch(f"/api/collections/{theirs['id']}", headers=h, json={"name": "x"})
    ).status_code == 404
    assert (await client.get("/api/collections", headers=h)).json() == []


async def test_usage_states_what_removing_a_document_affects(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    other = await new_doc(client, h)
    kept = await create(client, h, doc)
    r = await client.put(f"/api/highlights/{kept.json()['id']}/note", headers=h, json={"content": "ghi chú"})
    assert r.status_code == 200
    nb = (
        await client.post("/api/notebooks", headers=h, json={"title": "Sổ", "document_id": doc["id"]})
    ).json()
    await client.post("/api/posts", headers=h, json={"document_id": doc["id"]})

    usage = (await client.get(f"/api/documents/{doc['id']}/usage", headers=h)).json()
    assert usage == {"highlights": 1, "notes": 1, "has_summary": False, "notebooks": 1, "posts": 1}
    empty = (await client.get(f"/api/documents/{other['id']}/usage", headers=h)).json()
    assert empty == {"highlights": 0, "notes": 0, "has_summary": False, "notebooks": 0, "posts": 0}
    assert (await client.get(f"/api/documents/{doc['id']}/usage", headers=auth())).status_code == 404

    # Removing it takes the highlights and the link. The notebook and the post's source stay.
    assert (await client.delete(f"/api/documents/{doc['id']}", headers=h)).status_code == 204
    left = (await client.get(f"/api/notebooks/{nb['id']}", headers=h)).json()
    assert left["documents"] == []
    posts = (await client.get("/api/posts", headers=h)).json()
    assert posts[0]["sources"][0]["document_id"] is None
    assert posts[0]["sources"][0]["title"]


def test_no_derivatives_is_read_from_the_licence():
    assert rights.no_derivatives("CC BY-ND 4.0")
    assert not rights.no_derivatives("CC BY 4.0")
    assert not rights.no_derivatives("CC0")
    assert not rights.no_derivatives(None)


async def test_licence_comes_from_the_article_or_the_host(client):
    async with SessionLocal() as s:
        url = f"https://example.org/{uuid.uuid4().hex}"
        s.add(
            Article(
                source="example",
                url=url,
                title_key=uuid.uuid4().hex,
                title="Bài CC BY",
                language="en",
                kind="article",
                content="",
                word_count=0,
                license="CC BY 4.0",
                license_url="https://creativecommons.org/licenses/by/4.0/",
                credit="Tác giả",
            )
        )
        await s.commit()
        assert await rights.license_of_url(s, url) == "CC BY 4.0"
        assert await rights.license_of_url(s, "https://theconversation.com/a-1") == "CC BY-ND 4.0"
        assert await rights.license_of_url(s, "https://vn.theconversation.com/a-1") == "CC BY-ND 4.0"
        assert await rights.license_of_url(s, "https://nottheconversation.com/a-1") is None
        assert await rights.license_of_url(s, None) is None


async def test_a_blank_notebook_needs_no_ai_and_survives_the_draft_cleanup(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    r = await client.post(
        "/api/notebooks", headers=h, json={"title": "Dự án", "topic": " Sinh  học ", "document_id": doc["id"]}
    )
    assert r.status_code == 201
    nb = r.json()
    assert nb["ai_model"] is None
    assert nb["topic"] == "Sinh học"
    assert [d["id"] for d in nb["documents"]] == [doc["id"]]
    assert nb["documents"][0]["linked"] is True

    long_ago = datetime.now(UTC) - timedelta(days=90)
    async with SessionLocal() as s:
        await s.execute(
            update(Notebook)
            .where(Notebook.id == uuid.UUID(nb["id"]))
            .values(status="draft", opened_at=long_ago, updated_at=long_ago)
        )
        await s.commit()
    items = (await client.get("/api/notebooks", headers=h)).json()
    assert [i["id"] for i in items] == [nb["id"]]
    assert items[0]["topic"] == "Sinh học"
    assert items[0]["document_count"] == 1


async def test_an_ai_draft_with_a_post_is_kept_and_without_one_is_not(client, auth):
    h = auth()
    long_ago = datetime.now(UTC) - timedelta(days=90)
    ids = []
    for title in ("Có bài", "Không bài"):
        nb = (await client.post("/api/notebooks", headers=h, json={"title": title})).json()
        ids.append(uuid.UUID(nb["id"]))
    assert (await client.post("/api/posts", headers=h, json={"notebook_id": str(ids[0])})).status_code == 201
    async with SessionLocal() as s:
        await s.execute(
            update(Notebook)
            .where(Notebook.id.in_(ids))
            .values(status="draft", ai_model="gpt", opened_at=long_ago, updated_at=long_ago)
        )
        await s.commit()
    items = (await client.get("/api/notebooks", headers=h)).json()
    assert [i["id"] for i in items] == [str(ids[0])]


async def test_notebook_links_and_unlinks_documents_without_touching_them(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    nb = (await client.post("/api/notebooks", headers=h, json={"title": "Sổ"})).json()
    assert nb["documents"] == []
    r = await client.post(f"/api/notebooks/{nb['id']}/documents", headers=h, json={"document_id": doc["id"]})
    assert [d["id"] for d in r.json()["documents"]] == [doc["id"]]
    # Twice is once.
    r = await client.post(f"/api/notebooks/{nb['id']}/documents", headers=h, json={"document_id": doc["id"]})
    assert len(r.json()["documents"]) == 1

    theirs = await new_doc(client, auth())
    r = await client.post(
        f"/api/notebooks/{nb['id']}/documents", headers=h, json={"document_id": theirs["id"]}
    )
    assert r.status_code == 404
    r = await client.post(
        f"/api/notebooks/{nb['id']}/documents", headers=auth(), json={"document_id": doc["id"]}
    )
    assert r.status_code == 404

    r = await client.delete(f"/api/notebooks/{nb['id']}/documents/{doc['id']}", headers=h)
    assert r.json()["documents"] == []
    async with SessionLocal() as s:
        assert await s.get(Document, uuid.UUID(doc["id"])) is not None


async def test_notebook_topic_can_be_set_and_cleared(client, auth):
    h = auth()
    nb = (await client.post("/api/notebooks", headers=h, json={"title": "Sổ"})).json()
    r = await client.patch(f"/api/notebooks/{nb['id']}", headers=h, json={"topic": "Dự án A"})
    assert r.json()["topic"] == "Dự án A"
    r = await client.patch(f"/api/notebooks/{nb['id']}", headers=h, json={"title": "Sổ 2"})
    assert r.json()["topic"] == "Dự án A"
    r = await client.patch(f"/api/notebooks/{nb['id']}", headers=h, json={"topic": ""})
    assert r.json()["topic"] is None


async def test_an_inserted_summary_marks_the_notebook_once(client, auth):
    h = auth()
    created = await client.post("/api/notebooks", json={"title": "Viết tay"}, headers=h)
    assert created.status_code == 201, created.text
    notebook_id = created.json()["id"]
    assert created.json()["ai_model"] is None

    first = await client.patch(f"/api/notebooks/{notebook_id}", json={"ai_model": "gpt-a"}, headers=h)
    assert first.json()["ai_model"] == "gpt-a"
    again = await client.patch(f"/api/notebooks/{notebook_id}", json={"ai_model": "gpt-b"}, headers=h)
    assert again.json()["ai_model"] == "gpt-a"  # what AI first helped with stays on record
