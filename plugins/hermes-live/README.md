# Hermes Live Voice Plugin

This Hermes Agent plugin connects Hermes Dashboard to the companion Hermes Live Voice gateway.

The plugin provides:

- The **Live Voice** Dashboard tab.
- An authenticated same-origin WebSocket relay.
- A saved-conversation picker.
- The `hermes_live_status` tool.
- The `/hermes-live` and `/hermes-live ready` commands.

The plugin does not run provider WebSockets, audio pipelines, or background-task supervision inside Hermes.

## Install

Install the complete product through npm:

```sh
npm install --global hermes-live-voice
hermes-live setup --provider openai
hermes dashboard
```

Use `--provider gemini` for Gemini Live. Use `--provider local --service` for managed local voice on Apple Silicon.

The gateway and plugin share `$HERMES_HOME/hermes-live/config.env`. Use `hermes-live doctor` to diagnose the installation.

A pinned plugin-only install is available for source review:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --ref <40-character-commit-sha> --enable
```

This command does not install the gateway. A working voice installation still requires the npm setup path.

## Security Boundary

- The browser never receives the Hermes API key or gateway bearer.
- The plugin sends outbound requests only to the configured gateway origin.
- The plugin rejects gateway URLs with credentials, paths, queries, or fragments.
- The Dashboard relay revalidates Hermes authentication and the browser origin.
- The status tool reports whether a token exists, but it never returns the token.

See the main [Hermes Live Voice repository](https://github.com/bielcarpi/hermes-live-voice) for setup, architecture, and security documentation.
