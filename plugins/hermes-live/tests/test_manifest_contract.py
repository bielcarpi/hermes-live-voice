from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def test_manifest_declares_gateway_review_surface() -> None:
    manifest = (PLUGIN_ROOT / "plugin.yaml").read_text(encoding="utf-8")

    for expected in [
        "name: hermes-live",
        "manifest_version: 2",
        "api_version: 1",
        "label: Hermes Live Voice",
        "kind: standalone",
        "license: MIT",
        "homepage: https://github.com/bielcarpi/hermes-live-voice",
        "tags:",
        "- realtime-voice",
        "- hermes-dashboard",
        "python_dependencies:",
        '- "websockets>=15,<16"',
        "provides_tools:",
        "- hermes_live_status",
        "provides_commands:",
        "- hermes-live",
        "optional_env:",
        "name: HERMES_LIVE_URL",
        "name: HERMES_LIVE_AUTH_TOKEN",
        "secret: true",
    ]:
        assert expected in manifest


if __name__ == "__main__":
    test_manifest_declares_gateway_review_surface()
