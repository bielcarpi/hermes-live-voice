# Hermes Live Voice is installed

The plugin adds **Live Voice** controls to Dashboard Chat, status tool, slash command, and authenticated browser relay. The matching npm package runs the companion gateway.

For the normal setup:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Open **Chat**, select a saved conversation in Hermes’s list, and press **Start voice**. Expand **Tasks** to inspect background work and retained results.

Setup defaults to OpenAI, detects an available hosted key, and keeps an existing provider choice. Local voice requires `hermes-live setup --provider local`; on Apple Silicon that installation downloads Python and models.

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
