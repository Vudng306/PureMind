"""Clean Reader GĐ3: the side store and the extraction-error reports, through the API."""

import uuid

from sqlalchemy import func, select

from tests.pdfs import paper_pdf, text_pdf
from tests.test_documents import upload


async def test_side_store_is_the_owners_only(client, auth):
    alice, bob = auth(), auth()
    doc = (await upload(client, alice, paper_pdf())).json()
    r = await client.get(f"/api/documents/{doc['id']}/aside", headers=alice)
    assert r.status_code == 200
    aside = r.json()
    assert aside["classifier"] == "rules-1"
    blocks = aside["blocks"]
    assert [b["id"] for b in blocks] == list(range(len(blocks)))
    assert {"RUNNING_HEADER", "PAGE_NUMBER", "AFFILIATIONS"} <= {b["type"] for b in blocks}
    header = next(b for b in blocks if b["type"] == "RUNNING_HEADER")
    assert header["page"] >= 1 and len(header["box"]) == 4 and header["reason"]
    # CR-NFR-06: another user's side store is "not found", like the document.
    assert (await client.get(f"/api/documents/{doc['id']}/aside", headers=bob)).status_code == 404


async def test_report_extraction_error(client, auth):
    from app.db.session import SessionLocal
    from app.models import ExtractionReport

    alice, bob = auth(), auth()
    doc = (await upload(client, alice, paper_pdf())).json()
    url = f"/api/documents/{doc['id']}/extraction-reports"
    blocks = (await client.get(f"/api/documents/{doc['id']}/aside", headers=alice)).json()["blocks"]

    r = await client.post(url, headers=alice, json={"error_type": "wrongly_hidden", "block": 0, "page": 1})
    assert r.status_code == 201, r.text
    first = r.json()
    assert first["error_type"] == "wrongly_hidden" and first["block"] == 0
    # The same report twice is one report.
    again = await client.post(
        url, headers=alice, json={"error_type": "wrongly_hidden", "block": 0, "page": 1}
    )
    assert again.status_code == 201 and again.json()["id"] == first["id"]
    other = await client.post(
        url, headers=alice, json={"error_type": "wrong_order", "note": " Cột 2 trước cột 1 "}
    )
    assert other.status_code == 201 and other.json()["id"] != first["id"]

    async with SessionLocal() as session:
        rows = (
            await session.scalars(
                select(ExtractionReport).where(ExtractionReport.document_id == uuid.UUID(doc["id"]))
            )
        ).all()
        assert len(rows) == 2
        hidden = next(r for r in rows if r.error_type == "wrongly_hidden")
        assert hidden.block_type == blocks[0]["type"] and hidden.classifier == "rules-1"
        assert next(r for r in rows if r.error_type == "wrong_order").note == "Cột 2 trước cột 1"

    bad = [
        {"error_type": "nonsense"},
        {"error_type": "other", "block": len(blocks)},
        {"error_type": "other", "page": 99},
        {"error_type": "other", "note": "x" * 1001},
    ]
    for body in bad:
        assert (await client.post(url, headers=alice, json=body)).status_code == 422, body
    assert (await client.post(url, headers=bob, json={"error_type": "other"})).status_code == 404

    async with SessionLocal() as session:
        n = await session.scalar(select(func.count()).select_from(ExtractionReport))
        assert n == 2


async def test_old_extraction_has_no_classifier(client, auth):
    """A document made before the side store existed says so (classifier null), not "nothing hidden"."""
    from app.db.session import SessionLocal
    from app.models import Document

    h = auth()
    doc = (await upload(client, h, text_pdf(1))).json()
    async with SessionLocal() as session:
        row = await session.get(Document, uuid.UUID(doc["id"]))
        row.content_aside = None
        await session.commit()
    aside = (await client.get(f"/api/documents/{doc['id']}/aside", headers=h)).json()
    assert aside == {"classifier": None, "blocks": []}
