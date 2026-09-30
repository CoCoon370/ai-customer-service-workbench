import json

import pytest

from agent.embedding import DashScopeQueryEmbedder


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        return json.dumps(self.body).encode("utf-8")


def test_dashscope_query_embedder_requests_one_1024_dimension_vector(monkeypatch) -> None:
    calls = []

    def fake_urlopen(api_request, timeout):
        calls.append((api_request, timeout))
        return FakeResponse(
            {"output": {"embeddings": [{"embedding": [0.01] * 1024}]}}
        )

    monkeypatch.setattr("agent.embedding.request.urlopen", fake_urlopen)

    vector = DashScopeQueryEmbedder("secret-key").embed("客户问题")

    assert len(vector) == 1024
    request_body = json.loads(calls[0][0].data.decode("utf-8"))
    assert request_body["model"] == "text-embedding-v4"
    assert request_body["input"]["texts"] == ["客户问题"]
    assert request_body["parameters"]["dimension"] == 1024


def test_dashscope_query_embedder_rejects_wrong_dimension(monkeypatch) -> None:
    monkeypatch.setattr(
        "agent.embedding.request.urlopen",
        lambda *_args, **_kwargs: FakeResponse(
            {"output": {"embeddings": [{"embedding": [0.01] * 10}]}}
        ),
    )

    with pytest.raises(RuntimeError, match="invalid"):
        DashScopeQueryEmbedder("secret-key").embed("客户问题")
