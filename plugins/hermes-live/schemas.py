"""Tool schemas exposed by the hermes-live Hermes plugin."""

HERMES_LIVE_STATUS = {
    "name": "hermes_live_status",
    "description": (
        "Inspect the configured hermes-live realtime voice gateway. Use this "
        "when the user asks whether realtime voice is installed, where the "
        "gateway is listening, or whether the gateway is ready."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "probe": {
                "type": "boolean",
                "description": "Whether to make HTTP requests to the gateway. Defaults to true.",
            },
            "include_readiness": {
                "type": "boolean",
                "description": "Whether to call /ready in addition to /health and /v1/capabilities.",
            },
            "timeout_ms": {
                "type": "integer",
                "minimum": 100,
                "maximum": 10000,
                "description": "HTTP probe timeout in milliseconds. Defaults to 2000.",
            },
        },
    },
}
