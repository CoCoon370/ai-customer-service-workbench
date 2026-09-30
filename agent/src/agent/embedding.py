"""Query embeddings for meaning-based knowledge retrieval."""

from __future__ import annotations

import json
import math
from typing import Protocol
from urllib import request

EMBEDDING_MODEL = "text-embedding-v4"
EMBEDDING_DIMENSION = 1024
DEFAULT_EMBEDDING_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/embeddings/"
    "text-embedding/text-embedding"
)


class QueryEmbedder(Protocol):
    """Convert one customer question into the active knowledge vector space."""

    def embed(self, text: str) -> list[float]:
        """Return one validated query vector."""


class DashScopeQueryEmbedder:
    """Small synchronous adapter for DashScope text-embedding-v4."""

    def __init__(self, api_key: str, url: str = DEFAULT_EMBEDDING_URL) -> None:
        """Bind the server-only API credential and fixed embedding endpoint."""
        self._api_key = api_key
        self._url = url

    def embed(self, text: str) -> list[float]:
        """Generate and validate one 1024-dimension query vector."""
        payload = json.dumps(
            {
                "model": EMBEDDING_MODEL,
                "input": {"texts": [text]},
                "parameters": {"dimension": EMBEDDING_DIMENSION},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        api_request = request.Request(
            self._url,
            data=payload,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with request.urlopen(api_request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
        embeddings = body.get("output", {}).get("embeddings", [])
        if len(embeddings) != 1:
            raise RuntimeError("query embedding unavailable")
        vector = [float(value) for value in embeddings[0].get("embedding", [])]
        if len(vector) != EMBEDDING_DIMENSION or not all(
            math.isfinite(value) for value in vector
        ):
            raise RuntimeError("query embedding invalid")
        return vector
