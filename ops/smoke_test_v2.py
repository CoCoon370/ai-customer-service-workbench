"""Repeatable, redacted verifier for the isolated v2 workbench deployment."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import socket
import stat
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


class SmokeFailure(RuntimeError):
    """A safe failure that never carries response bodies or credentials."""


FAQ_QUESTION = '"待配送"是什么意思？'
PRODUCT_QUESTION = "有机蓝莓原浆 | 绿家自产 * Organic Blueberry Puree | Self-production"
DYNAMIC_QUESTION = "虚拟测试：今天库存、价格和物流到哪里了？"
DISCARD_VALIDATION_QUESTION = "虚拟测试：今天订单状态如何？"
EXPECTED_PRODUCT_ID = "2303836547"


def redact(value: object, *, secrets: list[str] | tuple[str, ...] = ()) -> str:
    """Remove configured secrets and common credential assignments, then cap output."""
    text = str(value).replace("\r", " ").replace("\n", " ")
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = re.sub(
        r"(?i)\b(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+",
        r"\1=[REDACTED]",
        text,
    )
    return text[:220]


def load_credentials(path: str | os.PathLike[str]) -> dict[str, str]:
    """Load the explicit server credential file only when it is root/private mode 0600."""
    credential_path = Path(path)
    if not credential_path.is_file() or credential_path.is_symlink():
        raise ValueError("credential path must be a regular file")
    mode = stat.S_IMODE(credential_path.stat().st_mode)
    if mode != 0o600:
        raise ValueError("credential file must use mode 0600")
    if hasattr(os, "geteuid") and os.geteuid() == 0 and credential_path.stat().st_uid != 0:
        raise ValueError("credential file must be root-owned")
    data = json.loads(credential_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not data:
        raise ValueError("credential file is invalid")
    return {str(key): str(value) for key, value in data.items() if str(value)}


def request_raw(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 10,
) -> tuple[int, str, bytes]:
    """Perform a bounded HTTP request and return only the controlled response tuple."""
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.headers.get("content-type", ""), response.read(1_000_000)
    except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
        raise SmokeFailure(f"request failed: {type(exc).__name__}") from None


def request_json(url: str, *, timeout: float = 10, **kwargs: Any) -> Any:
    """Require a successful JSON response without reflecting its body into errors."""
    status, content_type, body = request_raw(url, timeout=timeout, **kwargs)
    if status < 200 or status >= 300:
        raise SmokeFailure(f"unexpected HTTP status {status}")
    if "application/json" not in content_type.lower():
        raise SmokeFailure("response is not JSON")
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SmokeFailure("response contains invalid JSON") from None


def check_health_contracts(*, old_web_url: str, new_web_url: str, agent_health_url: str) -> dict[str, Any]:
    """Verify old/new Web and truthful, redacted Agent readiness."""
    old_status, _old_type, _old_body = request_raw(old_web_url)
    new_status, _new_type, _new_body = request_raw(new_web_url)
    if old_status != 200:
        raise SmokeFailure("old Web health failed")
    if new_status != 200:
        raise SmokeFailure("new Web login health failed")
    agent_status, content_type, body = request_raw(agent_health_url)
    if agent_status != 200 or "application/json" not in content_type.lower():
        raise SmokeFailure("Agent health failed")
    try:
        health = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SmokeFailure("Agent health JSON invalid") from None
    expected = {
        "status": "ready",
        "service": "workbench-agent-v2",
        "database": "ready",
        "knowledge": "ready",
        "model_configuration": "ready",
    }
    if any(health.get(key) != value for key, value in expected.items()):
        raise SmokeFailure("Agent readiness contract failed")
    if not health.get("knowledge_version"):
        raise SmokeFailure("Agent knowledge version missing")
    forbidden = ("token", "password", "secret", "api_key", "postgres_uri")
    if any(marker in json.dumps(health).lower() for marker in forbidden):
        raise SmokeFailure("Agent health contains secret-shaped fields")
    return {"old_web": "ready", "new_web": "ready", "agent": "ready", "agent_knowledge_version": health["knowledge_version"]}


def assert_agent_loopback_only(listener_text: str) -> None:
    """Reject 2124 unless every listener is exactly IPv4 loopback."""
    matched = [line for line in listener_text.splitlines() if re.search(r":2124(?:\s|$)", line)]
    if not matched:
        raise SmokeFailure("2124 listener missing")
    if any("127.0.0.1:2124" not in line for line in matched):
        raise SmokeFailure("2124 is publicly bound")


class WorkbenchSession:
    """Cookie-preserving JSON client that never reflects response bodies into errors."""

    def __init__(self, base_url: str) -> None:
        self._base_url = base_url.rstrip("/")
        jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def request_json(
        self,
        method: str,
        route: str,
        payload: dict[str, Any] | None = None,
        timeout: float = 20,
    ) -> tuple[int, Any]:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"content-type": "application/json"} if body is not None else {}
        request = urllib.request.Request(self._base_url + route, data=body, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=timeout) as response:
                raw = response.read(1_000_000)
                return response.status, _safe_json(raw)
        except urllib.error.HTTPError as error:
            raw = error.read(1_000_000)
            return error.code, _safe_json(raw)
        except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
            raise SmokeFailure(f"workbench request failed: {type(error).__name__}") from None


def _safe_json(body: bytes) -> Any:
    if not body:
        return None
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SmokeFailure("workbench response contains invalid JSON") from None


def _expect(status: int, expected: int, marker: str) -> None:
    if status != expected:
        raise SmokeFailure(marker)


def check_current_product_gate(product_id: str) -> bool:
    """Verify the stored product remains active and recommendable in the current view."""
    if not re.fullmatch(r"[0-9]{1,32}", product_id):
        return False
    sql = (
        "SELECT COUNT(*) FROM public.current_product_knowledge "
        f"WHERE product_id='{product_id}' AND status='approved' "
        "AND recommendable_snapshot=TRUE AND sale_status_snapshot='active'"
    )
    try:
        completed = subprocess.run(
            ["runuser", "-u", "postgres", "--", "psql", "-d", "linglongzivectordb_v2", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
            check=True,
            text=True,
            capture_output=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        raise SmokeFailure("product recommendation gate check failed") from None
    try:
        return int(completed.stdout.strip()) > 0
    except ValueError:
        raise SmokeFailure("product recommendation gate response invalid") from None


def check_workbench_contracts(
    base_url: str,
    credentials: dict[str, str],
    *,
    session_factory: Any | None = None,
    product_gate: Any = check_current_product_gate,
    run_id: str | None = None,
) -> dict[str, str]:
    """Exercise every approved human-reference route using tagged virtual records."""
    required = {"admin_username", "admin_password", "agent_a_username", "agent_a_password", "agent_b_username", "agent_b_password"}
    if not required.issubset(credentials):
        raise SmokeFailure("credential roles missing")
    create_session = session_factory or (lambda: WorkbenchSession(base_url))
    admin, agent_a, agent_b = create_session(), create_session(), create_session()

    for session, username_key, password_key, expected_role in (
        (admin, "admin_username", "admin_password", "admin"),
        (agent_a, "agent_a_username", "agent_a_password", "agent"),
        (agent_b, "agent_b_username", "agent_b_password", "agent"),
    ):
        status, body = session.request_json("POST", "/api/auth/login", {
            "username": credentials[username_key], "password": credentials[password_key]
        })
        if status != 200 or not isinstance(body, dict) or body.get("user", {}).get("role") != expected_role:
            raise SmokeFailure("login contract failed")

    drafts: dict[str, str] = {}
    for label, question, expected_mode in (
        ("faq", FAQ_QUESTION, "draft"),
        ("product", PRODUCT_QUESTION, "draft"),
        ("dynamic", DYNAMIC_QUESTION, "insufficient"),
    ):
        status, body = agent_a.request_json("POST", "/api/drafts", {"question": question}, timeout=45)
        if status != 201 or not isinstance(body, dict) or body.get("answerMode") != expected_mode or not body.get("id"):
            raise SmokeFailure(f"{label} draft contract failed")
        drafts[label] = str(body["id"])

    status, _ = agent_a.request_json("POST", "/api/feedback", {
        "draftRunId": drafts["dynamic"], "action": "discarded"
    })
    _expect(status, 400, "discard reason contract failed")

    tag = f"TASK8-SMOKE:{run_id or uuid.uuid4()}"
    feedback_payloads = (
        {"draftRunId": drafts["faq"], "action": "adopted"},
        {"draftRunId": drafts["product"], "action": "modified", "finalDraft": f"{tag} 虚拟人工修改稿"},
        {"draftRunId": drafts["dynamic"], "action": "discarded", "discardReason": "dynamic_data_required"},
    )
    for payload in feedback_payloads:
        status, _ = agent_a.request_json("POST", "/api/feedback", payload)
        _expect(status, 201, "feedback persistence contract failed")

    status, history_a = agent_a.request_json("GET", "/api/history")
    status_b, history_b = agent_b.request_json("GET", "/api/history")
    if status != 200 or status_b != 200 or not isinstance(history_a, dict) or not isinstance(history_b, dict):
        raise SmokeFailure("history contract failed")
    a_ids = {str(item.get("id")) for item in history_a.get("items", [])}
    b_ids = {str(item.get("id")) for item in history_b.get("items", [])}
    if not set(drafts.values()).issubset(a_ids) or set(drafts.values()) & b_ids:
        raise SmokeFailure("history isolation contract failed")

    details: dict[str, dict[str, Any]] = {}
    for label, action, question in (
        ("faq", "adopted", FAQ_QUESTION),
        ("product", "modified", PRODUCT_QUESTION),
        ("dynamic", "discarded", DYNAMIC_QUESTION),
    ):
        status, listing = admin.request_json("GET", f"/api/admin/feedback?action={action}&reviewStatus=pending&page=1&limit=100")
        if status != 200 or not isinstance(listing, dict):
            raise SmokeFailure("administrator filter contract failed")
        match = next((item for item in listing.get("items", []) if item.get("question") == question), None)
        if not match or not match.get("id"):
            raise SmokeFailure("administrator filter contract failed")
        feedback_id = str(match["id"])
        status, detail = admin.request_json("GET", f"/api/admin/feedback/{feedback_id}")
        if status != 200 or not isinstance(detail, dict):
            raise SmokeFailure("administrator detail contract failed")
        details[label] = detail
        review_action = "queue_for_review" if label == "dynamic" else "no_action"
        status, _ = admin.request_json("PATCH", f"/api/admin/feedback/{feedback_id}", {"action": review_action, "note": tag})
        _expect(status, 200, "administrator review contract failed")

    if not details["faq"].get("faqSnapshot"):
        raise SmokeFailure("FAQ evidence contract failed")
    product_snapshots = details["product"].get("productSnapshot") or []
    product_ids = {str(item.get("product_id")) for item in product_snapshots if isinstance(item, dict)}
    if EXPECTED_PRODUCT_ID not in product_ids:
        raise SmokeFailure("product evidence contract failed")
    if not product_gate(EXPECTED_PRODUCT_ID):
        raise SmokeFailure("product recommendation gate contract failed")
    dynamic_text = str(details["dynamic"].get("aiOriginal", ""))
    if "核实" not in dynamic_text or re.search(r"\d+\s*(?:元|件|单)", dynamic_text):
        raise SmokeFailure("dynamic safety contract failed")

    status, users = admin.request_json("GET", "/api/admin/users")
    if status != 200 or not isinstance(users, dict) or not isinstance(users.get("items"), list):
        raise SmokeFailure("administrator users contract failed")
    publish_status, _ = admin.request_json("POST", "/api/admin/knowledge/publish", {})
    _expect(publish_status, 404, "knowledge publication boundary failed")

    return {
        "faq": "passed",
        "product": "passed",
        "dynamic": "passed",
        "feedback": "passed",
        "history_isolation": "passed",
        "admin": "passed",
        "automatic_send": "disabled",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", required=True)
    parser.add_argument("--old-web-url", default="http://127.0.0.1:3000/")
    parser.add_argument("--new-web-url", default="http://127.0.0.1:3100/login")
    parser.add_argument("--agent-health-url", default="http://127.0.0.1:2124/health")
    parser.add_argument("--web-base-url", default="http://127.0.0.1:3100")
    parser.add_argument("--listeners-command", default="ss -lntH")
    args = parser.parse_args(argv)
    credentials = load_credentials(args.credentials)
    health = check_health_contracts(old_web_url=args.old_web_url, new_web_url=args.new_web_url, agent_health_url=args.agent_health_url)
    listeners = subprocess.run(args.listeners_command.split(), check=True, text=True, capture_output=True).stdout
    assert_agent_loopback_only(listeners)
    contracts = check_workbench_contracts(args.web_base_url, credentials)
    print(json.dumps({"status": "passed", "health": health, "contracts": contracts}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": redact(type(error).__name__)}, ensure_ascii=False))
        raise SystemExit(1)
