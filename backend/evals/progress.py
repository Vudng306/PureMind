"""Opt-in evaluation progress on stderr; stdout remains the result/report stream."""

import sys
import time
from contextlib import contextmanager


class Progress:
    def __init__(self, enabled=False):
        self.enabled = enabled
        self.started = time.perf_counter()

    def log(self, message):
        if self.enabled:
            print(f"[{time.perf_counter() - self.started:7.2f}s] {message}", file=sys.stderr, flush=True)

    @contextmanager
    def step(self, name):
        started = time.perf_counter()
        self.log(f"START {name}")
        try:
            yield
        except Exception as exc:
            self.log(f"FAIL {name} ({type(exc).__name__})")
            raise
        else:
            self.log(f"DONE {name} ({time.perf_counter() - started:.2f}s)")


async def embed_with_progress(settings, texts, *, purpose, usage, progress):
    from app.services import embeddings

    vectors = []
    batches = (len(texts) + embeddings.BATCH - 1) // embeddings.BATCH
    progress.log(f"Embedding model={settings.openai_embedding_model}; inputs={len(texts)}; batches={batches}")
    for start in range(0, len(texts), embeddings.BATCH):
        batch = texts[start : start + embeddings.BATCH]
        number = start // embeddings.BATCH + 1
        with progress.step(f"embedding batch {number}/{batches}, inputs={len(batch)}"):
            vectors.extend(await embeddings.embed(settings, batch, purpose=purpose, usage=usage))
    return vectors
