"""Internal-token-protected HTTP boundary for audited human-service drafts."""

from __future__ import annotations

import logging
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any, Protocol

import anyio
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from agent.config import Settings, get_settings
from agent.embedding import DashScopeQueryEmbedder
from agent.graph import adjust_reply, draft_reply
from agent.models import AdjustmentRequest, DraftRequest, DraftResponse
from agent.repository import PsycopgDatabase, Repository

logger = logging.getLogger(__name__)


class DraftService(Protocol):
    """Request boundary used by the API."""

    async def create(self, question: str) -> DraftResponse:
        """Create one safe draft."""

    async def health(self) -> dict[str, str]:
        """Return runtime database and knowledge readiness."""


class DefaultDraftService:
    """Run the synchronous retrieval/model flow outside the event loop."""

    def __init__(self, repository: Repository, llm: Any, embedder: Any) -> None:
        """Bind service-scoped retrieval and model dependencies."""
        self._repository = repository
        self._llm = llm
        self._embedder = embedder

    async def create(self, question: str) -> DraftResponse:
        """Create one draft using service-scoped dependencies."""
        return await anyio.to_thread.run_sync(
            lambda: draft_reply(
                question,
                repository=self._repository,
                llm=self._llm,
                embedder=self._embedder,
            )
        )

    async def adjust(self, payload: AdjustmentRequest) -> DraftResponse:
        return await anyio.to_thread.run_sync(lambda: adjust_reply(
            payload, repository=self._repository, llm=self._llm, embedder=self._embedder,
        ))

    async def health(self) -> dict[str, str]:
        """Check live database and active knowledge without exposing details."""
        return await anyio.to_thread.run_sync(self._repository.health)


def create_app(
    *, settings: Settings | Any | None = None, service: DraftService | None = None
) -> FastAPI:
    """Build an import-safe FastAPI app with injectable dependencies."""
    resources: dict[str, Any] = {"database": None}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if service is not None:
            app.state.draft_service = service
            app.state.settings = settings
        else:
            runtime_settings = settings or get_settings()
            database = PsycopgDatabase(
                _secret_value(runtime_settings.postgres_uri_custom)
            )
            database.open()
            llm = ChatOpenAI(
                model=runtime_settings.model_version,
                api_key=_secret_value(runtime_settings.dashscope_api_key),
                base_url=runtime_settings.dashscope_base_url,
                temperature=0.3,
            )
            embedder = DashScopeQueryEmbedder(
                _secret_value(runtime_settings.dashscope_api_key)
            )
            resources["database"] = database
            app.state.draft_service = DefaultDraftService(
                Repository(database), llm, embedder
            )
            app.state.settings = runtime_settings
        try:
            yield
        finally:
            database = resources["database"]
            if database is not None:
                database.close()

    application = FastAPI(lifespan=lifespan)
    if settings is not None:
        application.state.settings = settings
    if service is not None:
        application.state.draft_service = service

    @application.post("/v1/drafts", response_model=DraftResponse)
    async def create_draft(
        payload: DraftRequest,
        x_internal_token: str = Header(),
    ) -> DraftResponse:
        started = time.monotonic()
        configured_token = _secret_value(
            application.state.settings.workbench_agent_token
        )
        if not secrets.compare_digest(x_internal_token, configured_token):
            raise HTTPException(status_code=401, detail="unauthorized")
        try:
            response = await application.state.draft_service.create(payload.question)
        except Exception:
            logger.error(
                "draft_request_failed elapsed_ms=%d",
                round((time.monotonic() - started) * 1000),
            )
            raise HTTPException(
                status_code=503, detail="draft service unavailable"
            ) from None
        logger.info(
            "draft_request_completed run_id=%s elapsed_ms=%d status=%s "
            "model_version=%s prompt_version=%s knowledge_version=%s",
            response.run_id,
            round((time.monotonic() - started) * 1000),
            response.answer_mode,
            response.model_version,
            response.prompt_version,
            response.knowledge_version,
        )
        return response

    @application.post("/v1/adjustments", response_model=DraftResponse)
    async def create_adjustment(payload: AdjustmentRequest, x_internal_token: str = Header()) -> DraftResponse:
        configured = _secret_value(application.state.settings.workbench_agent_token)
        if not secrets.compare_digest(x_internal_token, configured):
            raise HTTPException(status_code=401, detail="unauthorized")
        try:
            return await application.state.draft_service.adjust(payload)
        except Exception:
            logger.error("adjustment_request_failed")
            raise HTTPException(status_code=503, detail="draft service unavailable") from None

    @application.get("/health")
    async def health():
        """Return truthful fixed-shape readiness without configuration values."""
        model_ready = bool(
            _secret_value(application.state.settings.dashscope_api_key)
        )
        try:
            runtime = await application.state.draft_service.health()
        except Exception:
            payload = {
                "status": "not_ready",
                "service": "workbench-agent-v2",
                "database": "not_ready",
                "knowledge": "not_ready",
                "model_configuration": "ready" if model_ready else "not_ready",
                "knowledge_version": "unavailable",
            }
            return JSONResponse(payload, status_code=503)
        payload = {
            "status": "ready" if model_ready else "not_ready",
            "service": "workbench-agent-v2",
            "database": runtime["database"],
            "knowledge": runtime["knowledge"],
            "model_configuration": "ready" if model_ready else "not_ready",
            "knowledge_version": runtime["knowledge_version"],
        }
        return JSONResponse(payload, status_code=200 if model_ready else 503)

    return application


def _secret_value(value: SecretStr | str) -> str:
    return value.get_secret_value() if isinstance(value, SecretStr) else value


app = create_app()
