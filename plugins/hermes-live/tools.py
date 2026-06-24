"""Tool handlers for the hermes-live Hermes plugin."""

from __future__ import annotations

import json
from os import getenv
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8788"


def gateway_status(args: dict[str, Any], **_kwargs: Any) -> str:
    """Return hermes-live gateway metadata and optional probe results."""
    gateway_url = _gateway_url()
    token_configured = bool(getenv("HERMES_LIVE_AUTH_TOKEN"))
    websocket_path = "/v1/live"
    result: dict[str, Any] = {
        "success": True,
        "gateway": {
            "name": "hermes-live",
            "mode": "gateway",
            "url": gateway_url,
            "websocket_url": _websocket_url(gateway_url, websocket_path),
            "websocket_path": websocket_path,
            "capabilities_path": "/v1/capabilities",
            "ready_path": "/ready",
            "auth_token_configured": token_configured,
        },
    }

    if not _bool_arg(args, "probe", True):
        result["probed"] = False
        return json.dumps(result)

    timeout = _timeout_seconds(args.get("timeout_ms"))
    checks = {
        "health": _get_json(gateway_url, "/health", None, timeout),
        "capabilities": _get_json(gateway_url, "/v1/capabilities", getenv("HERMES_LIVE_AUTH_TOKEN"), timeout),
    }
    if _bool_arg(args, "include_readiness", False):
        checks["ready"] = _get_json(gateway_url, "/ready", getenv("HERMES_LIVE_AUTH_TOKEN"), timeout)

    result["probed"] = True
    result["checks"] = checks
    result["success"] = all(check.get("ok") for check in checks.values())
    return json.dumps(result)


def _gateway_url() -> str:
    return (getenv("HERMES_LIVE_URL") or DEFAULT_GATEWAY_URL).rstrip("/")


def _websocket_url(gateway_url: str, path: str) -> str:
    if gateway_url.startswith("https://"):
        return "wss://" + gateway_url.removeprefix("https://") + path
    if gateway_url.startswith("http://"):
        return "ws://" + gateway_url.removeprefix("http://") + path
    return gateway_url + path


def _bool_arg(args: dict[str, Any], name: str, default: bool) -> bool:
    value = args.get(name, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _timeout_seconds(value: Any) -> float:
    if isinstance(value, (int, float)) and 100 <= value <= 10000:
        return float(value) / 1000
    return 2.0


def _get_json(base_url: str, path: str, token: str | None, timeout: float) -> dict[str, Any]:
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = Request(base_url + path, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return {
                "ok": 200 <= response.status < 300,
                "status": response.status,
                "body": _parse_json(body),
            }
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return {"ok": False, "status": error.code, "body": _parse_json(body)}
    except (TimeoutError, URLError, OSError) as error:
        return {"ok": False, "error": str(error)}


def _parse_json(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value
