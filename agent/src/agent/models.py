"""Strict request, response, and search-result models."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SearchStatus = Literal["matched", "insufficient", "error"]


class StrictModel(BaseModel):
    """Reject fields outside the audited API contract."""

    model_config = ConfigDict(extra="forbid")


class DraftRequest(StrictModel):
    """A customer question submitted for drafting."""

    question: str = Field(min_length=1, max_length=2000)

    @field_validator("question", mode="before")
    @classmethod
    def trim_question(cls, value: Any) -> Any:
        """Trim text before enforcing the public length boundary."""
        return value.strip() if isinstance(value, str) else value


class AdjustmentRequest(DraftRequest):
    """Server-owned prior reply with operator guidance, never trusted as facts."""

    previous_drafts: list[str] = Field(min_length=1, max_length=3)
    instruction: str = Field(min_length=1, max_length=2200)


class FaqHit(StrictModel):
    """Auditable snapshot of an approved FAQ match."""

    card_id: str
    answer: str
    category: str
    source_snapshot: dict[str, Any]
    score: float
    knowledge_version: str


class ProductHit(StrictModel):
    """Auditable snapshot of a recommendable product match."""

    product_id: str
    name: str
    sku_ids: list[str]
    stable_facts: dict[str, Any]
    source_snapshot: dict[str, Any]
    score: float
    knowledge_version: str


class SearchResult(StrictModel):
    """A safe search outcome shared by both retrieval tools."""

    status: SearchStatus
    faq_hits: list[FaqHit] = Field(default_factory=list)
    product_hits: list[ProductHit] = Field(default_factory=list)
    insufficient_fields: list[str] = Field(default_factory=list)
    retryable: bool = False
    error_code: str | None = None


class DraftResponse(StrictModel):
    """A human-service draft plus its complete audit versions."""

    run_id: str
    intent: str
    answer_mode: Literal["draft", "insufficient", "error"]
    draft: str
    faq_hits: list[FaqHit]
    product_hits: list[ProductHit]
    model_version: str
    prompt_version: str
    knowledge_version: str
    insufficient_fields: list[str]
    retryable: bool = False
    error_code: str | None = None
