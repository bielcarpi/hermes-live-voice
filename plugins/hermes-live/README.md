# Hermes Live Voice plugin

This directory is the Hermes Agent plugin installed under `~/.hermes/plugins/hermes-live` by the `hermes-live plugin install` command.

It registers:

- the `hermes_live_status` tool, which reports the configured companion gateway and can probe its health, capabilities, and readiness;
- the `/hermes-live` command for a concise gateway status report;
- the `/hermes-live ready` command for the authenticated readiness probe.

The plugin does not run the audio gateway inside Hermes. Start the Node.js companion runtime separately:

```sh
hermes-live serve
```

Set `HERMES_LIVE_URL` when the gateway is not at `http://127.0.0.1:8788`. Set `HERMES_LIVE_AUTH_TOKEN` in the Hermes process when the gateway requires authentication. The status tool reports whether a token is configured but never returns its value.

For installation, provider configuration, architecture, and security guidance, see the main [Hermes Live Voice repository](https://github.com/bielcarpi/hermes-live-voice).
