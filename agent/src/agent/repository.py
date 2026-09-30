"""Parameterized reads from the two active-release knowledge views."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from agent.models import FaqHit, ProductHit


class Database(Protocol):
    """Minimal database boundary required by the repository."""

    def fetch_all(
        self, query: str, params: tuple[object, ...]
    ) -> Sequence[Mapping[str, Any]]:
        """Execute a parameterized read and return mapping rows."""

    def health(self) -> dict[str, str]:
        """Return database and active-knowledge readiness."""


class PsycopgDatabase:
    """Service-scoped PostgreSQL pool adapter with explicit lifecycle."""

    def __init__(self, connection_string: str) -> None:
        """Store the connection string without opening a connection."""
        self._connection_string = connection_string
        self._pool: Any = None

    def open(self) -> None:
        """Open the pool during application lifespan startup."""
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        self._pool = ConnectionPool(
            conninfo=self._connection_string,
            kwargs={"row_factory": dict_row},
            min_size=1,
            max_size=4,
            open=True,
        )

    def close(self) -> None:
        """Close the service-scoped pool during lifespan shutdown."""
        if self._pool is not None:
            self._pool.close()
            self._pool = None

    def fetch_all(
        self, query: str, params: tuple[object, ...]
    ) -> Sequence[Mapping[str, Any]]:
        """Execute a read through the opened pool."""
        if self._pool is None:
            raise RuntimeError("database pool is not open")
        with self._pool.connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(query, params)
                return cursor.fetchall()

    def health(self) -> dict[str, str]:
        """Prove the database and active knowledge release are readable."""
        if self._pool is None:
            raise RuntimeError("database pool is not open")
        with self._pool.connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1 AS ready")
                if cursor.fetchone()["ready"] != 1:
                    raise RuntimeError("database readiness check failed")
                cursor.execute(
                    """
                    SELECT version AS version
                    FROM public.knowledge_releases
                    WHERE status = 'active'
                    ORDER BY activated_at DESC NULLS LAST, created_at DESC
                    LIMIT 1
                    """
                )
                row = cursor.fetchone()
                if not row or not row["version"]:
                    raise RuntimeError("active knowledge release missing")
                return {
                    "database": "ready",
                    "knowledge": "ready",
                    "knowledge_version": str(row["version"]),
                }


class RepositoryError(RuntimeError):
    """Safe repository failure without database details."""

    def __init__(self) -> None:
        """Create a fixed public-safe retrieval error."""
        super().__init__("knowledge retrieval unavailable")
        self.code = "retrieval_unavailable"


FAQ_SEARCH_SQL = """
SELECT
    card_id,
    answer,
    category,
    source_snapshot,
    release_version,
    CASE
        WHEN question ILIKE ('%%' || %s || '%%') THEN 1.0
        WHEN answer ILIKE ('%%' || %s || '%%') THEN 0.85
        WHEN category ILIKE ('%%' || %s || '%%') THEN 0.8
        ELSE 0.0
    END AS score
FROM public.current_business_faq
WHERE status = 'approved'
  AND (
      question ILIKE ('%%' || %s || '%%')
      OR answer ILIKE ('%%' || %s || '%%')
      OR category ILIKE ('%%' || %s || '%%')
  )
ORDER BY score DESC, card_id
LIMIT %s
"""


PRODUCT_SEARCH_SQL = """
WITH matching_chunks AS MATERIALIZED (
    SELECT
        product_id,
        release_version,
        stable_facts,
        chunk_id,
        chunk_type,
        sale_status_snapshot,
        recommendable_snapshot
    FROM public.current_product_knowledge
    WHERE status = 'approved'
      AND combined_text ILIKE ('%%' || %s || '%%')
)
SELECT DISTINCT ON (product_id)
    product_id,
    release_version,
    stable_facts,
    jsonb_build_object('chunk_id', chunk_id, 'chunk_type', chunk_type) AS source_snapshot,
    1.0 AS score,
    sale_status_snapshot,
    recommendable_snapshot
FROM matching_chunks
WHERE recommendable_snapshot = TRUE
  AND sale_status_snapshot = 'active'
ORDER BY product_id, chunk_id
LIMIT %s
"""

FAQ_SEMANTIC_SEARCH_SQL = """
SELECT
    c.card_id,
    c.answer,
    c.category,
    c.source_snapshot,
    c.release_version,
    GREATEST(
        1 - (c.content_vector <=> %s::vector),
        COALESCE((
            SELECT max(1 - (p.phrase_vector <=> %s::vector))
            FROM public.business_faq_phrases p
            WHERE p.card_id = c.card_id
              AND p.release_version = c.release_version
              AND p.phrase_vector IS NOT NULL
        ), -1)
    ) AS score
FROM public.current_business_faq c
WHERE c.status = 'approved'
  AND c.content_vector IS NOT NULL
ORDER BY score DESC, c.card_id
LIMIT %s
"""

PRODUCT_SEMANTIC_SEARCH_SQL = """
WITH ranked_chunks AS MATERIALIZED (
    SELECT
        product_id,
        release_version,
        stable_facts,
        chunk_id,
        chunk_type,
        sale_status_snapshot,
        recommendable_snapshot,
        1 - (content_vector <=> %s::vector) AS score
    FROM public.current_product_knowledge
    WHERE status = 'approved'
      AND content_vector IS NOT NULL
      AND recommendable_snapshot = TRUE
      AND sale_status_snapshot = 'active'
), best_products AS (
    SELECT DISTINCT ON (product_id)
        product_id,
        release_version,
        stable_facts,
        jsonb_build_object('chunk_id', chunk_id, 'chunk_type', chunk_type)
            AS source_snapshot,
        score,
        sale_status_snapshot,
        recommendable_snapshot
    FROM ranked_chunks
    ORDER BY product_id, score DESC, chunk_id
)
SELECT * FROM best_products
ORDER BY score DESC, product_id
LIMIT %s
"""


class Repository:
    """Read audited knowledge through active-release views only."""

    def __init__(self, database: Database) -> None:
        """Bind the parameterized database executor."""
        self._database = database

    def health(self) -> dict[str, str]:
        """Expose readiness without leaking the private database adapter."""
        return self._database.health()

    def search_business_faq(self, query: str, limit: int) -> list[FaqHit]:
        """Return approved FAQ matches without leaking database failures."""
        try:
            rows = self._database.fetch_all(
                FAQ_SEARCH_SQL,
                (query, query, query, query, query, query, limit),
            )
            return [self._faq_hit(row) for row in rows]
        except RepositoryError:
            raise
        except Exception as error:
            raise RepositoryError() from error

    def search_products(self, query: str, limit: int) -> list[ProductHit]:
        """Return only active and explicitly recommendable products."""
        try:
            rows = self._database.fetch_all(PRODUCT_SEARCH_SQL, (query, limit))
            return [
                self._product_hit(row)
                for row in rows
                if row.get("recommendable_snapshot") is True
                and row.get("sale_status_snapshot") == "active"
            ]
        except RepositoryError:
            raise
        except Exception as error:
            raise RepositoryError() from error

    def search_business_faq_semantic(
        self, vector: list[float], limit: int
    ) -> list[FaqHit]:
        """Return approved FAQ cards ranked in the active vector space."""
        literal = _vector_literal(vector)
        try:
            rows = self._database.fetch_all(
                FAQ_SEMANTIC_SEARCH_SQL, (literal, literal, limit)
            )
            return [self._faq_hit(row) for row in rows]
        except RepositoryError:
            raise
        except Exception as error:
            raise RepositoryError() from error

    def search_products_semantic(
        self, vector: list[float], limit: int
    ) -> list[ProductHit]:
        """Return active recommendable products ranked by meaning."""
        literal = _vector_literal(vector)
        try:
            rows = self._database.fetch_all(
                PRODUCT_SEMANTIC_SEARCH_SQL, (literal, limit)
            )
            return [self._product_hit(row) for row in rows]
        except RepositoryError:
            raise
        except Exception as error:
            raise RepositoryError() from error

    @staticmethod
    def _faq_hit(row: Mapping[str, Any]) -> FaqHit:
        return FaqHit(
            card_id=str(row["card_id"]),
            answer=str(row["answer"]),
            category=str(row["category"]),
            source_snapshot=dict(row["source_snapshot"]),
            score=float(row["score"]),
            knowledge_version=str(row["release_version"]),
        )

    @staticmethod
    def _product_hit(row: Mapping[str, Any]) -> ProductHit:
        facts = dict(row["stable_facts"])
        sku_codes = facts.get("skuCodes", [])
        return ProductHit(
            product_id=str(row["product_id"]),
            name=str(facts.get("title", "")),
            sku_ids=[str(value) for value in sku_codes] if isinstance(sku_codes, list) else [],
            stable_facts=facts,
            source_snapshot=dict(row["source_snapshot"]),
            score=float(row["score"]),
            knowledge_version=str(row["release_version"]),
        )


def _vector_literal(vector: list[float]) -> str:
    """Serialize a validated query vector for a parameterized pgvector cast."""
    return "[" + ",".join(format(float(value), ".9g") for value in vector) + "]"
