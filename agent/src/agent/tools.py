"""Safe FAQ and product retrieval tools with request-scoped audit snapshots."""

from __future__ import annotations

from contextvars import ContextVar, Token
from typing import Protocol

from agent.models import FaqHit, ProductHit, SearchResult

FAQ_THRESHOLD = 0.75
PRODUCT_THRESHOLD = 0.75
AMBIGUITY_MARGIN = 0.05


class KnowledgeRepository(Protocol):
    """Retrieval operations required by the tool layer."""

    def search_business_faq(self, query: str, limit: int) -> list[FaqHit]:
        """Return FAQ candidates."""
        ...

    def search_products(self, query: str, limit: int) -> list[ProductHit]:
        """Return product candidates."""
        ...

    def search_business_faq_semantic(
        self, vector: list[float], limit: int
    ) -> list[FaqHit]:
        """Return FAQ candidates ranked by meaning."""
        ...

    def search_products_semantic(
        self, vector: list[float], limit: int
    ) -> list[ProductHit]:
        """Return product candidates ranked by meaning."""
        ...


_hit_snapshot: ContextVar[SearchResult] = ContextVar(
    "hit_snapshot", default=SearchResult(status="insufficient")
)


def reset_hit_snapshot(token: Token[SearchResult] | None = None):
    """Start a fresh request snapshot or restore the previous context."""
    if token is not None:
        _hit_snapshot.reset(token)
        return None
    return _hit_snapshot.set(SearchResult(status="insufficient"))


def get_hit_snapshot() -> SearchResult:
    """Return the current request's immutable-by-convention snapshot."""
    return _hit_snapshot.get().model_copy(deep=True)


def search_business_faq(
    query: str, *, repository: KnowledgeRepository, limit: int = 5
) -> SearchResult:
    """Search audited FAQ knowledge and return a safe structured outcome."""
    normalized = _normalize_query(query)
    if normalized is None:
        return _store(SearchResult(status="insufficient", insufficient_fields=["question"]))
    try:
        hits = [
            hit
            for hit in repository.search_business_faq(normalized, limit)
            if hit.score >= FAQ_THRESHOLD
        ]
    except Exception:
        return _store(_safe_error())
    if not hits:
        return _store(
            SearchResult(status="insufficient", insufficient_fields=["faq_match"])
        )
    return _store(SearchResult(status="matched", faq_hits=hits))


def search_products(
    query: str,
    *,
    repository: KnowledgeRepository,
    limit: int = 5,
    allow_multiple: bool = False,
) -> SearchResult:
    """Search recommendable products and reject ambiguous identities."""
    normalized = _normalize_query(query)
    if normalized is None:
        return _store(SearchResult(status="insufficient", insufficient_fields=["question"]))
    try:
        hits = sorted(
            (
                hit
                for hit in repository.search_products(normalized, limit)
                if hit.score >= PRODUCT_THRESHOLD
            ),
            key=lambda hit: hit.score,
            reverse=True,
        )
    except Exception:
        return _store(_safe_error())
    if not hits:
        return _store(
            SearchResult(status="insufficient", insufficient_fields=["product_match"])
        )
    if (
        not allow_multiple
        and
        len(hits) > 1
        and hits[0].product_id != hits[1].product_id
        and hits[0].score - hits[1].score < AMBIGUITY_MARGIN
    ):
        return _store(
            SearchResult(status="insufficient", insufficient_fields=["product_identity"])
        )
    selected_hits = hits if allow_multiple else [hits[0]]
    return _store(SearchResult(status="matched", product_hits=selected_hits))


def _normalize_query(query: str) -> str | None:
    normalized = query.strip() if isinstance(query, str) else ""
    return normalized if 1 <= len(normalized) <= 2000 else None


def _safe_error() -> SearchResult:
    return SearchResult(
        status="error",
        retryable=True,
        error_code="retrieval_unavailable",
    )


def _store(result: SearchResult) -> SearchResult:
    current = _hit_snapshot.get()
    _hit_snapshot.set(
        SearchResult(
            status=result.status,
            faq_hits=result.faq_hits or current.faq_hits,
            product_hits=result.product_hits or current.product_hits,
            insufficient_fields=result.insufficient_fields,
            retryable=result.retryable,
            error_code=result.error_code,
        )
    )
    return result
