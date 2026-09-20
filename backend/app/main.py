import logging
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import account, documents, highlights, notebooks, search, summaries
from app.core import logging as applog
from app.core.config import get_settings
from app.core.messages import MSG

settings = get_settings()
applog.configure(settings.log_level)
log = logging.getLogger("app.request")

app = FastAPI(
    title="PureMind API",
    version="0.1.0",
    # NFR-SEC-08: no interactive docs in production
    docs_url=None if settings.is_production else "/api/docs",
    redoc_url=None,
    openapi_url=None if settings.is_production else "/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "Range"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if settings.is_production:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


def endpoint_template(request: Request) -> str:
    """ "/api/documents/7f3a…" -> "/api/documents/{document_id}", so logs group by endpoint.

    `scope["route"].path` is relative to the router it was declared in, so the path parameters are put
    back by hand instead.
    """
    path = request.url.path
    for name, value in (request.scope.get("path_params") or {}).items():
        path = path.replace(str(value), "{" + name + "}", 1)
    return path


@app.middleware("http")
async def access_log(request: Request, call_next):
    """NFR-OBS-01: one JSON line per request. Added last, so it is the outermost middleware."""
    request_id = request.headers.get("X-Request-ID") or applog.new_request_id()
    # No reset: Starlette runs every request in its own task, and the error handlers that run after this
    # middleware should still see the id.
    applog.request_id_var.set(request_id)
    applog.user_id_var.set(None)
    started = time.perf_counter()

    def record(status: int) -> dict:
        fields = {
            "method": request.method,
            "path": request.url.path,
            "endpoint": endpoint_template(request),
            "status": status,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        }
        if user_id := request.scope.get(applog.USER_ID_SCOPE_KEY):
            fields["user_id"] = user_id
        return fields

    try:
        response = await call_next(request)
    except Exception:
        # The traceback is logged by unhandled_handler, which runs after this middleware.
        log.error("request failed", extra=record(500))
        raise
    response.headers["X-Request-ID"] = request_id
    log.info("request", extra=record(response.status_code))
    return response


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    """Errors are returned as {"detail": "<message>"} (SRS 3.4)."""
    message = "Dữ liệu không hợp lệ."
    for err in exc.errors():
        text = str(err.get("msg", ""))
        code = next((c for c in MSG if c in text), None)
        if code:
            message = MSG[code]
            break
    return JSONResponse(status_code=422, content={"detail": message})


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    log.exception("unhandled error", exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": MSG["MSG-99"]})


@app.get("/api/healthz", tags=["health"])
async def healthz():
    return {"status": "ok"}


app.include_router(account.router, prefix="/api")
app.include_router(documents.router, prefix="/api")
app.include_router(highlights.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(summaries.router, prefix="/api")
app.include_router(notebooks.router, prefix="/api")
