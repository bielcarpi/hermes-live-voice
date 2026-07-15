"""Security-focused smoke coverage for the Hermes plugin gateway probe."""

from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator
from unittest.mock import patch


Route = tuple[int, dict[str, str], bytes]


def run_status_probe_smoke(tools: Any) -> None:
    """Exercise URL validation, redirect policy, auth boundaries, and output bounds."""
    _check_gateway_origin_validation(tools)
    _check_auth_token_validation(tools)
    _check_probe_sanitization_and_auth(tools)
    _check_token_reflection_and_control_suppression(tools)
    _check_protocol_version_bounds(tools)
    _check_redirects_are_not_followed(tools)
    _check_response_limits_and_media_type(tools)
    _check_http_error_sanitization(tools)


def _check_gateway_origin_validation(tools: Any) -> None:
    valid = {
        "http://127.0.0.1:8788": "http://127.0.0.1:8788",
        "https://gateway.example.test/": "https://gateway.example.test",
        "http://[::1]:8788/": "http://[::1]:8788",
    }
    for configured, expected in valid.items():
        with patch.dict(os.environ, {"HERMES_LIVE_URL": configured}, clear=False):
            assert_equal(tools.configured_gateway_url(), expected, f"valid origin {configured}")

    invalid = [
        "ftp://gateway.example.test",
        "http://user:embedded-secret@gateway.example.test",
        "http://gateway.example.test/private",
        "http://gateway.example.test?token=embedded-secret",
        "http://gateway.example.test?",
        "http://gateway.example.test#fragment",
        "http://gateway.example.test#",
        " http://gateway.example.test",
        "http://gateway.example.test ",
        "http://gateway.example.test\\@attacker.example",
        "http://",
        "http://gateway.example.test:99999",
        "//gateway.example.test",
        "data:application/json,{}",
    ]
    for configured in invalid:
        with patch.dict(os.environ, {"HERMES_LIVE_URL": configured}, clear=False):
            payload_text = tools.gateway_status({"probe": False})
            payload = json.loads(payload_text)
        assert_equal(payload["success"], False, f"invalid origin rejected: {configured}")
        assert_equal(payload["probed"], False, f"invalid origin not probed: {configured}")
        assert_equal(payload["error"]["code"], "invalid_gateway_url", "safe URL error code")
        if configured in payload_text or "embedded-secret" in payload_text:
            raise AssertionError("invalid configured URL or embedded credential leaked into tool output")
        if len(payload_text) > tools.MAX_OUTPUT_CHARS:
            raise AssertionError("invalid URL response exceeded the tool output limit")


def _check_auth_token_validation(tools: Any) -> None:
    invalid_tokens = [
        "embedded secret",
        "embedded\nsecret",
        "embedded\rsecret",
        "x" * (tools.MAX_AUTH_TOKEN_BYTES + 1),
    ]
    for token in invalid_tokens:
        with patch.dict(
            os.environ,
            {"HERMES_LIVE_URL": tools.DEFAULT_GATEWAY_URL, "HERMES_LIVE_AUTH_TOKEN": token},
            clear=False,
        ):
            payload_text = tools.gateway_status({"probe": False})
            payload = json.loads(payload_text)
        assert_equal(payload["success"], False, "unsafe auth token rejected")
        assert_equal(payload["probed"], False, "unsafe auth token not used")
        assert_equal(payload["error"]["code"], "invalid_auth_token", "safe auth token error code")
        if token in payload_text:
            raise AssertionError("invalid auth token leaked into tool output")


def _check_probe_sanitization_and_auth(tools: Any) -> None:
    secret = "probe-bearer-secret"
    reflected_secret = "server-reflected-secret"
    routes: dict[str, Route] = {
        "/health": json_route(
            200,
            {
                "status": "ok",
                "service": "hermes-live",
                "secret": reflected_secret,
                "unknown": {"nested": [reflected_secret]},
            },
        ),
        "/v1/capabilities": json_route(
            200,
            {
                "object": "hermes_live.capabilities",
                "service": "hermes-live",
                "protocolVersion": 3,
                "websocket": {"path": "/v1/live", "protocol": "json-base64-audio", "secret": reflected_secret},
                "realtime": {
                    "provider": "openai",
                    "model": "gpt-realtime-2.1",
                    "audio": {
                        "input": {"enabled": True, "mimeType": "audio/pcm;rate=24000", "secret": reflected_secret},
                        "output": {"enabled": True, "mimeType": "audio/pcm;rate=24000"},
                        "turnDetection": "disabled",
                    },
                    "apiKey": reflected_secret,
                },
                "tasks": {
                    "scope": "owner",
                    "durable": True,
                    "persistence": "local_file",
                    "disconnectContinuation": True,
                    "gatewayRestartRecovery": "reconcile_by_upstream_run_id",
                    "hermesRestartRecovery": False,
                    "ambiguousDispatch": "fenced_no_automatic_retry",
                    "maxConcurrent": 3,
                    "maxQueued": 32,
                    "maxRetained": 200,
                    "retentionMs": 604800000,
                    "pollIntervalMs": 1000,
                    "statePath": f"/private/{reflected_secret}/tasks.json",
                },
                "features": {
                    "background_tasks": True,
                    "durable_task_state": True,
                    "task_reconnect_snapshot": True,
                    "parallel_read_only_tasks": True,
                    "exact_task_stop": True,
                    "task_notifications": True,
                    "hermes_runs": True,
                    "run_event_detail": "full",
                    "max_sessions": 4,
                    "unknown_secret": reflected_secret,
                },
                "secret": reflected_secret,
            },
        ),
        "/ready": json_route(
            200,
            {
                "status": "ready",
                "checks": {
                    "gateway": {
                        "ok": True,
                        "port": 8788,
                        "authRequired": True,
                        "tasks": {
                            "durable": True,
                            "maxConcurrent": 3,
                            "maxQueued": 32,
                            "maxRetained": 200,
                            "retentionMs": 604800000,
                            "pollIntervalMs": 1000,
                            "stateFile": f"/private/{reflected_secret}/tasks.json",
                        },
                        "runEventDetail": "full",
                        "secret": reflected_secret,
                    },
                    "hermes": {
                        "ok": True,
                        "model": "hermes-agent",
                        "baseUrl": f"http://user:{reflected_secret}@internal.example",
                        "error": reflected_secret,
                    },
                    "realtime": {
                        "ok": True,
                        "configured": True,
                        "provider": "openai",
                        "model": "gpt-realtime-2.1",
                        "baseUrl": f"https://{reflected_secret}@api.example",
                    },
                    "unknown": {"secret": reflected_secret},
                },
                "secret": reflected_secret,
            },
        ),
    }
    with gateway_server(routes) as server:
        with patch.dict(
            os.environ,
            {"HERMES_LIVE_URL": server.url, "HERMES_LIVE_AUTH_TOKEN": secret},
            clear=False,
        ):
            payload_text = tools.gateway_status({"include_readiness": True})
            payload = json.loads(payload_text)

    assert_equal(payload["success"], True, "sanitized gateway probe succeeds")
    assert_equal(payload["checks"]["health"]["body"]["service"], "hermes-live", "health allowlist")
    assert_equal(
        payload["checks"]["capabilities"]["body"]["realtime"]["provider"],
        "openai",
        "capability allowlist",
    )
    capabilities = payload["checks"]["capabilities"]["body"]
    assert_equal(
        capabilities["tasks"],
        {
            "durable": True,
            "disconnectContinuation": True,
            "hermesRestartRecovery": False,
            "scope": "owner",
            "persistence": "local_file",
            "gatewayRestartRecovery": "reconcile_by_upstream_run_id",
            "ambiguousDispatch": "fenced_no_automatic_retry",
            "maxConcurrent": 3,
            "maxQueued": 32,
            "maxRetained": 200,
            "retentionMs": 604800000,
            "pollIntervalMs": 1000,
        },
        "public task capability allowlist",
    )
    assert_equal(
        capabilities["features"],
        {
            "background_tasks": True,
            "durable_task_state": True,
            "task_reconnect_snapshot": True,
            "parallel_read_only_tasks": True,
            "exact_task_stop": True,
            "task_notifications": True,
            "max_sessions": 4,
        },
        "task feature allowlist",
    )
    assert_equal(payload["checks"]["ready"]["body"]["checks"]["hermes"]["ok"], True, "readiness allowlist")
    assert_equal(
        payload["checks"]["ready"]["body"]["checks"]["gateway"]["tasks"],
        {
            "durable": True,
            "maxConcurrent": 3,
            "maxQueued": 32,
            "maxRetained": 200,
            "retentionMs": 604800000,
            "pollIntervalMs": 1000,
        },
        "readiness task allowlist excludes state paths",
    )
    if secret in payload_text or reflected_secret in payload_text:
        raise AssertionError("probe output exposed a bearer or non-allowlisted upstream value")
    if len(payload_text) > tools.MAX_OUTPUT_CHARS:
        raise AssertionError("probe response exceeded the tool output limit")

    request_headers = {path: headers for path, headers in server.requests}
    if request_headers["/health"].get("authorization") is not None:
        raise AssertionError("public health probe must not receive the gateway bearer")
    for path in ("/v1/capabilities", "/ready"):
        assert_equal(request_headers[path].get("authorization"), f"Bearer {secret}", f"auth header for {path}")


def _check_redirects_are_not_followed(tools: Any) -> None:
    routes: dict[str, Route] = {
        "/health": (302, {"location": "/redirect-target", "content-type": "application/json"}, b"{}"),
        "/redirect-target": json_route(200, {"status": "ok", "service": "unexpected-target"}),
    }
    with gateway_server(routes) as server:
        result = tools._get_json(server.url, "/health", "must-not-be-forwarded", 1.0)

    assert_equal(result, {"ok": False, "status": 302, "error": "redirect_not_allowed"}, "redirect result")
    requested_paths = [path for path, _headers in server.requests]
    assert_equal(requested_paths, ["/health"], "redirect target was not requested")


def _check_protocol_version_bounds(tools: Any) -> None:
    base = {
        "object": "hermes_live.capabilities",
        "service": "hermes-live",
    }
    for protocol_version in (1, 2, 1_000):
        assert_equal(
            tools._expected_success_shape(
                "/v1/capabilities",
                {**base, "protocolVersion": protocol_version},
            ),
            True,
            f"valid protocol version {protocol_version}",
        )
    for protocol_version in (-1, 0, 1_001, True, "2"):
        assert_equal(
            tools._expected_success_shape(
                "/v1/capabilities",
                {**base, "protocolVersion": protocol_version},
            ),
            False,
            f"invalid protocol version {protocol_version!r}",
        )


def _check_token_reflection_and_control_suppression(tools: Any) -> None:
    secret = "exact-bearer-to-redact"
    routes: dict[str, Route] = {
        "/health": json_route(200, {"status": "ok", "service": "hermes-live"}),
        "/v1/capabilities": json_route(
            200,
            {
                "object": "hermes_live.capabilities",
                "service": "hermes-live",
                "protocolVersion": 3,
                "websocket": {"path": "/v1/live", "protocol": "json\ncontrol"},
                "realtime": {
                    "provider": "openai",
                    "model": f"prefix-{secret}-suffix",
                    "audio": {"turnDetection": "disabled\u0000control"},
                },
            },
        ),
    }
    with gateway_server(routes) as server:
        with patch.dict(
            os.environ,
            {"HERMES_LIVE_URL": server.url, "HERMES_LIVE_AUTH_TOKEN": secret},
            clear=False,
        ):
            payload_text = tools.gateway_status({})
            payload = json.loads(payload_text)

    assert_equal(payload["success"], True, "optional reflected fields do not invalidate the endpoint")
    realtime = payload["checks"]["capabilities"]["body"]["realtime"]
    assert_equal(realtime, {"provider": "openai"}, "bearer-bearing and control-bearing strings omitted")
    websocket = payload["checks"]["capabilities"]["body"]["websocket"]
    assert_equal(websocket, {"path": "/v1/live"}, "control-bearing protocol omitted")
    if secret in payload_text or "\\n" in payload_text or "\\u0000" in payload_text:
        raise AssertionError("probe output exposed a reflected bearer or control-bearing string")


def _check_response_limits_and_media_type(tools: Any) -> None:
    oversized = b'{"status":"ok","padding":"' + (b"x" * tools.MAX_RESPONSE_BYTES) + b'"}'
    routes: dict[str, Route] = {
        "/health": (200, {"content-type": "application/json"}, oversized),
        "/plain": (200, {"content-type": "text/plain"}, b'{"status":"ok"}'),
        "/invalid": (200, {"content-type": "application/json"}, b"not-json"),
        "/non-standard": (200, {"content-type": "application/json"}, b'{"status":"ok","value":NaN}'),
        "/unexpected": json_route(200, {"service": "hermes-live"}),
        "/ready": json_route(
            200,
            {
                "status": "ready",
                "checks": {"gateway": {"ok": True}, "hermes": {"ok": False}, "realtime": {"ok": True}},
            },
        ),
    }
    with gateway_server(routes) as server:
        too_large = tools._get_json(server.url, "/health", None, 1.0)
        invalid_type = tools._get_json(server.url, "/plain", None, 1.0)
        invalid_json = tools._get_json(server.url, "/invalid", None, 1.0)
        non_standard = tools._get_json(server.url, "/non-standard", None, 1.0)
        unexpected = tools._get_json(server.url, "/unexpected", None, 1.0)
        not_ready = tools._get_json(server.url, "/ready", None, 1.0)

    assert_equal(too_large["error"], "response_too_large", "response byte cap")
    assert_equal(invalid_type["error"], "invalid_content_type", "JSON media type requirement")
    assert_equal(invalid_json["error"], "invalid_json", "invalid JSON handling")
    assert_equal(non_standard["error"], "invalid_json", "non-standard JSON constant handling")
    assert_equal(unexpected["error"], "unexpected_response", "endpoint schema check")
    assert_equal(not_ready["error"], "unexpected_response", "200 ready response with a failed check rejected")


def _check_http_error_sanitization(tools: Any) -> None:
    reflected_secret = "error-body-secret"
    routes = {
        "/v1/capabilities": json_route(401, {"status": "unauthorized", "secret": reflected_secret}),
    }
    with gateway_server(routes) as server:
        result = tools._get_json(server.url, "/v1/capabilities", "wrong-token", 1.0)
    serialized = json.dumps(result)

    assert_equal(result["ok"], False, "HTTP error result")
    assert_equal(result["status"], 401, "HTTP error status")
    assert_equal(result["body"], {"status": "unauthorized"}, "HTTP error body allowlist")
    if reflected_secret in serialized or "wrong-token" in serialized:
        raise AssertionError("HTTP error probe exposed a response secret or bearer")


class GatewayServer:
    def __init__(self, server: ThreadingHTTPServer, requests: list[tuple[str, dict[str, str]]]) -> None:
        self._server = server
        self.requests = requests
        host, port = server.server_address[:2]
        self.url = f"http://{host}:{port}"


@contextmanager
def gateway_server(routes: dict[str, Route]) -> Iterator[GatewayServer]:
    requests: list[tuple[str, dict[str, str]]] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            requests.append((self.path, {name.lower(): value for name, value in self.headers.items()}))
            status, headers, body = routes.get(
                self.path,
                json_route(404, {"status": "not_found"}),
            )
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(body)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    wrapped = GatewayServer(server, requests)
    try:
        yield wrapped
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def json_route(status: int, value: Any) -> Route:
    return status, {"content-type": "application/json; charset=utf-8"}, json.dumps(value).encode("utf-8")


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")
