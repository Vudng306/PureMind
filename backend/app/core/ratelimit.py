"""In-process sliding-window rate limiter (NFR-SEC-07).

Suitable for the single-instance Docker Compose deployment; move to Redis before running several API replicas.
"""

import time
from collections import defaultdict, deque
from threading import Lock


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def hit(self, key: str) -> bool:
        """Record an attempt; returns False when the key is over the limit."""
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] >= self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


upload_limiter = RateLimiter(limit=30, window_seconds=3600)
