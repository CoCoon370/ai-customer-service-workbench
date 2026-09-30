import pytest
from pydantic import ValidationError

from agent.models import DraftRequest, DraftResponse, FaqHit, ProductHit


def test_draft_response_contains_auditable_versions() -> None:
    response = DraftResponse(
        run_id="run-1",
        intent="product_question",
        answer_mode="draft",
        draft="????????????????",
        faq_hits=[],
        product_hits=[],
        model_version="qwen-plus",
        prompt_version="workbench-v1",
        knowledge_version="knowledge-2026-08-10-v1",
        insufficient_fields=[],
    )

    assert response.model_dump()["knowledge_version"] == "knowledge-2026-08-10-v1"


def test_request_trims_question_and_rejects_unknown_fields() -> None:
    assert DraftRequest(question="  ?????  ").question == "?????"
    with pytest.raises(ValidationError):
        DraftRequest(question="?????", customer_id="should-not-be-accepted")


@pytest.mark.parametrize("question", ["   ", "?" * 2001])
def test_request_rejects_question_outside_trimmed_length(question: str) -> None:
    with pytest.raises(ValidationError):
        DraftRequest(question=question)


def test_hit_models_keep_auditable_source_snapshots() -> None:
    faq = FaqHit(
        card_id="faq-1",
        answer="?????",
        category="??",
        source_snapshot={"source": "approved-seed"},
        score=0.91,
        knowledge_version="knowledge-2026-08-10-v1",
    )
    product = ProductHit(
        product_id="product-1",
        name="????",
        sku_ids=["sku-1"],
        stable_facts={"summary": "????"},
        source_snapshot={"chunk_id": "chunk-1"},
        score=0.88,
        knowledge_version="knowledge-2026-08-10-v1",
    )

    assert faq.source_snapshot == {"source": "approved-seed"}
    assert product.sku_ids == ["sku-1"]
