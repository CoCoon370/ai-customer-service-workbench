"""Environment-backed settings loaded only when the API service starts."""

from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated server-only configuration."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    workbench_agent_token: SecretStr = Field(min_length=16)
    postgres_uri_custom: SecretStr
    dashscope_api_key: SecretStr
    dashscope_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model_version: str = "qwen-plus"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load and cache settings without doing so at module import time."""
    return Settings()
