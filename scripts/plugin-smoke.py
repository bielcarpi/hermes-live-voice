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


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT / "plugins" / "hermes-live"


class FakeHermesPluginContext:
    def __init__(self) -> None:
        self.tools: list[dict[str, Any]] = []
        self.commands: list[dict[str, Any]] = []

    def register_tool(self, **kwargs: Any) -> None:
        self.tools.append(kwargs)

    def register_command(self, name: str, handler: Any, description: str = "") -> None:
        self.commands.append({"name": name, "handler": handler, "description": description})


def main() -> None:
    for path in [PLUGIN_DIR / "__init__.py", PLUGIN_DIR / "schemas.py", PLUGIN_DIR / "tools.py"]:
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

    print("Plugin smoke ok: manifest, register(ctx), tool handler, and slash command verified")


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
