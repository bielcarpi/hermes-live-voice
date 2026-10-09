# Provider testing

CI proves the protocol, gateway, task store, plugin, package, and Docker image against deterministic fakes. It cannot prove your microphone, account access, model rollout, local model weights, or network path.

## Fast checks

```sh
hermes-live doctor
hermes-live doctor --provider-smoke
hermes-live provider-smoke --functional
hermes-live launch-check
```

The default smoke opens the gateway's provider adapter and closes it cleanly. With `--functional`, it also checks task delegation and receipt audio using a synthetic task result. This works with local, OpenAI, and Gemini providers. It does not start a Hermes worker. Managed Apple Silicon setup runs this functional check before declaring local voice ready.

`hermes-live launch-check` checks the plugin, gateway, provider connection, and a bounded Hermes worker separately. It rejects mock mode. A pass still requires a Dashboard conversation to establish microphone, playback, interruption, and spoken completion behavior.
Record release-relevant live results with the
[provider compatibility receipt template](provider-compatibility-receipt-template.md).
Blocked or failing attempts can be kept under `docs/provider-receipts/` when
they explain a real release blocker.

For a source checkout:

```sh
npm run verify
npm audit --audit-level=moderate
```

With the local provider running, the gateway check verifies delegation, receipt audio, response cancellation, reconnect during a running task, and spoken completion. It uses a fake Hermes worker:

```sh
npm run check:gateway:local
```

For hosted providers, build once, then run `node scripts/gateway-smoke.mjs --live-provider openai` or `--live-provider gemini` with your normal provider credentials. Gemini cancellation requires live audio barge-in and remains part of the browser checklist below.

To test speech input, add `--audio-pcm /path/to/fixture.pcm`. Use 24 kHz mono signed PCM16 little-endian audio, between 0.1 and 30 seconds. The fixture must say: “Delegate in the background: gateway integration check.” Use synthetic speech, without personal data. The check streams audio in real time. It does not test physical microphone or speaker quality.

## Local Hugging Face

Start the upstream server, then run the smoke:

```sh
# Foreground provider, Apple Silicon
hermes-live local run

# Terminal 2
HERMES_LIVE_PROVIDER=local \
HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING=true \
hermes-live provider-smoke --functional
```

The routing setting matches the managed runtime launched by `hermes-live local run`. Setup saves it automatically. An external upstream server without the Hermes wrapper uses its own model-selected routing and needs separate qualification.

Confirm:

- the server emits `session.created` and accepts the protocol v6 session update;
- input and output use the upstream OpenAI Realtime PCM16 wire format at 24 kHz (the local pipeline resamples internally);
- VAD starts and stops turns without a push-to-talk click;
- speaking over the assistant cancels old output;
- user and assistant transcripts appear once;
- one task tool call returns a receipt and the conversation continues;
- a completion notice waits until the current turn is idle.

`hermes-live local run` pins the upstream Python package version tested by the release. Normal installs use the managed service created by `hermes-live setup`. Other platforms can run upstream `speech-to-speech serve` separately and point `HERMES_LIVE_LOCAL_URL` at it.

## Gemini

```sh
HERMES_LIVE_PROVIDER=gemini \
GEMINI_API_KEY=... \
hermes-live provider-smoke
```

For Vertex/Enterprise auth, set `GOOGLE_GENAI_USE_ENTERPRISE=true`, `GOOGLE_CLOUD_PROJECT`, and optionally `GOOGLE_CLOUD_LOCATION`.

Gemini 3.1 Flash Live function calling is synchronous. A long Hermes task must
therefore return a fast gateway receipt first; the Hermes `/v1/runs` worker,
task progress, and completion notification continue outside the blocking
Gemini tool turn.

## OpenAI

```sh
HERMES_LIVE_PROVIDER=openai \
OPENAI_API_KEY=... \
hermes-live provider-smoke
```

The default uses `gpt-realtime-2`, `marin`, PCM16, and automatic server VAD. Manual submission requires `OPENAI_REALTIME_TURN_DETECTION=disabled`. `gpt-realtime-1.5` remains available through `OPENAI_REALTIME_MODEL` when you want the faster non-reasoning Realtime path. Some OpenAI transport examples can lag the model guide, so record the exact accepted model in the receipt. Change model, voice, VAD, or G.711 settings only when the target account supports them.

## End-to-end release check

1. Open Hermes Dashboard → Live Voice and select a saved conversation.
2. Talk without clicking for each turn; interrupt one assistant response by speaking.
3. Ask for a short direct answer and verify it remains in the selected Hermes chat.
4. Delegate two read-only tasks and verify both receipts, progress, `/status`, and results.
5. Disconnect voice while they run, reconnect, and verify the snapshot restores them.
6. Let one finish while talking. Its notice waits until the voice is idle and remains unread until acknowledged.
7. Start a follow-up from the finished task and verify its parent/root lineage.
8. Stop one exact task and verify the other continues.
9. Restart only the gateway with the task volume preserved and verify reconciliation.

Do not call a provider or model supported from a successful connection alone. Release evidence must include actual input, audio playback, interruption, task delegation, completion notification, and reconnect behavior.

## References

- [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech)
- [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
