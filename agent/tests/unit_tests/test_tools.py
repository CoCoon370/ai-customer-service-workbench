from agent.models import FaqHit, ProductHit
from agent.tools import (
    get_hit_snapshot,
    reset_hit_snapshot,
    search_business_faq,
    search_products,
)


def product_hit(product_id: str, score: float) -> ProductHit:
    return ProductHit(
        product_id=product_id,
        name=f"商品-{product_id}",
        sku_ids=[],
        stable_facts={"title": f"商品-{product_id}"},
        source_snapshot={"chunk_id": f"chunk-{product_id}"},
        score=score,
        knowledge_version="release-1",
    )


def test_ambiguous_products_return_insufficient() -> None:
    class AmbiguousRepository:
        def search_products(self, query, limit):
            return [product_hit("one", 0.91), product_hit("two", 0.90)]

    result = search_products("那个蓝莓", repository=AmbiguousRepository())

    assert result.status == "insufficient"
    assert result.product_hits == []
    assert result.insufficient_fields == ["product_identity"]


def test_catalog_lookup_can_keep_multiple_products_for_dynamic_questions() -> None:
    class CatalogRepository:
        def search_products(self, query, limit):
            return [product_hit("one", 0.91), product_hit("two", 0.90)]

    result = search_products(
        "花生", repository=CatalogRepository(), allow_multiple=True
    )

    assert result.status == "matched"
    assert [hit.product_id for hit in result.product_hits] == ["one", "two"]


def test_tool_records_request_scoped_hit_snapshot() -> None:
    class MatchedRepository:
        def search_business_faq(self, query, limit):
            return [
                FaqHit(
                    card_id="faq-1",
                    answer="审核答案",
                    category="配送",
                    source_snapshot={"source": "approved"},
                    score=0.91,
                    knowledge_version="release-1",
                )
            ]

    token = reset_hit_snapshot()
    try:
        result = search_business_faq("配送范围", repository=MatchedRepository())
        snapshot = get_hit_snapshot()
    finally:
        reset_hit_snapshot(token)

    assert result.status == "matched"
    assert [hit.card_id for hit in snapshot.faq_hits] == ["faq-1"]
    assert snapshot.product_hits == []


def test_tool_error_is_retryable_and_redacts_exception() -> None:
    class BrokenRepository:
        def search_products(self, query, limit):
            raise RuntimeError("postgresql://user:secret@db SELECT private")

    result = search_products("蔬菜", repository=BrokenRepository())
    serialized = result.model_dump_json()

    assert result.status == "error"
    assert result.retryable is True
    assert result.error_code == "retrieval_unavailable"
    assert "secret" not in serialized
    assert "SELECT" not in serialized
