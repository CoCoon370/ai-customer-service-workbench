import pytest

from agent.graph import (
    detect_intent,
    draft_reply,
    extract_faq_query,
    extract_product_query,
)
from agent.models import FaqHit, ProductHit
from agent.prompt import REGISTERED_TOOLS, SYSTEM_PROMPT


class FakeLlm:
    def __init__(self, reply: str = "理解您的关心。审核信息显示支持常规配送。") -> None:
        self.reply = reply
        self.calls = []

    def invoke(self, messages):
        self.calls.append(messages)
        return self.reply


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        ("有花生吗", "花生"),
        ("番茄还有吗？", "番茄"),
        ("黄皮怎么卖", "黄皮"),
        ("藕片怎么保存？", "藕片"),
        ("天麻片要怎么吃", "天麻片"),
        ("面包有哪些种类", "面包"),
        ("天麻有什么功效？", "天麻"),
    ],
)
def test_extracts_product_name_from_real_customer_phrasing(
    question: str, expected: str
) -> None:
    assert extract_product_query(question) == expected


@pytest.mark.parametrize("question", ["有花生吗", "番茄还有吗", "黄皮怎么卖"])
def test_real_product_phrasing_routes_to_product_search(question: str) -> None:
    assert detect_intent(question) == "product_question"


def test_aftersales_complaint_routes_to_faq_search() -> None:
    question = "刚收到的番茄已经烂了"

    assert detect_intent(question) == "faq_question"
    assert extract_faq_query(question) == "售后"


def test_free_shipping_phrase_routes_to_shipping_faq() -> None:
    question = "怎么才能包邮"

    assert detect_intent(question) == "faq_question"
    assert extract_faq_query(question) == "运费"


def test_static_catalog_question_keeps_multiple_audited_matches() -> None:
    class CatalogRepository:
        def __init__(self) -> None:
            self.queries = []

        def search_business_faq(self, query, limit):
            return []

        def search_products(self, query, limit):
            self.queries.append(query)
            return [
                ProductHit(
                    product_id="bread-1",
                    name="全麦面包",
                    sku_ids=[],
                    stable_facts={"title": "全麦面包"},
                    source_snapshot={"chunk_id": "bread-1"},
                    score=1.0,
                    knowledge_version="release-1",
                ),
                ProductHit(
                    product_id="bread-2",
                    name="杂粮面包",
                    sku_ids=[],
                    stable_facts={"title": "杂粮面包"},
                    source_snapshot={"chunk_id": "bread-2"},
                    score=1.0,
                    knowledge_version="release-1",
                ),
            ]

    repository = CatalogRepository()
    llm = FakeLlm("目前有全麦面包和杂粮面包可供参考。")

    result = draft_reply("面包有哪些种类", repository=repository, llm=llm)

    assert result.answer_mode == "draft"
    assert repository.queries == ["面包"]
    assert len(result.product_hits) == 2
    assert len(llm.calls) == 1


def test_dynamic_product_question_uses_catalog_match_without_claiming_stock() -> None:
    class CatalogRepository:
        def __init__(self) -> None:
            self.queries = []

        def search_business_faq(self, query, limit):
            return []

        def search_products(self, query, limit):
            self.queries.append(query)
            return [
                ProductHit(
                    product_id="peanut-1",
                    name="有机花生",
                    sku_ids=[],
                    stable_facts={"title": "有机花生"},
                    source_snapshot={"chunk_id": "chunk-peanut-1"},
                    score=1.0,
                    knowledge_version="release-1",
                ),
                ProductHit(
                    product_id="peanut-2",
                    name="花生米",
                    sku_ids=[],
                    stable_facts={"title": "花生米"},
                    source_snapshot={"chunk_id": "chunk-peanut-2"},
                    score=1.0,
                    knowledge_version="release-1",
                ),
            ]

    repository = CatalogRepository()
    llm = FakeLlm("现在有货")

    result = draft_reply("有花生吗", repository=repository, llm=llm)

    assert result.answer_mode == "draft"
    assert repository.queries == ["花生"]
    assert "实时" in result.draft
    assert "为准" in result.draft
    assert "现在有货" not in result.draft
    assert len(result.product_hits) == 2
    assert llm.calls == []


@pytest.mark.parametrize("question", ["明天能发货吗", "什么时候到货"])
def test_realtime_shipping_question_requires_system_verification(question: str) -> None:
    llm = FakeLlm("明天一定发货并按时到货")

    result = draft_reply(question, tools=[], llm=llm)

    assert result.answer_mode == "insufficient"
    assert "有赞" in result.draft or "系统" in result.draft
    assert "明天一定发货" not in result.draft
    assert "按时到货" not in result.draft
    assert llm.calls == []


def test_static_shipping_rule_still_uses_approved_faq() -> None:
    class MatchedRepository:
        def search_business_faq(self, query, limit):
            return [
                FaqHit(
                    card_id="faq-shipping-rule",
                    answer="审核通过的静态发货规则。",
                    category="发货规则",
                    source_snapshot={"source": "approved"},
                    score=0.95,
                    knowledge_version="release-1",
                )
            ]

        def search_products(self, query, limit):
            return []

    llm = FakeLlm("根据审核规则为您整理如下。")

    result = draft_reply("你们的发货规则是什么", repository=MatchedRepository(), llm=llm)

    assert result.answer_mode == "draft"
    assert len(llm.calls) == 1


def test_prompt_has_no_human_handoff_or_send_capability() -> None:
    assert "联系人工客服" not in SYSTEM_PROMPT
    assert "仅供真人客服参考" in SYSTEM_PROMPT
    assert "send_message" not in REGISTERED_TOOLS
    assert REGISTERED_TOOLS == ("search_business_faq", "search_products")


def test_matched_tool_facts_are_polished_by_model() -> None:
    class MatchedRepository:
        def search_business_faq(self, query, limit):
            return [
                FaqHit(
                    card_id="faq-1",
                    answer="支持常规配送。",
                    category="配送",
                    source_snapshot={"source": "approved"},
                    score=0.95,
                    knowledge_version="release-1",
                )
            ]

        def search_products(self, query, limit):
            return []

    llm = FakeLlm()

    result = draft_reply("你们支持配送吗", repository=MatchedRepository(), llm=llm)

    assert result.answer_mode == "draft"
    assert result.draft == llm.reply
    assert [hit.card_id for hit in result.faq_hits] == ["faq-1"]
    assert result.knowledge_version == "release-1"
    assert len(llm.calls) == 1


def test_retrieval_error_never_calls_model_or_leaks_exception() -> None:
    class BrokenRepository:
        def search_business_faq(self, query, limit):
            raise RuntimeError("postgresql://user:secret@db SELECT private")

        def search_products(self, query, limit):
            raise RuntimeError("postgresql://user:secret@db SELECT private")

    llm = FakeLlm()

    result = draft_reply("配送规则是什么", repository=BrokenRepository(), llm=llm)
    serialized = result.model_dump_json()

    assert result.answer_mode == "error"
    assert result.retryable is True
    assert llm.calls == []
    assert "secret" not in serialized
    assert "SELECT" not in serialized


def test_semantic_flow_searches_faq_and_products_without_keyword_routing() -> None:
    class FakeEmbedder:
        def __init__(self) -> None:
            self.questions = []

        def embed(self, text):
            self.questions.append(text)
            return [0.01] * 1024

    class SemanticRepository:
        def __init__(self) -> None:
            self.faq_calls = 0
            self.product_calls = 0

        def search_business_faq_semantic(self, vector, limit):
            self.faq_calls += 1
            return []

        def search_products_semantic(self, vector, limit):
            self.product_calls += 1
            return [
                ProductHit(
                    product_id="corn-1",
                    name="生态玉米",
                    sku_ids=[],
                    stable_facts={"title": "生态玉米", "口感": "甜糯"},
                    source_snapshot={"chunk_id": "corn-1"},
                    score=0.81,
                    knowledge_version="release-1",
                )
            ]

    embedder = FakeEmbedder()
    repository = SemanticRepository()
    llm = FakeLlm("这款生态玉米的审核资料显示口感甜糯。")

    result = draft_reply(
        "你们家的玉米是糯玉米还是甜玉米？",
        repository=repository,
        llm=llm,
        embedder=embedder,
    )

    assert result.answer_mode == "draft"
    assert result.intent == "product_question"
    assert embedder.questions == ["你们家的玉米是糯玉米还是甜玉米？"]
    assert repository.faq_calls == 1
    assert repository.product_calls == 1
    assert [hit.product_id for hit in result.product_hits] == ["corn-1"]


def test_semantic_flow_combines_aftersales_faq_and_product_facts() -> None:
    class FakeEmbedder:
        def embed(self, text):
            return [0.01] * 1024

    class SemanticRepository:
        def search_business_faq_semantic(self, vector, limit):
            return [
                FaqHit(
                    card_id="after-sales",
                    answer="收到破损商品后请保留照片并核实订单。",
                    category="售后",
                    source_snapshot={"source": "approved"},
                    score=0.82,
                    knowledge_version="release-1",
                )
            ]

        def search_products_semantic(self, vector, limit):
            return [
                ProductHit(
                    product_id="tomato-1",
                    name="生态番茄",
                    sku_ids=[],
                    stable_facts={"title": "生态番茄"},
                    source_snapshot={"chunk_id": "tomato-1"},
                    score=0.77,
                    knowledge_version="release-1",
                )
            ]

    result = draft_reply(
        "我收到了几个烂番茄",
        repository=SemanticRepository(),
        llm=FakeLlm("很抱歉，建议您保留照片并提供订单信息以便核实。"),
        embedder=FakeEmbedder(),
    )

    assert result.answer_mode == "draft"
    assert result.intent == "combined_question"
    assert len(result.faq_hits) == 1
    assert len(result.product_hits) == 1
