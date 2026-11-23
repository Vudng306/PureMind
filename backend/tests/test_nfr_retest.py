"""Reproducible checks at the actual NFR limits, without external AI or web calls."""

import httpx
import pytest

from app.core.config import get_settings
from app.services import web
from app.services.openai_client import AIError
from tests.pdfs import text_pdf
from tests.test_epub_web import fake_web  # noqa: F401
from tests.test_highlights import create
from tests.test_reader_notebook import ai  # noqa: F401
from tests.test_summaries import consent, new_doc


@pytest.mark.parametrize("delta", [-1, 0, 1])
async def test_actual_upload_boundary(client, auth, delta):
    limit = 50 * 1024 * 1024
    assert get_settings().max_upload_bytes == limit
    pdf = text_pdf(1)
    data = pdf + b" " * (limit + delta - len(pdf))
    response = await client.post(
        "/api/documents/upload",
        headers=auth(),
        files={"file": ("boundary.pdf", data, "application/pdf")},
    )
    assert response.status_code == (413 if delta > 0 else 201), response.text


@pytest.mark.parametrize("delta", [-1, 0, 1])
@pytest.mark.parametrize("declared_length", [True, False])
async def test_actual_url_boundary(fake_web, delta, declared_length):  # noqa: F811
    limit = 20 * 1024 * 1024
    assert limit == web.MAX_BYTES
    fake_web.dns["boundary.example.org"] = ["93.184.216.34"]
    headers = {"content-type": "application/pdf"}
    if declared_length:
        headers["content-length"] = str(limit + delta)
    response = httpx.Response(200, headers=headers, content=b" " * (limit + delta))
    if not declared_length:
        del response.headers["content-length"]
    fake_web.routes["boundary.example.org/a"] = response
    if delta > 0:
        with pytest.raises(web.FetchFailed):
            await web.fetch_url("https://boundary.example.org/a")
    else:
        result = await web.fetch_url("https://boundary.example.org/a")
        assert len(result.body) == limit + delta


@pytest.mark.parametrize("redirects", [5, 6])
async def test_actual_redirect_boundary(fake_web, redirects):  # noqa: F811
    assert web.MAX_REDIRECTS == 5
    fake_web.dns["boundary.example.org"] = ["93.184.216.34"]
    for i in range(redirects):
        fake_web.routes[f"boundary.example.org/{i}"] = httpx.Response(302, headers={"location": f"/{i + 1}"})
    fake_web.routes[f"boundary.example.org/{redirects}"] = httpx.Response(200, content=b"ok")
    if redirects > 5:
        with pytest.raises(web.FetchFailed):
            await web.fetch_url("https://boundary.example.org/0")
    else:
        assert (await web.fetch_url("https://boundary.example.org/0")).body == b"ok"


async def test_read_and_highlight_survive_ai_failure(client, auth, ai):  # noqa: F811
    headers = auth()
    document = await new_doc(client, headers, text_pdf(3))
    await consent(client, headers)
    saved = await create(client, headers, document)
    assert saved.status_code == 201
    ai(AIError("provider unavailable"))
    for operation in ("quick", "deep", "mindmap"):
        failed = await client.post(f"/api/documents/{document}/ai/{operation}", headers=headers)
        assert failed.status_code == 502, failed.text
        opened = await client.get(f"/api/documents/{document}", headers=headers)
        assert opened.status_code == 200 and opened.json()["content_clean"]
        assert (await client.get(f"/api/documents/{document}/file", headers=headers)).status_code == 200
        created = await create(client, headers, document, start_offset=30, end_offset=38)
        assert created.status_code in (200, 201), created.text
        edited = await client.patch(
            f"/api/highlights/{saved.json()['id']}", headers=headers, json={"color": "green"}
        )
        assert edited.status_code == 200 and edited.json()["color"] == "green"
        notebook = await client.get(f"/api/notebook/documents/{document}", headers=headers)
        assert notebook.status_code == 200
        assert saved.json()["id"] in [item["id"] for item in notebook.json()["highlights"]]
