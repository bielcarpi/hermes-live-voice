# Durable Background Tasks

Hermes Live protocol v3 separates the realtime conversation from Hermes work. A voice turn can delegate a task, receive a stable receipt immediately, and continue while the gateway supervises the Hermes run independently.

```txt
voice or text turn
  -> realtime provider calls start_background_task
  -> gateway persists task_<id> before publishing it
  -> provider receives the receipt
  -> Hermes work continues under the server-owned supervisor
  -> clients receive lifecycle updates and a durable completion notice
```

The gateway is the task owner. A browser tab, terminal, realtime-provider connection, or WebSocket is only a subscriber and controller. Closing one detaches it; it never implies cancellation.

## Task Contract

The realtime provider has four narrow tools:

- `start_background_task`: submit work and return a stable `task_id` quickly;
- `list_background_tasks`: inspect the current owner's active and recent inbox;
- `get_background_task`: fetch one exact state or retained result;
- `stop_background_task`: request cooperative cancellation of one exact task.

Clients do not send a `task.start` protocol message. They send speech or `text.input`; the realtime model decides when to delegate through `start_background_task`. Direct client controls are `task.list`, `task.get`, `task.stop`, and `task.notification.ack`.

The public states are:

| State | Meaning |
| --- | --- |
| `accepted` | The task is being dispatched. |
| `queued` | The task is durably waiting for safe admission. |
| `running` | Hermes accepted the upstream run. |
| `stopping` | An exact stop or fail-closed containment is in progress. |
| `completed` | Hermes confirmed completion and a bounded result is retained. |
| `failed` | Hermes confirmed failure. |
| `cancelled` | Hermes confirmed cancellation, or a queued task was cancelled before dispatch. |
| `unknown` | The gateway cannot prove the outcome. It must not be described as success or failure. |

Every task has a monotonically increasing, per-task `sequence`, but clients retain two independent revisions: lifecycle state by `taskId` and notification state by `taskId`, `notificationId`, and acknowledgement. Lifecycle and notification messages can share one sequence and arrive in either order; both must be applied. Exact repeats within one channel are idempotent, while conflicting content at the same channel sequence must fail closed. The upstream Hermes run id is private and is never part of protocol v3.

## Ownership And Subscriptions

Tasks are scoped to a hashed owner identity derived from the server-owned Hermes session key. A reconnect using the same configured profile/user scope receives one or more bounded `task.snapshot` frames and subscribes to subsequent changes. Those frames always include every retained active task and unread notification; only older read terminal history may be omitted from the recent view.

By default, `session.start.profileId` and `userLabel` are ignored. All clients using the same gateway defaults therefore share one owner inbox. `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true` lets trusted clients select a scope; it is not authentication or multi-tenant isolation. See [Security](security.md#identity-and-authorization).

## Admission And Parallelism

The scheduler is bounded by `HERMES_LIVE_MAX_CONCURRENT_TASKS` and `HERMES_LIVE_MAX_QUEUED_TASKS`.

- `exclusive` is the default and is required for writes, Git operations, deployments, database changes, external messages, or uncertain side effects. It runs only when no other task is active.
- With `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=false` (the default), every provider request is clamped to `exclusive` and its resource keys are ignored.
- `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true` lets model-declared `parallel_read_only` work overlap only when the declared `resource_keys` are disjoint.
- Tasks sharing any resource key never overlap.
- Among eligible tasks, queue admission is oldest-first. An exclusive task is a FIFO barrier. With the read-only opt-in enabled, a task blocked on one resource does not block a later read-only task whose resource keys are disjoint. Tasks awaiting owner reconnection or a safe retry window are temporarily ineligible.

Resource keys should identify the actual contention boundary, such as an absolute repository path, database, deployment target, or account. The opt-in trusts policy metadata supplied by the model; it is not a sandbox. Keep it off unless Hermes permissions and isolation can absorb a wrong classification.

## Persistence And Recovery

The default state file is:

```txt
~/.hermes/hermes-live/tasks-v1.json
```

The store writes a complete bounded document through a private temporary file, `fsync`, atomic rename, and directory `fsync`. Its directory is forced to mode `0700` and the file to `0600` on supported Unix systems. A lifetime lock allows one writer. Invalid JSON, schema corruption, symlinks, wrong directory ownership, oversized state, or an unconfirmed post-rename commit stop the gateway instead of silently resetting history.

Stable v0.5 reads state created by the v0.5 beta. A beta file that already filled the old byte ceiling can use bounded migration headroom while its accepted work drains; with the default limit, the absolute read/write ceiling is 96 MiB plus 64 KiB. New tasks still have to fit the normal 64 MiB budget, and migration never deletes queued or active work. The store returns to the normal ceiling as soon as the document and its reserves fit.

The upgrade is forward-only once stable writes a confirmed-missing or operator-containment field: the older beta's strict parser will reject that newer record. Back up the private state file while the gateway is stopped before upgrading; do not roll back the binary against state already written by stable v0.5.

Recovery depends on what restarted:

| Event | Result |
| --- | --- |
| Client, tab, terminal, or realtime-provider disconnect | Tasks continue. Reconnect with the same owner scope to receive a snapshot and unread notifications. |
| Gateway restart while the same Hermes Agent process remains alive | Tasks with a persisted upstream run id are reconciled through Hermes status and event APIs. Queued tasks wait until their owner reconnects and re-registers its server-side session key. |
| Hermes Agent restart | In-progress upstream run state is not durable in current Hermes releases. A later confirmed `404` becomes public `unknown` and releases scheduler capacity. |
| Gateway restart during an unconfirmed run-creation request | The task becomes `dispatch_unknown`. It is not retried automatically because Hermes does not provide an idempotency key for `POST /v1/runs`. |

Gateway persistence does not undo side effects already performed by Hermes. A task that becomes `unknown` may have completed some or all of its work.

## Ambiguous Dispatch Fence

`dispatch_unknown` is the safe response to an ambiguous run-creation outcome: Hermes may have accepted the request, but the gateway did not receive a trustworthy run id. Retrying could duplicate a mutation, so the task stays public `unknown` and fences conflicting admission.

Recovery is explicit and offline:

1. Stop Hermes Live. If needed, stop or restart Hermes Agent in a maintenance window so no in-memory run can still be active. This does not reverse effects that already happened.
2. Inspect fenced records with `hermes-live tasks unresolved` and audit the target systems.
3. After you have stopped or otherwise contained any possible upstream work, run `hermes-live tasks contain <taskId> --confirm-contained`.
4. Restart the gateway. The record remains `unknown` with an audit event, but it no longer blocks admission.

Never change an unknown task back to queued or retry it without checking external effects.

An unclean process exit can leave the store lock behind. Confirm that no gateway process is using the state file, then run `hermes-live tasks unlock --confirm-no-gateway`. The store never steals a lock on a timer because two writers are worse than a manual recovery step.

## Completion Notifications

Terminal outcomes create a durable notification. Connected clients receive `task.notification`; disconnected clients receive it after reconnect. The notification has a stable id, terminal kind, safe summary, and acknowledgement state. `task.notification.ack` must name the exact task and notification id.

Spoken delivery happens only while the user and provider response are idle:

- OpenAI Realtime uses a response-scoped, audio-only request with `conversation: "none"`, no tools, and no conversation input. This is a true out-of-band announcement.
- Gemini Live has no equivalent response-scoped channel. The gateway sends an authenticated marker through realtime text input, so speech is best-effort and not a durable or deterministically ordered provider turn.

The durable source of truth is the task inbox, not whether a provider spoke. Announcements are intentionally generic; the provider fetches an exact retained result only when the user asks.

## Approval Boundary

Protocol v3 has no interactive approval messages, buttons, or terminal commands. If Hermes enters `waiting_for_approval`, the supervisor attempts `deny` with `resolve_all`, then stops that exact upstream run. Clients see a non-actionable stopping/progress state.

This is fail-closed. Do not advertise that approvals can be completed in another Hermes Live surface. A future approval workflow requires a proven upstream identity contract that targets exactly one request.

## Retention

Terminal tasks become eligible for age pruning after `HERMES_LIVE_TASK_RETENTION_HOURS` (default seven days). Terminal, confirmed-missing, or operator-contained history may be removed sooner when the record limit or normal 64 MiB store budget needs room for a current write; acknowledged history is evicted before unread items.

Admission reserves the largest valid terminal write for every task that can run concurrently, plus bounded lifecycle/control headroom. A terminal result consumes its reserved slot. A queued task can reclaim that slot only through a durable pre-dispatch write, which may prune closed history or hold admission before Hermes receives a request. Operationally active tasks are never pruned to make room.

`HERMES_LIVE_TASK_HISTORY_LIMIT` (default 200) is the advertised retained-history target; the store also reserves bounded capacity for configured queued and active work. Each wire list/snapshot frame is capped at 100 tasks. Reconnect hydration can use multiple frames so active work and unread notifications never compete with recent terminal history for that cap. Completed output is bounded; list snapshots include a summary, while `task.get` can return the retained output.

For wire details, see [Client Protocol](client-protocol.md). For storage and deployment controls, see [Security](security.md) and [Local Setup](local-setup.md).
