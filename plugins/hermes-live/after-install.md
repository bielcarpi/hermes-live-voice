# Hermes Live Voice is installed

The plugin adds the **Live Voice** Dashboard tab, status tool, slash command, and authenticated browser relay. The matching npm package runs the companion gateway.

For the normal setup:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Choose **Live Voice**, then start a new Hermes chat or resume a saved one. The Dashboard stays responsive while delegated tasks run, shows what each task is doing, keeps results in a durable inbox, and supports follow-up work.

On Apple Silicon, setup installs and starts fully local voice automatically. The first run downloads the models; no separate provider terminal is needed.

Useful commands:

```sh
hermes-live doctor
hermes-live diagnostics
hermes-live service status
hermes-live service logs
hermes-live terminal
hermes-live terminal --resume <sessionId>
```

For a normal local install, setup enables Hermes' private API bridge and creates its credential automatically. It prompts securely for any missing voice-provider credentials and never prints API keys. For a remote gateway, Docker, source development, or custom browser UI, see the project README and `docs/` directory.
