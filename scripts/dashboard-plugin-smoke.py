#!/usr/bin/env python3
"""Exercise the Dashboard backend without requiring a Hermes installation."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import types
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_API = ROOT / "plugins" / "hermes-live" / "dashboard" / "plugin_api.py"


class _Router:
    def get(self, _path: str):
        return lambda function: function

    def websocket(self, _path: str):
        return lambda function: function


class _WebSocketDisconnect(Exception):
    pass


class _AsyncClient:
    def __init__(self, **_kwargs: Any) -> None:
        pass

    async def __aenter__(self) -> "_AsyncClient":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None


class _StreamResponse:
    def __init__(self, *, status: int, content_type: str | None, body: bytes) -> None:
        self.status_code = status
        self.headers = {"content-type": content_type} if content_type is not None else {}
        self.body = body

    async def __aenter__(self) -> "_StreamResponse":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def aiter_bytes(self) -> AsyncIterator[bytes]:
        yield self.body


class _StreamClient:
    def __init__(self, response: _StreamResponse) -> None:
        self.response = response

    def stream(self, *_args: Any, **_kwargs: Any) -> _StreamResponse:
        return self.response


def _install_import_stubs() -> None:
    try:
        __import__("fastapi")
    except ModuleNotFoundError:
        fastapi = types.ModuleType("fastapi")
        fastapi.APIRouter = _Router
        fastapi.WebSocket = object
        fastapi.WebSocketDisconnect = _WebSocketDisconnect
        sys.modules["fastapi"] = fastapi

    try:
        __import__("httpx")
    except ModuleNotFoundError:
        httpx = types.ModuleType("httpx")
        httpx.AsyncClient = _AsyncClient
        httpx.Timeout = lambda *_args, **_kwargs: object()
        httpx.Limits = lambda *_args, **_kwargs: object()
        sys.modules["httpx"] = httpx


def _load_plugin_api() -> Any:
    _install_import_stubs()
    spec = importlib.util.spec_from_file_location("hermes_live_dashboard_plugin_api", PLUGIN_API)
    if spec is None or spec.loader is None:
        raise AssertionError("failed to create Dashboard plugin API import spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _BrowserSocket:
    def __init__(self, received: list[dict[str, Any]] | None = None) -> None:
        self.received = list(received or [])
        self.accepted = False
        self.closed: list[int] = []
        self.sent: list[str] = []

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, *, code: int) -> None:
        self.closed.append(code)

    async def receive(self) -> dict[str, Any]:
        if self.received:
            return self.received.pop(0)
        await asyncio.Future()
        raise AssertionError("unreachable")

    async def send_text(self, message: str) -> None:
        self.sent.append(message)


class _Upstream:
    def __init__(self, messages: list[str] | None = None, *, block_after_messages: bool = False) -> None:
        self.messages = list(messages or [])
        self.block_after_messages = block_after_messages
        self.sent: list[str] = []

    async def send(self, message: str) -> None:
        self.sent.append(message)

    def __aiter__(self) -> AsyncIterator[str]:
        return self

    async def __anext__(self) -> str:
        if self.messages:
            return self.messages.pop(0)
        if self.block_after_messages:
            await asyncio.Future()
        raise StopAsyncIteration


class _ConnectContext:
    def __init__(self, upstream: _Upstream) -> None:
        self.upstream = upstream

    async def __aenter__(self) -> _Upstream:
        return self.upstream

    async def __aexit__(self, *_args: Any) -> None:
        return None


class _RedirectError(Exception):
    def __init__(self, location: str) -> None:
        super().__init__("redirect")
        self.location = location


class _RedirectingConnectContext:
    """Minimal model of websockets' credential-preserving redirect loop."""

    def __init__(
        self,
        url: str,
        options: dict[str, Any],
        attempts: list[tuple[str, dict[str, str] | None]],
    ) -> None:
        self.url = url
        self.options = options
        self.attempts = attempts

    def process_redirect(self, error: _RedirectError) -> Exception | str:
        return error.location

    async def __aenter__(self) -> _Upstream:
        outcome = self.process_redirect(_RedirectError("wss://attacker.example/v1/live"))
        if isinstance(outcome, str):
            self.attempts.append((outcome, self.options.get("additional_headers")))
            return _Upstream()
        raise outcome

    async def __aexit__(self, *_args: Any) -> None:
        return None


def _set_hermes_auth(*, auth: bool = True, request: bool = True, calls: list[str] | None = None) -> None:
    call_log = calls if calls is not None else []

    def auth_ok(_ws: Any) -> bool:
        call_log.append("auth")
        return auth

    def request_is_allowed(_ws: Any) -> bool:
        call_log.append("request")
        return request

    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli.web_server = types.SimpleNamespace(
        _ws_auth_ok=auth_ok,
        _ws_request_is_allowed=request_is_allowed,
    )
    sys.modules["hermes_cli"] = hermes_cli


def _set_websockets_connect(connect: Any) -> None:
    websockets = types.ModuleType("websockets")
    asyncio_module = types.ModuleType("websockets.asyncio")
    client = types.ModuleType("websockets.asyncio.client")
    client.connect = connect
    websockets.asyncio = asyncio_module
    asyncio_module.client = client
    sys.modules["websockets"] = websockets
    sys.modules["websockets.asyncio"] = asyncio_module
    sys.modules["websockets.asyncio.client"] = client


def test_url_and_payload_guards(plugin: Any) -> None:
    assert plugin._normalise_gateway_url("HTTPS://Voice.Example:9443/") == "https://voice.example:9443"
    assert plugin._normalise_gateway_url("http://[::1]:8788") == "http://[::1]:8788"
    assert plugin._gateway_websocket_url("https://voice.example") == "wss://voice.example/v1/live"

    invalid_urls = [
        "ws://voice.example",
        "http://user:secret@voice.example",
        "http://voice.example/base",
        "http://voice.example?token=secret",
        "http://voice.example/#fragment",
        "http://voice.example\\@attacker.example",
        "http://voice.example:99999",
        "http://voice.example\x01",
        "http://voice.example\x07",
        "http://" + ("x" * plugin.MAX_GATEWAY_URL_CHARS),
        "",
    ]
    for value in invalid_urls:
        try:
            plugin._normalise_gateway_url(value)
        except plugin.GatewayConfigurationError:
            continue
        raise AssertionError(f"unsafe gateway URL accepted: {value!r}")

    old_token = os.environ.get("HERMES_LIVE_AUTH_TOKEN")
    try:
        for token in ("unsafe\x01token", "unsafe\x07token", "x" * (plugin.MAX_TOKEN_BYTES + 1)):
            os.environ["HERMES_LIVE_AUTH_TOKEN"] = token
            try:
                plugin._gateway_token()
            except plugin.GatewayConfigurationError:
                continue
            raise AssertionError(f"unsafe gateway token accepted: {token!r}")
    finally:
        if old_token is None:
            os.environ.pop("HERMES_LIVE_AUTH_TOKEN", None)
        else:
            os.environ["HERMES_LIVE_AUTH_TOKEN"] = old_token

    assert plugin._is_bounded_json_message('{"type":"session.start","protocolVersion":3}')
    assert not plugin._is_bounded_json_message("[]")
    assert not plugin._is_bounded_json_message('{"type":"audio.input","data":NaN}')
    assert not plugin._is_bounded_json_message('{"notType":"session.start"}')
    assert not plugin._is_bounded_json_message('{"type":')


def test_capability_sanitizing(plugin: Any) -> None:
    protocol, provider, model, audio, tasks = plugin._capabilities_summary(
        {
            "protocolVersion": 3,
            "realtime": {
                "provider": "gemini",
                "model": "gemini-live-2.5-flash",
                "ignored": "must not escape",
                "audio": {
                    "input": {
                        "enabled": True,
                        "mimeType": "audio/pcm;rate=16000",
                        "recommendedFrameMs": 50,
                        "secret": "must not escape",
                    },
                    "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
                    "turnDetection": "provider",
                    "secret": "must not escape",
                },
            },
            "tasks": {
                "durable": True,
                "disconnectContinuation": True,
                "maxConcurrent": 3,
                "maxRetained": 200,
                "statePath": "/private/must-not-escape/tasks.json",
            },
            "secret": "must not escape",
        }
    )
    assert protocol == 3
    assert provider == "gemini"
    assert model == "gemini-live-2.5-flash"
    assert audio == {
        "input": {"enabled": True, "mimeType": "audio/pcm;rate=16000", "recommendedFrameMs": 50},
        "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
        "turnDetection": "provider",
    }
    assert "secret" not in json.dumps(audio)
    assert tasks == {
        "durable": True,
        "disconnectContinuation": True,
        "maxConcurrent": 3,
        "maxRetained": 200,
        "parallel": True,
    }
    assert "statePath" not in json.dumps(tasks)

    reflected = "configured-dashboard-bearer"
    protocol, provider, model, audio, tasks = plugin._capabilities_summary(
        {
            "protocolVersion": 3,
            "realtime": {
                "provider": f"provider-{reflected}-suffix",
                "model": f"prefix-{reflected}",
                "audio": {
                    "input": {"enabled": True, "mimeType": f"audio/{reflected};rate=16000"},
                    "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
                    "turnDetection": f"provider-{reflected}",
                },
            },
        },
        sensitive_values=(reflected,),
    )
    assert protocol == 3
    assert provider is None
    assert model is None
    assert audio == {
        "input": {"enabled": True},
        "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
    }
    assert reflected not in json.dumps(audio)
    assert tasks is None


def test_readiness_requires_every_check(plugin: Any) -> None:
    healthy = {
        "status": "ready",
        "checks": {"gateway": {"ok": True}, "hermes": {"ok": True}, "realtime": {"ok": True}},
    }
    assert plugin._readiness_is_ready(plugin._Probe(status=200, body=healthy))
    assert not plugin._readiness_is_ready(
        plugin._Probe(
            status=200,
            body={
                "status": "ready",
                "checks": {"gateway": {"ok": True}, "hermes": {"ok": False}, "realtime": {"ok": True}},
            },
        )
    )
    assert not plugin._readiness_is_ready(plugin._Probe(status=200, body={"status": "ready"}))
    assert not plugin._readiness_is_ready(plugin._Probe(status=503, body=healthy))


def test_capabilities_require_hermes_live_identity(plugin: Any) -> None:
    valid = {
        "object": "hermes_live.capabilities",
        "service": "hermes-live",
        "protocolVersion": 3,
    }
    assert plugin._capabilities_identity_is_valid(plugin._Probe(status=200, body=valid))
    for changed in (
        {"object": "other.capabilities"},
        {"service": "other-service"},
        {"protocolVersion": 0},
        {"protocolVersion": 1_001},
        {"protocolVersion": True},
        {"protocolVersion": "3"},
    ):
        assert not plugin._capabilities_identity_is_valid(plugin._Probe(status=200, body={**valid, **changed}))
    assert not plugin._capabilities_identity_is_valid(plugin._Probe(status=503, body=valid))
    assert not plugin._capabilities_identity_is_valid(plugin._Probe(status=200, body=valid, error="invalid_json"))


def test_auth_order_and_fail_closed(plugin: Any) -> None:
    calls: list[str] = []
    _set_hermes_auth(calls=calls)
    assert plugin._dashboard_ws_rejection_code(object()) is None
    assert calls == ["auth", "request"]

    calls.clear()
    _set_hermes_auth(auth=False, calls=calls)
    assert plugin._dashboard_ws_rejection_code(object()) == 4401
    assert calls == ["auth"]

    calls.clear()
    _set_hermes_auth(request=False, calls=calls)
    assert plugin._dashboard_ws_rejection_code(object()) == 4403
    assert calls == ["auth", "request"]

    sys.modules["hermes_cli"] = types.ModuleType("hermes_cli")
    logging_disabled = plugin.log.disabled
    plugin.log.disabled = True
    try:
        assert plugin._dashboard_ws_rejection_code(object()) == 4403
    finally:
        plugin.log.disabled = logging_disabled


async def test_status(plugin: Any) -> None:
    original_fetch = plugin._fetch_json
    calls: list[tuple[str, dict[str, str] | None]] = []
    wrong_service = False

    async def fake_fetch(_client: Any, url: str, headers: dict[str, str] | None = None) -> Any:
        calls.append((url, headers))
        if url.endswith("/health"):
            return plugin._Probe(status=200, body={"status": "ok"})
        if url.endswith("/v1/capabilities"):
            return plugin._Probe(
                status=200,
                body={
                    "object": "hermes_live.capabilities",
                    "service": "wrong-service" if wrong_service else "hermes-live",
                    "protocolVersion": 3,
                    "realtime": {
                        "provider": "gemini",
                        "model": "gemini-live",
                        "audio": {
                            "input": {"enabled": True, "mimeType": "audio/pcm;rate=16000"},
                            "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
                            "turnDetection": "provider",
                        },
                    },
                    "tasks": {
                        "durable": True,
                        "disconnectContinuation": True,
                        "maxConcurrent": 3,
                        "maxRetained": 200,
                        "stateFile": "/private/tasks.json",
                    },
                },
            )
        return plugin._Probe(
            status=200,
            body={
                "status": "ready",
                "checks": {"gateway": {"ok": True}, "hermes": {"ok": True}, "realtime": {"ok": True}},
            },
        )

    plugin._fetch_json = fake_fetch
    old_url = os.environ.get("HERMES_LIVE_URL")
    old_token = os.environ.get("HERMES_LIVE_AUTH_TOKEN")
    os.environ["HERMES_LIVE_URL"] = "https://voice.example:9443"
    os.environ["HERMES_LIVE_AUTH_TOKEN"] = "dashboard-gateway-secret"
    try:
        status = await plugin.gateway_status()
        wrong_service = True
        wrong_service_status = await plugin.gateway_status()
    finally:
        plugin._fetch_json = original_fetch
        if old_url is None:
            os.environ.pop("HERMES_LIVE_URL", None)
        else:
            os.environ["HERMES_LIVE_URL"] = old_url
        if old_token is None:
            os.environ.pop("HERMES_LIVE_AUTH_TOKEN", None)
        else:
            os.environ["HERMES_LIVE_AUTH_TOKEN"] = old_token

    assert status == {
        "configured": True,
        "reachable": True,
        "ready": True,
        "gateway": {"mode": "server-proxied"},
        "protocolVersion": 3,
        "provider": "gemini",
        "model": "gemini-live",
        "audio": {
            "input": {"enabled": True, "mimeType": "audio/pcm;rate=16000"},
            "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
            "turnDetection": "provider",
        },
        "tasks": {
            "durable": True,
            "disconnectContinuation": True,
            "maxConcurrent": 3,
            "maxRetained": 200,
            "parallel": True,
        },
        "error": None,
    }
    assert calls[0][1] is None
    assert calls[1][1] == {"Authorization": "Bearer dashboard-gateway-secret"}
    assert calls[2][1] == {"Authorization": "Bearer dashboard-gateway-secret"}
    assert "dashboard-gateway-secret" not in json.dumps(status)
    assert wrong_service_status == {
        "configured": True,
        "reachable": True,
        "ready": False,
        "gateway": {"mode": "server-proxied"},
        "protocolVersion": None,
        "provider": None,
        "model": None,
        "audio": None,
        "tasks": None,
        "error": "capabilities_unavailable",
    }


async def test_status_suppresses_reflected_bearer_and_failed_readiness(plugin: Any) -> None:
    original_fetch = plugin._fetch_json
    secret = "dashboard-reflection-secret"

    async def fake_fetch(_client: Any, url: str, headers: dict[str, str] | None = None) -> Any:
        del headers
        if url.endswith("/health"):
            return plugin._Probe(status=200, body={"status": "ok"})
        if url.endswith("/v1/capabilities"):
            return plugin._Probe(
                status=200,
                body={
                    "object": "hermes_live.capabilities",
                    "service": "hermes-live",
                    "protocolVersion": 3,
                    "realtime": {
                        "provider": "openai",
                        "model": f"prefix-{secret}-suffix",
                        "audio": {
                            "input": {"enabled": True, "mimeType": f"audio/{secret}"},
                            "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
                            "turnDetection": f"provider-{secret}",
                        },
                    },
                },
            )
        return plugin._Probe(
            status=200,
            body={
                "status": "ready",
                "checks": {"gateway": {"ok": True}, "hermes": {"ok": False}, "realtime": {"ok": True}},
            },
        )

    plugin._fetch_json = fake_fetch
    old_url = os.environ.get("HERMES_LIVE_URL")
    old_token = os.environ.get("HERMES_LIVE_AUTH_TOKEN")
    os.environ["HERMES_LIVE_URL"] = "https://voice.example:9443"
    os.environ["HERMES_LIVE_AUTH_TOKEN"] = secret
    try:
        status = await plugin.gateway_status()
    finally:
        plugin._fetch_json = original_fetch
        if old_url is None:
            os.environ.pop("HERMES_LIVE_URL", None)
        else:
            os.environ["HERMES_LIVE_URL"] = old_url
        if old_token is None:
            os.environ.pop("HERMES_LIVE_AUTH_TOKEN", None)
        else:
            os.environ["HERMES_LIVE_AUTH_TOKEN"] = old_token

    assert status == {
        "configured": True,
        "reachable": True,
        "ready": False,
        "gateway": {"mode": "server-proxied"},
        "protocolVersion": 3,
        "provider": "openai",
        "model": None,
        "audio": {
            "input": {"enabled": True},
            "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
        },
        "tasks": None,
        "error": "gateway_not_ready",
    }
    assert secret not in json.dumps(status)


async def test_status_fetch_requires_json_media_type(plugin: Any) -> None:
    good = await plugin._fetch_json(
        _StreamClient(
            _StreamResponse(
                status=200,
                content_type="application/json; charset=utf-8",
                body=b'{"status":"ok"}',
            )
        ),
        "http://gateway.test/health",
    )
    assert good == plugin._Probe(status=200, body={"status": "ok"})

    problem_json = await plugin._fetch_json(
        _StreamClient(
            _StreamResponse(
                status=503,
                content_type="application/problem+json",
                body=b'{"status":"not_ready"}',
            )
        ),
        "http://gateway.test/ready",
    )
    assert problem_json == plugin._Probe(status=503, body={"status": "not_ready"})

    for content_type in ("text/plain", None):
        rejected = await plugin._fetch_json(
            _StreamClient(
                _StreamResponse(
                    status=200,
                    content_type=content_type,
                    body=b'{"status":"ok"}',
                )
            ),
            "http://gateway.test/health",
        )
        assert rejected == plugin._Probe(status=200, error="invalid_content_type")

    non_standard = await plugin._fetch_json(
        _StreamClient(
            _StreamResponse(
                status=200,
                content_type="application/json",
                body=b'{"status":"ok","value":NaN}',
            )
        ),
        "http://gateway.test/health",
    )
    assert non_standard == plugin._Probe(status=200, error="invalid_json")


async def test_relay_and_route(plugin: Any) -> None:
    browser = _BrowserSocket(
        [
            {"type": "websocket.receive", "text": '{"type":"session.start","protocolVersion":3}'},
            {"type": "websocket.disconnect"},
        ]
    )
    upstream = _Upstream(block_after_messages=True)
    captured: dict[str, Any] = {}

    def connect(url: str, **options: Any) -> _ConnectContext:
        captured["url"] = url
        captured["options"] = options
        return _ConnectContext(upstream)

    _set_hermes_auth()
    _set_websockets_connect(connect)
    old_url = os.environ.get("HERMES_LIVE_URL")
    old_token = os.environ.get("HERMES_LIVE_AUTH_TOKEN")
    os.environ["HERMES_LIVE_URL"] = "https://voice.example:9443"
    os.environ["HERMES_LIVE_AUTH_TOKEN"] = "server-owned-secret"
    try:
        await plugin.live_websocket(browser)
    finally:
        if old_url is None:
            os.environ.pop("HERMES_LIVE_URL", None)
        else:
            os.environ["HERMES_LIVE_URL"] = old_url
        if old_token is None:
            os.environ.pop("HERMES_LIVE_AUTH_TOKEN", None)
        else:
            os.environ["HERMES_LIVE_AUTH_TOKEN"] = old_token

    assert browser.accepted
    assert browser.closed == [1000]
    assert browser.sent == []
    assert upstream.sent == ['{"type":"session.start","protocolVersion":3}']
    assert captured["url"] == "wss://voice.example:9443/v1/live"
    assert captured["options"]["proxy"] is None
    assert captured["options"]["max_size"] == plugin.MAX_MESSAGE_BYTES
    assert captured["options"]["logger"].disabled
    assert captured["options"]["additional_headers"] == {"Authorization": "Bearer server-owned-secret"}

    browser = _BrowserSocket()
    upstream = _Upstream(['{"type":"session.ready","protocolVersion":3}'])
    await plugin._relay_gateway_to_browser(upstream, browser)
    assert browser.sent == ['{"type":"session.ready","protocolVersion":3}']

    browser = _BrowserSocket([{"type": "websocket.receive", "bytes": b"binary"}])
    try:
        await plugin._relay_browser_to_gateway(browser, _Upstream())
    except plugin._RelayProtocolError as exc:
        assert exc.source == "browser"
    else:
        raise AssertionError("binary browser frame was accepted")


async def test_upstream_redirect_cannot_replay_bearer(plugin: Any) -> None:
    browser = _BrowserSocket()
    attempts: list[tuple[str, dict[str, str] | None]] = []

    def connect(url: str, **options: Any) -> _RedirectingConnectContext:
        attempts.append((url, options.get("additional_headers")))
        return _RedirectingConnectContext(url, options, attempts)

    _set_hermes_auth()
    _set_websockets_connect(connect)
    old_url = os.environ.get("HERMES_LIVE_URL")
    old_token = os.environ.get("HERMES_LIVE_AUTH_TOKEN")
    old_log_disabled = plugin.log.disabled
    os.environ["HERMES_LIVE_URL"] = "https://voice.example:9443"
    os.environ["HERMES_LIVE_AUTH_TOKEN"] = "redirect-sensitive-secret"
    plugin.log.disabled = True
    try:
        await plugin.live_websocket(browser)
    finally:
        plugin.log.disabled = old_log_disabled
        if old_url is None:
            os.environ.pop("HERMES_LIVE_URL", None)
        else:
            os.environ["HERMES_LIVE_URL"] = old_url
        if old_token is None:
            os.environ.pop("HERMES_LIVE_AUTH_TOKEN", None)
        else:
            os.environ["HERMES_LIVE_AUTH_TOKEN"] = old_token

    assert attempts == [
        (
            "wss://voice.example:9443/v1/live",
            {"Authorization": "Bearer redirect-sensitive-secret"},
        )
    ]
    assert browser.accepted
    assert browser.closed == [1013]
    assert len(browser.sent) == 1
    assert json.loads(browser.sent[0]) == {
        "type": "session.error",
        "code": "gateway_unavailable",
        "message": "The Live Voice gateway is unavailable.",
        "recoverable": False,
    }
    assert "redirect-sensitive-secret" not in browser.sent[0]


async def main() -> None:
    plugin = _load_plugin_api()
    test_url_and_payload_guards(plugin)
    test_capability_sanitizing(plugin)
    test_readiness_requires_every_check(plugin)
    test_capabilities_require_hermes_live_identity(plugin)
    test_auth_order_and_fail_closed(plugin)
    await test_status(plugin)
    await test_status_suppresses_reflected_bearer_and_failed_readiness(plugin)
    await test_status_fetch_requires_json_media_type(plugin)
    await test_relay_and_route(plugin)
    await test_upstream_redirect_cannot_replay_bearer(plugin)
    print("Dashboard plugin smoke ok: config, status, auth, bearer proxy, bounds, and relay verified")


if __name__ == "__main__":
    asyncio.run(main())
