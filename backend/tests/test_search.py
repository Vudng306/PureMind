from tests.pdfs import text_pdf

START, END = "\x02", "\x03"


async def setup_library(client, headers):
    r = await client.post(
        "/api/documents/upload",
        headers=headers,
        files={"file": ("ml.pdf", text_pdf(2, title="Machine learning"), "application/pdf")},
    )
    doc = r.json()
    await client.patch(
        f"/api/documents/{doc['id']}", headers=headers, json={"note": "review gradient descent before exam"}
    )
    for text, note, category in (
        ("overfitting happens when the model memorises noise", "ask about regularisation", "question"),
        ("gradient descent updates weights step by step", "", "concept"),
    ):
        await client.post(
            "/api/highlights",
            headers=headers,
            json={
                "document_id": doc["id"],
                "block_id": "b1",
                "start_offset": 0,
                "end_offset": len(text),
                "selected_text": text,
                "note": note,
                "category": category,
            },
        )
    return doc


async def test_search_groups_results_by_type(client, auth):
    h = auth()
    doc = await setup_library(client, h)

    r = await client.get("/api/search?q=gradient", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["highlights"]["total"] == 1
    hit = body["highlights"]["items"][0]
    assert (
        hit["document_id"] == doc["id"]
        and hit["document_title"] == doc["title"]
        and hit["category"] == "concept"
    )
    assert f"{START}gradient{END}" in hit["snippet"]
    # The document note matches too.
    assert [n["kind"] for n in body["notes"]["items"]] == ["document_note"]

    notes = (await client.get("/api/search?q=regularisation", headers=h)).json()["notes"]
    assert notes["total"] == 1 and notes["items"][0]["kind"] == "note"

    docs = (await client.get("/api/search?q=machine", headers=h)).json()["documents"]
    assert docs["total"] == 1 and docs["items"][0]["file_type"] == "pdf"


async def test_search_filters_and_validation(client, auth):
    h = auth()
    await setup_library(client, h)
    only = (await client.get("/api/search?q=gradient&types=highlight", headers=h)).json()
    assert (
        only["highlights"]["total"] == 1 and only["notes"]["total"] == 0 and only["documents"]["total"] == 0
    )

    filtered = (await client.get("/api/search?q=gradient&category=question", headers=h)).json()
    assert filtered["highlights"]["total"] == 0

    assert (await client.get("/api/search?q=a", headers=h)).status_code == 422
    assert (await client.get("/api/search?q=%20%20", headers=h)).status_code == 422


async def test_search_is_private(client, auth):
    await setup_library(client, auth())
    other = (await client.get("/api/search?q=gradient", headers=auth())).json()
    assert other["highlights"]["total"] == other["notes"]["total"] == other["documents"]["total"] == 0


def test_query_helpers():
    from app.api.routes.search import _plain_snippet, _tsquery

    assert _tsquery("tổng  quá") == "tổng & quá:*"
    assert _tsquery("C++ & !x") == "C & x:*"
    snippet = _plain_snippet("Điểm mấu chốt nằm ở chữ Tổng quát hóa.", "tong quat")
    assert f"{START}Tổng{END} {START}quát{END}" in snippet
