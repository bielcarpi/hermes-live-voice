# Setup

## Normal install

Run:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes-live launch-check
hermes dashboard
```

Setup enables Hermes' private API bridge, creates a random bridge credential when needed, installs and enables the bundled Dashboard plugin, checks both runtimes, then installs the required user services. On Apple Silicon it defaults to fully local voice. Existing custom or remote Hermes API endpoints are never reconfigured.

If activation fails, run:

```sh
hermes-live doctor
hermes-live doctor --provider-smoke
```

Both commands suppress credentials and print the next concrete fix.

Use `hermes-live launch-check` before a demo or production use. It rejects mock mode and starts one bounded Hermes worker.

To create a support bundle, run `hermes-live diagnostics`. The private JSON file excludes logs, prompts, task results, audio, and secret values.

## Local voice

On Apple Silicon, `hermes-live setup` uses `uv` to install and run `speech-to-speech==0.2.12`.
The managed voice stack uses Parakeet STT, a 4-bit MLX language model, Qwen3-TTS, VAD, and realtime WebSocket transport.
It installs a private launchd service and waits for the models.
Then it proves a structured task tool call and spoken receipt before it starts the gateway.
This warms the first real inference path.
No second terminal is needed.

The managed profile requires at least 12 GB of physical memory; a 16 GB Apple Silicon Mac is recommended (7.6 GB observed warm, 9.0 GB peak on the tested 16 GB M1 Pro). Setup checks this before downloading models. It moves an implicit local endpoint to a nearby free port when needed; an explicit `HERMES_LIVE_LOCAL_URL` is never changed.

The `hermes-live local` commands are for diagnostics and development:

```sh
hermes-live local status
hermes-live local logs
hermes-live local restart
hermes-live local uninstall  # remove the managed service
hermes-live local run       # foreground debugging
hermes-live local command   # print the pinned command
```

On Linux, Windows, CUDA systems, or a separate voice host, run [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech) in `realtime` mode and set:

```sh
HERMES_LIVE_PROVIDER=local
HERMES_LIVE_LOCAL_URL=ws://127.0.0.1:8765/v1/realtime
```

Local endpoints must be loopback by default. A trusted network endpoint requires `HERMES_LIVE_LOCAL_ALLOW_REMOTE=true`; public endpoints must also use `wss://`. The upstream server has no authentication of its own, so do not expose it directly.

## Other providers

```sh
# Gemini Live
GEMINI_API_KEY=... hermes-live setup --provider gemini

# OpenAI Realtime
OPENAI_API_KEY=... hermes-live setup --provider openai

# Text-only development
hermes-live setup --provider mock
```

OpenAI Realtime uses `gpt-realtime-2` by default. Set
`OPENAI_REALTIME_MODEL=gpt-realtime-1.5` when you want the faster
non-reasoning Realtime path. OpenAI user transcripts use
`gpt-4o-mini-transcribe` by default. Set `OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE` to a two-letter language code when a known language needs a hint. Set `OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL=disabled` to turn input transcription off.

Provider secrets can come from the process environment, an existing managed config, or `~/.hermes/.env`. Setup prompts without echoing missing values. The normal local install generates its internal Hermes bridge key automatically. Secret command-line flags are deliberately unsupported.

## Configuration

Managed settings live at:

```txt
$HERMES_HOME/hermes-live/config.env
```

The directory is `0700` and the file is `0600` on POSIX systems. The parser accepts only known keys and JSON strings; it refuses symlinks, duplicate or unknown keys, unsafe permissions, and oversized files. Environment variables take precedence. Project `.env` files are not loaded.

Common settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `HERMES_BASE_URL` | `http://127.0.0.1:8642` | Hermes API Server |
| `HERMES_MODEL` | Hermes profile default | Optional literal model override; normally leave unset |
| `HERMES_LIVE_PROVIDER` | selected by setup | `local`, `gemini`, `openai`, or `mock` |
| `HERMES_LIVE_LOCAL_URL` | `ws://127.0.0.1:8765/v1/realtime` | Hugging Face realtime endpoint |
| `GEMINI_MODEL` | `gemini-3.1-flash-live-preview` | Gemini Live model |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2` | OpenAI Realtime model |
| `HERMES_LIVE_HOST` / `HERMES_LIVE_PORT` | `127.0.0.1` / first free port from `8788` | Gateway listener |
| `HERMES_LIVE_AUTH_TOKEN` | unset | Required for network-accessible gateway binds |
| `HERMES_LIVE_MAX_SESSIONS` | `1` local / `8` hosted | Concurrent voice sessions; match the provider pool |
| `HERMES_LIVE_MAX_CONCURRENT_TASKS` | `3` | Bounded worker slots |
| `HERMES_LIVE_MAX_QUEUED_TASKS` | `32` | Bounded pending work |
| `HERMES_LIVE_TRUST_DECLARED_READ_ONLY` | `false` | Allow declared read-only work to share slots |
| `OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | OpenAI user transcript model, or `disabled` |
| `OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE` | unset | Optional lowercase ISO-639-1 language hint |

Use [.env.example](../.env.example) for containers and `hermes-live print-config` to inspect every resolved value with secrets redacted. `HERMES_LIVE_CONFIG_FILE` selects a different managed file.

`HERMES_HOME` defaults to `~/.hermes`; named Hermes profiles therefore keep their plugin and Live Voice config together. Setup and the Dashboard plugin share the resolved managed file automatically. If `8788` belongs to another local service, setup selects and saves a free port. An explicitly configured port is never changed silently.

## Service lifecycle

```sh
hermes-live service status
hermes-live service restart
hermes-live service logs
hermes-live service stop
hermes-live service start
hermes-live service uninstall
```

After updating the npm package, reconcile the installed files:

```sh
npm install --global hermes-live-voice@latest
hermes-live upgrade
```

The upgrade command keeps the existing provider settings and credentials. It replaces the bundled plugin, checks both runtimes, and refreshes the service definitions. Use `hermes-live setup` when you want to change providers.

## Source development

```sh
git clone https://github.com/bielcarpi/hermes-live-voice.git
cd hermes-live-voice
npm ci
HERMES_LIVE_PROVIDER=mock HERMES_AGENT_API_SERVER_KEY=... npm run dev
```

Run `npm run verify` before opening a pull request. The mock provider proves deterministic gateway behavior but not a microphone, model access, or a real provider session.

## Docker

The image contains the Node gateway, not Python models. Point it at Gemini/OpenAI or a separately managed Hugging Face endpoint:

```sh
HERMES_AGENT_API_SERVER_KEY=... \
HERMES_LIVE_AUTH_TOKEN=replace-with-a-long-random-value \
docker compose -f examples/docker-compose.yml up --build
```

The example binds the host port to loopback, drops Linux capabilities, uses a read-only root filesystem, and persists task state on a dedicated volume. To reach local voice on the host, bind speech-to-speech only to a trusted interface and set `HERMES_LIVE_PROVIDER=local`; the compose file uses `host.docker.internal:8765` with the explicit private-network opt-in.

## Automation

```sh
hermes-live setup --provider local --non-interactive --json
```

For a config-only or remote deployment, provide `HERMES_AGENT_API_SERVER_KEY` and add `--no-service`. Useful layout flags are `--hermes-url`, `--config`, `--plugins-dir`, `--hermes-command`, `--no-enable`, and `--no-service`.
