# Hermes Live Voice plugin

This directory is the Hermes Agent plugin installed under `~/.hermes/plugins/hermes-live` by the `hermes-live plugin install` command.

It registers:

- the `hermes_live_status` tool, which reports the configured companion gateway and can probe its health, capabilities, and readiness;
- the `/hermes-live` command for a concise gateway status report;
- the `/hermes-live ready` command for the authenticated readiness probe;
- a Hermes Dashboard **Live Voice** integration;
- an authenticated same-origin Dashboard proxy that keeps gateway credentials out of browser code.

The plugin does not run the audio gateway inside Hermes. Start the installed Node.js companion runtime separately:

```sh
hermes-live serve
```

From a built repository checkout, the equivalent command is `node dist/cli.js serve`.

Set `HERMES_LIVE_URL` when the gateway is not at `http://127.0.0.1:8788`. Set `HERMES_LIVE_AUTH_TOKEN` in the Hermes process when the gateway requires authentication. The status tool reports whether a token is configured but never returns its value.

Start or restart `hermes dashboard` after enabling the plugin, then choose **Live Voice**. The Dashboard tab keeps voice and text conversation responsive while delegated tasks continue in a durable task inbox. It shows active and recent work, unread completion updates, stable task IDs, result details, and an exact stop control for each active task. Disconnecting ends only the voice session; background tasks keep working and synchronize when you reconnect. Its backend applies the gateway bearer server-side, so the browser connects only to an authenticated same-origin plugin WebSocket.

For installation, provider configuration, architecture, and security guidance, see the main [Hermes Live Voice repository](https://github.com/bielcarpi/hermes-live-voice).
