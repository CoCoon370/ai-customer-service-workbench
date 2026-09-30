import pytest
from psycopg._queries import PostgresQuery
from psycopg.adapt import Transformer

from agent.repository import (
    FAQ_SEARCH_SQL,
    FAQ_SEMANTIC_SEARCH_SQL,
    PRODUCT_SEARCH_SQL,
    PRODUCT_SEMANTIC_SEARCH_SQL,
    Repository,
    RepositoryError,
)


class FakeDatabase:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []
        self.health_calls = 0

    def fetch_all(self, query, params):
        self.calls.append((query, params))
        return self.rows

    def health(self):
        self.health_calls += 1
        return {
            "database": "ready",
            "knowledge": "ready",
            "knowledge_version": "release-1",
        }


def test_repository_exposes_health_through_its_public_boundary() -> None:
    database = FakeDatabase([])

    result = Repository(database).health()

    assert result["knowledge_version"] == "release-1"
    assert database.health_calls == 1


@pytest.mark.parametrize(
    ("query", "params"),
    [
        (
            FAQ_SEARCH_SQL,
            (
                "配送范围",
                "配送范围",
                "配送范围",
                "配送范围",
                "配送范围",
                "配送范围",
                5,
            ),
        ),
        (PRODUCT_SEARCH_SQL, ("蔬菜", 5)),
        (
            FAQ_SEMANTIC_SEARCH_SQL,
            ("[0.01,0.02]", "[0.01,0.02]", 5),
        ),
        (PRODUCT_SEMANTIC_SEARCH_SQL, ("[0.01,0.02]", 5)),
    ],
    ids=["faq", "product", "faq-semantic", "product-semantic"],
)
def test_parameterized_search_sql_is_accepted_by_psycopg3(
    query: str, params: tuple[object, ...]
) -> None:
    converted = PostgresQuery(Transformer())

    converted.convert(query, params)

    assert converted.query


def test_product_search_excludes_non_recommendable_rows() -> None:
    database = FakeDatabase(
        [
            {
                "product_id": "ok",
                "release_version": "release-1",
                "stable_facts": {"title": "有机蔬菜", "skuCodes": ["sku-1"]},
                "source_snapshot": {"chunk_id": "chunk-ok"},
                "score": 0.9,
                "sale_status_snapshot": "active",
                "recommendable_snapshot": True,
            },
            {
                "product_id": "backup",
                "release_version": "release-1",
                "stable_facts": {"title": "备份商品", "skuCodes": []},
                "source_snapshot": {"chunk_id": "chunk-backup"},
                "score": 0.99,
                "sale_status_snapshot": "excluded_non_sale",
                "recommendable_snapshot": False,
            },
        ]
    )

    hits = Repository(database).search_products("蔬菜", 5)

    assert [hit.product_id for hit in hits] == ["ok"]
    query, params = database.calls[0]
    assert "current_product_knowledge" in query
    assert "workbench_products" not in query
    assert "recommendable_snapshot = TRUE" in query
    assert "sale_status_snapshot = 'active'" in query
    assert "蔬菜" not in query
    assert "蔬菜" in params


def test_product_search_materializes_text_match_before_recommendability_filter() -> None:
    """Scan matching chunks once before applying the product recommendation gate."""
    normalized = " ".join(PRODUCT_SEARCH_SQL.split())

    assert "WITH matching_chunks AS MATERIALIZED" in normalized
    inner, outer = normalized.split(") SELECT DISTINCT ON", maxsplit=1)
    assert "combined_text ILIKE" in inner
    assert "recommendable_snapshot = TRUE" not in inner
    assert "recommendable_snapshot = TRUE" in outer
    assert "sale_status_snapshot = 'active'" in outer


def test_faq_search_reads_only_current_view_with_parameters() -> None:
    database = FakeDatabase(
        [
            {
                "card_id": "faq-1",
                "answer": "审核答案",
                "category": "配送",
                "source_snapshot": {"source": "approved"},
                "score": 0.91,
                "release_version": "release-1",
            }
        ]
    )

    hits = Repository(database).search_business_faq("配送范围", 5)

    assert hits[0].card_id == "faq-1"
    query, params = database.calls[0]
    assert "current_business_faq" in query
    assert "business_faq_cards" not in query
    assert "配送范围" not in query
    assert "配送范围" in params


def test_faq_search_can_match_the_approved_category() -> None:
    database = FakeDatabase([])

    Repository(database).search_business_faq("售后", 5)

    query, params = database.calls[0]
    assert "category ILIKE" in query
    assert params == ("售后", "售后", "售后", "售后", "售后", "售后", 5)


def test_repository_wraps_database_exception_without_exposing_details() -> None:
    class BrokenDatabase:
        def fetch_all(self, query, params):
            raise RuntimeError("postgresql://user:secret@db SELECT private")

    try:
        Repository(BrokenDatabase()).search_products("蔬菜", 5)
    except RepositoryError as error:
        assert str(error) == "knowledge retrieval unavailable"
        assert error.code == "retrieval_unavailable"
    else:
        raise AssertionError("RepositoryError was not raised")


def test_semantic_queries_use_pgvector_and_keep_parameters_separate() -> None:
    database = FakeDatabase([])
    repository = Repository(database)
    vector = [0.01] * 1024

    repository.search_business_faq_semantic(vector, 5)
    repository.search_products_semantic(vector, 5)

    faq_query, faq_params = database.calls[0]
    product_query, product_params = database.calls[1]
    assert faq_query == FAQ_SEMANTIC_SEARCH_SQL
    assert product_query == PRODUCT_SEMANTIC_SEARCH_SQL
    assert "<=> %s::vector" in faq_query
    assert "business_faq_phrases" in faq_query
    assert "<=> %s::vector" in product_query
    assert "recommendable_snapshot = TRUE" in product_query
    assert len(faq_params[0].strip("[]").split(",")) == 1024
    assert faq_params[0] == faq_params[1]
    assert len(product_params[0].strip("[]").split(",")) == 1024
