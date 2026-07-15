# Hermes Live Voice is installed

The Hermes plugin, Dashboard tab, and server-side Dashboard proxy are now available. The plugin does **not** start the companion voice gateway for you.

## 1. Start the companion gateway

Start in deterministic, no-provider-cost mock mode:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_PROVIDER=mock \
hermes-live serve
```

The `hermes-live` command comes from the matching `hermes-live-voice` npm package. A plugin installed directly from GitHub does not install that CLI and follows unpinned `main`; use it only with a gateway built from the same checkout. From a built checkout, replace `hermes-live` with `node dist/cli.js`.

After mock mode completes a delegated task, restart with `HERMES_LIVE_PROVIDER=gemini` plus `GEMINI_API_KEY`, or `HERMES_LIVE_PROVIDER=openai` plus `OPENAI_API_KEY`, for live speech.

If the gateway requires authentication, give the gateway and the Hermes Dashboard process the same strong value:

```sh
HERMES_LIVE_AUTH_TOKEN=your-random-gateway-token
```

Set `HERMES_LIVE_URL` in the Hermes Dashboard process when the gateway is not available at the default `http://127.0.0.1:8788`.

## 2. Start or restart the Dashboard

```sh
hermes dashboard
```

Open the Dashboard and choose **Live Voice**. The page reports gateway readiness before you connect. Microphone access works on `localhost` or another browser secure context.

The Dashboard browser never receives the gateway credential or upstream gateway URL. It opens an authenticated, same-origin WebSocket to the plugin backend; the backend connects to the companion gateway and applies the credential server-side.

## 3. Know the controls

- **Interrupt speech** clears queued local playback and requests provider cancellation/truncation when supported, while leaving an active Hermes task running. Provider-side cancellation semantics differ; test the selected provider with real audio.
- **Stop task** appears on each active task card and targets that card's stable task ID. It leaves both the voice session and every other task untouched.
- **Mark read** acknowledges one completion or status notification. Results remain available in the recent task inbox.
- **Disconnect voice** ends the realtime voice session only. Durable tasks keep working, and the Dashboard synchronizes their latest state after reconnecting.

For a terminal-only conversation on the same machine, Hermes' built-in Voice Mode remains the shortest path. Hermes Live Voice is the realtime gateway and client surface for the Dashboard, browsers, mobile or desktop apps, and other custom clients.

See the project README for provider configuration, Docker deployment, security guidance, and end-to-end testing.
