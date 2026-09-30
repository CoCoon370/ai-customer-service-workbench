import logging
from types import SimpleNamespace

from fastapi.testclient import TestClient

from agent.models import DraftResponse
from api.app import create_app


class FakeService:
    def __init__(self) -> None:
        self.questions = []

    async def create(self, question: str) -> DraftResponse:
        self.questions.append(question)
        return DraftResponse(
            run_id="run-1",
            intent="faq_question",
            answer_mode="draft",
            draft="仅供客服参考的草稿",
            faq_hits=[],
            product_hits=[],
            model_version="qwen-plus",
            prompt_version="workbench-v1",
            knowledge_version="release-1",
            insufficient_fields=[],
        )


def client(service=None) -> TestClient:
    settings = SimpleNamespace(workbench_agent_token="internal-test-token")
    return TestClient(create_app(settings=settings, service=service or FakeService()))


def test_draft_endpoint_requires_internal_token() -> None:
    api = client()

    assert api.post("/v1/drafts", json={"question": "配送范围"}).status_code == 422
    response = api.post(
        "/v1/drafts",
        json={"question": "配送范围"},
        headers={"x-internal-token": "wrong"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "unauthorized"}


def test_draft_endpoint_trims_question_and_returns_audit_response() -> None:
    service = FakeService()
    api = client(service)

    response = api.post(
        "/v1/drafts",
        json={"question": "  配送范围  "},
        headers={"x-internal-token": "internal-test-token"},
    )

    assert response.status_code == 200
    assert service.questions == ["配送范围"]
    assert response.json()["knowledge_version"] == "release-1"


def test_draft_endpoint_rejects_invalid_question_lengths() -> None:
    api = client()
    headers = {"x-internal-token": "internal-test-token"}

    assert api.post("/v1/drafts", json={"question": "   "}, headers=headers).status_code == 422
    assert api.post("/v1/drafts", json={"question": "问" * 2001}, headers=headers).status_code == 422


def test_api_logs_metadata_without_full_question(caplog) -> None:
    api = client()
    question = "这是不可进入日志的完整问题-unique"

    with caplog.at_level(logging.INFO):
        response = api.post(
            "/v1/drafts",
            json={"question": question},
            headers={"x-internal-token": "internal-test-token"},
        )

    assert response.status_code == 200
    assert question not in caplog.text
    assert "run-1" in caplog.text
    assert "release-1" in caplog.text


def test_api_redacts_unexpected_service_error() -> None:
    class BrokenService:
        async def create(self, question: str):
            raise RuntimeError("postgresql://user:secret@db SELECT private")

    response = client(BrokenService()).post(
        "/v1/drafts",
        json={"question": "配送范围"},
        headers={"x-internal-token": "internal-test-token"},
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "draft service unavailable"}
    assert "secret" not in response.text
    assert "SELECT" not in response.text


def test_api_has_no_send_or_handoff_route() -> None:
    routes = {route.path for route in client().app.routes}

    assert routes == {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/health", "/redoc", "/v1/drafts", "/v1/adjustments"}


def test_adjustment_requires_internal_token():
    response = client().post('/v1/adjustments', json={
        'question': '配送范围', 'previous_drafts': ['旧回复'], 'instruction': '更简短',
    }, headers={'x-internal-token': 'wrong'})
    assert response.status_code == 401
