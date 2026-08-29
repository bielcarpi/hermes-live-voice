# Hermes Live Voice plugin

This directory is the Hermes Agent plugin installed under `~/.hermes/plugins/hermes-live` by the `hermes-live plugin install` command.

It registers:

- the `hermes_live_status` tool, which reports the configured companion gateway and can probe its health, capabilities, and readiness;
- the `/hermes-live` command for a concise gateway status report;
- the `/hermes-live ready` command for the authenticated readiness probe;
- a Hermes Dashboard **Live Voice** integration;
- an authenticated same-origin Dashboard proxy that lists saved Hermes chats and keeps gateway credentials out of browser code.

The plugin does not run the audio gateway inside Hermes. The npm setup command installs the plugin, verifies the connection, and manages the companion runtime:

```sh
npm install --global hermes-live-voice
hermes-live setup --provider openai
```

Setup also enables and starts Hermes' private API bridge. Use
`hermes-live setup --provider gemini` for Gemini Live, or `hermes-live setup
--provider local --service` for the managed Apple Silicon local Hugging Face
runtime. Use `hermes-live doctor` for exact fixes, `hermes-live diagnostics` for
a redacted support bundle, and `hermes-live local status` for local voice. From a
source checkout, the manual voice-gateway equivalent is `node dist/cli.js serve`.

The normal setup needs no plugin environment variables: the gateway and plugin share `$HERMES_HOME/hermes-live/config.env`, including any automatically selected local port. `HERMES_LIVE_URL` and `HERMES_LIVE_AUTH_TOKEN` remain explicit overrides for custom deployments. The status tool reports whether a token is configured but never returns its value.

Reviewers can also install just this plugin directory through Hermes' pinned
subdir install path:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --ref <40-character-commit-sha> --enable
```

That path does not install the companion gateway runtime. Use `npm install
--global hermes-live-voice && hermes-live setup` for a working voice gateway.
For updates, prefer `hermes-live upgrade`; Hermes subdirectory installs are best
treated as pinned review installs until upstream subdirectory update metadata is
stable.

Start or restart `hermes dashboard`, then choose **Live Voice**. Start a new Hermes chat or resume a saved one. The tab keeps conversation responsive while delegated tasks continue in a durable inbox, shows sanitized live activity, and supports exact stops and follow-ups from finished work. Disconnecting ends only the voice session; background tasks keep working and synchronize when you reconnect. Its backend applies the gateway bearer server-side, so the browser connects only to authenticated same-origin plugin routes.

Security review boundary:

- The plugin never starts the voice gateway inside the Hermes process.
- The only intentional outbound egress is to the configured companion gateway origin.
- The manifest uses Hermes' v2 metadata fields for reviewability but declares no privileged host capabilities.
- Python dependencies are declared for plugin-doctor diagnostics; normal Hermes Dashboard installs already provide the web server runtime.
- `HERMES_LIVE_URL` is normalized to a credential-free HTTP(S) origin with no path, query, or fragment.
- `HERMES_LIVE_AUTH_TOKEN` is applied server-side only and is never returned to Dashboard JavaScript.
- Browser WebSocket traffic goes through the authenticated same-origin Dashboard proxy.
- Repo-level tests cover registration, status probing, manifest version matching, static asset sync, and secret-marker checks; `tests/test_manifest_contract.py` exists so plugin scanners can find a local smoke test when the plugin directory is reviewed in isolation.

For installation, provider configuration, architecture, and security guidance, see the main [Hermes Live Voice repository](https://github.com/bielcarpi/hermes-live-voice).
