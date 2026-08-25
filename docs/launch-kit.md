# Community Sharing

Use this page when sharing Hermes Live Voice with Hermes users and Hermes-specific plugin directories.

## Canonical Links

- GitHub: https://github.com/bielcarpi/hermes-live-voice
- npm: https://www.npmjs.com/package/hermes-live-voice
- Release: https://github.com/bielcarpi/hermes-live-voice/releases/tag/v1.0.1
- Social preview: [assets/social-preview.svg](../assets/social-preview.svg)

## One-Line Descriptions

Short:

> Continuous realtime voice for Hermes Agent. Talk while Hermes runs background tasks.

Provider-specific:

> Continuous realtime voice for Hermes Agent, with local Hugging Face speech-to-speech, Gemini Live, and OpenAI Realtime.

Directory listing:

> Continuous realtime voice for new or saved Hermes chats. Keeps conversation responsive while durable Hermes runs execute in the background, with bounded progress, stop/status controls, and reconnect-safe completion reporting.

## Proof Points

- v1.0.1 is published on GitHub and npm.
- Installs with `npm install -g hermes-live-voice`.
- Adds a Live Voice tab to Hermes Dashboard through the bundled Hermes plugin.
- Supports local Hugging Face speech-to-speech on Apple Silicon, Gemini Live, and OpenAI Realtime.
- Uses Hermes `/v1/runs` for background work instead of blocking the voice conversation.
- Provides `hermes-live launch-check` as the v1 go/no-go path for provider, plugin, gateway, and one bounded Hermes worker.
- Keeps Hermes Agent as the brain: model selection, tools, memory, skills, approvals, and execution stay in Hermes.

Do not claim provider support until the relevant gate in [Live Provider Testing](live-provider-testing.md) has current live evidence.

## Primary Discord Post

Target one Hermes-specific channel first. The best fit is the Nous Research `#plugins-skills-and-skins` forum because Hermes Live Voice ships a Hermes plugin, CLI, Dashboard tab, and provider adapters.

Title:

```txt
Hermes Live Voice v1.0.1 - realtime voice for Hermes Agent
```

Body:

````md
I just released Hermes Live Voice v1.0.1, an MIT realtime voice gateway/plugin for Hermes Agent.

It adds a Live Voice tab to Hermes Dashboard plus browser and terminal clients. The main use case is: talk to a saved Hermes chat, delegate longer work to Hermes runs, keep the voice conversation open, ask for progress, stop/steer work, and get completion notices after reconnecting.

What it supports:

- Hermes Dashboard plugin + `hermes-live` CLI
- local Hugging Face speech-to-speech on Apple Silicon
- Gemini Live and OpenAI Realtime
- durable task supervision over Hermes `/v1/runs`
- `hermes-live launch-check` to prove provider, plugin, gateway, and one bounded Hermes worker

Repo: https://github.com/bielcarpi/hermes-live-voice
npm: https://www.npmjs.com/package/hermes-live-voice

Install:

```sh
npm install -g hermes-live-voice
hermes-live setup
hermes-live launch-check
hermes dashboard
```

I would appreciate feedback from Hermes builders on the plugin surface, local voice path, and which long-running voice workflows should be smoother next.
````

## Awesome-List Refresh

The project is already listed in `0xNyk/awesome-hermes-agent`, but older entries can lag behind the current release. Use this copy when requesting an update:

```md
Small update for the Hermes Live Voice entry: v1.0.1 is now out.

Suggested refreshed entry:

**[beta]** [Hermes Live Voice](https://github.com/bielcarpi/hermes-live-voice) by [bielcarpi](https://github.com/bielcarpi) - Continuous realtime voice for new or saved Hermes chats. Keeps conversation responsive while durable Hermes runs execute in the background, exposes bounded live progress, stop/status controls, and reconnect-safe completion reporting. Installs as a Hermes Dashboard plugin plus CLI via `npm install -g hermes-live-voice && hermes-live setup`. Supports local Hugging Face speech-to-speech on Apple Silicon, Gemini Live, and OpenAI Realtime. v1.0.1, `hermes-live launch-check`, CI/CodeQL/Hermes compatibility/release workflows green. MIT.
```

## Short Social Posts

Technical:

```txt
Hermes Live Voice v1.0.1 is out: continuous realtime voice for Hermes Agent.

Talk to saved Hermes chats while durable `/v1/runs` keep working in the background. Includes a Hermes Dashboard plugin, terminal client, local Hugging Face voice, Gemini Live, and OpenAI Realtime.

https://github.com/bielcarpi/hermes-live-voice
```

Local-AI angle:

```txt
I released Hermes Live Voice v1.0.1.

The Apple Silicon path can run local Hugging Face speech-to-speech, so Hermes Agent gets a continuous voice loop without sending audio to a hosted realtime provider. Gemini Live and OpenAI Realtime are supported too.

https://github.com/bielcarpi/hermes-live-voice
```

Builder feedback:

```txt
Looking for feedback from Hermes Agent builders on Hermes Live Voice v1.0.1.

It keeps a voice session responsive while Hermes runs longer tasks in the background, then reports progress and completion back into the conversation.

What would make this smoother for real Hermes workflows?

https://github.com/bielcarpi/hermes-live-voice
```

## Hermes-Specific Launch Targets

High fit:

- Nous Research Discord `#plugins-skills-and-skins` forum.
- `0xNyk/awesome-hermes-agent` listing refresh.
- Hermes Atlas / `ksimback/hermes-ecosystem` repository suggestion.
- `ZeroPointRepo/awesome-hermes-skills` listing refresh if maintainers want a v1 update.
- `Anil-matcha/awesome-hermes-agent` repository suggestion.
- `aliaihub/awesome-hermes-usecases` voice workflow suggestion.
- `musichen/awesome-hermes-dashboards` Dashboard plugin suggestion.
- Chinese translated list `jefferyjob/awesome-hermes-agent-zh`, with bilingual entry text.
- `frankxai/awesome-hermes-agent-skills` and `frankxai/awesome-hermes-agents` resource suggestions.

Secondary fit:

- `0xarkstar/awesome-hermes-agent`, PR-only contribution path.
- `zcweah1981/awesome-hermes-agent-zh`, only if a specific Chinese documentation page needs a realtime voice section.
- Smaller Hermes-specific lists, only if they have issue-based contribution paths.

Avoid:

- Generic launch and social communities that are not Hermes-specific.
- Generic AI directories that do not send Hermes developer traffic.
- Repeated Discord cross-posts inside the same server.
- Any community where the post would be mostly a link with no Hermes technical context.

## Recommended Launch Sequence

1. Post once in the Nous Research `#plugins-skills-and-skins` forum.
2. Request a refresh for the existing `0xNyk/awesome-hermes-agent` listing so it points at v1.0.1.
3. Submit Hermes Live Voice to Hermes Atlas through `ksimback/hermes-ecosystem`.
4. Submit Hermes Live Voice to `Anil-matcha/awesome-hermes-agent`.
5. Suggest Hermes Live Voice for the existing voice workflow and dashboard plugin lists.
6. Submit bilingual text to the active Chinese translated awesome list.
7. Monitor the existing `ZeroPointRepo/awesome-hermes-skills` listing and refresh it only if maintainers accept issue-based updates.
8. Track maintainer responses and answer implementation questions with links to `hermes-live launch-check`, plugin install docs, and provider testing docs.
9. Open PR-based directory updates only after explicit approval.

## Repository Discovery Checklist

- Keep the GitHub description and topics aligned with Hermes, voice agents, local AI, and realtime providers.
- Set the repository social preview image to `assets/social-preview.svg` in GitHub repository settings.
- Keep the README first screen focused on the install path and the "talk while Hermes works" promise.
- Share the exact problem and workflow, not a generic voice-assistant pitch.
- Ask for Hermes-builder feedback on plugin surface, local voice setup, and long-running task workflows.
- Avoid claiming official NousResearch status. This is a community MIT project.
