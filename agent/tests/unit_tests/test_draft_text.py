from agent.draft_text import normalize_customer_draft
from agent.prompt import PROMPT_VERSION, SYSTEM_PROMPT


def test_normalize_customer_draft_removes_markdown_but_preserves_temperature() -> None:
    draft = "您好，保质期是**6个月**。\n\n### 温馨提示\n- 请在-18°C以下冷冻。\n- 查看包装标签哦～"

    assert normalize_customer_draft(draft) == (
        "您好，保质期是6个月。\n\n温馨提示\n请在-18°C以下冷冻。\n查看包装标签哦"
    )


def test_prompt_requires_plain_natural_customer_service_text() -> None:
    assert PROMPT_VERSION == "workbench-v2"
    assert "真人客服" in SYSTEM_PROMPT
    assert "只输出纯文本" in SYSTEM_PROMPT
    assert "不得使用 Markdown" in SYSTEM_PROMPT
