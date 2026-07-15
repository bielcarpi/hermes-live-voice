#!/usr/bin/env python3
"""Validate the packaged Hermes plugin without requiring Hermes itself."""

from __future__ import annotations

import importlib.util
import json
import py_compile
import re
import sys
from pathlib import Path
from typing import Any

from plugin_tools_smoke import run_status_probe_smoke


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT / "plugins" / "hermes-live"
DASHBOARD_DIR = PLUGIN_DIR / "dashboard"


class FakeHermesPluginContext:
    def __init__(self) -> None:
        self.tools: list[dict[str, Any]] = []
        self.commands: list[dict[str, Any]] = []

    def register_tool(self, **kwargs: Any) -> None:
        self.tools.append(kwargs)

    def register_command(self, name: str, handler: Any, description: str = "") -> None:
        self.commands.append({"name": name, "handler": handler, "description": description})


def main() -> None:
    for path in [
        PLUGIN_DIR / "__init__.py",
        PLUGIN_DIR / "schemas.py",
        PLUGIN_DIR / "tools.py",
        DASHBOARD_DIR / "plugin_api.py",
    ]:
        py_compile.compile(str(path), doraise=True)

    plugin = load_plugin()
    ctx = FakeHermesPluginContext()
    plugin.register(ctx)

    tool = one(ctx.tools, "tool")
    assert_equal(tool["name"], "hermes_live_status", "registered tool name")
    assert_equal(tool["toolset"], "hermes-live", "registered toolset")
    assert_equal(tool["schema"]["name"], "hermes_live_status", "tool schema name")

    payload = json.loads(tool["handler"]({"probe": False}))
    assert_equal(payload["success"], True, "non-probing status success")
    assert_equal(payload["probed"], False, "non-probing status probe flag")
    assert_equal(payload["gateway"]["websocket_path"], "/v1/live", "gateway websocket path")
    if "HERMES_LIVE_AUTH_TOKEN" in json.dumps(payload):
        raise AssertionError("gateway status payload must not leak env var names or secrets")

    command = one(ctx.commands, "command")
    assert_equal(command["name"], "hermes-live", "registered slash command")

    run_status_probe_smoke(plugin.tools)

    manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    for expected in [
        "name: hermes-live",
        "kind: standalone",
        "provides_tools:",
        "- hermes_live_status",
        "provides_commands:",
        "- hermes-live",
    ]:
        if expected not in manifest:
            raise AssertionError(f"plugin.yaml missing {expected!r}")

    version_match = re.search(r"^version:\s*([^\s#]+)", manifest, re.MULTILINE)
    if version_match is None:
        raise AssertionError("plugin.yaml is missing a version")
    assert_equal(version_match.group(1), package["version"], "plugin/package version")

    dashboard_manifest = json.loads((DASHBOARD_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert_equal(dashboard_manifest["name"], "hermes-live", "dashboard plugin name")
    assert_equal(dashboard_manifest["version"], package["version"], "dashboard/package version")
    assert_equal(dashboard_manifest["tab"]["path"], "/live-voice", "dashboard tab path")
    assert_equal(dashboard_manifest["entry"], "dist/index.js", "dashboard entry")
    assert_equal(dashboard_manifest["css"], "dist/style.css", "dashboard CSS")
    assert_equal(dashboard_manifest["api"], "plugin_api.py", "dashboard API")

    canonical_assets = {
        ROOT / "clients" / "browser" / "hermes-live-client.js": DASHBOARD_DIR / "dist" / "hermes-live-client.js",
        ROOT / "clients" / "browser" / "mic-worklet.js": DASHBOARD_DIR / "dist" / "mic-worklet.js",
    }
    for source, copy in canonical_assets.items():
        if source.read_bytes() != copy.read_bytes():
            raise AssertionError(f"dashboard asset is stale: {copy.relative_to(ROOT)}")

    static_assets = [
        DASHBOARD_DIR / "dist" / "index.js",
        DASHBOARD_DIR / "dist" / "style.css",
        *canonical_assets.values(),
    ]
    forbidden_secret_markers = [
        "__HERMES_SESSION_TOKEN__",
        "HERMES_LIVE_AUTH_TOKEN",
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "HERMES_AGENT_API_SERVER_KEY",
    ]
    for path in static_assets:
        source = path.read_text(encoding="utf-8")
        found = [marker for marker in forbidden_secret_markers if marker in source]
        if found:
            raise AssertionError(f"dashboard static asset {path.relative_to(ROOT)} contains secret marker(s): {found}")

    print(
        "Plugin smoke ok: Hermes and Dashboard manifests, register(ctx), API syntax, synced assets, "
        "tool handler security probes, and slash command verified"
    )


def load_plugin() -> Any:
    spec = importlib.util.spec_from_file_location(
        "hermes_live_plugin",
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    if spec is None or spec.loader is None:
        raise AssertionError("failed to create plugin import spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def one(values: list[Any], label: str) -> Any:
    if len(values) != 1:
        raise AssertionError(f"expected exactly one registered {label}, got {len(values)}")
    return values[0]


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


if __name__ == "__main__":
    main()
