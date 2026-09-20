FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY pyproject.toml ./
RUN mkdir app && pip install . && rm -rf app

COPY . .
RUN useradd --create-home appuser && mkdir -p /data/uploads && chown -R appuser /data /app
USER appuser

EXPOSE 8000
# $PORT is set by the host (Railway, Render, Fly); 8000 is the local docker-compose default.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips '*'"]
