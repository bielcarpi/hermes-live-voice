# Setup

## Normal install

Start Hermes Agent's API Server, keep its `API_SERVER_KEY` in `~/.hermes/.env`, then run:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Setup writes a private config, installs and enables the bundled Dashboard plugin, checks Hermes and the selected voice provider, then installs a launchd or systemd user service.

If activation fails, run:

```sh
hermes-live doctor
hermes-live doctor --provider-smoke
```

Both commands suppress credentials and print the next concrete fix.

## Local voice

On Apple Silicon, the package can launch the tested Hugging Face stack directly:

```sh
# First terminal
hermes-live local

# Second terminal
hermes-live setup --provider local
```

`hermes-live local` uses `uv` to run `speech-to-speech==0.2.11` with local Parakeet STT, a 4-bit MLX language model, Qwen3-TTS, VAD, and the realtime WebSocket transport. It spells out the Apple Silicon settings because upstream's direct-microphone preset selects a different transport, and supplies macOS's CA bundle to standalone Python installs when needed. The first run downloads dependencies and model weights. `hermes-live local command` prints the exact command without running it.

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

Secrets can come from the process environment, an existing managed config, or `~/.hermes/.env`. Setup prompts without echoing missing values. Secret command-line flags are deliberately unsupported.

## Configuration

Managed settings live at:

```txt
~/.hermes/hermes-live/config.env
```

The directory is `0700` and the file is `0600` on POSIX systems. The parser accepts only known keys and JSON strings; it refuses symlinks, duplicate or unknown keys, unsafe permissions, and oversized files. Environment variables take precedence. Project `.env` files are not loaded.

Common settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `HERMES_BASE_URL` | `http://127.0.0.1:8642` | Hermes API Server |
| `HERMES_LIVE_PROVIDER` | selected by setup | `local`, `gemini`, `openai`, or `mock` |
| `HERMES_LIVE_LOCAL_URL` | `ws://127.0.0.1:8765/v1/realtime` | Hugging Face realtime endpoint |
| `HERMES_LIVE_HOST` / `HERMES_LIVE_PORT` | `127.0.0.1` / `8788` | Gateway listener |
| `HERMES_LIVE_AUTH_TOKEN` | unset | Required for network-accessible gateway binds |
| `HERMES_LIVE_MAX_CONCURRENT_TASKS` | `3` | Bounded worker slots |
| `HERMES_LIVE_MAX_QUEUED_TASKS` | `32` | Bounded pending work |
| `HERMES_LIVE_TRUST_DECLARED_READ_ONLY` | `false` | Allow declared read-only work to share slots |

Use [.env.example](../.env.example) for containers and `hermes-live print-config` to inspect every resolved value with secrets redacted. `HERMES_LIVE_CONFIG_FILE` selects a different managed file.

## Service lifecycle

```sh
hermes-live service status
hermes-live service restart
hermes-live service logs
hermes-live service stop
hermes-live service start
hermes-live service uninstall
```

Run setup again after upgrading or changing providers. It replaces the bundled plugin, rechecks both runtimes, and refreshes the service definition without putting API keys in launchd or systemd files.

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
HERMES_AGENT_API_SERVER_KEY=... \
hermes-live setup --provider local --non-interactive --json --no-service
```

Useful layout flags are `--hermes-url`, `--config`, `--plugins-dir`, `--hermes-command`, `--no-enable`, and `--no-service`.
