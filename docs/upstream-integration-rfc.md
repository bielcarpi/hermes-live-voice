# Upstream Integration RFC

Status: draft for maintainer discussion.

Hermes Live Voice should aim to become a documented Hermes realtime voice
companion, not a fork of Hermes Agent and not a provider SDK bundle inside
Hermes core.

For the current evidence matrix and remaining official-readiness gaps, see the
[Maintainer Review Packet](maintainer-review-packet.md) and
[Maintainer Readiness Audit](maintainer-readiness-audit.md).

## Goal

Make Hermes Live Voice the reference self-hosted gateway pattern for continuous
voice sessions that delegate real work to Hermes Agent.

The desired official wording, after maintainer acceptance, is:

```txt
Implements the documented external realtime voice gateway pattern for Hermes Agent.
```

Do not use stronger wording such as "official NousResearch distribution" or
"officially recommended gateway" unless NousResearch maintainers explicitly
approve that language.

## Why This Belongs Outside Core

Hermes should remain authoritative for:

- tools;
- memory;
- model routing;
- saved conversations;
- approvals;
- run execution;
- durable history.

Realtime providers should own:

- audio transport;
- provider-native turn-taking;
- speech interruption;
- speech-to-speech model behavior;
- provider-specific session handshakes.

Hermes Live Voice owns the middle layer:

- the authenticated client WebSocket;
- the Dashboard plugin and same-origin relay;
- provider adapters for local voice, Gemini Live, and OpenAI Realtime;
- task admission, persistence, progress, stop/status, and reconnect projection;
- Hermes API Server calls to conversations and `/v1/runs`.

That boundary follows the strongest pattern in the current Hermes ecosystem:
third-party integrations stay in standalone repos, while core exposes stable
provider and run contracts.

## Current Upstream Context

Checked on 2026-08-29.

The upstream Hermes tracker already has active realtime voice work:

- [#77111](https://github.com/NousResearch/hermes-agent/issues/77111) proposes a provider-neutral realtime voice/session interface instead of merging several competing vendor transports.
- [#95147](https://github.com/NousResearch/hermes-agent/pull/95147) is an open draft for a small provider/session foundation with fake providers and no vendor transport.
- [#64947](https://github.com/NousResearch/hermes-agent/issues/64947) proposes a transport-neutral run authority so conversational surfaces can talk while work continues.
- [#82554](https://github.com/NousResearch/hermes-agent/issues/82554) tracks exact approval identity for delayed approvals.
- [#97325](https://github.com/NousResearch/hermes-agent/pull/97325) proposes a docs pointer to another community realtime voice plugin.

This means Hermes Live Voice should not claim to be the only realtime voice
path. Its clear value is the packaged, self-hosted gateway and Dashboard/runtime
story around Hermes `/v1/runs`.

The current realtime RFC thread also has strong evidence from `hermes-talk`,
including OpenAI, xAI/Grok, and Gemini Live lanes behind a provider-neutral
session contract, plus active discussion of core-hosted and surface-hosted
session topologies. Hermes Live Voice should respect that work. Its useful
additional evidence is the self-hosted external gateway shape: the companion
process owns the public client protocol, Dashboard relay, headless/VPS browser
access pattern, and task projection while Hermes remains the work authority.

Treat these as three distinct transport topologies when talking to upstream
maintainers:

| Topology | Who owns the provider socket | Best fit | Hermes Live Voice relevance |
| --- | --- | --- | --- |
| Core-hosted | Hermes core process | Future first-party interfaces and provider plugins that run inside Hermes. | Consumer only. Hermes Live should adapt if upstream exposes this contract. |
| Surface-hosted | Browser/mobile/client surface with scoped credentials or a relay fallback | Lowest-latency direct browser/mobile audio when the provider supports safe short-lived credentials. | Possible future browser optimization, not the current default. |
| Gateway-hosted | Companion process beside Hermes | Self-hosted operators who want provider keys, Hermes keys, task state, and browser relay kept server-side. | Current architecture. This is the evidence Hermes Live Voice can add. |

The gateway-hosted shape is not a claim that every browser/mobile integration
should proxy raw audio through a Node process. It is a deployable self-hosted
path for Hermes operators, especially headless/VPS Dashboard users who need a
same-origin browser relay and durable `/v1/runs` task projection without putting
provider or Hermes credentials in client code.

## Provider Documentation Alignment

Current provider documentation supports the gateway boundary:

- OpenAI documents WebSockets as the server-to-server Realtime transport and
  recommends WebRTC for browser and mobile clients when they connect directly:
  https://developers.openai.com/api/docs/guides/realtime-websocket
- OpenAI's Realtime model guide names `gpt-realtime-2` for stronger realtime
  reasoning and tool use, with `gpt-realtime-1.5` as a fast non-reasoning
  speech-to-speech path. Some transport examples still show a more specific
  reasoning-model string, so release receipts should record the exact model
  accepted by the target account:
  https://developers.openai.com/api/docs/guides/realtime-models-prompting
- OpenAI's Realtime event reference supports `session.update`, PCM audio
  configuration, input buffer commits, function-call outputs, response
  creation, and conversation truncation:
  https://developers.openai.com/api/reference/resources/realtime/client-events
- Gemini Live is a preview, stateful WebSocket API for low-latency voice and
  vision. It documents raw little-endian PCM input at 16 kHz, raw PCM output at
  24 kHz, barge-in, transcripts, and tool use:
  https://ai.google.dev/gemini-api/docs/live-api
- Gemini 3.1 Flash Live function calling is synchronous only. Hermes Live Voice
  must therefore return fast tool receipts to Gemini and let Hermes `/v1/runs`
  continue separately instead of blocking the live conversation on long work:
  https://ai.google.dev/gemini-api/docs/live-api/tools

The architecture should keep direct browser/mobile provider sessions optional
and provider-specific. The current repo's default gateway path keeps raw
provider and Hermes credentials server-side, which is the simpler safe path for
self-hosted Hermes operators.

## Comparative Repository Lessons

The best Hermes plugin peers and voice frameworks share these practices:

- lead with one concrete workflow, not a broad platform pitch;
- make installation copyable in five minutes;
- separate automatic setup from manual operator decisions;
- document every secret-bearing environment variable in the plugin manifest;
- use fail-closed provider selection and credential handling;
- show a doctor or launch-check command that gives a redacted support receipt;
- include issue templates, PR checklist, contribution guide, security policy,
  changelog, license, CI, and release evidence;
- document limitations as first-class behavior instead of hiding them;
- use provider compatibility receipts when live APIs can drift;
- keep the plugin small when long-running sockets, audio, and provider SDKs are
  better handled by a companion process.

Hermes Live Voice already satisfies most of this list. The remaining work is
to collect fresh live provider receipts and align its public wording with the
upstream realtime/session and runs discussions.

## Positioning Among Voice Paths

Hermes Live Voice should be precise about what it is.

| Path | Best fit | Boundary |
| --- | --- | --- |
| Built-in Hermes Voice Mode | Local or turn-based voice where STT, Hermes reasoning, and TTS run as a serial pipeline. | Hermes owns the whole turn. |
| Core realtime provider interface | Shared upstream contracts for provider-neutral duplex sessions. | Hermes core owns the interface; providers remain thin. |
| `hermes-talk` and other community realtime voice plugins | Specific voice surfaces, provider experiments, Discord/terminal-first workflows, and provider-neutral session evidence. | Plugin-specific lifecycle. |
| Hermes Live Voice | Self-hosted gateway, Dashboard tab, browser SDK, terminal client, and durable `/v1/runs` task supervision. | Gateway owns realtime client protocol and task projection; Hermes owns work. |

The official ask should therefore be narrow: document the external gateway
pattern and make Hermes contracts stable enough that this implementation can
track upstream safely.

## Required Hermes Contracts

Official-quality integration needs these contracts to be stable or explicitly
versioned:

1. `/v1/capabilities` keys for runs, run events, stop, steer, session continuity,
   and approval targetability.
2. Replayable or discoverable `POST /v1/runs` creation through an idempotency key
   or equivalent caller correlation.
3. Owner/profile-scoped run status, events, stop, steer, and listing behavior.
4. Exact approval request identity in run events and approval responses.
5. A browser-safe SSE or same-origin relay guidance for `/v1/runs/{run_id}/events`.
6. A documented plugin path for Dashboard tabs that proxy companion services
   without leaking companion bearer tokens to browser code.
7. A compatibility fixture or test matrix that downstream gateways can run
   against new Hermes releases.

Until exact approval identity exists, Hermes Live Voice must keep interactive
approval handling disabled and fail closed.

## Proposed Upstream Path

1. Comment on the realtime voice RFC with Hermes Live Voice as consumer
   evidence, emphasizing that it supports a gateway-hosted topology and uses
   Hermes-owned runs.
2. Comment on the conversational workhorse RFC with lost-create and reconnect
   requirements from Hermes Live Voice.
3. Prepare a docs-only Hermes PR that describes the external realtime voice
   gateway pattern neutrally. The PR should list community implementations only
   if maintainers want a directory section.
4. Prepare a small compatibility-contract PR or issue for `/v1/capabilities`
   keys needed by external gateways.
5. Keep provider adapters and audio runtime outside Hermes core unless the
   upstream realtime provider interface explicitly accepts a thin adapter shape.
6. After maintainer acceptance, update this README language from "community
   project" to the exact approved wording.

## Docs-Only PR Packet

Use this only after the reviewed Hermes Live Voice release is public and at
least one live-provider receipt exists.

Suggested upstream PR title:

```txt
docs(voice): describe external realtime voice gateways
```

Suggested upstream files:

- `website/docs/user-guide/features/voice-mode.md`
- optionally `website/docs/guides/use-voice-mode-with-hermes.md`, only if
  maintainers want the practical guide to link out.

Suggested insertion point for `voice-mode.md`: after the feature overview table,
before first-party setup requirements.

Suggested minimal text:

```md
### External realtime voice gateways

Hermes Voice Mode is the first-party Hermes speech path for CLI, messaging, and
Discord voice. Some community integrations use a companion realtime gateway
instead. In that topology, the realtime provider handles audio transport,
turn-taking, and interruption, while Hermes remains authoritative for saved
conversations, tools, memory, approvals, and run execution.

Use this pattern when you need a continuous speech-to-speech session that can
delegate longer work to Hermes `/v1/runs` without blocking the spoken
conversation.

Community implementations:

- [Hermes Live Voice](https://github.com/bielcarpi/hermes-live-voice) -
  self-hosted realtime voice gateway and Dashboard plugin with local voice,
  Gemini Live, OpenAI Realtime, browser SDK, terminal client, and durable task
  supervision over `/v1/runs`.

Community projects are not bundled with Hermes Agent. Review their source,
credentials, plugin manifest, and provider requirements before enabling them.
```

Suggested PR body:

```md
## Why

Hermes now has active first-party voice docs plus active realtime/session and
Runs API discussions. This docs-only change names the external realtime gateway
topology without moving provider SDKs, audio lifecycle, or community runtime
code into Hermes core.

## Boundary

- Hermes remains authoritative for tools, memory, saved conversations,
  approvals, and `/v1/runs`.
- Realtime providers handle audio transport, provider-native turn-taking, and
  interruption behavior.
- Companion gateways own their client protocol, Dashboard relay, provider
  adapters, and task projection.

## Evidence

- Hermes Live Voice release: <release URL>
- Maintainer readiness audit: <audit URL>
- Live provider receipt: <receipt URL>
- Realtime/session RFC: #77111
- Conversational Runs authority RFC: #64947

## Non-goals

- No provider SDKs added to Hermes core.
- No endorsement or official recommendation of a community project.
- No change to built-in Hermes Voice Mode behavior.
```

## Upstream Comment Boundaries

Use one focused comment per thread.

| Target | Purpose | Recommendation |
| --- | --- | --- |
| [#77111](https://github.com/NousResearch/hermes-agent/issues/77111) | Realtime provider/session interface. | Post consumer evidence for the gateway-hosted topology and provider differences. |
| [#64947](https://github.com/NousResearch/hermes-agent/issues/64947) | Conversational workhorse and canonical Runs authority. | Post consumer evidence for idempotent run creation, reconnect, retained task state, exact stop, and lost-create recovery. |
| [#97325](https://github.com/NousResearch/hermes-agent/pull/97325) | Docs pointer for another community realtime voice plugin. | Do not derail the PR. Comment only if maintainers ask for a broader community-plugin wording. |

Avoid asking for official status in the first comment. Ask for the contract or
documentation shape that would make an external gateway maintainable.

If someone asks how this differs from `hermes-talk`, use this answer:

```md
`hermes-talk` is the stronger existing proof that one realtime session contract
can carry multiple providers and surface types. Hermes Live Voice is focused on
a different deployment shape: a self-hosted companion gateway with a Hermes
Dashboard tab, browser SDK, terminal client, and durable `/v1/runs` task inbox.

They should not compete for "the" voice slot. The useful upstream outcome is a
small Hermes-owned contract that lets both approaches stay outside core while
sharing the same authority boundaries: Hermes owns tools, memory, approvals,
saved conversations, and run execution; realtime providers own audio and
turn-taking.
```

## Draft Comment For #77111

```md
Adding one downstream data point from Hermes Live Voice:

https://github.com/bielcarpi/hermes-live-voice

This is not meant to compete with the `hermes-talk` evidence already in this
thread. I think that work is the strongest proof that one provider-neutral
session contract can carry multiple realtime providers. Hermes Live Voice is a
slightly different consumer shape: a self-hosted companion gateway plus
Dashboard plugin, browser SDK, and terminal client.

The ownership boundary is the same:

- realtime providers handle audio, turn-taking, and interruption behavior;
- Hermes remains authoritative for tools, memory, saved conversations,
  approvals, and `/v1/runs`;
- the companion gateway owns the authenticated client WebSocket, task
  projection, progress notifications, and reconnect-safe task inbox.

This maps to the gateway-hosted topology being discussed alongside core-hosted
and surface-hosted sessions. Hermes Live Voice keeps provider and Hermes
credentials server-side and gives headless/VPS Dashboard users a same-origin
browser relay without asking Hermes core to carry provider SDKs.

That gateway topology adds a few contract requirements from the downstream
side:

1. stable `/v1/capabilities` flags for runs/events/stop/steer/session
   continuity;
2. idempotent or exactly recoverable run creation;
3. profile/owner-scoped run controls;
4. exact approval request identity;
5. browser-safe event relay or SSE guidance;
6. a documented Dashboard plugin pattern for proxying companion services
   without leaking bearer tokens to browser code;
7. compatibility fixtures downstream gateways can run against new Hermes
   releases.

I am not proposing that Hermes core absorb provider SDKs, audio lifecycle code,
or this gateway. The maintainable path looks like stable Hermes-owned contracts
plus documented external gateway guidance. Until exact approval identity exists,
Hermes Live Voice keeps approval-required work fail-closed.

If maintainers want it, I can open a docs-only PR describing the external
realtime voice gateway pattern neutrally, with Hermes Live Voice listed only as
a community implementation unless stronger wording is explicitly approved.
```

## Draft Comment For #64947

```md
Hermes Live Voice is a current consumer of the `/v1/runs` shape from an external
realtime voice gateway:

https://github.com/bielcarpi/hermes-live-voice

The gateway starts a voice session, returns a fast task receipt to the realtime
provider, then lets Hermes continue the real work through `/v1/runs` while the
voice conversation remains responsive. The client can ask for status, detach,
reconnect, receive retained completion notifications, and stop a specific task.

The main contracts that matter from this consumer side are:

1. run creation must be idempotent or exactly recoverable after a lost `202`;
2. run status/events/stop/steer must stay profile/owner scoped;
3. event streams must be safe to consume through a browser-facing relay;
4. a task stop must target exactly one upstream run;
5. approval-required work needs exact approval request identity before a voice
   UI can safely surface approval controls.

Hermes Live Voice currently fails approval-required work closed because guessing
approval identity from a voice session would be unsafe. That is the right client
default until the upstream contract is exact.

I am happy to provide the gateway as downstream evidence for the RunService
contract and to adapt the compatibility checks once the upstream shape is
accepted.
```

## Conditional Docs Wording For #97325

Only use this if maintainers want the voice docs to mention more than one
community implementation:

```md
Realtime duplex voice is available through community plugins and companion
gateways. These integrations keep tools, memory, approvals, and execution in
Hermes while the realtime provider handles audio and turn-taking.

- hermes-talk: terminal, Discord, and Dashboard-oriented realtime voice plugin.
- Hermes Live Voice: self-hosted gateway, Dashboard tab, browser SDK, terminal
  client, and `/v1/runs` task supervision.
```

## Acceptance Criteria For "Official-Ready"

- The repo continues to install from npm and GitHub without local build steps.
- `hermes-live launch-check` passes against a real Hermes API Server and at
  least one realtime provider for the release being promoted.
- Provider receipts exist for every provider advertised as currently working.
- The bundled plugin passes static review without undeclared secret environment
  access.
- Public issue templates give users a safe provider-receipt path.
- README wording says "community project" until maintainers approve stronger
  wording.
- The upstream RFC comments or docs PR link to real evidence, not only claims.
- Interactive approvals remain absent or fail-closed until Hermes exposes exact
  approval identity.
