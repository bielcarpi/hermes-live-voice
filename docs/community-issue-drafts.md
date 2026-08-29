# Community Issue Drafts

Use these drafts after the reviewed release is public. They are intentionally
small and evidence-oriented, so first contributors can help without changing
the gateway architecture.

Do not open these before the release URL, npm version, plugin-index target, and
reviewed commit are stable.

## Provider Receipt: OpenAI Realtime

Title:

```txt
provider receipt: OpenAI Realtime on v1.0.2
```

Labels:

```txt
help wanted, documentation
```

Body:

```md
We need one current OpenAI Realtime provider receipt for Hermes Live Voice v1.0.2.

Scope:

- install `hermes-live-voice@1.0.2`;
- configure `hermes-live setup --provider openai`;
- run `hermes-live launch-check`;
- verify one voice turn, one Hermes `/v1/runs` task receipt, completion notification, reconnect, and exact task stop;
- record the result with `docs/provider-compatibility-receipt-template.md`.

Do not paste API keys, raw transcripts, private audio, prompts, task results,
local usernames, or sensitive Hermes output.

Acceptance criteria:

- The receipt names the Hermes Live Voice version, Hermes Agent version, OpenAI model, date, and result.
- A blocked or failed attempt is labeled blocked or failed, not passing.
- The receipt can be linked from release notes or the maintainer readiness audit.
```

## Provider Receipt: Gemini Live

Title:

```txt
provider receipt: Gemini Live on v1.0.2
```

Labels:

```txt
help wanted, documentation
```

Body:

```md
We need one current Gemini Live provider receipt for Hermes Live Voice v1.0.2.

Scope:

- install `hermes-live-voice@1.0.2`;
- configure `hermes-live setup --provider gemini`;
- run `hermes-live launch-check`;
- verify one voice turn, one Hermes `/v1/runs` task receipt, completion notification, reconnect, and exact task stop;
- record whether the Gemini path used API-key auth or Vertex/Enterprise auth.

Gemini Live tool calls are synchronous, so long Hermes work should return a
fast gateway task receipt and continue through Hermes `/v1/runs`.

Acceptance criteria:

- The receipt names the Hermes Live Voice version, Hermes Agent version, Gemini model, auth mode, region if relevant, date, and result.
- No API keys, bearer tokens, private audio, prompts, task results, local usernames, or sensitive Hermes output are included.
- Blocked provider access is recorded as blocked with the smallest actionable cause.
```

## Hardware Receipt: Local Voice On Apple Silicon

Title:

```txt
hardware receipt: local voice on Apple Silicon
```

Labels:

```txt
help wanted, documentation
```

Body:

```md
We need one current hardware receipt for the managed local Hugging Face
speech-to-speech path on Apple Silicon.

Scope:

- install `hermes-live-voice@1.0.2`;
- configure `hermes-live setup --provider local --service`;
- run `hermes-live launch-check`;
- record Mac model family, memory size, macOS version, Hermes Agent version, and result;
- verify VAD, barge-in, audio playback, one task receipt, completion notification, reconnect, and exact task stop.

Acceptance criteria:

- The receipt confirms whether setup, service management, warm memory use, and audio behavior matched the README.
- No private prompts, transcripts, audio, usernames, paths, task results, or secrets are included.
- Any model-download, microphone-permission, or memory-pressure failure is recorded as blocked or failed with the smallest actionable cause.
```

## Documentation: Dashboard Screenshot

Title:

```txt
docs: add clean Dashboard Live Voice screenshots
```

Labels:

```txt
good first issue, documentation
```

Body:

```md
The README uses static generated visuals, but a clean real Dashboard screenshot
would help Hermes users understand the flow faster.

Scope:

- capture one Live Voice connected-state screenshot;
- capture one task inbox screenshot with a retained completion;
- redact or avoid all secrets, local usernames, customer paths, prompts, task output, and API keys;
- add the images under `assets/`;
- reference them from the README or docs without adding a video/demo recording.

Acceptance criteria:

- Screenshots are readable on GitHub in light and dark page contexts.
- No sensitive local information is visible.
- `npm run check:docs` passes.
```

## Platform Receipt: Linux Local Runtime

Title:

```txt
research: Linux path for local voice runtime
```

Labels:

```txt
help wanted
```

Body:

```md
The managed local voice setup is Apple Silicon-first. We need a clear Linux
operator path before claiming more.

Scope:

- test the upstream Hugging Face speech-to-speech realtime server on one Linux profile;
- document CPU/GPU, memory, driver/runtime requirements, and startup command;
- set `HERMES_LIVE_LOCAL_URL` against that running service;
- run `HERMES_LIVE_PROVIDER=local hermes-live provider-smoke`;
- record what would be needed for a managed Linux service path.

Acceptance criteria:

- The result is documented as passed, failed, or blocked.
- Unsupported hardware receives an actionable fallback.
- No model cache paths, usernames, prompts, audio, task results, or secrets are included.
```
