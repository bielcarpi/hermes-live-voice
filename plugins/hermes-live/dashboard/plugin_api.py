"""Authenticated Hermes Dashboard bridge for the Hermes Live Voice gateway.

The browser connects only to this same-origin plugin API.  Gateway credentials
stay in the Hermes process environment and are attached to the upstream
connection server-side.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect


log = logging.getLogger(__name__)
# websockets' debug logger prints handshake headers, including Authorization.
# Give the upstream client a detached, disabled logger so enabling global debug
# logging in Hermes can never write the gateway credential.
_upstream_protocol_log = logging.Logger(f"{__name__}.upstream")
_upstream_protocol_log.disabled = True

router = APIRouter()

DEFAULT_GATEWAY_URL = "http://127.0.0.1:8788"
GATEWAY_WEBSOCKET_PATH = "/v1/live"
MAX_MESSAGE_BYTES = 8_000_000
MAX_STATUS_BODY_BYTES = 256_000
MAX_TOKEN_BYTES = 8_192
MAX_GATEWAY_URL_CHARS = 2_048
STATUS_TIMEOUT_SECONDS = 2.5
MAX_CONVERSATIONS = 50


class GatewayConfigurationError(ValueError):
    """Raised when server-owned gateway configuration isn't safe to use."""


class _RelayProtocolError(Exception):
    def __init__(self, source: str) -> None:
        super().__init__(source)
        self.source = source


@dataclass(frozen=True)
class _Probe:
    status: int | None = None
    body: dict[str, Any] | None = None
    error: str | None = None

    @property
    def reached_server(self) -> bool:
        return self.status is not None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300


def _normalise_gateway_url(value: str | None = None) -> str:
    """Return a credential-free HTTP(S) origin suitable for gateway calls.

    Hermes Live currently serves its HTTP and WebSocket endpoints at fixed
    root paths.  Rejecting base paths, queries, fragments, and user-info keeps
    endpoint construction unambiguous and prevents credentials embedded in an
    environment URL from being reflected to the dashboard.
    """

    raw = DEFAULT_GATEWAY_URL if value is None else value
    if not isinstance(raw, str):
        raise GatewayConfigurationError("gateway URL must be a string")
    if (
        not raw
        or len(raw) > MAX_GATEWAY_URL_CHARS
        or raw != raw.strip()
        or any(
            character.isspace()
            or character == "\\"
            or ord(character) < 0x20
            or ord(character) == 0x7F
            for character in raw
        )
    ):
        raise GatewayConfigurationError("gateway URL contains unsafe characters")

    try:
        parsed = urlsplit(raw)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise GatewayConfigurationError("gateway URL is malformed") from exc

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise GatewayConfigurationError("gateway URL must use HTTP or HTTPS")
    if not hostname:
        raise GatewayConfigurationError("gateway URL must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise GatewayConfigurationError("gateway URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise GatewayConfigurationError("gateway URL must not contain a query or fragment")
    if parsed.path not in {"", "/"}:
        raise GatewayConfigurationError("gateway URL must not contain a base path")

    host = hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = host if port is None else f"{host}:{port}"
    return urlunsplit((scheme, netloc, "", "", ""))


def _gateway_url() -> str:
    return _normalise_gateway_url(os.getenv("HERMES_LIVE_URL") or DEFAULT_GATEWAY_URL)


def _gateway_token() -> str | None:
    token = os.getenv("HERMES_LIVE_AUTH_TOKEN")
    if not token:
        return None
    try:
        encoded = token.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise GatewayConfigurationError("gateway token contains unsafe characters") from exc
    if len(encoded) > MAX_TOKEN_BYTES or any(
        character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F
        for character in token
    ):
        raise GatewayConfigurationError("gateway token contains unsafe characters")
    return token


def _gateway_websocket_url(gateway_url: str) -> str:
    parsed = urlsplit(_normalise_gateway_url(gateway_url))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunsplit((scheme, parsed.netloc, GATEWAY_WEBSOCKET_PATH, "", ""))


def _reject_upstream_redirect(error: Exception) -> Exception:
    """Return the handshake error so websockets cannot follow its Location."""

    return error


def _disable_upstream_redirects(connection: Any) -> Any:
    """Fail closed if the upstream client cannot disable redirect handling.

    websockets follows HTTP handshake redirects by default and reuses
    ``additional_headers`` on the redirected request.  Replacing the per-
    connection redirect hook keeps the installation bearer pinned to the
    configured gateway origin.
    """

    try:
        connection.process_redirect = _reject_upstream_redirect
    except Exception as exc:
        raise GatewayConfigurationError("upstream WebSocket redirects could not be disabled") from exc
    return connection


@router.get("/status")
async def gateway_status() -> dict[str, Any]:
    """Return a small, sanitized gateway status summary for the dashboard."""

    try:
        gateway_url = _gateway_url()
        token = _gateway_token()
    except GatewayConfigurationError:
        return _empty_status(configured=False, error="invalid_gateway_configuration")

    authenticated_headers = {"Authorization": f"Bearer {token}"} if token else None
    timeout = httpx.Timeout(
        STATUS_TIMEOUT_SECONDS,
        connect=min(1.5, STATUS_TIMEOUT_SECONDS),
    )
    limits = httpx.Limits(max_connections=3, max_keepalive_connections=0)

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        limits=limits,
        trust_env=False,
        headers={"Accept": "application/json"},
    ) as client:
        health, capabilities, readiness = await asyncio.gather(
            _fetch_json(client, f"{gateway_url}/health"),
            _fetch_json(client, f"{gateway_url}/v1/capabilities", authenticated_headers),
            _fetch_json(client, f"{gateway_url}/ready", authenticated_headers),
        )

    reachable = any(probe.reached_server for probe in (health, capabilities, readiness))
    capabilities_valid = _capabilities_identity_is_valid(capabilities)
    ready = capabilities_valid and _readiness_is_ready(readiness)
    protocol_version, provider, model, audio, tasks = _capabilities_summary(
        capabilities.body if capabilities_valid else None,
        sensitive_values=(token,) if token else (),
    )

    error: str | None
    if not reachable:
        error = "gateway_unreachable"
    elif capabilities.status in {401, 403} or readiness.status in {401, 403}:
        error = "gateway_auth_failed"
    elif not capabilities_valid:
        error = "capabilities_unavailable"
    elif not ready:
        error = "gateway_not_ready"
    else:
        error = None

    return {
        "configured": True,
        "reachable": reachable,
        "ready": ready,
        "gateway": {"mode": "server-proxied"},
        "protocolVersion": protocol_version,
        "provider": provider,
        "model": model,
        "audio": audio,
        "tasks": tasks,
        "error": error,
    }


@router.get("/conversations")
async def gateway_conversations() -> dict[str, Any]:
    """Return a bounded, sanitized list of persisted Hermes chats."""

    try:
        gateway_url = _gateway_url()
        token = _gateway_token()
    except GatewayConfigurationError:
        return {"conversations": [], "error": "invalid_gateway_configuration"}

    headers = {"Authorization": f"Bearer {token}"} if token else None
    timeout = httpx.Timeout(STATUS_TIMEOUT_SECONDS, connect=min(1.5, STATUS_TIMEOUT_SECONDS))
    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        limits=httpx.Limits(max_connections=1, max_keepalive_connections=0),
        trust_env=False,
        headers={"Accept": "application/json"},
    ) as client:
        probe = await _fetch_json(
            client,
            f"{gateway_url}/v1/conversations?limit={MAX_CONVERSATIONS}",
            headers,
        )

    if not probe.ok or not isinstance(probe.body, dict):
        return {"conversations": [], "error": "conversations_unavailable"}
    raw = probe.body.get("conversations")
    if not isinstance(raw, list):
        return {"conversations": [], "error": "conversations_unavailable"}
    conversations = []
    for item in raw[:MAX_CONVERSATIONS]:
        safe = _safe_conversation(item, sensitive_values=(token,) if token else ())
        if safe is not None:
            conversations.append(safe)
    return {"conversations": conversations, "error": None}


def _empty_status(*, configured: bool, error: str) -> dict[str, Any]:
    return {
        "configured": configured,
        "reachable": False,
        "ready": False,
        "gateway": {"mode": "server-proxied"},
        "protocolVersion": None,
        "provider": None,
        "model": None,
        "audio": None,
        "tasks": None,
        "error": error,
    }


def _safe_conversation(
    value: Any,
    *,
    sensitive_values: tuple[str, ...] = (),
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    session_id = _safe_text(value.get("id"), maximum=256, sensitive_values=sensitive_values)
    if session_id is None or not all(character.isalnum() or character in "._:-" for character in session_id):
        return None
    result: dict[str, Any] = {"id": session_id}
    for key, maximum in (("title", 100), ("preview", 500), ("source", 64)):
        text = _safe_text(value.get(key), maximum=maximum, sensitive_values=sensitive_values)
        if text is not None:
            result[key] = text
    last_active = value.get("lastActive")
    if isinstance(last_active, int) and not isinstance(last_active, bool) and 0 <= last_active <= 8_640_000_000_000_000:
        result["lastActive"] = last_active
    return result


async def _fetch_json(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str] | None = None,
) -> _Probe:
    """Fetch a bounded JSON object without returning transport details."""

    try:
        async with client.stream("GET", url, headers=headers) as response:
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json" and not content_type.endswith("+json"):
                return _Probe(status=response.status_code, error="invalid_content_type")
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > MAX_STATUS_BODY_BYTES:
                    return _Probe(status=response.status_code, error="response_too_large")
                chunks.append(chunk)
            raw = b"".join(chunks)
            try:
                parsed = json.loads(raw, parse_constant=_reject_json_constant) if raw else None
            except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
                return _Probe(status=response.status_code, error="invalid_json")
            if parsed is not None and not isinstance(parsed, dict):
                return _Probe(status=response.status_code, error="invalid_json")
            return _Probe(status=response.status_code, body=parsed)
    except asyncio.CancelledError:
        raise
    except Exception:
        return _Probe(error="request_failed")


def _capabilities_summary(
    capabilities: dict[str, Any] | None,
    *,
    sensitive_values: tuple[str, ...] = (),
) -> tuple[int | None, str | None, str | None, dict[str, Any] | None, dict[str, Any] | None]:
    if not isinstance(capabilities, dict):
        return None, None, None, None, None

    protocol_version = _safe_protocol_version(capabilities.get("protocolVersion"))
    tasks = _safe_task_capabilities(capabilities.get("tasks"))

    realtime = capabilities.get("realtime")
    if not isinstance(realtime, dict):
        return protocol_version, None, None, None, tasks

    provider = _safe_text(realtime.get("provider"), sensitive_values=sensitive_values)
    model = _safe_text(realtime.get("model"), sensitive_values=sensitive_values)
    audio = _safe_audio(realtime.get("audio"), sensitive_values=sensitive_values)
    return protocol_version, provider, model, audio, tasks


def _capabilities_identity_is_valid(capabilities: _Probe) -> bool:
    return (
        capabilities.ok
        and capabilities.error is None
        and isinstance(capabilities.body, dict)
        and capabilities.body.get("object") == "hermes_live.capabilities"
        and capabilities.body.get("service") == "hermes-live"
        and _safe_protocol_version(capabilities.body.get("protocolVersion")) is not None
    )


def _safe_protocol_version(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 1_000 else None


def _readiness_is_ready(readiness: _Probe) -> bool:
    if not readiness.ok or not isinstance(readiness.body, dict) or readiness.body.get("status") != "ready":
        return False
    checks = readiness.body.get("checks")
    if not isinstance(checks, dict):
        return False
    return all(
        isinstance(checks.get(name), dict) and checks[name].get("ok") is True
        for name in ("gateway", "hermes", "realtime", "tasks")
    )


def _safe_text(
    value: Any,
    *,
    maximum: int = 256,
    sensitive_values: tuple[str, ...] = (),
) -> str | None:
    if not isinstance(value, str) or not value or len(value) > maximum:
        return None
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        return None
    if any(secret and secret in value for secret in sensitive_values):
        return None
    return value


def _safe_audio(value: Any, *, sensitive_values: tuple[str, ...] = ()) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    result: dict[str, Any] = {}
    for direction in ("input", "output"):
        raw_direction = value.get(direction)
        if not isinstance(raw_direction, dict) or not isinstance(raw_direction.get("enabled"), bool):
            continue
        safe_direction: dict[str, Any] = {"enabled": raw_direction["enabled"]}
        mime_type = _safe_text(
            raw_direction.get("mimeType"),
            maximum=128,
            sensitive_values=sensitive_values,
        )
        if mime_type is not None:
            safe_direction["mimeType"] = mime_type
        if direction == "input":
            frame_ms = raw_direction.get("recommendedFrameMs")
            if isinstance(frame_ms, int) and not isinstance(frame_ms, bool) and 1 <= frame_ms <= 10_000:
                safe_direction["recommendedFrameMs"] = frame_ms
        result[direction] = safe_direction

    turn_detection = _safe_text(
        value.get("turnDetection"),
        maximum=64,
        sensitive_values=sensitive_values,
    )
    if turn_detection is not None:
        result["turnDetection"] = turn_detection
    return result or None


def _safe_task_capabilities(value: Any) -> dict[str, Any] | None:
    """Expose only the task settings needed by the Dashboard, never persistence paths."""
    if not isinstance(value, dict):
        return None

    result: dict[str, Any] = {}
    for name in ("durable", "disconnectContinuation", "declaredReadOnlyTrusted"):
        raw = value.get(name)
        if isinstance(raw, bool):
            result[name] = raw
    for name in ("maxConcurrent", "maxRetained"):
        raw = value.get(name)
        if isinstance(raw, int) and not isinstance(raw, bool) and 1 <= raw <= 1_000_000:
            result[name] = raw
    if "maxConcurrent" in result and "declaredReadOnlyTrusted" in result:
        result["parallel"] = result["maxConcurrent"] > 1 and result["declaredReadOnlyTrusted"]
    return result or None


@router.websocket("/live")
async def live_websocket(ws: WebSocket) -> None:
    """Authenticate a dashboard WebSocket and relay the JSON live protocol."""

    rejection_code = _dashboard_ws_rejection_code(ws)
    if rejection_code is not None:
        await _safe_close(ws, rejection_code)
        return

    try:
        gateway_url = _gateway_url()
        token = _gateway_token()
    except GatewayConfigurationError:
        await ws.accept()
        await _send_session_error(ws, "gateway_unavailable", "The Live Voice gateway is not configured correctly.")
        await _safe_close(ws, 1013)
        return

    try:
        from websockets.asyncio.client import connect
    except Exception:
        await ws.accept()
        await _send_session_error(ws, "gateway_unavailable", "The Live Voice gateway is unavailable.")
        await _safe_close(ws, 1013)
        return

    try:
        await ws.accept()
    except Exception:
        return

    connect_options: dict[str, Any] = {
        "open_timeout": 5,
        "close_timeout": 3,
        "ping_interval": 20,
        "ping_timeout": 20,
        "max_size": MAX_MESSAGE_BYTES,
        "max_queue": 16,
        "write_limit": 65_536,
        "proxy": None,
        "logger": _upstream_protocol_log,
    }
    if token:
        connect_options["additional_headers"] = {"Authorization": f"Bearer {token}"}

    try:
        upstream_connection = _disable_upstream_redirects(
            connect(_gateway_websocket_url(gateway_url), **connect_options)
        )
        async with upstream_connection as upstream:
            await _bridge_connections(ws, upstream)
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        raise
    except _RelayProtocolError as exc:
        if exc.source == "browser":
            await _send_session_error(ws, "invalid_message", "Live Voice accepts bounded JSON protocol messages only.")
            await _safe_close(ws, 1008)
        else:
            await _send_session_error(ws, "gateway_protocol_error", "The Live Voice gateway returned an invalid protocol message.")
            await _safe_close(ws, 1011)
        return
    except Exception as exc:
        # Never log the configured URL, credential, request headers, or the
        # exception text: handshake exceptions can contain transport details.
        log.warning("Live Voice dashboard proxy failed (%s)", type(exc).__name__)
        await _send_session_error(ws, "gateway_unavailable", "The Live Voice gateway is unavailable.")
        await _safe_close(ws, 1013)
        return

    await _safe_close(ws, 1000)


def _dashboard_ws_rejection_code(ws: WebSocket) -> int | None:
    """Delegate auth and request-boundary checks to Hermes, failing closed."""

    try:
        from hermes_cli import web_server
    except Exception:
        log.warning("Live Voice dashboard WebSocket auth helpers are unavailable")
        return 4403

    auth_ok = getattr(web_server, "_ws_auth_ok", None)
    request_is_allowed = getattr(web_server, "_ws_request_is_allowed", None)
    if not callable(auth_ok) or not callable(request_is_allowed):
        log.warning("Live Voice dashboard WebSocket auth helpers are incomplete")
        return 4403

    try:
        if not bool(auth_ok(ws)):
            return 4401
        if not bool(request_is_allowed(ws)):
            return 4403
    except Exception as exc:
        log.warning("Live Voice dashboard WebSocket authorization failed closed (%s)", type(exc).__name__)
        return 4403
    return None


async def _bridge_connections(ws: WebSocket, upstream: Any) -> None:
    browser_to_gateway = asyncio.create_task(_relay_browser_to_gateway(ws, upstream))
    gateway_to_browser = asyncio.create_task(_relay_gateway_to_browser(upstream, ws))
    tasks = {browser_to_gateway, gateway_to_browser}
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        results = await asyncio.gather(*done, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _relay_browser_to_gateway(ws: WebSocket, upstream: Any) -> None:
    while True:
        message = await ws.receive()
        message_type = message.get("type")
        if message_type == "websocket.disconnect":
            return
        if message_type != "websocket.receive":
            continue
        text = message.get("text")
        if not isinstance(text, str) or not _is_bounded_json_message(text):
            raise _RelayProtocolError("browser")
        await upstream.send(text)


async def _relay_gateway_to_browser(upstream: Any, ws: WebSocket) -> None:
    async for message in upstream:
        if not isinstance(message, str) or not _is_bounded_json_message(message):
            raise _RelayProtocolError("gateway")
        await ws.send_text(message)


def _is_bounded_json_message(message: str) -> bool:
    try:
        if len(message.encode("utf-8")) > MAX_MESSAGE_BYTES:
            return False
        parsed = json.loads(message, parse_constant=_reject_json_constant)
    except (UnicodeEncodeError, json.JSONDecodeError, RecursionError, ValueError):
        return False
    return isinstance(parsed, dict) and isinstance(parsed.get("type"), str)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


async def _send_session_error(ws: WebSocket, code: str, message: str) -> None:
    try:
        await ws.send_text(
            json.dumps(
                {
                    "type": "session.error",
                    "code": code,
                    "message": message,
                    "recoverable": False,
                },
                separators=(",", ":"),
            )
        )
    except Exception:
        pass


async def _safe_close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:
        pass
