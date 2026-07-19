# Hermes Live Voice is installed

The plugin adds the **Live Voice** Dashboard tab, status tool, slash command, and authenticated browser relay. The matching npm package runs the companion gateway.

For the normal local setup:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Choose **Live Voice**, then start a new Hermes chat or resume a saved one. The Dashboard stays responsive while delegated tasks run, shows what each task is doing, keeps results in a durable inbox, and supports follow-up work.

Useful commands:

```sh
hermes-live doctor
hermes-live service status
hermes-live service logs
hermes-live terminal
hermes-live terminal --resume <sessionId>
```

Setup reads Hermes's `API_SERVER_KEY` from `~/.hermes/.env` when available and prompts securely for missing provider credentials. It never prints API keys. For a remote gateway, Docker, source development, or custom browser UI, see the project README and `docs/` directory.
