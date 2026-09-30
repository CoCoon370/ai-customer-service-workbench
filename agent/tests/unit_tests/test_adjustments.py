from types import SimpleNamespace
from agent.graph import adjust_reply
from agent.models import AdjustmentRequest, FaqHit


def invoke(output, instruction="先安抚，别说教", previous=None):
    captured = {}
    class Repository:
        def search_business_faq_semantic(self, vector, limit):
            return [FaqHit(card_id="1", answer="猕猴桃成熟会变软", category="food",
                           source_snapshot={}, score=.9, knowledge_version="test")]
        def search_products_semantic(self, vector, limit):
            return []
    class Embedder:
        def embed(self, text):
            captured["query"] = text
            return [1.0]
    class LLM:
        def invoke(self, messages):
            captured["messages"] = messages
            if isinstance(output, Exception):
                raise output
            return SimpleNamespace(content=output)
    payload = AdjustmentRequest(question="猕猴桃怎么是硬的", previous_drafts=previous or ["原始稿"], instruction=instruction)
    return adjust_reply(payload, repository=Repository(), embedder=Embedder(), llm=LLM()), captured


def test_context():
    result, captured = invoke("收到还没软的果子，确实会有些失望。", previous=["初稿", "第二稿"])
    assert result.answer_mode == "draft"
    assert result.prompt_version.endswith("-adjust-v1")
    text = str(captured["messages"])
    for value in ("猕猴桃怎么是硬的", "初稿", "第二稿", "先安抚", "成熟会变软", "不属于事实依据"):
        assert value in text
    assert "先安抚" in captured["query"]


def test_unchanged_reply_is_failure():
    result, _ = invoke("原始稿")
    assert result.error_code == "adjustment_unchanged"


def test_model_failure_is_not_success():
    result, _ = invoke(RuntimeError("network"))
    assert result.answer_mode == "error"


def test_insufficient_is_not_new_draft():
    result, _ = invoke("__INSUFFICIENT__")
    assert result.answer_mode == "insufficient"
