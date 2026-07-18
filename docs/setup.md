# Setup And Service Management

The published package can activate a local Hermes Live Voice installation without cloning the repository or keeping a gateway terminal open.

## Activate

Before setup, start Hermes Agent's API Server and keep its `API_SERVER_KEY` in `~/.hermes/.env`. Then run:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Setup:

- asks for Gemini, OpenAI, or text-only mock mode;
- reuses the Hermes key and any existing provider key when available;
- prompts without echoing missing secrets;
- writes a private managed config;
- installs the exact bundled Hermes plugin and enables it;
- verifies the Hermes durable-run API and a real provider session;
- installs and starts a macOS launchd or Linux systemd user service;
- waits until the gateway reports ready.

The local browser client is available at <http://127.0.0.1:8788>. The Dashboard is the recommended everyday UI; `hermes-live terminal` is the headless text client.

## Managed Configuration

The default file is:

```txt
~/.hermes/hermes-live/config.env
```

Its directory and file use `0700` and `0600` permissions on POSIX systems. The parser accepts only documented Hermes Live settings and JSON-quoted string values. It refuses symlinks, unexpected keys, duplicate keys, unsafe permissions, oversized files, and non-string values. The runtime does not source the file or load a project `.env`.

Process environment variables take precedence. Use `HERMES_LIVE_CONFIG_FILE` to select another managed file. Containers should keep using explicit environment injection or an orchestrator secret store.

## Diagnostics

```sh
hermes-live doctor
hermes-live doctor --provider-smoke
hermes-live doctor --json
```

The default check covers Node, managed-config integrity, plugin/runtime version parity, the Hermes CLI, required Hermes API capabilities, provider configuration, the user service, and gateway readiness. `--provider-smoke` also opens and closes a real provider session.

## Service Lifecycle

```sh
hermes-live service status
hermes-live service restart
hermes-live service logs
hermes-live service stop
hermes-live service start
hermes-live service uninstall
```

macOS uses `~/Library/LaunchAgents/dev.hermes-live-voice.gateway.plist`. Linux uses `~/.config/systemd/user/dev.hermes-live-voice.gateway.service`. Definitions contain the absolute Node/CLI paths and managed-config path, not API keys.

Run `hermes-live setup` again after changing provider credentials or upgrading the package. It safely rewrites the managed config, replaces the bundled plugin, rechecks both upstream services, and refreshes the gateway service.

## Automation And Custom Layouts

Noninteractive setup never prompts and prints a safe machine-readable report:

```sh
HERMES_AGENT_API_SERVER_KEY=... \
GEMINI_API_KEY=... \
hermes-live setup --provider gemini --non-interactive --json
```

The credentials remain environment values; there are deliberately no secret CLI flags. Useful layout options are:

```txt
--hermes-url <url>
--config <path>
--plugins-dir <path>
--hermes-command <path>
--no-enable
--no-service
```

Use `--no-service` for containers, unsupported operating systems, or a separately supervised gateway. Start it with `hermes-live serve`.
