import uuid

from tests.pdfs import text_pdf


async def new_doc(client, headers) -> str:
    r = await client.post(
        "/api/documents/upload", headers=headers, files={"file": ("bai.pdf", text_pdf(2), "application/pdf")}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def payload(**kw):
    data = {
        "block_id": "b3",
        "start_offset": 4,
        "end_offset": 20,
        "selected_text": "mô hình đoán đúng",
        "color": "yellow",
        "page_number": 1,
    }
    data.update(kw)
    return data


async def create(client, headers, doc, **kw):
    return await client.post("/api/highlights", headers=headers, json=payload(document_id=doc, **kw))


async def items(client, headers, query=""):
    r = await client.get(f"/api/highlights{query}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def test_highlight_crud(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    client_id = str(uuid.uuid4())

    r = await create(client, h, doc, id=client_id)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["id"] == client_id and created["note"] == "" and created["category"] is None
    assert created["document_id"] == doc
    assert (await create(client, h, doc, id=client_id)).status_code == 409

    r = await client.patch(f"/api/highlights/{client_id}", headers=h, json={"color": "purple", "category": "question"})
    assert r.status_code == 200 and r.json()["color"] == "purple" and r.json()["category"] == "question"
    # Unset fields are left alone; category null removes the category (FR-HL-04 step 2).
    r = await client.patch(f"/api/highlights/{client_id}", headers=h, json={"category": None})
    assert r.json()["category"] is None and r.json()["color"] == "purple"

    await create(client, h, doc, block_id="b9")
    page = await items(client, h)
    assert page["total"] == 2 and [x["block_id"] for x in page["items"]] == ["b9", "b3"]  # newest first
    assert (await items(client, h, f"?document_id={doc}&sort=document"))["total"] == 2

    assert (await client.delete(f"/api/highlights/{client_id}", headers=h)).status_code == 204
    assert (await items(client, h))["total"] == 1


async def test_highlight_note(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    hl = (await create(client, h, doc)).json()

    r = await client.put(f"/api/highlights/{hl['id']}/note", headers=h, json={"content": "Vì sao **quan trọng**"})
    assert r.status_code == 200 and r.json()["note"] == "Vì sao **quan trọng**"
    r = await client.put(f"/api/highlights/{hl['id']}/note", headers=h, json={"content": "x" * 10001})
    assert r.status_code == 422 and r.json()["detail"] == "Ghi chú tối đa 10.000 ký tự."
    assert (await client.delete(f"/api/highlights/{hl['id']}/note", headers=h)).status_code == 204
    assert (await items(client, h))["items"][0]["note"] == ""


async def test_highlight_filters_and_paging(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    for i in range(5):
        await create(
            client, h, doc, block_id=f"b{i}", color="blue" if i % 2 else "yellow", category="concept" if i < 2 else None
        )
    assert (await items(client, h, "?color=blue"))["total"] == 2
    assert (await items(client, h, "?category=concept"))["total"] == 2
    page2 = await items(client, h, "?page=2&page_size=2")
    assert page2["total"] == 5 and len(page2["items"]) == 2
    assert (await client.get("/api/highlights?category=other", headers=h)).status_code == 422


async def test_highlight_validation(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    for bad in (
        payload(color="orange"),
        payload(start_offset=10, end_offset=10),
        payload(selected_text=""),
        payload(category="misc"),
    ):
        assert (await client.post("/api/highlights", headers=h, json={**bad, "document_id": doc})).status_code == 422
    r = await create(client, h, doc, selected_text="x" * 5001)
    assert r.status_code == 422 and "5.000" in r.json()["detail"]


async def test_highlights_are_private(client, auth):
    alice, bob = auth(), auth()
    doc = await new_doc(client, alice)
    hl = (await create(client, alice, doc)).json()

    assert (await create(client, bob, doc)).status_code == 404
    assert (await client.patch(f"/api/highlights/{hl['id']}", headers=bob, json={"color": "blue"})).status_code == 404
    assert (await client.put(f"/api/highlights/{hl['id']}/note", headers=bob, json={"content": "x"})).status_code == 404
    assert (await client.delete(f"/api/highlights/{hl['id']}", headers=bob)).status_code == 404
    assert (await items(client, bob))["total"] == 0


async def test_deleting_document_removes_its_highlights(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    await create(client, h, doc)
    assert (await client.delete(f"/api/documents/{doc}", headers=h)).status_code == 204
    assert (await items(client, h))["total"] == 0


async def test_document_note_and_read_fraction(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    r = await client.patch(f"/api/documents/{doc}", headers=h, json={"note": "Ôn lại chương 2", "read_fraction": 0.42})
    assert r.status_code == 200, r.text
    assert r.json()["note"] == "Ôn lại chương 2" and r.json()["read_fraction"] == 0.42

    listed = (await client.get("/api/documents", headers=h)).json()
    assert listed[0]["read_fraction"] == 0.42 and "note" not in listed[0]

    assert (await client.patch(f"/api/documents/{doc}", headers=h, json={"read_fraction": 1.5})).status_code == 422
    assert (await client.patch(f"/api/documents/{doc}", headers=h, json={"note": ""})).json()["note"] == ""


async def test_import_local_annotations(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    other = await new_doc(client, auth())  # someone else's document
    missing = str(uuid.uuid4())
    local_id = str(uuid.uuid4())
    body = {
        "highlights": [
            {**payload(id=local_id), "document_id": doc, "created_at": "2026-09-01T08:00:00Z"},
            {**payload(block_id="b5"), "document_id": other},
        ],
        "notes": {doc: "Ghi chú cũ", missing: "mất"},
        "progress": {doc: 0.3},
    }
    r = await client.post("/api/annotations/import", headers=h, json=body)
    assert r.status_code == 200, r.text
    result = r.json()
    assert (result["highlights"], result["notes"], result["progress"]) == (1, 1, 1)
    assert set(result["unknown_documents"]) == {other, missing}

    # Running it again changes nothing and keeps newer server data.
    await client.patch(f"/api/documents/{doc}", headers=h, json={"note": "Mới hơn"})
    again = (await client.post("/api/annotations/import", headers=h, json=body)).json()
    assert (again["highlights"], again["notes"], again["progress"]) == (0, 0, 0)

    detail = (await client.get(f"/api/documents/{doc}", headers=h)).json()
    assert detail["note"] == "Mới hơn" and detail["read_fraction"] == 0.3
    listed = (await items(client, h))["items"]
    assert [x["id"] for x in listed] == [local_id]
    assert listed[0]["created_at"].startswith("2026-09-01")


async def test_reader_preferences_extended(client, auth):
    h = auth()
    prefs = {
        "line_height": 1.8,
        "column_width": 600,
        "default_mode": "original",
        "color_labels": {"yellow": "Quan trọng", "green": "", "blue": "Khái niệm", "pink": "Hỏi thầy", "purple": ""},
    }
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": prefs})
    assert r.status_code == 200, r.text
    assert r.json()["reading_preferences"] == prefs

    for bad in ({"line_height": 2}, {"column_width": 700}, {"color_labels": {"yellow": "x" * 25}}):
        assert (await client.patch("/api/account", headers=h, json={"reading_preferences": bad})).status_code == 422


async def test_pdf_page_highlight(client, auth):
    """FR-HL-01 step 2: a highlight made on the original PDF page is stored as page + normalised rectangles."""
    h = auth()
    doc = await new_doc(client, h)
    rects = [{"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.03}, {"x": 0.1, "y": 0.235, "w": 0.3, "h": 0.03}]
    body = {"document_id": doc, "selected_text": "mô hình đoán đúng", "page_number": 2, "rects": rects, "color": "blue"}
    r = await client.post("/api/highlights", headers=h, json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["rects"] == rects and out["block_id"] is None and out["start_offset"] is None
    assert (await items(client, h))["items"][0]["rects"] == rects

    # Clean-text highlights have no rectangles.
    assert (await create(client, h, doc)).json()["rects"] is None

    for bad in (
        {**body, "page_number": None},  # rectangles need a page
        {**body, "rects": [{"x": 0.8, "y": 0.1, "w": 0.5, "h": 0.1}]},  # outside the page
        {**body, "rects": []},
        {**body, "rects": None},  # no position at all
        {**body, "block_id": "b1"},  # partial text anchor
    ):
        assert (await client.post("/api/highlights", headers=h, json=bad)).status_code == 422, bad
    r = await client.post("/api/highlights", headers=h, json={**body, "page_number": 3})  # the PDF has 2 pages
    assert r.status_code == 422 and r.json()["detail"] == "Trang không tồn tại trong tài liệu."
