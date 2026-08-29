# Community Sharing

Use this page when sharing Hermes Live Voice with Hermes users and Hermes-specific plugin directories.

## Canonical Links

- GitHub: https://github.com/bielcarpi/hermes-live-voice
- npm: https://www.npmjs.com/package/hermes-live-voice
- Current release: https://github.com/bielcarpi/hermes-live-voice/releases/latest
- Social preview: [assets/social-preview.png](../assets/social-preview.png)

Use `v1.0.2` for the next launch after the reviewed release is tagged and
published. Until then, treat `v1.0.1` as the latest public stable release.

## One-Line Descriptions

Short:

> Continuous realtime voice for Hermes Agent. Talk while Hermes runs background tasks.

Provider-specific:

> Continuous realtime voice for Hermes Agent, with local Hugging Face speech-to-speech, Gemini Live, and OpenAI Realtime adapter paths.

Directory listing:

> Continuous realtime voice for new or saved Hermes chats. Keeps conversation responsive while durable Hermes runs execute in the background, with bounded progress, stop/status controls, and reconnect-safe completion reporting.

## Proof Points

- v1.0.2 is the prepared launch target for the next GitHub and npm release.
- Installs with `npm install -g hermes-live-voice`.
- Adds a Live Voice tab to Hermes Dashboard through the bundled Hermes plugin.
- Includes implemented provider paths for local Hugging Face speech-to-speech on Apple Silicon, Gemini Live, and OpenAI Realtime.
- Uses Hermes `/v1/runs` for background work instead of blocking the voice conversation.
- Provides `hermes-live launch-check` as the v1 go/no-go path for provider, plugin, gateway, and one bounded Hermes worker.
- Keeps Hermes Agent as the brain: model selection, tools, memory, skills, approvals, and execution stay in Hermes.

Do not claim a provider path is live-verified for the current release until the
relevant gate in [Live Provider Testing](live-provider-testing.md) has current
live evidence.

For official-facing review, use the
[maintainer review packet](maintainer-review-packet.md) and
[maintainer readiness audit](maintainer-readiness-audit.md).
Keep outreach copy evidence-bounded and focused on Hermes builders.

## Current Discovery State

Checked on 2026-08-29:

| Channel | State | Best next action |
| --- | --- | --- |
| GitHub repository | Public, v1.0.1 release, Issues and Discussions enabled, custom social preview configured. Public topics still need the cleanup command below. | Release v1.0.2 after review approval, apply the metadata refresh, then keep README, topics, release notes, and social preview aligned. |
| npm package | Published as `hermes-live-voice`. Public latest is v1.0.1; local package metadata has been tightened for the next release. | Publish the refreshed metadata with the next verified release before npm-focused outreach. |
| Hermes community plugin index | Not listed in the bundled Hermes seed or visible temporary index. Current Hermes docs/code point at `NousResearch/hermes-plugin-index`, but that repository returned 404 when checked and is tracked upstream in NousResearch/hermes-agent#87565. | After v1.0.2 is public, submit to the canonical index if it exists. Otherwise use the visible temporary index only if maintainers still accept it, and keep direct pinned install documented. |
| `0xNyk/awesome-hermes-agent` | Listed, but still describes v0.9.2 and older verification counts. | Request a v1.0.2 refresh after the release is public. |
| Hermes Atlas / `ksimback/hermes-ecosystem` | Listed as a plugin project. Cached star count may lag. | Monitor after the next release; request refresh only if stale. |
| `ZeroPointRepo/awesome-hermes-skills` | Listed with a short entry. | Request a stronger entry focused on realtime voice and background runs. |
| `aliaihub/awesome-hermes-usecases` | Listed as a realtime voice workflow. | Request a refresh only if the wording drifts from the current release. |
| `Anil-matcha/awesome-hermes-agent` | Not listed. | Submit a concise plugin entry. |
| `musichen/awesome-hermes-dashboards` | Not listed. | Submit as a Dashboard plugin with Live Voice tab. |
| Chinese Hermes lists | Not listed in the checked list. | Submit bilingual text only where external plugin entries are accepted. |
| Upstream Hermes realtime RFCs | Active maintainer/community discussion. | Comment with consumer evidence, not endorsement requests. |

## Primary Discord Post

Target one Hermes-specific channel first. The best fit is the Nous Research `#plugins-skills-and-skins` forum because Hermes Live Voice ships a Hermes plugin, CLI, Dashboard tab, and provider adapters.

Title:

```txt
Hermes Live Voice v1.0.2 - realtime voice for Hermes Agent
```

Body:

````md
I just released Hermes Live Voice v1.0.2, an MIT realtime voice gateway/plugin for Hermes Agent.

It adds a Live Voice tab to Hermes Dashboard plus browser and terminal clients. The main use case is: talk to a saved Hermes chat, delegate longer work to Hermes runs, keep the voice conversation open, ask for progress, stop/steer work, and get completion notices after reconnecting.

What it includes:

- Hermes Dashboard plugin + `hermes-live` CLI
- local Hugging Face speech-to-speech path on Apple Silicon
- Gemini Live and OpenAI Realtime adapters
- durable task supervision over Hermes `/v1/runs`
- `hermes-live launch-check` to prove provider, plugin, gateway, and one bounded Hermes worker

Repo: https://github.com/bielcarpi/hermes-live-voice
npm: https://www.npmjs.com/package/hermes-live-voice

Install:

```sh
npm install -g hermes-live-voice
hermes-live setup --provider openai
hermes-live launch-check
hermes dashboard
```

I would appreciate feedback from Hermes builders on the plugin surface, local voice path, and which long-running voice workflows should be smoother next.
````

If someone asks how this relates to `hermes-talk`, answer directly:

```md
`hermes-talk` is the stronger existing proof that one realtime session contract
can carry multiple providers and surface types. Hermes Live Voice is focused on
a different deployment shape: a self-hosted companion gateway with a Hermes
Dashboard tab, browser SDK, terminal client, and durable `/v1/runs` task inbox.

I do not think these should compete for "the" voice slot. The useful upstream
direction is a small Hermes-owned contract that lets both stay outside core
while preserving the same authority boundary: Hermes owns tools, memory,
approvals, saved conversations, and run execution; realtime providers own audio
and turn-taking.
```

## Hermes Plugin Index Submission

Hermes' plugin docs describe a community index used by `hermes plugins search`
and bare-name `hermes plugins install <name>` resolution:
https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins

The canonical URL in current Hermes docs and CLI code is:
https://raw.githubusercontent.com/NousResearch/hermes-plugin-index/main/index.json

At the 2026-08-29 check, `NousResearch/hermes-plugin-index` returned 404 and
the gap was already tracked upstream:
https://github.com/NousResearch/hermes-agent/issues/87565

The visible temporary community index checked on 2026-08-29 is:
https://github.com/Revell-ai/hermes-plugin-index

Re-check the current index home before submitting. Prefer the canonical
NousResearch index if it exists. Use the visible temporary index only if that is
still the maintainer-accepted contribution path. Submit this only after the
reviewed public commit exists, and replace `<40-char-reviewed-sha>` with the
exact commit users should install.

Generate the exact entry from this repository with:

```sh
PLUGIN_INDEX_REF=<40-char-reviewed-sha> node scripts/plugin-index-entry.mjs
```

```json
{
  "name": "hermes-live",
  "description": "Continuous realtime voice for Hermes Agent. Talk while Hermes runs background tasks.",
  "author": "Biel Carpi and Hermes Live contributors",
  "tags": [
    "voice",
    "realtime",
    "dashboard",
    "gateway",
    "background-tasks"
  ],
  "repo": "bielcarpi/hermes-live-voice",
  "subdir": "plugins/hermes-live",
  "ref": "<40-char-reviewed-sha>",
  "homepage": "https://github.com/bielcarpi/hermes-live-voice",
  "capabilities": [
    "tools",
    "dashboard"
  ],
  "api_version": 1,
  "added_at": "2026-08-29"
}
```

The index review is metadata-only. Users still install and enable the plugin
explicitly. Direct pinned install does not depend on the index:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --ref <40-char-reviewed-sha> --enable
```

The npm package remains the normal setup path because it manages the companion
gateway runtime:

```sh
npm install --global hermes-live-voice
hermes-live setup --provider openai
```

Treat the direct subdirectory command as a pinned review/install escape hatch,
not the normal update path. Use `hermes-live upgrade` for package-managed
updates until Hermes' subdirectory plugin update metadata is stable.

## Awesome-List Refresh

The project is already listed in `0xNyk/awesome-hermes-agent`, but older entries can lag behind the current release. Use this copy when requesting an update:

```md
Small update for the Hermes Live Voice entry: v1.0.2 is now out.

Suggested refreshed entry:

**[beta]** [Hermes Live Voice](https://github.com/bielcarpi/hermes-live-voice) by [bielcarpi](https://github.com/bielcarpi) - Continuous realtime voice for new or saved Hermes chats. Keeps conversation responsive while durable Hermes runs execute in the background, exposes bounded live progress, stop/status controls, and reconnect-safe completion reporting. Installs as a Hermes Dashboard plugin plus CLI via `npm install -g hermes-live-voice && hermes-live setup`. Includes local Hugging Face speech-to-speech on Apple Silicon, Gemini Live, and OpenAI Realtime provider paths. v1.0.2, `hermes-live launch-check`, CI/CodeQL/Hermes compatibility/release workflows green. MIT.
```

## Directory Submission Drafts

Use these only for Hermes-specific directories with a clear issue or pull-request contribution path.

### `ZeroPointRepo/awesome-hermes-skills`

```md
Small refresh suggestion for the existing `hermes-live-voice` entry.

Current suggested text:

[hermes-live-voice](https://github.com/bielcarpi/hermes-live-voice) by [bielcarpi](https://github.com/bielcarpi) - Self-hosted realtime voice gateway and Dashboard plugin for Hermes Agent. Talk to new or saved Hermes chats while Hermes runs background tasks through `/v1/runs`, with live progress, exact stop/status controls, retained completion notifications, browser SDK, terminal client, and implemented local Hugging Face speech-to-speech, Gemini Live, and OpenAI Realtime provider paths. MIT. **[beta]**
```

### `Anil-matcha/awesome-hermes-agent`

```md
Suggested plugin entry:

**[Hermes Live Voice](https://github.com/bielcarpi/hermes-live-voice)** - Self-hosted realtime voice gateway and Dashboard plugin for Hermes Agent. It keeps voice conversations responsive while Hermes runs longer work through `/v1/runs`, then reports progress and completion back into the session. Includes Dashboard, terminal, and browser SDK clients, with local Hugging Face speech-to-speech, Gemini Live, and OpenAI Realtime provider paths. MIT.
```

### `musichen/awesome-hermes-dashboards`

```md
Suggested Dashboard plugin entry:

**[Hermes Live Voice](https://github.com/bielcarpi/hermes-live-voice)** - Adds a Live Voice tab to Hermes Dashboard backed by a self-hosted realtime gateway. Users can talk to new or saved Hermes chats, delegate background work, see task status/progress, reconnect to retained completions, and keep provider/Hermes credentials server-side.
```

### Hermes Atlas Refresh

Hermes Atlas already lists the project. Use this only if its cached metadata remains stale after the next release:

```md
Hermes Live Voice is already listed. Could the entry be refreshed to the current release metadata?

Current one-line description:

Self-hosted realtime voice gateway for Hermes Agent. Keep talking while Hermes runs background tasks with local voice, Gemini Live, or OpenAI Realtime.
```

### Chinese Hermes Lists

For Chinese translated directories, keep the first submission simple unless the maintainer asks for a full translated paragraph:

```md
Suggested English source entry for translation:

Hermes Live Voice - Self-hosted realtime voice gateway and Dashboard plugin for Hermes Agent. Talk to new or saved Hermes chats while Hermes runs background tasks through `/v1/runs`. Includes live progress, stop/status controls, retained completion notifications, browser SDK, terminal client, and implemented local Hugging Face speech-to-speech, Gemini Live, and OpenAI Realtime provider paths.
```

## Short Social Posts

Technical:

```txt
Hermes Live Voice v1.0.2 is out: continuous realtime voice for Hermes Agent.

Talk to saved Hermes chats while durable `/v1/runs` keep working in the background. Includes a Hermes Dashboard plugin, terminal client, local Hugging Face voice path, Gemini Live adapter, and OpenAI Realtime adapter.

https://github.com/bielcarpi/hermes-live-voice
```

Local-AI angle:

```txt
I released Hermes Live Voice v1.0.2.

The Apple Silicon path can run local Hugging Face speech-to-speech, so Hermes Agent gets a continuous voice loop without sending audio to a hosted realtime provider. Gemini Live and OpenAI Realtime adapter paths are included too.

https://github.com/bielcarpi/hermes-live-voice
```

Builder feedback:

```txt
Looking for feedback from Hermes Agent builders on Hermes Live Voice v1.0.2.

It keeps a voice session responsive while Hermes runs longer tasks in the background, then reports progress and completion back into the conversation.

What would make this smoother for real Hermes workflows?

https://github.com/bielcarpi/hermes-live-voice
```

## Hermes-Specific Launch Targets

High fit:

- Nous Research Discord `#plugins-skills-and-skins` forum.
- `0xNyk/awesome-hermes-agent` listing refresh.
- Hermes Atlas / `ksimback/hermes-ecosystem` listing freshness check.
- `ZeroPointRepo/awesome-hermes-skills` listing refresh.
- `aliaihub/awesome-hermes-usecases` voice workflow suggestion.
- `Anil-matcha/awesome-hermes-agent` repository suggestion.
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

1. Merge the readiness changes through the protected GitHub PR path.
2. Run a live-provider receipt for at least one promoted provider, or keep provider copy explicitly evidence-bounded.
3. Submit a pinned `plugins/hermes-live` entry to the canonical Hermes community plugin index if it exists, or to the maintainer-accepted temporary index.
4. Apply the GitHub metadata refresh below, then run `npm run audit:public-launch`.
5. Post once in the Nous Research `#plugins-skills-and-skins` forum.
6. Request a refresh for the existing `0xNyk/awesome-hermes-agent` listing so it points at v1.0.2.
7. Request a stronger entry for the existing `ZeroPointRepo/awesome-hermes-skills` listing.
8. Submit Hermes Live Voice to `Anil-matcha/awesome-hermes-agent`.
9. Suggest Hermes Live Voice for the dashboard list and refresh the voice-workflow list only if its entry is stale.
10. Submit bilingual text to an active Chinese translated Hermes list only if external plugin entries fit that repository.
11. Post one evidence-focused comment to upstream #77111 and one to #64947 after the public branch/release is ready.
12. Track maintainer responses and answer implementation questions with links to `hermes-live launch-check`, plugin install docs, and provider testing docs.
13. Open PR-based directory updates only after explicit approval.
14. Do not comment on the `hermes-talk` docs PR unless maintainers explicitly ask for a broader community-implementation section.

## Community Adoption Sequence

Use this as the working plan for the next two weeks after the reviewed release
is public. The public copy should sell the workflow, not the star target.

1. Release v1.0.2 with the README, npm metadata, GitHub topics, and social preview aligned.
2. Confirm the public CI badge is green after the protected PR lands.
3. Add the existing `workflow-lint` and `verify-windows` jobs to required branch-protection checks.
4. Publish one live-provider receipt for the provider used in the first Discord post.
5. Submit the pinned community plugin-index PR so `hermes plugins search voice` can discover the plugin once the canonical or maintainer-accepted temporary index is available.
6. Run `npm run check:external-audits` to prove the audit fixtures. Run `npm run audit:public-launch` and fix any public metadata, release, or branch-protection failure before outreach.
7. Post one focused Nous Research Discord thread and stay active in replies for the first 48 hours.
8. Refresh existing Hermes list entries only after the release URL is stable.
9. Open two or three narrow issues labeled `good first issue` or `help wanted` for provider receipts, docs screenshots, and non-Apple local runtime testing. Use [Community Issue Drafts](community-issue-drafts.md) for the first issue set.
10. Answer every first-week issue or discussion with a concrete reproduction path, not generic support copy.
11. Comment on upstream realtime/runs threads with implementation evidence, then link back to those comments from the maintainer readiness audit.
12. Recheck GitHub search results, npm metadata, plugin-index status, and awesome-list wording one week after launch.
13. Do not cross-post to broad communities unless Hermes builders are already engaging with the project elsewhere.

## 100-Star Adoption Plan

This is the practical path from the current public baseline to 100+ legitimate
GitHub stars. It is not a guarantee. It is the smallest launch plan that has a
credible chance because it concentrates on Hermes users who can install,
review, and recommend the project.

Current public baseline checked on 2026-08-29:

- GitHub repository: public.
- GitHub stars: 37.
- Latest public release: v1.0.1.
- Local reviewed release candidate: v1.0.2.
- Public npm latest: v1.0.1.

Target:

- 100+ GitHub stars after the v1.0.2 public launch.
- At least one external live-provider receipt.
- At least one Hermes-specific directory refresh or plugin-index listing.
- At least one external issue, discussion, or pull request from a non-owner.

Expected star channels, if executed well:

| Channel | Conservative target | Why it can work |
| --- | ---: | --- |
| One focused Nous Research Discord thread | 15-30 stars | It reaches Hermes operators at the moment they can evaluate the workflow. |
| Existing `0xNyk/awesome-hermes-agent` refresh | 10-25 stars | It already has Hermes ecosystem traffic and maturity-tag context. |
| Plugin-index or directory submissions | 5-15 stars | Bare-name/plugin discovery catches users looking for installable integrations. |
| Provider receipt issues and first-contributor tasks | 5-10 stars | Clear issues create visible activity without pretending the project is bigger than it is. |
| Upstream realtime/Runs implementation evidence | 5-15 stars | Maintainers and advanced users care about proof, not launch copy. |
| Long-tail GitHub/npm topic search | 5-10 stars | Strong topics and package keywords matter after the first activity spike. |

Execution gates:

1. Do not start outreach until v1.0.2 is public on GitHub and npm.
2. Do not start outreach until the public CI badge is green.
3. Do not start outreach until `npm run audit:public-launch` passes.
4. Do not claim live provider verification until the provider receipt exists.
5. Do not claim official status unless Hermes maintainers approve exact wording.

48-hour launch operating plan:

1. Hour 0: apply GitHub description/topics/social preview, confirm v1.0.2 on npm,
   and run `npm run audit:public-launch`.
2. Hour 1: publish one Hermes Discord forum post in `#plugins-skills-and-skins`.
3. Hours 1-24: reply quickly to setup questions with exact commands, not broad
   marketing claims.
4. Day 1: open two or three narrow public issues from
   [Community Issue Drafts](community-issue-drafts.md), labeled `good first issue`
   or `help wanted`.
5. Day 1-2: submit or request the existing Hermes list refreshes only after the
   release URL is stable.
6. Day 2: comment on upstream realtime/Runs threads with implementation evidence
   and links to the maintainer review packet.
7. Day 7: re-check GitHub search rank, npm metadata, stars, forks, issues,
   discussions, and directory entries; update only stale public copy.

Do not do these:

- Do not buy, trade, coordinate, or ask friends for artificial stars.
- Do not backdate or rewrite public history to simulate a longer project.
- Do not cross-post into generic AI launch communities.
- Do not post to Product Hunt, Hacker News, or Reddit for this launch.
- Do not publish a demo recording. Use static visuals, a text transcript,
  `hermes-live launch-check`, and provider receipts as proof.
- Do not position this as a general voice-agent framework. The winning wedge is:
  Hermes voice plus durable background runs.

Peer patterns checked on 2026-08-29:

| Project | Stars checked | Pattern to copy | How Hermes Live Voice uses it |
| --- | ---: | --- | --- |
| `livekit/agents` | 13,470 | Clear docs home, provider/plugin ecosystem, install command above examples. | README leads with install, providers, docs, and clients. |
| `pipecat-ai/pipecat` | 14,932 | Ecosystem map, client SDKs, examples, provider matrix, community links. | README and launch kit expose Dashboard, terminal, browser SDK, providers, and directory paths. |
| `openai/openai-realtime-agents` | 6,968 | Concrete realtime patterns, screenshots, diagrams, and setup steps. | Architecture, transcript, static Dashboard preview, and launch-check explain the workflow without a recording. |
| `0xNyk/awesome-hermes-agent` | 5,491 | Maturity tags, trust-boundary warnings, and ecosystem start path. | Launch copy stays community/beta/evidence-bounded and links security boundaries. |
| `42-evey/hermes-plugins` | 441 | Category grouping and exact plugin purposes. | Hermes Live Voice separates plugin, gateway, clients, providers, and task supervision. |
| `Humalike/hermes-humalike-plugin` | 202 | One-command setup plus explicit automated/manual setup boundary. | README and plugin docs say what setup manages and what custom deployments own. |
| `8bit64k/cronalytics` | 107 | Dashboard proof, CLI commands, workflows, and honest caveats. | README shows Dashboard preview, CLI operations, limitations, and launch-check. |
| `streamcoreai/streamcore-server` | 198 | Strong bring-your-own-agent boundary and honest not-built-yet list. | Hermes Live Voice keeps Hermes as brain and documents current boundaries. |

## Repository Discovery Checklist

- Keep the GitHub description and topics aligned with Hermes, voice agents, local AI, and realtime providers.
- Set the repository social preview image to `assets/social-preview.png` in GitHub repository settings.
- After the first public OpenSSF Scorecard run publishes results, consider
  adding the Scorecard badge to README. Do not add it before a result exists.
- Keep the README first screen focused on the install path and the "talk while Hermes works" promise.
- Share the exact problem and workflow, not a generic voice-assistant pitch.
- Keep the direct pinned install command visible until bare-name plugin discovery is proven through the canonical or maintainer-accepted temporary index.
- Ask for Hermes-builder feedback on plugin surface, local voice setup, and long-running task workflows.
- Avoid claiming official NousResearch status. This is a community MIT project.
- Check public metrics live before quoting them. Do not freeze star or fork
  counts into reusable copy.

Recommended GitHub topics, capped at GitHub's 20-topic limit:

```txt
hermes-agent
hermes-plugin
realtime-voice
speech-to-speech
voice-agent
voice-assistant
openai-realtime
gemini-live
local-ai
local-voice
huggingface
self-hosted
browser-sdk
hermes-dashboard
background-tasks
task-supervision
realtime-audio
full-duplex
websocket
typescript
```

Use these as the default unless a future release changes the product surface.
They are stronger for discovery than generic AI topics alone.

After review approval, apply the metadata refresh with:

```sh
gh repo edit bielcarpi/hermes-live-voice \
  --description "Self-hosted realtime voice gateway for Hermes Agent. Keep talking while Hermes runs background tasks through local, Gemini Live, and OpenAI Realtime adapters." \
  --homepage "https://www.npmjs.com/package/hermes-live-voice" \
  --remove-topic ai-agents \
  --remove-topic nous-research \
  --remove-topic terminal

gh repo edit bielcarpi/hermes-live-voice \
  --add-topic hermes-dashboard \
  --add-topic voice-assistant \
  --add-topic websocket
```

Keep Issues and Discussions enabled. They were both enabled when checked on
2026-08-29. The public launch audit checks this because provider receipts,
first-contributor issues, and setup questions need public intake surfaces.

## Branch Protection Launch Gate

Before v1.0.2 outreach, protect `main` with every release-critical check that
already exists in this repository. In GitHub repository settings, use:

```txt
Settings > Branches > main > Require status checks to pass before merging
```

Required checks:

- `workflow-lint`
- `verify (20)`
- `verify (22)`
- `verify (24)`
- `verify-windows`
- `Analyze (javascript-typescript)`
- `Analyze (python)`
- `dependency-review`

Do not use the broad `CodeQL` aggregate status as a substitute for the two
language-specific analysis jobs. Do not treat the v1.0.2 release as ready for
outreach until `npm run audit:public-launch` sees the exact required check
names above from the live branch-protection API.

## Upstream Readiness Gate

Before posting upstream comments or using stronger official-facing language,
run:

```sh
npm run check:external-audits
npm run audit:upstream-readiness -- --report-only
```

The fixture smoke proves the audit scripts' expected pass/fail behavior without
network access. The upstream audit itself is read-only. It checks the public
Hermes repo, tracked realtime/Runs issues, the `hermes-talk` docs PR,
plugin-index availability, and the public Hermes Live Voice release state. A
failing result is normal until maintainers accept a docs or plugin-discovery
path. Treat it as the source of current external blockers, not as a local
verification failure.

Do not use official wording while this audit reports no maintainer acceptance
signal. The correct wording remains:

```txt
Community MIT realtime voice gateway and Dashboard plugin for Hermes Agent.
```
