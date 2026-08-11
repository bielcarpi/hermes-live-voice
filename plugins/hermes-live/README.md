# Hermes Live Voice plugin

This directory is the Hermes Agent plugin installed under `~/.hermes/plugins/hermes-live` by the `hermes-live plugin install` command.

It registers:

- the `hermes_live_status` tool, which reports the configured companion gateway and can probe its health, capabilities, and readiness;
- the `/hermes-live` command for a concise gateway status report;
- the `/hermes-live ready` command for the authenticated readiness probe;
- a Hermes Dashboard **Live Voice** integration;
- an authenticated same-origin Dashboard proxy that lists saved Hermes chats and keeps gateway credentials out of browser code.

The plugin does not run the audio gateway inside Hermes. The npm setup command installs the plugin, verifies the connection, and manages the companion runtime:

```sh
npm install --global hermes-live-voice
hermes-live setup
```

Setup also enables and starts Hermes' private API bridge. On Apple Silicon it installs and starts the fully local Hugging Face runtime. Use `hermes-live doctor` for exact fixes, `hermes-live diagnostics` for a redacted support bundle, and `hermes-live local status` for local voice. From a source checkout, the manual voice-gateway equivalent is `node dist/cli.js serve`.

The normal setup needs no plugin environment variables: the gateway and plugin share `$HERMES_HOME/hermes-live/config.env`, including any automatically selected local port. `HERMES_LIVE_URL` and `HERMES_LIVE_AUTH_TOKEN` remain explicit overrides for custom deployments. The status tool reports whether a token is configured but never returns its value.

Start or restart `hermes dashboard`, then choose **Live Voice**. Start a new Hermes chat or resume a saved one. The tab keeps conversation responsive while delegated tasks continue in a durable inbox, shows sanitized live activity, and supports exact stops and follow-ups from finished work. Disconnecting ends only the voice session; background tasks keep working and synchronize when you reconnect. Its backend applies the gateway bearer server-side, so the browser connects only to authenticated same-origin plugin routes.

For installation, provider configuration, architecture, and security guidance, see the main [Hermes Live Voice repository](https://github.com/bielcarpi/hermes-live-voice).
