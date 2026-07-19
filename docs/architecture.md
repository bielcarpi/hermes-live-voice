# Architecture

Hermes Live Voice is a realtime voice gateway for Hermes Agent. The speech provider handles conversation and turn-taking; Hermes keeps its memory, tools, skills, MCP servers, and execution environment; the gateway owns authentication, durable background-task supervision, and the protocol between them.

It is an independent community integration, not a replacement for Hermes or an official NousResearch release.

## System Shape

```txt
Hermes Dashboard / browser / terminal / native client
  -> authenticated Hermes Live protocol v4 WebSocket
  -> LiveGatewaySession (conversation and client subscription)
       -> Gemini Live or OpenAI Realtime (speech and delegation decisions)
       -> Hermes Sessions Chat (selected conversation memory and canonical turns)
       -> TaskSupervisor (server-owned queue, persistence, reconciliation)
            -> Hermes Agent API Server /v1/runs
            -> private tasks-v1.json
```

The Dashboard path adds a same-origin relay:

```txt
Dashboard browser
  -> Hermes-authenticated plugin WebSocket
  -> Hermes Live plugin backend
  -> gateway bearer applied server-side
  -> Hermes Live gateway
```

The browser never receives the installation-wide gateway bearer or Hermes API key.

## Responsibilities

### Clients

Voice clients capture microphone audio, send base64 PCM frames, play provider audio, render transcript and task state, and expose separate controls for speech interruption and exact task stop. The shared browser SDK supplies protocol validation, reconnect snapshots, task/notification caches, bounded buffering, a microphone worklet, and audio playback.

The terminal uses the same persistent protocol but is text-control only. It supports the durable task inbox and exact stop without adding native audio dependencies.

### Hermes Plugin

The optional `hermes-live` plugin provides:

- `hermes_live_status` and `/hermes-live` discovery;
- the Hermes Dashboard **Live Voice** tab;
- an authenticated same-origin HTTP/WebSocket relay;
- packaged browser client, microphone worklet, and styles.

The plugin stays small and Hermes-specific. The companion gateway remains a separate process.

### Live Gateway Session

`LiveGatewaySession` owns one client/provider conversation:

- protocol negotiation, client authentication, and browser origin checks;
- creation or resumption of one persisted Hermes conversation;
- realtime provider connection and interruption state;
- canonical Hermes chat turns plus five narrow background-task tools;
- subscription to the owner's durable task stream;
- safe completion announcements while the conversation is idle.

A session does not own task lifetime. Closing it detaches from tasks and closes only the realtime provider connection.

### Task Supervisor

`TaskSupervisor` is a server-wide service shared by sessions. It owns:

- persist-before-publish task creation;
- owner-scoped list, get, stop, subscription, and notification acknowledgement;
- terminal-task follow-ups with explicit parent/root lineage;
- bounded queueing and safe admission;
- exclusive execution by default, with operator-enabled disjoint read-only parallelism;
- Hermes run creation, SSE consumption, periodic status reconciliation, and exact stop;
- gateway-restart recovery from persisted upstream run ids;
- retry of only definitive `429 rate_limit_exceeded` and `503 gateway_draining` rejections;
- ambiguity fencing when a mutating outcome cannot be proven;
- fail-closed approval denial and stop.

See [Durable Background Tasks](background-tasks.md) for the state and recovery contract.

### Realtime Provider

The realtime provider owns speech recognition/generation, conversational flow, and the decision to continue the saved chat or delegate. It receives only these gateway tools:

- `continue_hermes_conversation`
- `start_background_task`
- `list_background_tasks`
- `get_background_task`
- `follow_up_background_task`
- `stop_background_task`

It never receives Hermes credentials, raw Hermes tools, upstream run ids, the local state file, or approval authority. A task receipt returns quickly, so the provider can continue talking while Hermes works.

Supported adapters are Gemini Live, OpenAI Realtime, and a text-only mock. OpenAI can generate a response-scoped out-of-band completion announcement. Gemini completion speech is best-effort because Gemini Live has no equivalent out-of-band response channel.

### Hermes Agent

Hermes owns the actual delegated work. The gateway currently requires these Hermes capability flags:

- `run_submission`
- `run_status`
- `run_events_sse`
- `run_stop`
- `run_approval_response`

Canonical chat uses Hermes Sessions Chat so the selected conversation keeps its persisted history and compression lineage. Background workers use `POST /v1/runs`, `GET /v1/runs/{run_id}`, `GET /v1/runs/{run_id}/events`, `POST /v1/runs/{run_id}/stop`, and the approval endpoint only for fail-closed denial. These upstream details never appear in protocol v4.

These are two separate execution planes. The conversation plane serializes canonical turns into one selected Hermes session. The task plane starts independent Hermes `AIAgent` runs so long work can continue after voice disconnects. Hermes Live does not automatically decompose every request into subagents; the realtime model delegates only when work should outlive or run beside the current conversation.

Hermes currently retains active run state in its process. The gateway can reconcile after its own restart if that Hermes process remains alive; it cannot make an in-progress Hermes run survive a Hermes restart.

## Ownership And Identity

The gateway derives a server-side Hermes session key from:

- `HERMES_LIVE_SESSION_PREFIX`
- `HERMES_LIVE_PROFILE_ID`
- `HERMES_LIVE_USER_LABEL`

Example:

```txt
agent:main:hermes-live:profile:default:user:voice
```

The same value defines the task owner scope and is hashed before persistence. Client `profileId` and `userLabel` are ignored unless `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true`. That option is for already-trusted clients and does not create multi-tenant authorization.

Each background task receives a separate Hermes session id derived from its stable `task_<id>`. This isolates task execution history from the realtime conversation while the owner scope controls who may inspect or stop it. A follow-up is another independent worker whose prompt includes the bounded retained result of its terminal parent; parent/root ids make that lineage visible without exposing private worker history.

## Persistence Boundary

The local file store contains task prompts, titles, internal run/session ids, bounded event summaries, results, usage, and notification state. It does not store provider or Hermes API keys, but prompts and results can still be sensitive. A lifetime lock makes the store single-writer; abandoned locks require an explicit offline operator command.

Every state is persisted before subscribers see it. The store uses atomic replacement and strict filesystem checks; corruption is fatal rather than silently replaced. In Docker, `/var/lib/hermes-live` is the only persistent writable volume and the remaining root filesystem is read-only.

## Public Projection

Hermes event streams are internal. Protocol v4 exposes only bounded task snapshots and lifecycle facts:

- no upstream run id;
- no raw reasoning, tool arguments/output, approval identity, or provider envelopes;
- bounded progress summaries with obvious credential patterns redacted;
- retained output only for completion lifecycle or an exact `task.get`;
- generic durable notifications.

Task titles, summaries, and results remain untrusted data. The provider instruction and UIs must summarize/render them as data, never execute embedded instructions, links, markup, or tool requests.

## Failure Model

The gateway favors a visible unknown state over a fabricated result:

- unsupported protocol or missing Hermes features: reject session startup;
- missing provider credentials: reject startup except in mock mode;
- network bind without gateway auth: reject unless the unsafe opt-out is explicit;
- slow or oversized client/provider data: fail within bounded queues and payload limits;
- client/provider disconnect: detach; tasks keep running;
- confirmed busy/draining dispatch rejection: bounded backoff and safe retry;
- ambiguous dispatch: `dispatch_unknown`, no automatic retry, scheduler fence;
- ambiguous stop or missing upstream state: `unknown` until reconciliation can prove more;
- approval required: deny all and stop the exact task;
- state-file corruption or uncertain disk commit: refuse further mutation and require operator recovery.

## Code Boundaries

| Layer | Path | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/protocol`, `src/domain/tasks` | Wire schemas, task records, and pure transitions. |
| Application | `src/application/live-gateway`, `src/application/task-supervisor` | Conversation orchestration, task policy, scheduling, recovery, and ports. |
| Inbound adapters | `src/adapters/inbound/http` | HTTP, WebSocket auth/origin policy, and demo serving. |
| Hermes adapter | `src/adapters/outbound/hermes` | Bounded JSON/SSE calls to Hermes Runs API. |
| Task store | `src/adapters/outbound/task-store` | Private atomic local-file persistence. |
| Provider adapters | `src/adapters/outbound/realtime` | Gemini Live, OpenAI Realtime, and mock implementations. |
| Clients | `clients/browser`, `src/cli` | Browser SDK/audio and terminal surfaces. |

`LiveGatewaySession` and `TaskSupervisor` depend on ports, not raw WebSockets, provider SDKs, or filesystem APIs. This keeps conversation lifetime, task lifetime, and external transports independently testable.
