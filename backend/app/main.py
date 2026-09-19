import logging

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import account, documents, highlights, notebooks, search, summaries
from app.core.config import get_settings
from app.core.messages import MSG

settings = get_settings()
logging.basicConfig(level=logging.INFO)

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
    logging.getLogger("app").exception("unhandled error", exc_info=exc)
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
