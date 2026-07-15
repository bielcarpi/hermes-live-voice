"""Tool handlers for the hermes-live Hermes plugin."""

from __future__ import annotations

import json
from os import getenv
from typing import Any, BinaryIO
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8788"
MAX_GATEWAY_URL_CHARS = 2048
MAX_AUTH_TOKEN_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 16 * 1024
MAX_OUTPUT_CHARS = 16 * 1024
MAX_FIELD_CHARS = 256

_INVALID_GATEWAY_URL_MESSAGE = (
    "HERMES_LIVE_URL must be a credential-free HTTP(S) origin without a path, query, or fragment."
)
_INVALID_AUTH_TOKEN_MESSAGE = "HERMES_LIVE_AUTH_TOKEN must be a bounded token without whitespace or control characters."


class _NoRedirectHandler(HTTPRedirectHandler):
    """Turn redirects into HTTPError responses instead of following them."""

    def redirect_request(
        self,
        req: Request,
        fp: BinaryIO,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


_NO_REDIRECT_OPENER = build_opener(ProxyHandler({}), _NoRedirectHandler())


def gateway_status(args: dict[str, Any], **_kwargs: Any) -> str:
    """Return bounded gateway metadata and optional, sanitized probe results."""
    try:
        gateway_url = configured_gateway_url()
    except ValueError:
        return _dump_result(
            {
                "success": False,
                "probed": False,
                "error": {
                    "code": "invalid_gateway_url",
                    "message": _INVALID_GATEWAY_URL_MESSAGE,
                },
            }
        )

    try:
        gateway_token = configured_gateway_token()
    except ValueError:
        return _dump_result(
            {
                "success": False,
                "probed": False,
                "error": {
                    "code": "invalid_auth_token",
                    "message": _INVALID_AUTH_TOKEN_MESSAGE,
                },
            }
        )

    token_configured = gateway_token is not None
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
        return _dump_result(result)

    timeout = _timeout_seconds(args.get("timeout_ms"))
    sensitive_values = (gateway_token,) if gateway_token else ()
    checks = {
        "health": _get_json(gateway_url, "/health", None, timeout, sensitive_values),
        "capabilities": _get_json(
            gateway_url,
            "/v1/capabilities",
            gateway_token,
            timeout,
            sensitive_values,
        ),
    }
    if _bool_arg(args, "include_readiness", False):
        checks["ready"] = _get_json(
            gateway_url,
            "/ready",
            gateway_token,
            timeout,
            sensitive_values,
        )

    result["probed"] = True
    result["checks"] = checks
    result["success"] = all(check.get("ok") is True for check in checks.values())
    return _dump_result(result)


def configured_gateway_url() -> str:
    """Return the configured gateway as a validated, credential-free origin."""
    raw_value = getenv("HERMES_LIVE_URL") or DEFAULT_GATEWAY_URL
    if (
        not isinstance(raw_value, str)
        or not raw_value
        or len(raw_value) > MAX_GATEWAY_URL_CHARS
        or raw_value != raw_value.strip()
        or "\\" in raw_value
        or "?" in raw_value
        or "#" in raw_value
        or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in raw_value)
    ):
        raise ValueError(_INVALID_GATEWAY_URL_MESSAGE)

    try:
        parsed = urlsplit(raw_value)
        _validate_gateway_origin(parsed)
        # Accessing .port performs urllib's numeric/range validation.
        parsed.port
    except (TypeError, ValueError) as error:
        raise ValueError(_INVALID_GATEWAY_URL_MESSAGE) from error

    return f"{parsed.scheme.lower()}://{parsed.netloc}"


def configured_gateway_token() -> str | None:
    """Return a bounded bearer that is safe to place in one HTTP header."""
    token = getenv("HERMES_LIVE_AUTH_TOKEN")
    if not token:
        return None
    try:
        encoded = token.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(_INVALID_AUTH_TOKEN_MESSAGE) from error
    if len(encoded) > MAX_AUTH_TOKEN_BYTES or any(
        character.isspace() or ord(character) < 32 or ord(character) == 127 for character in token
    ):
        raise ValueError(_INVALID_AUTH_TOKEN_MESSAGE)
    return token


def _validate_gateway_origin(parsed: SplitResult) -> None:
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ValueError(_INVALID_GATEWAY_URL_MESSAGE)
    if not parsed.netloc or parsed.hostname is None:
        raise ValueError(_INVALID_GATEWAY_URL_MESSAGE)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(_INVALID_GATEWAY_URL_MESSAGE)
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError(_INVALID_GATEWAY_URL_MESSAGE)


def _websocket_url(gateway_url: str, path: str) -> str:
    if gateway_url.startswith("https://"):
        return "wss://" + gateway_url.removeprefix("https://") + path
    return "ws://" + gateway_url.removeprefix("http://") + path


def _bool_arg(args: dict[str, Any], name: str, default: bool) -> bool:
    value = args.get(name, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _timeout_seconds(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and 100 <= value <= 10000:
        return float(value) / 1000
    return 2.0


def _get_json(
    base_url: str,
    path: str,
    token: str | None,
    timeout: float,
    sensitive_values: tuple[str, ...] = (),
) -> dict[str, Any]:
    redacted_values = tuple(value for value in (*sensitive_values, token) if value)
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = Request(base_url + path, headers=headers, method="GET")
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=timeout) as response:
            return _response_result(response, path, int(response.status), redacted_values)
    except HTTPError as error:
        try:
            if 300 <= error.code < 400:
                return {"ok": False, "status": error.code, "error": "redirect_not_allowed"}
            return _response_result(error, path, error.code, redacted_values)
        finally:
            error.close()
    except TimeoutError:
        return {"ok": False, "error": "timeout"}
    except (URLError, OSError, ValueError, UnicodeError):
        return {"ok": False, "error": "request_failed"}


def _response_result(
    response: Any,
    path: str,
    status: int,
    sensitive_values: tuple[str, ...],
) -> dict[str, Any]:
    body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        return {"ok": False, "status": status, "error": "response_too_large"}

    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json" and not content_type.endswith("+json"):
        return {"ok": False, "status": status, "error": "invalid_content_type"}

    try:
        parsed = json.loads(body.decode("utf-8"), parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return {"ok": False, "status": status, "error": "invalid_json"}

    sanitized = _suppress_sensitive_strings(_sanitize_body(path, parsed), sensitive_values)
    ok = 200 <= status < 300
    if ok and not _expected_success_shape(path, sanitized):
        return {"ok": False, "status": status, "error": "unexpected_response"}

    result: dict[str, Any] = {"ok": ok, "status": status}
    if sanitized:
        result["body"] = sanitized
    elif not ok:
        result["error"] = "http_error"
    return result


def _sanitize_body(path: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    if path == "/health":
        return _sanitize_health(value)
    if path == "/v1/capabilities":
        return _sanitize_capabilities(value)
    if path == "/ready":
        return _sanitize_readiness(value)
    return {}


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant: {value}")


def _suppress_sensitive_strings(value: dict[str, Any], sensitive_values: tuple[str, ...]) -> dict[str, Any]:
    if not sensitive_values:
        return value

    def visit(item: Any) -> Any:
        if isinstance(item, str):
            return None if any(secret in item for secret in sensitive_values) else item
        if isinstance(item, dict):
            return {name: safe for name, child in item.items() if (safe := visit(child)) is not None}
        return item

    return visit(value)


def _sanitize_health(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    _copy_string(value, result, "status")
    _copy_string(value, result, "service")
    return result


def _sanitize_capabilities(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in ("object", "service", "status"):
        _copy_string(value, result, name)
    _copy_integer(value, result, "protocolVersion")

    websocket = _mapping(value.get("websocket"))
    safe_websocket: dict[str, Any] = {}
    for name in ("path", "protocol"):
        _copy_string(websocket, safe_websocket, name)
    if safe_websocket:
        result["websocket"] = safe_websocket

    realtime = _mapping(value.get("realtime"))
    safe_realtime: dict[str, Any] = {}
    for name in ("provider", "model"):
        _copy_string(realtime, safe_realtime, name)
    audio = _sanitize_audio(_mapping(realtime.get("audio")))
    if audio:
        safe_realtime["audio"] = audio
    if safe_realtime:
        result["realtime"] = safe_realtime

    hermes = _mapping(value.get("hermes"))
    approvals = _sanitize_approvals(_mapping(hermes.get("approvals")))
    if approvals:
        result["hermes"] = {"approvals": approvals}

    features = _sanitize_features(_mapping(value.get("features")))
    if features:
        result["features"] = features
    return result


def _sanitize_audio(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for direction in ("input", "output"):
        source = _mapping(value.get(direction))
        safe_direction: dict[str, Any] = {}
        _copy_boolean(source, safe_direction, "enabled")
        _copy_string(source, safe_direction, "mimeType")
        _copy_integer(source, safe_direction, "recommendedFrameMs")
        if safe_direction:
            result[direction] = safe_direction
    _copy_string(value, result, "turnDetection")
    return result


def _sanitize_approvals(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in ("uiSupported", "interactive", "negotiated"):
        _copy_boolean(value, result, name)
    for name in ("fallback", "requiredFeature"):
        _copy_string(value, result, name)
    return result


_BOOLEAN_FEATURES = {
    "auth_required",
    "server_managed_identity",
    "gemini_live",
    "openai_realtime",
    "mock_live",
    "hermes_runs",
    "hermes_run_events",
    "hermes_stop",
    "hermes_approval",
    "hermes_approval_ui",
    "hermes_approval_fallback_deny_all",
    "hermes_approval_fallback_stops_run",
    "hermes_approval_requires_targeted_response",
    "browser_demo",
    "optional_hermes_plugin",
}


def _sanitize_features(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in _BOOLEAN_FEATURES:
        _copy_boolean(value, result, name)
    _copy_string(value, result, "run_event_detail")
    _copy_integer(value, result, "max_sessions")
    return result


def _sanitize_readiness(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    _copy_string(value, result, "status")
    checks = _mapping(value.get("checks"))
    safe_checks: dict[str, Any] = {}

    gateway = _mapping(checks.get("gateway"))
    safe_gateway: dict[str, Any] = {}
    for name in ("ok", "authRequired", "demoEnabled", "serverManagedIdentity"):
        _copy_boolean(gateway, safe_gateway, name)
    for name in ("port", "maxSessions"):
        _copy_integer(gateway, safe_gateway, name)
    _copy_string(gateway, safe_gateway, "runEventDetail")
    if safe_gateway:
        safe_checks["gateway"] = safe_gateway

    hermes = _mapping(checks.get("hermes"))
    safe_hermes: dict[str, Any] = {}
    _copy_boolean(hermes, safe_hermes, "ok")
    _copy_string(hermes, safe_hermes, "model")
    approvals = _sanitize_approvals(_mapping(hermes.get("approvals")))
    if approvals:
        safe_hermes["approvals"] = approvals
    if safe_hermes:
        safe_checks["hermes"] = safe_hermes

    realtime = _mapping(checks.get("realtime"))
    safe_realtime: dict[str, Any] = {}
    for name in ("ok", "configured", "injected", "sessionChecked", "enterprise", "projectConfigured"):
        _copy_boolean(realtime, safe_realtime, name)
    for name in (
        "provider",
        "model",
        "location",
        "apiVersion",
        "voice",
        "reasoningEffort",
        "turnDetection",
        "inputAudioFormat",
        "outputAudioFormat",
    ):
        _copy_string(realtime, safe_realtime, name)
    if safe_realtime:
        safe_checks["realtime"] = safe_realtime

    if safe_checks:
        result["checks"] = safe_checks
    return result


def _expected_success_shape(path: str, value: dict[str, Any]) -> bool:
    if path == "/health":
        return value.get("status") == "ok" and value.get("service") == "hermes-live"
    if path == "/v1/capabilities":
        protocol_version = value.get("protocolVersion")
        return (
            value.get("object") == "hermes_live.capabilities"
            and value.get("service") == "hermes-live"
            and isinstance(protocol_version, int)
            and not isinstance(protocol_version, bool)
            and 1 <= protocol_version <= 1_000
        )
    if path == "/ready":
        checks = _mapping(value.get("checks"))
        return value.get("status") == "ready" and all(
            _mapping(checks.get(name)).get("ok") is True
            for name in ("gateway", "hermes", "realtime")
        )
    return False


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _copy_string(source: dict[str, Any], target: dict[str, Any], name: str) -> None:
    value = source.get(name)
    if isinstance(value, str) and len(value) <= MAX_FIELD_CHARS and all(character.isprintable() for character in value):
        target[name] = value


def _copy_boolean(source: dict[str, Any], target: dict[str, Any], name: str) -> None:
    value = source.get(name)
    if isinstance(value, bool):
        target[name] = value


def _copy_integer(source: dict[str, Any], target: dict[str, Any], name: str) -> None:
    value = source.get(name)
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) <= 1_000_000_000:
        target[name] = value


def _dump_result(value: dict[str, Any]) -> str:
    serialized = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    if len(serialized) <= MAX_OUTPUT_CHARS:
        return serialized
    return json.dumps(
        {
            "success": False,
            "probed": bool(value.get("probed")),
            "error": {"code": "output_too_large"},
        },
        separators=(",", ":"),
    )
