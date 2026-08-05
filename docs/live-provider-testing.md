# Provider testing

CI proves the protocol, gateway, task store, plugin, package, and Docker image against deterministic fakes. It cannot prove your microphone, account access, model rollout, local model weights, or network path.

## Fast checks

```sh
hermes-live doctor
hermes-live doctor --provider-smoke
```

The manual smoke opens the same adapter used by the gateway, waits for provider readiness, and closes it cleanly. It does not send audio or start a Hermes task. Managed Apple Silicon setup additionally runs an isolated task-tool and spoken-receipt check before declaring local voice ready.

For a source checkout:

```sh
npm run verify
npm audit --audit-level=moderate
```

With the managed local provider already running, the full local gateway gate also proves model-selected delegation, a fake Hermes run, SSE completion, and delivery back to the browser protocol:

```sh
npm run check:gateway:local
```

## Local Hugging Face

Start the upstream server, then run the smoke:

```sh
# Foreground provider, Apple Silicon
hermes-live local run

# Terminal 2
HERMES_LIVE_PROVIDER=local hermes-live provider-smoke
```

Confirm:

- the server emits `session.created` and accepts the protocol v6 session update;
- input and output use the upstream OpenAI Realtime PCM16 wire format at 24 kHz (the local pipeline resamples internally);
- VAD starts and stops turns without a push-to-talk click;
- speaking over the assistant cancels old output;
- user and assistant transcripts appear once;
- one task tool call returns a receipt and the conversation continues;
- a completion notice waits until the current turn is idle.

`hermes-live local run` pins the upstream Python package version tested by the release. Normal installs use the managed service created by `hermes-live setup`. Other platforms should run the upstream `realtime` mode separately and point `HERMES_LIVE_LOCAL_URL` at it.

## Gemini

```sh
HERMES_LIVE_PROVIDER=gemini \
GEMINI_API_KEY=... \
hermes-live provider-smoke
```

For Vertex/Enterprise auth, set `GOOGLE_GENAI_USE_ENTERPRISE=true`, `GOOGLE_CLOUD_PROJECT`, and optionally `GOOGLE_CLOUD_LOCATION`.

## OpenAI

```sh
HERMES_LIVE_PROVIDER=openai \
OPENAI_API_KEY=... \
hermes-live provider-smoke
```

The default uses `gpt-realtime-2.1`, `marin`, PCM16, and push-to-talk semantics. Change model, voice, VAD, or G.711 settings only when the target account supports them.

## End-to-end release check

1. Open Hermes Dashboard → Live Voice and select a saved conversation.
2. Talk without clicking for each turn; interrupt one assistant response by speaking.
3. Ask for a short direct answer and verify it remains in the selected Hermes chat.
4. Delegate two read-only tasks and verify both receipts, progress, `/status`, and results.
5. Disconnect voice while they run, reconnect, and verify the snapshot restores them.
6. Let one finish while talking. Its notice should wait until the voice is idle and remain unread until acknowledged.
7. Start a follow-up from the finished task and verify its parent/root lineage.
8. Stop one exact task and verify the other continues.
9. Restart only the gateway with the task volume preserved and verify reconciliation.

Do not call a provider or model supported from a successful connection alone. Release evidence should include actual input, audio playback, interruption, task delegation, completion notification, and reconnect behavior.

## References

- [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech)
- [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
