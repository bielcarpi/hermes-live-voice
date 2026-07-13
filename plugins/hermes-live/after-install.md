# Hermes Live Voice is installed

The Hermes plugin, Dashboard tab, and server-side Dashboard proxy are now available. The plugin does **not** start the companion voice gateway for you.

## 1. Start the companion gateway

From a built checkout of `hermes-live-voice`:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_PROVIDER=gemini \
GEMINI_API_KEY=your-gemini-key \
node dist/cli.js serve
```

Use `HERMES_LIVE_PROVIDER=openai` with `OPENAI_API_KEY` for OpenAI Realtime, or `HERMES_LIVE_PROVIDER=mock` for a text-only, no-provider-cost integration check.

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

- **Interrupt speech** cancels the current spoken response while leaving an active Hermes task running.
- **Stop Hermes task** requests cancellation of the active tool-using run while leaving the voice session connected. Keep watching until Hermes reports a terminal state.
- **Disconnect** requests cleanup of the provider session and any active Hermes task, then waits for gateway confirmation. If confirmation fails or the page is closed before it arrives, verify the task directly in Hermes.
- Permanent approval choices require a second confirmation and are shown only when Hermes provides an inspectable permission pattern.

For a terminal-only conversation on the same machine, Hermes' built-in Voice Mode remains the shortest path. Hermes Live Voice is the realtime gateway and client surface for the Dashboard, browsers, mobile or desktop apps, and other custom clients.

See the project README for provider configuration, Docker deployment, security guidance, and end-to-end testing.
