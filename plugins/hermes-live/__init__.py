"""Hermes plugin metadata for hermes-live.

The realtime gateway runs as a companion runtime. This plugin gives Hermes
installations a discoverable description of that gateway without embedding a
public WebSocket/audio server inside Hermes core.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from os import getenv
from typing import Any


@dataclass(frozen=True)
class HermesLiveGateway:
    name: str = "hermes-live"
    mode: str = "gateway"
    url: str = getenv("HERMES_LIVE_URL", "http://127.0.0.1:8788")
    websocket_path: str = "/v1/live"
    capabilities_path: str = "/v1/capabilities"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def get_gateway_info() -> dict[str, Any]:
    return HermesLiveGateway().as_dict()
