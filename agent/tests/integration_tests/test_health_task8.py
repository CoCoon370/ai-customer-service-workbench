from types import SimpleNamespace

from fastapi.testclient import TestClient

from api.app import create_app


class HealthyService:
    async def health(self):
        return {
            "database": "ready",
            "knowledge": "ready",
            "knowledge_version": "release-1",
        }

    async def create(self, question):
        raise AssertionError("draft path was not requested")


def client(service=None):
    settings = SimpleNamespace(
        workbench_agent_token="internal-test-token",
        dashscope_api_key="model-key-configured",
    )
    return TestClient(create_app(settings=settings, service=service or HealthyService()))


def test_health_reports_truthful_readiness_without_secrets():
    response = client().get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "service": "workbench-agent-v2",
        "database": "ready",
        "knowledge": "ready",
        "model_configuration": "ready",
        "knowledge_version": "release-1",
    }
    lowered = response.text.lower()
    assert "token" not in lowered
    assert "password" not in lowered
    assert "api_key" not in lowered


def test_health_returns_503_when_runtime_dependency_is_not_ready():
    class BrokenHealthService(HealthyService):
        async def health(self):
            raise RuntimeError("postgresql://secret")

    response = client(BrokenHealthService()).get("/health")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "service": "workbench-agent-v2",
        "database": "not_ready",
        "knowledge": "not_ready",
        "model_configuration": "ready",
        "knowledge_version": "unavailable",
    }
    assert "secret" not in response.text
