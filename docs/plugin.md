# Hermes Plugin

The gateway does not have to be a Hermes plugin.

`hermes-live` is useful as a standalone sidecar because users can install it with npm, Docker, or a process manager and point it at an existing Hermes API Server.

## Why Not Plugin-Only

A realtime voice gateway has concerns that do not fit cleanly as a normal Hermes tool plugin:

- Public WebSocket listener.
- Browser/mobile client auth.
- Realtime provider credentials.
- Long-lived audio sessions.
- Static demo serving.
- TLS/reverse proxy deployment.
- Provider-specific reconnect/error handling.

Those are gateway concerns, not agent skill concerns.

## Why Include a Plugin Stub

The optional plugin can still be useful for:

- Letting Hermes installations discover `hermes-live`.
- Exposing local metadata.
- Showing the expected gateway URL.
- Future local launch helpers.
- Future Saturday-specific or voice-specific Hermes tools.

The plugin should remain small. It should not embed the whole realtime server inside Hermes.

## How People Use It Without Saturday

Users can run the gateway directly:

```sh
npm install -g hermes-live
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_LIVE_PROVIDER=mock hermes-live serve
```

or with Docker:

```sh
docker compose -f examples/docker-compose.yml up
```

Then they connect any client to:

```txt
ws://localhost:8788/v1/live
```

They can also send a one-shot text request from a terminal:

```sh
hermes-live client "What should I work on next?"
```

Saturday is one client. It is not required.
