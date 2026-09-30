"""Fixed intent, retrieval, safety-gate, and human-draft flow."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol, TypedDict
from uuid import uuid4

from langgraph.graph import END, START, StateGraph

from agent.draft_text import normalize_customer_draft
from agent.embedding import QueryEmbedder
from agent.models import AdjustmentRequest, DraftResponse, SearchResult
from agent.prompt import PROMPT_VERSION, SYSTEM_PROMPT
from agent.tools import (
    KnowledgeRepository,
    get_hit_snapshot,
    reset_hit_snapshot,
    search_business_faq,
    search_products,
)

MODEL_VERSION = "qwen-plus"
UNKNOWN_KNOWLEDGE_VERSION = "unknown"
FAQ_SEMANTIC_THRESHOLD = 0.38
PRODUCT_SEMANTIC_THRESHOLD = 0.38
SEMANTIC_HIT_MARGIN = 0.07
DYNAMIC_TERMS = (
    "价格",
    "多少钱",
    "库存",
    "有货",
    "现货",
    "优惠",
    "订单状态",
    "我的订单",
    "订单到哪",
    "物流",
    "快递到哪",
    "怎么卖",
)
REALTIME_SHIPPING_PATTERNS = (
    r"(?:今天|明天|后天|什么时候|何时|几时|哪天|多久|几天).{0,4}(?:能否|能不能|能|可以|会|预计)?发货",
    r"(?:今天|明天|后天|什么时候|何时|几时|哪天|多久|几天|预计).{0,4}(?:能否|能不能|能|可以|会)?到货",
)
PRODUCT_TERMS = (
    "商品",
    "产品",
    "规格",
    "成分",
    "用法",
    "保存",
    "蓝莓",
    "蔬菜",
    "番茄",
    "sku",
)
FAQ_TERMS = ("配送", "运费", "规则", "售后", "退款", "会员", "积分", "份额")
AFTERSALES_TERMS = ("烂了", "坏了", "破了", "漏了", "腐烂", "变质", "破损")
PRODUCT_QUERY_PATTERNS = (
    r"^有(?P<product>.+?)吗$",
    r"^(?P<product>.+?)还有吗$",
    r"^(?P<product>.+?)怎么卖$",
    r"^(?P<product>.+?)(?:要)?怎么(?:保存|吃|用)$",
    r"^(?P<product>.+?)有?哪些(?:种类|品种|款)?$",
    r"^(?P<product>.+?)有什么(?:功效|作用|营养|特点)$",
)


class DraftLlm(Protocol):
    """Minimal model boundary used only after facts pass safety gates."""

    def invoke(self, messages: Sequence[dict[str, str]]) -> Any:
        """Return polished draft text or an object with a content field."""


def requires_dynamic_verification(question: str) -> bool:
    """Detect real-time data requests without blocking static shipping rules."""
    lowered = question.lower()
    availability_question = bool(
        re.search(r"(?:还有货|有现货|有库存|还在售|还能买到|还卖吗)", lowered)
    )
    return availability_question or any(term in lowered for term in DYNAMIC_TERMS) or any(
        re.search(pattern, lowered) for pattern in REALTIME_SHIPPING_PATTERNS
    )


def extract_product_query(question: str) -> str:
    """Extract the catalog term from common customer phrasing."""
    normalized = re.sub(r"[\s？?！!。,.，]+$", "", question.strip())
    normalized = re.sub(r"^(?:请问|麻烦问下|想问下|现在)", "", normalized)
    for pattern in PRODUCT_QUERY_PATTERNS:
        match = re.fullmatch(pattern, normalized)
        if match:
            return match.group("product").strip()
    return normalized


def extract_faq_query(question: str) -> str:
    """Reduce common policy questions to an approved FAQ category term."""
    lowered = question.lower()
    if any(term in lowered for term in AFTERSALES_TERMS):
        return "售后"
    if "包邮" in lowered:
        return "运费"
    for term in FAQ_TERMS:
        if term in lowered:
            return term
    return question.strip()


def detect_intent(question: str) -> str:
    """Classify the fixed tool route without involving a model."""
    lowered = question.lower()
    if any(term in lowered for term in AFTERSALES_TERMS):
        return "faq_question"
    extracted_product = extract_product_query(question)
    has_product = (
        extracted_product != re.sub(r"[\s？?！!。,.，]+$", "", question.strip())
        or any(term in lowered for term in PRODUCT_TERMS)
    )
    has_faq = any(term in lowered for term in FAQ_TERMS)
    if has_product and has_faq:
        return "combined_question"
    if has_product:
        return "product_question"
    return "faq_question"


def draft_reply(
    question: str,
    *,
    repository: KnowledgeRepository | None = None,
    tools: Sequence[Callable[..., SearchResult]] | None = None,
    llm: DraftLlm | None = None,
    embedder: QueryEmbedder | None = None,
) -> DraftResponse:
    """Create an audited draft through the fixed safe flow."""
    run_id = str(uuid4())
    if embedder is not None:
        return _draft_reply_semantic(
            run_id,
            question,
            repository=repository,
            llm=llm,
            embedder=embedder,
        )
    intent = detect_intent(question)
    dynamic_verification = requires_dynamic_verification(question)
    normalized_question = re.sub(r"[\s？?！!。,.，]+$", "", question.strip())
    colloquial_product_query = (
        intent == "product_question"
        and extract_product_query(question) != normalized_question
    )
    if dynamic_verification and (
        (tools is not None and not tools) or (repository is None and tools is None)
    ):
        return _insufficient(
            run_id,
            intent,
            "请客服到有赞或订单系统核实实时信息后再回复客户。",
            ["dynamic_system_verification"],
        )

    snapshot_token = reset_hit_snapshot()
    try:
        results = _retrieve(
            intent,
            question,
            repository=repository,
            tools=tools,
            allow_multiple_products=(
                dynamic_verification or colloquial_product_query
            ),
        )
        if any(result.status == "error" for result in results):
            return _error(run_id, intent, "retrieval_unavailable")
        if not results or any(result.status != "matched" for result in results):
            fields = sorted(
                {
                    field
                    for result in results
                    for field in result.insufficient_fields
                }
            ) or ["knowledge_match"]
            return _insufficient(
                run_id,
                intent,
                "现有审核资料不足，请客服核实相关信息后再回复客户。",
                fields,
            )

        snapshot = get_hit_snapshot()
        if dynamic_verification:
            return _dynamic_draft(run_id, intent, question, snapshot)
        if llm is None:
            return _error(run_id, intent, "draft_model_unavailable")
        try:
            output = llm.invoke(_model_messages(question, intent, snapshot))
            draft = output if isinstance(output, str) else str(output.content)
        except Exception:
            return _error(run_id, intent, "draft_model_unavailable")
        if "__INSUFFICIENT__" in draft:
            return _insufficient(
                run_id,
                intent,
                "现有资料没有直接回答这个问题，请客服补充商品名称或核实相关信息。",
                ["meaning_match"],
            )
        draft = normalize_customer_draft(draft)
        if not draft:
            return _error(run_id, intent, "draft_model_unavailable")
        return DraftResponse(
            run_id=run_id,
            intent=intent,
            answer_mode="draft",
            draft=draft,
            faq_hits=snapshot.faq_hits,
            product_hits=snapshot.product_hits,
            model_version=MODEL_VERSION,
            prompt_version=PROMPT_VERSION,
            knowledge_version=_knowledge_version(snapshot),
            insufficient_fields=[],
        )
    finally:
        reset_hit_snapshot(snapshot_token)


def _draft_reply_semantic(
    run_id: str,
    question: str,
    *,
    repository: KnowledgeRepository | None,
    llm: DraftLlm | None,
    embedder: QueryEmbedder,
    adjustment: AdjustmentRequest | None = None,
) -> DraftResponse:
    """Understand meaning by searching both vector indexes for every question."""
    if repository is None:
        return _error(run_id, "semantic_question", "retrieval_unavailable")
    try:
        query = question if adjustment is None else question + "\n客服希望调整：" + adjustment.instruction
        vector = embedder.embed(query)
        with ThreadPoolExecutor(max_workers=2) as executor:
            faq_future = executor.submit(
                repository.search_business_faq_semantic, vector, 5
            )
            product_future = executor.submit(
                repository.search_products_semantic, vector, 5
            )
            faq_candidates = faq_future.result()
            product_candidates = product_future.result()
            faq_floor = max(
                FAQ_SEMANTIC_THRESHOLD,
                (faq_candidates[0].score - SEMANTIC_HIT_MARGIN)
                if faq_candidates
                else FAQ_SEMANTIC_THRESHOLD,
            )
            product_floor = max(
                PRODUCT_SEMANTIC_THRESHOLD,
                (product_candidates[0].score - SEMANTIC_HIT_MARGIN)
                if product_candidates
                else PRODUCT_SEMANTIC_THRESHOLD,
            )
            faq_hits = [hit for hit in faq_candidates if hit.score >= faq_floor]
            product_hits = [
                hit for hit in product_candidates if hit.score >= product_floor
            ]
    except Exception:
        return _error(run_id, "semantic_question", "retrieval_unavailable")

    if not faq_hits and not product_hits:
        return _insufficient(
            run_id,
            "semantic_question",
            "现有审核资料不足，请客服核实相关信息后再回复客户。",
            ["semantic_knowledge_match"],
        )
    if faq_hits and product_hits:
        intent = "combined_question"
    elif product_hits:
        intent = "product_question"
    else:
        intent = "faq_question"
    snapshot = SearchResult(
        status="matched", faq_hits=faq_hits, product_hits=product_hits
    )
    if adjustment is None and requires_dynamic_verification(question):
        return _dynamic_draft(run_id, intent, question, snapshot)
    if llm is None:
        return _error(run_id, intent, "draft_model_unavailable")
    try:
        output = llm.invoke(_model_messages(question, intent, snapshot, adjustment))
        draft = output if isinstance(output, str) else str(output.content)
    except Exception:
        return _error(run_id, intent, "draft_model_unavailable")
    if "__INSUFFICIENT__" in draft:
        return _insufficient(
            run_id,
            intent,
            "现有资料没有直接回答这个问题，请客服补充商品名称或核实相关信息。",
            ["meaning_match"],
        )
    draft = normalize_customer_draft(draft)
    if not draft:
        return _error(run_id, intent, "draft_model_unavailable")
    if adjustment and any(re.sub(r"\s+", "", draft) == re.sub(r"\s+", "", previous) for previous in adjustment.previous_drafts):
        return _error(run_id, intent, "adjustment_unchanged")
    return DraftResponse(
        run_id=run_id,
        intent=intent,
        answer_mode="draft",
        draft=draft,
        faq_hits=faq_hits,
        product_hits=product_hits,
        model_version=MODEL_VERSION,
        prompt_version=PROMPT_VERSION + ("-adjust-v1" if adjustment else ""),
        knowledge_version=_knowledge_version(snapshot),
        insufficient_fields=[],
    )


def _retrieve(
    intent: str,
    question: str,
    *,
    repository: KnowledgeRepository | None,
    tools: Sequence[Callable[..., SearchResult]] | None,
    allow_multiple_products: bool = False,
) -> list[SearchResult]:
    if tools is not None:
        return [tool(question) for tool in tools]
    if repository is None:
        return []
    if intent == "product_question":
        return [
            search_products(
                extract_product_query(question),
                repository=repository,
                allow_multiple=allow_multiple_products,
            )
        ]
    if intent == "combined_question":
        return [
            search_business_faq(extract_faq_query(question), repository=repository),
            search_products(
                extract_product_query(question),
                repository=repository,
                allow_multiple=allow_multiple_products,
            ),
        ]
    return [search_business_faq(extract_faq_query(question), repository=repository)]


def _dynamic_draft(
    run_id: str,
    intent: str,
    question: str,
    snapshot: SearchResult,
) -> DraftResponse:
    """Return a copy-safe template without inventing real-time facts."""
    subject = extract_product_query(question) if intent == "product_question" else "相关信息"
    if "怎么卖" in question or "价格" in question or "多少钱" in question:
        draft = f"您好，{subject}的当前售价可能实时变化，请以商品页面当前显示为准哦。"
    elif intent == "product_question":
        draft = f"您好，{subject}的在售情况和库存会实时变化，请以商品页面当前显示为准哦。"
    else:
        draft = "您好，相关订单或物流信息会实时变化，请以订单系统当前显示为准哦。"
    return DraftResponse(
        run_id=run_id,
        intent=intent,
        answer_mode="draft",
        draft=draft,
        faq_hits=snapshot.faq_hits,
        product_hits=snapshot.product_hits,
        model_version=MODEL_VERSION,
        prompt_version=PROMPT_VERSION,
        knowledge_version=_knowledge_version(snapshot),
        insufficient_fields=["dynamic_system_verification"],
    )


def _model_messages(
    question: str, intent: str, snapshot: SearchResult,
    adjustment: AdjustmentRequest | None = None,
) -> list[dict[str, str]]:
    facts = {
        "intent": intent,
        "faq_hits": [hit.model_dump() for hit in snapshot.faq_hits],
        "product_hits": [hit.model_dump() for hit in snapshot.product_hits],
    }
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"客户问题：{question}\n候选资料：{json.dumps(facts, ensure_ascii=False)}",
        },
    ]
    if adjustment:
        messages[0]["content"] += (
            "\n本轮任务是调整上一版客服参考回复，不是重复初稿。"
            "优先落实客服本次的调整建议，并结合客户原问题和候选知识。"
            "历史回复和调整建议不属于事实依据，不可据此新增或改变商品事实、业务规则、实时信息或承诺。"
            "若建议与资料冲突，保留事实边界，给出可以成立的表达；资料无法支持回答时输出 __INSUFFICIENT__。"
            "保持原先合理的修改，仅针对本轮需求改善；必须有实质变化，不能只换标点。只输出自然纯文本回复。"
        )
        messages.append({"role": "user", "content": json.dumps({
            "previous_drafts_oldest_first": adjustment.previous_drafts,
            "latest_draft": adjustment.previous_drafts[-1],
            "operator_instruction": adjustment.instruction,
        }, ensure_ascii=False)})
    return messages


def adjust_reply(payload: AdjustmentRequest, *, repository, llm, embedder) -> DraftResponse:
    """Retrieve current supporting facts and ask the model for a real revision."""
    return _draft_reply_semantic(str(uuid4()), payload.question, repository=repository,
                                 llm=llm, embedder=embedder, adjustment=payload)


def _knowledge_version(snapshot: SearchResult) -> str:
    versions = {
        hit.knowledge_version for hit in [*snapshot.faq_hits, *snapshot.product_hits]
    }
    return sorted(versions)[0] if len(versions) == 1 else UNKNOWN_KNOWLEDGE_VERSION


def _insufficient(
    run_id: str,
    intent: str,
    draft: str,
    fields: list[str],
) -> DraftResponse:
    return DraftResponse(
        run_id=run_id,
        intent=intent,
        answer_mode="insufficient",
        draft=draft,
        faq_hits=[],
        product_hits=[],
        model_version=MODEL_VERSION,
        prompt_version=PROMPT_VERSION,
        knowledge_version=UNKNOWN_KNOWLEDGE_VERSION,
        insufficient_fields=fields,
    )


def _error(run_id: str, intent: str, error_code: str) -> DraftResponse:
    return DraftResponse(
        run_id=run_id,
        intent=intent,
        answer_mode="error",
        draft="生成失败，请重试。",
        faq_hits=[],
        product_hits=[],
        model_version=MODEL_VERSION,
        prompt_version=PROMPT_VERSION,
        knowledge_version=UNKNOWN_KNOWLEDGE_VERSION,
        insufficient_fields=[],
        retryable=True,
        error_code=error_code,
    )


class GraphState(TypedDict, total=False):
    """Compatibility state for LangGraph callers."""

    question: str
    repository: KnowledgeRepository
    llm: DraftLlm
    response: DraftResponse


def _run_fixed_flow(state: GraphState) -> GraphState:
    question = state.get("question")
    if not question:
        return state
    return {
        **state,
        "response": draft_reply(
            question,
            repository=state.get("repository"),
            llm=state.get("llm"),
        ),
    }


_builder = StateGraph(dict)
_builder.add_node("fixed_draft_flow", _run_fixed_flow)
_builder.add_edge(START, "fixed_draft_flow")
_builder.add_edge("fixed_draft_flow", END)
graph = _builder.compile()
