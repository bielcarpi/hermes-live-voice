"""Hermes plugin metadata for hermes-live.

The realtime gateway runs as a companion runtime. This plugin gives Hermes
installations a discoverable description of that gateway without embedding a
public WebSocket/audio server inside Hermes core.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from . import schemas, tools


@dataclass(frozen=True)
class HermesLiveGateway:
    name: str = "hermes-live"
    mode: str = "gateway"
    url: str = ""
    websocket_path: str = "/v1/live"
    capabilities_path: str = "/v1/capabilities"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def get_gateway_info() -> dict[str, Any]:
    return HermesLiveGateway(url=_gateway_url()).as_dict()


def register(ctx: Any) -> None:
    """Register hermes-live discovery tools with Hermes."""
    ctx.register_tool(
        name="hermes_live_status",
        toolset="hermes-live",
        schema=schemas.HERMES_LIVE_STATUS,
        handler=tools.gateway_status,
        description="Inspect the configured hermes-live realtime voice gateway.",
    )

    if hasattr(ctx, "register_command"):
        ctx.register_command(
            "hermes-live",
            _slash_command,
            description="Show hermes-live gateway status and connection details.",
        )


def _slash_command(raw_args: str = "") -> str:
    include_readiness = "ready" in raw_args.split()
    return tools.gateway_status({"include_readiness": include_readiness})


def _gateway_url() -> str:
    return tools.configured_gateway_url()
