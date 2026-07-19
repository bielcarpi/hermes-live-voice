import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import type { ApprovalChoice } from "../src/domain/protocol/client-protocol.js";
import type { HermesRunEvent } from "../src/domain/protocol/server-protocol.js";
import type {
  ApprovalResult,
  HermesCapabilities,
  HermesRequestOptions,
  HermesRunSnapshot,
  HermesRunsPort,
  HermesSessionChatResult,
  HermesSessionHistory,
  HermesSessionSummary,
  StartRunParams,
  StartRunResult,
} from "../src/application/live-gateway/ports/hermes-runs.port.js";
import type {
  LiveModelAdapter,
  LiveModelAudio,
  LiveModelCallbacks,
  LiveModelConnectParams,
  LiveModelEvent,
  LiveModelSession,
  LiveTaskNotification,
  LiveToolCall,
} from "../src/application/live-gateway/ports/realtime-model.port.js";
import { startServer } from "../src/adapters/inbound/http/server.js";
import { FileTaskStore } from "../src/adapters/outbound/task-store/file-task-store.js";
import { TaskSupervisor } from "../src/application/task-supervisor/task-supervisor.js";
import {
  acknowledgeTaskNotification,
  createTaskRecord,
  transitionTask,
  type TaskRecord,
} from "../src/domain/tasks/index.js";

type TestServer = Awaited<ReturnType<typeof startServer>>;
type JsonMessage = Record<string, any>;

const openServers: TestServer[] = [];
const openSockets: WebSocket[] = [];
const stateDirectories: string[] = [];
const temporaryRoot = realpathSync(tmpdir());
const defaultSessionKey = "agent:main:hermes-live:profile:default:user:voice";

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
  for (const directory of stateDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("live gateway WebSocket", () => {
  it("keeps protocol v3 clients in unbound compatibility mode", async () => {
    const config = testConfig();
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const client = await connectClient(server.url);

    send(client.socket, {
      type: "session.start",
      id: "session_start_1",
      protocolVersion: 3,
      profileId: "ignored-profile",
      userLabel: "Ignored User",
    });
    const ready = await client.messages.wait("session.ready");
    const snapshot = await client.messages.wait("task.snapshot");

    expect(ready).toMatchObject({
      type: "session.ready",
      protocolVersion: 3,
      requestId: "session_start_1",
      model: "test-live-model",
      tasks: {
        scope: "owner",
        sequence: "per_task",
        reconnect: "snapshot",
        durable: true,
        parallel: false,
        maxConcurrent: 3,
        supports: { list: true, get: true, stop: true, followUp: false, resume: false, notificationAck: true },
      },
    });
    expect(ready.sessionKey).toBeUndefined();
    expect(ready.hermes.baseUrl).toBeUndefined();
    expect(snapshot).toEqual({ type: "task.snapshot", reason: "initial", tasks: [], truncated: false });
    expect(provider.latest.params.safetyIdentifier).toBe(
      createHash("sha256").update(defaultSessionKey).digest("hex"),
    );
  });

  it("resumes the writable Hermes conversation tip and keeps canonical chat in that session", async () => {
    const hermes = new HermesHarness();
    hermes.sessions.set("session_original", {
      id: "session_original",
      title: "Release planning",
      source: "web",
      preview: "Plan the release",
      lastActive: 1_784_131_200_000,
    });
    hermes.sessions.set("session_tip", {
      id: "session_tip",
      title: "Release planning",
      source: "web",
      preview: "Continue the release",
      lastActive: 1_784_131_300_000,
    });
    hermes.historyBehavior = async () => ({ sessionId: "session_tip", messages: [] });
    hermes.chatBehavior = async (sessionId, message) => ({
      sessionId,
      content: `Hermes answered: ${message}`,
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    });
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await connectClient(server.url);

    send(client.socket, {
      type: "session.start",
      id: "resume_start",
      protocolVersion: 4,
      conversation: { mode: "resume", sessionId: "session_original" },
    });
    await expect(client.messages.wait("session.ready")).resolves.toMatchObject({
      protocolVersion: 4,
      conversation: {
        mode: "resume",
        sessionId: "session_tip",
        title: "Release planning",
      },
    });
    await client.messages.wait("task.snapshot");
    expect(provider.latest.params.systemInstruction).toContain("continue_hermes_conversation");

    provider.emit({
      type: "tool_call",
      call: { id: "continue_chat", name: "continue_hermes_conversation", args: { message: "What changed?" } },
    });
    await expect(provider.latest.toolResponses.wait()).resolves.toMatchObject({
      response: {
        ok: true,
        session_id: "session_tip",
        message: "Hermes answered: What changed?",
        usage: { total_tokens: 14 },
      },
    });
    expect(hermes.historyCalls).toEqual(["session_original"]);
    expect(hermes.chatCalls).toEqual([{ sessionId: "session_tip", message: "What changed?" }]);
  });

  it("rejects adversarial request ids without reflecting them or breaking the connection", async () => {
    const server = await startTestServer({
      config: testConfig(),
      hermes: new HermesHarness(),
      provider: new RecordingLiveAdapter(),
    });
    const client = await readyClient(server.url);
    const malformedIds: unknown[] = [
      "contains whitespace",
      "_leading_punctuation",
      "line\nbreak",
      "x".repeat(129),
      42,
    ];

    for (const id of malformedIds) {
      send(client.socket, { type: "task.list", id, limit: 1 });
      const error = await client.messages.wait("session.error");
      expect(error).toMatchObject({ code: "client_message_failed", recoverable: false });
      expect(error).not.toHaveProperty("requestId");
    }

    send(client.socket, { type: "task.list", id: "usable_after_bad_ids", limit: 1 });
    await expect(
      client.messages.wait("task.snapshot", (message) => message.requestId === "usable_after_bad_ids"),
    ).resolves.toMatchObject({ reason: "list", tasks: [], truncated: false });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("returns a durable receipt immediately and keeps realtime conversation responsive during dispatch", async () => {
    const start = deferred<StartRunResult>();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => start.promise;
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);

    const taskCall = backgroundTaskCall("delegate_1", "Audit the release", {
      title: "Release audit",
      execution_mode: "exclusive",
      resource_keys: ["repo:release"],
    });
    provider.emit({ type: "tool_call", call: taskCall });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === taskCall.id);

    expect(receipt.response).toMatchObject({
      ok: true,
      task_id: expect.stringMatching(/^task_[a-f0-9]{32}$/),
      status: "queued",
      message: expect.stringContaining("keep talking"),
    });
    await waitUntil(() => hermes.startCalls.length === 1);
    expect(hermes.startCalls[0]).toMatchObject({
      input: "Audit the release",
      sessionKey: defaultSessionKey,
    });
    expect(start.settled).toBe(false);

    send(client.socket, { type: "text.input", id: "continue_1", text: "And what time is it?" });
    await waitUntil(() => provider.latest.textInputs.includes("And what time is it?"));
    provider.emit({ type: "response", status: "started", responseId: "voice_2" });
    provider.emit({ type: "text", text: "We can keep talking.", speaker: "assistant", final: true });
    provider.emit({ type: "response", status: "completed", responseId: "voice_2" });
    await expect(client.messages.wait("transcript.delta")).resolves.toMatchObject({
      text: "We can keep talking.",
      final: true,
    });
    expect(start.settled).toBe(false);

    start.resolve({ runId: "run_deferred", status: "queued" });
    await expect(client.messages.wait("task.started", (message) => message.taskId === receipt.response.task_id)).resolves
      .toMatchObject({ taskId: receipt.response.task_id });
  });

  it("projects a stop during blocked dispatch as stopping until the exact Hermes run can be stopped", async () => {
    const start = deferred<StartRunResult>();
    const config = testConfig();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => start.promise;
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const first = await readyClient(server.url);

    provider.emit({ type: "tool_call", call: backgroundTaskCall("blocked_dispatch", "Dispatch slowly") });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "blocked_dispatch");
    const taskId = String(receipt.response.task_id);
    await waitForStoredTask(config.tasks.stateFile, taskId, "dispatching");

    send(first.socket, { type: "task.stop", id: "stop_blocked_dispatch", taskId });
    await expect(first.messages.wait(
      "task.stopping",
      (message) => message.taskId === taskId && message.requestId === "stop_blocked_dispatch",
    )).resolves.toMatchObject({ taskId, requestId: "stop_blocked_dispatch" });
    expect(storedTask(config.tasks.stateFile, taskId)).toMatchObject({
      status: "dispatching",
      stopRequestedAt: expect.any(Number),
    });

    send(first.socket, { type: "task.list", id: "list_blocked_dispatch", limit: 10 });
    const listed = await first.messages.wait(
      "task.snapshot",
      (message) => message.requestId === "list_blocked_dispatch",
    );
    expect(listed.tasks).toEqual([expect.objectContaining({ taskId, state: "stopping" })]);
    expect(listed.tasks[0]).not.toHaveProperty("queuePosition");

    send(first.socket, { type: "task.get", id: "get_blocked_dispatch", taskId });
    await expect(first.messages.wait(
      "task.snapshot",
      (message) => message.requestId === "get_blocked_dispatch",
    )).resolves.toMatchObject({ tasks: [expect.objectContaining({ taskId, state: "stopping" })] });

    provider.emit({
      type: "tool_call",
      call: { id: "tool_stop_blocked_dispatch", name: "stop_background_task", args: { task_id: taskId } },
    });
    await expect(provider.latest.toolResponses.wait(
      (entry) => entry.call.id === "tool_stop_blocked_dispatch",
    )).resolves.toMatchObject({ response: { ok: true, task_id: taskId, status: "stopping" } });

    first.socket.terminate();
    await first.messages.waitForClose();
    const second = await readyClient(server.url, { expectedSnapshotReason: "reconnect" });
    expect(second.initialSnapshot.tasks).toEqual([
      expect.objectContaining({ taskId, state: "stopping" }),
    ]);

    start.resolve({ runId: "run_blocked_dispatch", status: "started" });
    await waitUntil(() => hermes.stopCalls.includes("run_blocked_dispatch"));
    expect(hermes.stopCalls).toEqual(["run_blocked_dispatch"]);
    await waitForStoredTask(config.tasks.stateFile, taskId, "stopping");
  });

  it("never exposes a private task-store path when persistence rejects a provider task", async () => {
    const config = testConfig();
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const logger = fakeLogger();
    const server = await startTestServer({ config, hermes, provider, logger });
    const client = await readyClient(server.url);
    const stateDirectory = dirname(config.tasks.stateFile);

    try {
      rmSync(stateDirectory, { recursive: true, force: true });
      writeFileSync(stateDirectory, "not a task-store directory", { mode: 0o600 });
      provider.emit({
        type: "tool_call",
        call: backgroundTaskCall("private_store_failure", "Persist this task"),
      });

      const toolResponse = await provider.latest.toolResponses.wait(
        (entry) => entry.call.id === "private_store_failure",
      );
      const clientError = await client.messages.wait(
        "session.error",
        (message) => message.code === "tool_call_failed",
      );
      const publicFrames = JSON.stringify([toolResponse.response, clientError]);

      expect(toolResponse.response).toEqual({
        ok: false,
        error: "Background task could not be accepted safely.",
      });
      expect(clientError).toMatchObject({
        code: "tool_call_failed",
        message: "Background task could not be accepted safely.",
        recoverable: true,
      });
      expect(publicFrames).not.toContain(stateDirectory);
      expect(publicFrames).not.toContain("tasks-v1.json");
      expect(publicFrames).not.toContain("EACCES");
      expect(logger.warn).toHaveBeenCalledWith(
        "live session operation failed",
        expect.objectContaining({ code: "tool_call_failed" }),
      );
    } finally {
      rmSync(stateDirectory, { force: true });
      mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
    }
  });

  it("never exposes a private task-store path when a client task control cannot persist", async () => {
    const config = testConfig();
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const logger = fakeLogger();
    const server = await startTestServer({ config, hermes, provider, logger });
    const client = await readyClient(server.url);

    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("client_store_failure_seed", "Keep this task running"),
    });
    const receipt = await provider.latest.toolResponses.wait(
      (entry) => entry.call.id === "client_store_failure_seed",
    );
    const taskId = String(receipt.response.task_id);
    await client.messages.wait("task.started", (message) => message.taskId === taskId);

    const stateDirectory = dirname(config.tasks.stateFile);
    try {
      rmSync(stateDirectory, { recursive: true, force: true });
      writeFileSync(stateDirectory, "not a task-store directory", { mode: 0o600 });
      send(client.socket, {
        type: "task.stop",
        id: "private_client_store_failure",
        taskId,
        reason: "exact test stop",
      });

      const clientError = await client.messages.wait(
        "session.error",
        (message) => message.requestId === "private_client_store_failure",
      );
      const publicFrame = JSON.stringify(clientError);

      expect(clientError).toMatchObject({
        code: "client_message_failed",
        message: "Unable to stop that background task safely.",
        requestId: "private_client_store_failure",
        recoverable: false,
      });
      expect(publicFrame).not.toContain(stateDirectory);
      expect(publicFrame).not.toContain("tasks-v1.json");
      expect(publicFrame).not.toContain("EEXIST");
      expect(logger.warn).toHaveBeenCalledWith(
        "live session operation failed",
        expect.objectContaining({ code: "client_message_failed" }),
      );
    } finally {
      rmSync(stateDirectory, { force: true });
      mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
    }
  });

  it("detaches without stopping Hermes, reconnects from disk, and delivers one stable unread notification", async () => {
    const config = testConfig();
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const first = await readyClient(server.url);

    const secretTitle = "TOP SECRET deployment title";
    const secretOutput = "TOP SECRET retained result";
    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("persist_1", "Perform durable work", { title: secretTitle }),
    });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "persist_1");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    const runId = hermes.runIdForInput("Perform durable work");

    first.socket.terminate();
    await first.messages.waitForClose();
    expect(hermes.stopCalls).toEqual([]);

    hermes.complete(runId, secretOutput);
    await waitForStoredTask(config.tasks.stateFile, taskId, "completed");

    const second = await readyClient(server.url, { expectedSnapshotReason: "reconnect" });
    const reconnectSnapshot = second.initialSnapshot;
    expect(reconnectSnapshot.tasks).toEqual([
      expect.objectContaining({ taskId, state: "completed", result: expect.objectContaining({ summary: secretOutput, truncated: true }) }),
    ]);
    const notification = await second.messages.wait(
      "task.notification",
      (message) => message.taskId === taskId && message.notification.acknowledged === false,
    );
    expect(notification.notification.notificationId).toMatch(
      new RegExp(`^notification_${taskId}_[0-9]+$`),
    );
    const spoken = await provider.latest.notifications.wait();
    expect(spoken.announcement).toBe("Your background task is finished. The result is ready in the task inbox.");
    expect(spoken.context).not.toContain(secretTitle);
    expect(spoken.context).not.toContain(secretOutput);
    expect(spoken.announcement).not.toContain(secretTitle);
    expect(spoken.announcement).not.toContain(secretOutput);
    await waitUntil(() => storedTask(config.tasks.stateFile, taskId)?.notification?.announcedAt !== undefined);
    const preAckNotifications = second.messages.observed.filter(
      (message) => message.type === "task.notification" && message.taskId === taskId,
    );
    expect(preAckNotifications.map((message) => ({
      sequence: message.sequence,
      requestId: message.requestId,
      acknowledged: message.notification.acknowledged,
    }))).toEqual([{ sequence: notification.sequence, requestId: undefined, acknowledged: false }]);

    send(second.socket, {
      type: "task.notification.ack",
      id: "ack_reconnect_1",
      taskId,
      notificationId: notification.notification.notificationId,
    });
    const acknowledged = await second.messages.wait(
      "task.notification",
      (message) => message.requestId === "ack_reconnect_1",
    );
    expect(acknowledged.notification).toMatchObject({
      notificationId: notification.notification.notificationId,
      acknowledged: true,
    });

    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("detach_2", "Keep running after session.close", { resource_keys: ["repo:two"] }),
    });
    await provider.latest.toolResponses.wait((entry) => entry.call.id === "detach_2");
    await waitUntil(() => hermes.startCalls.length === 2);
    send(second.socket, { type: "session.close", id: "detach_now", detach: true });
    await expect(second.messages.waitForClose()).resolves.toMatchObject({ code: 1000 });
    expect(hermes.stopCalls).toEqual([]);
  });

  it("reprojects an announced unread notification on every reconnect without repeating provider speech", async () => {
    const config = testConfig();
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const first = await readyClient(server.url);

    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("reconnect_notice_1", "Finish before reconnect"),
    });
    const receipt = await provider.latest.toolResponses.wait(
      (entry) => entry.call.id === "reconnect_notice_1",
    );
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    hermes.complete(hermes.runIdForInput("Finish before reconnect"), "durable result");

    const firstNotification = await first.messages.wait(
      "task.notification",
      (message) => message.taskId === taskId && message.notification.acknowledged === false,
    );
    await provider.connection(0).notifications.wait();
    await waitUntil(() => storedTask(config.tasks.stateFile, taskId)?.notification?.announcedAt !== undefined);
    expect(provider.connection(0).notifications.items).toHaveLength(1);

    first.socket.terminate();
    await first.messages.waitForClose();

    const second = await readyClient(server.url, { expectedSnapshotReason: "reconnect" });
    const secondNotification = await second.messages.wait(
      "task.notification",
      (message) => message.taskId === taskId && message.notification.acknowledged === false,
    );
    expect(secondNotification.notification.notificationId).toBe(
      firstNotification.notification.notificationId,
    );
    expect(second.messages.observed.filter(
      (message) => message.type === "task.notification" && message.taskId === taskId,
    )).toHaveLength(1);
    expect(provider.connection(1).notifications.items).toEqual([]);

    second.socket.terminate();
    await second.messages.waitForClose();

    const third = await readyClient(server.url, { expectedSnapshotReason: "reconnect" });
    const thirdNotification = await third.messages.wait(
      "task.notification",
      (message) => message.taskId === taskId && message.notification.acknowledged === false,
    );
    expect(thirdNotification.notification.notificationId).toBe(
      firstNotification.notification.notificationId,
    );
    expect(third.messages.observed.filter(
      (message) => message.type === "task.notification" && message.taskId === taskId,
    )).toHaveLength(1);
    expect(provider.connection(2).notifications.items).toEqual([]);

    send(third.socket, {
      type: "task.notification.ack",
      id: "ack_after_reconnects",
      taskId,
      notificationId: thirdNotification.notification.notificationId,
    });
    await expect(third.messages.wait(
      "task.notification",
      (message) => message.requestId === "ack_after_reconnects",
    )).resolves.toMatchObject({ notification: { acknowledged: true } });
    await waitUntil(() => storedTask(config.tasks.stateFile, taskId)?.notification?.unread === false);

    third.socket.terminate();
    await third.messages.waitForClose();
    const fourth = await readyClient(server.url, { expectedSnapshotReason: "reconnect" });
    await fourth.messages.expectNone("task.notification", 50);
    expect(provider.connections.flatMap((connection) => connection.notifications.items)).toHaveLength(1);
  });

  it("hydrates every retained active and unread task beyond the recent-history window", async () => {
    const config = testConfig({ tasks: { historyLimit: 200 } });
    const ownerIdentity = defaultSessionKey;
    const baseTime = Date.now() - 20_000;
    const active = seededRunningTask(ownerIdentity, "Old active task", baseTime, "run_seed_active");
    const unread = seededCompletedTask(ownerIdentity, "Old unread task", baseTime + 10, "run_seed_unread", false);
    const recent = Array.from({ length: 101 }, (_, index) => seededCompletedTask(
      ownerIdentity,
      `Recent terminal task ${index}`,
      baseTime + 1_000 + index * 10,
      `run_seed_recent_${index}`,
      true,
    ));
    await seedTaskState(config, [active, unread, ...recent]);

    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const client = await readyClient(server.url, { expectedSnapshotReason: "reconnect" });

    await waitUntil(() => client.messages.observed.filter(
      (message) => message.type === "task.snapshot" && message.reason === "reconnect",
    ).length >= 2);
    const hydrationFrames = client.messages.observed.filter(
      (message) => message.type === "task.snapshot" && message.reason === "reconnect",
    );
    expect(hydrationFrames.every((message) => message.tasks.length <= 100)).toBe(true);
    const hydratedTaskIds = hydrationFrames.flatMap((message) => message.tasks.map((task: JsonMessage) => task.taskId));
    expect(hydratedTaskIds).toContain(active.taskId);
    expect(hydratedTaskIds).toContain(unread.taskId);

    await expect(client.messages.wait(
      "task.notification",
      (message) => message.taskId === unread.taskId && message.notification.acknowledged === false,
    )).resolves.toMatchObject({ taskId: unread.taskId });

    send(client.socket, { type: "task.list", id: "bounded_history", limit: 100 });
    await expect(client.messages.wait(
      "task.snapshot",
      (message) => message.requestId === "bounded_history",
    )).resolves.toMatchObject({ reason: "list", tasks: expect.any(Array), truncated: true });
    const listResponse = client.messages.observed.find((message) => message.requestId === "bounded_history");
    expect(listResponse?.tasks).toHaveLength(100);
  });

  it("claims completion speech once across sessions and broadcasts acknowledgement to every client", async () => {
    const config = testConfig();
    const record = seededCompletedTask(
      defaultSessionKey,
      "One shared completion",
      Date.now() - 1_000,
      "run_seed_shared_notice",
      false,
    );
    await seedTaskState(config, [record]);
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes: new HermesHarness(), provider });

    const [first, second] = await Promise.all([
      readyClient(server.url, { expectedSnapshotReason: "reconnect" }),
      readyClient(server.url, { expectedSnapshotReason: "reconnect" }),
    ]);
    const [firstNotice, secondNotice] = await Promise.all([
      first.messages.wait("task.notification", (message) => message.taskId === record.taskId),
      second.messages.wait("task.notification", (message) => message.taskId === record.taskId),
    ]);
    expect(secondNotice.notification.notificationId).toBe(firstNotice.notification.notificationId);

    await waitUntil(() => provider.connections.reduce(
      (count, connection) => count + connection.notifications.items.length,
      0,
    ) === 1);
    await delay(50);
    expect(provider.connections.reduce(
      (count, connection) => count + connection.notifications.items.length,
      0,
    )).toBe(1);

    send(first.socket, {
      type: "task.notification.ack",
      id: "shared_ack",
      taskId: record.taskId,
      notificationId: firstNotice.notification.notificationId,
    });
    await expect(first.messages.wait(
      "task.notification",
      (message) => message.requestId === "shared_ack",
    )).resolves.toMatchObject({ notification: { acknowledged: true } });
    await expect(second.messages.wait(
      "task.notification",
      (message) => message.taskId === record.taskId && message.notification.acknowledged === true,
    )).resolves.toMatchObject({ notification: { acknowledged: true } });
  });

  it("persists notification speech only after the provider accepts it and retries a failed handoff", async () => {
    const config = testConfig();
    const record = seededCompletedTask(
      defaultSessionKey,
      "Retry completion speech",
      Date.now() - 1_000,
      "run_seed_retry_notice",
      false,
    );
    await seedTaskState(config, [record]);
    const firstAttempt = deferred<void>();
    let attempts = 0;
    const provider = new RecordingLiveAdapter();
    provider.sessionFactory = (params) => {
      const session = new RecordingLiveSession(params);
      session.notificationBehavior = async () => {
        attempts += 1;
        if (attempts === 1) {
          await firstAttempt.promise;
          throw new Error("provider rejected notification");
        }
      };
      return session;
    };
    const server = await startTestServer({ config, hermes: new HermesHarness(), provider });
    await readyClient(server.url, { expectedSnapshotReason: "reconnect" });

    await waitUntil(() => provider.latest.notificationCalls.length === 1);
    expect(storedTask(config.tasks.stateFile, record.taskId)?.notification?.announcedAt).toBeUndefined();
    firstAttempt.resolve();
    await provider.latest.notifications.wait();
    expect(provider.latest.notificationCalls).toHaveLength(2);
    await waitUntil(() => storedTask(config.tasks.stateFile, record.taskId)?.notification?.announcedAt !== undefined);
  });

  it("retries within the same session when provider speech succeeds but its durable marker fails", async () => {
    const config = testConfig();
    const record = seededCompletedTask(
      defaultSessionKey,
      "Retry completion persistence",
      Date.now() - 1_000,
      "run_seed_retry_persistence",
      false,
    );
    await seedTaskState(config, [record]);
    const hermes = new HermesHarness();
    const store = new FileTaskStore({
      directory: dirname(config.tasks.stateFile),
      filename: basename(config.tasks.stateFile),
      maxRecords: config.tasks.historyLimit + config.tasks.maxConcurrent + config.tasks.maxQueued,
      retentionMs: config.tasks.retentionMs,
    });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      maxConcurrent: config.tasks.maxConcurrent,
      maxQueued: config.tasks.maxQueued,
      pollIntervalMs: config.tasks.pollIntervalMs,
    });
    vi.spyOn(supervisor, "completeNotificationAnnouncement")
      .mockRejectedValueOnce(new Error("temporary task-state write failure"));
    const provider = new RecordingLiveAdapter();
    provider.sessionFactory = (params) => {
      const session = new RecordingLiveSession(params);
      session.notificationBehavior = async () => {
        params.callbacks.onEvent({ type: "response", status: "completed" });
      };
      return session;
    };
    const server = await startServer({
      config,
      hermes,
      liveModel: provider,
      taskSupervisor: supervisor,
      logger: fakeLogger(),
    });
    openServers.push(server);
    await readyClient(server.url, { expectedSnapshotReason: "reconnect" });

    await waitUntil(() => provider.latest.notificationCalls.length === 2);
    await waitUntil(() => storedTask(config.tasks.stateFile, record.taskId)?.notification?.announcedAt !== undefined);
    expect(provider.latest.notifications.items).toHaveLength(2);
  });

  it("retries a transient notification claim failure instead of stranding the durable notice", async () => {
    const config = testConfig();
    const record = seededCompletedTask(
      defaultSessionKey,
      "Retry notification claim",
      Date.now() - 1_000,
      "run_seed_retry_claim",
      false,
    );
    await seedTaskState(config, [record]);
    const hermes = new HermesHarness();
    const store = new FileTaskStore({
      directory: dirname(config.tasks.stateFile),
      filename: basename(config.tasks.stateFile),
      maxRecords: config.tasks.historyLimit + config.tasks.maxConcurrent + config.tasks.maxQueued,
      retentionMs: config.tasks.retentionMs,
      terminalReserveSlots: config.tasks.maxConcurrent,
    });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      maxConcurrent: config.tasks.maxConcurrent,
      maxQueued: config.tasks.maxQueued,
      pollIntervalMs: config.tasks.pollIntervalMs,
    });
    const claim = vi.spyOn(supervisor, "claimNotificationAnnouncement");
    claim.mockRejectedValueOnce(new Error("temporary task-state read failure"));
    const provider = new RecordingLiveAdapter();
    provider.sessionFactory = (params) => {
      const session = new RecordingLiveSession(params);
      session.notificationBehavior = async () => {
        params.callbacks.onEvent({ type: "response", status: "completed" });
      };
      return session;
    };
    const server = await startServer({
      config,
      hermes,
      liveModel: provider,
      taskSupervisor: supervisor,
      logger: fakeLogger(),
    });
    openServers.push(server);
    await readyClient(server.url, { expectedSnapshotReason: "reconnect" });

    await waitUntil(() => claim.mock.calls.length === 2);
    await waitUntil(() => provider.latest.notificationCalls.length === 1);
    await waitUntil(() => storedTask(config.tasks.stateFile, record.taskId)?.notification?.announcedAt !== undefined);
  });

  it("re-arms a notification retry that expires while another claim is still in flight", async () => {
    const config = testConfig();
    const first = seededCompletedTask(
      defaultSessionKey,
      "Retry after a long claim batch",
      Date.now() - 2_000,
      "run_seed_long_claim_first",
      false,
    );
    const second = seededCompletedTask(
      defaultSessionKey,
      "Complete the long claim batch",
      Date.now() - 1_000,
      "run_seed_long_claim_second",
      false,
    );
    await seedTaskState(config, [first, second]);
    const hermes = new HermesHarness();
    const store = new FileTaskStore({
      directory: dirname(config.tasks.stateFile),
      filename: basename(config.tasks.stateFile),
      maxRecords: config.tasks.historyLimit + config.tasks.maxConcurrent + config.tasks.maxQueued,
      retentionMs: config.tasks.retentionMs,
      terminalReserveSlots: config.tasks.maxConcurrent,
    });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      maxConcurrent: config.tasks.maxConcurrent,
      maxQueued: config.tasks.maxQueued,
      pollIntervalMs: config.tasks.pollIntervalMs,
    });
    const originalClaim = supervisor.claimNotificationAnnouncement.bind(supervisor);
    const secondClaimEntered = deferred<void>();
    const releaseSecondClaim = deferred<void>();
    let claimCalls = 0;
    vi.spyOn(supervisor, "claimNotificationAnnouncement").mockImplementation(async (...args) => {
      claimCalls += 1;
      if (claimCalls === 1) throw new Error("temporary first-claim failure");
      if (claimCalls === 2) {
        secondClaimEntered.resolve();
        await releaseSecondClaim.promise;
      }
      return originalClaim(...args);
    });
    const provider = new RecordingLiveAdapter();
    provider.sessionFactory = (params) => {
      const session = new RecordingLiveSession(params);
      session.notificationBehavior = async () => {
        params.callbacks.onEvent({ type: "response", status: "completed" });
      };
      return session;
    };
    const server = await startServer({
      config,
      hermes,
      liveModel: provider,
      taskSupervisor: supervisor,
      logger: fakeLogger(),
    });
    openServers.push(server);
    await readyClient(server.url, { expectedSnapshotReason: "reconnect" });
    await secondClaimEntered.promise;

    // The first retry expires after 250 ms. Keep the second claim blocked past
    // that deadline so the timer has to re-arm instead of being consumed.
    await delay(350);
    releaseSecondClaim.resolve();

    await waitUntil(() => provider.latest.notificationCalls.length === 2);
    await waitUntil(() => [first, second].every((record) =>
      storedTask(config.tasks.stateFile, record.taskId)?.notification?.announcedAt !== undefined));
  });

  it("bounds repeated notification claim failures until a new session reconnects", async () => {
    const config = testConfig();
    const record = seededCompletedTask(
      defaultSessionKey,
      "Persistent notification claim failure",
      Date.now() - 1_000,
      "run_seed_failed_claim",
      false,
    );
    await seedTaskState(config, [record]);
    const hermes = new HermesHarness();
    const store = new FileTaskStore({
      directory: dirname(config.tasks.stateFile),
      filename: basename(config.tasks.stateFile),
      maxRecords: config.tasks.historyLimit + config.tasks.maxConcurrent + config.tasks.maxQueued,
      retentionMs: config.tasks.retentionMs,
      terminalReserveSlots: config.tasks.maxConcurrent,
    });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      maxConcurrent: config.tasks.maxConcurrent,
      maxQueued: config.tasks.maxQueued,
      pollIntervalMs: config.tasks.pollIntervalMs,
    });
    const claim = vi.spyOn(supervisor, "claimNotificationAnnouncement")
      .mockRejectedValue(new Error("task-state reads remain unavailable"));
    const provider = new RecordingLiveAdapter();
    const server = await startServer({
      config,
      hermes,
      liveModel: provider,
      taskSupervisor: supervisor,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const firstClient = await readyClient(server.url, { expectedSnapshotReason: "reconnect" });

    await waitUntil(() => claim.mock.calls.length === 3);
    provider.emit({ type: "response", status: "completed", responseId: "unrelated_idle_event" });
    await delay(800);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(provider.latest.notificationCalls).toHaveLength(0);
    expect(storedTask(config.tasks.stateFile, record.taskId)?.notification).toMatchObject({ unread: true });
    expect(storedTask(config.tasks.stateFile, record.taskId)?.notification?.announcedAt).toBeUndefined();

    claim.mockRestore();
    firstClient.socket.terminate();
    await firstClient.messages.waitForClose();
    await readyClient(server.url, { expectedSnapshotReason: "reconnect" });
    await waitUntil(() => provider.latest.notificationCalls.length === 1);
    await waitUntil(() => storedTask(config.tasks.stateFile, record.taskId)?.notification?.announcedAt !== undefined);
  });

  it("bounds automatic notification speech retries and leaves the durable inbox unread", async () => {
    const config = testConfig();
    const record = seededCompletedTask(
      defaultSessionKey,
      "Provider remains unavailable",
      Date.now() - 1_000,
      "run_seed_failed_notice",
      false,
    );
    await seedTaskState(config, [record]);
    const provider = new RecordingLiveAdapter();
    provider.sessionFactory = (params) => {
      const session = new RecordingLiveSession(params);
      session.notificationBehavior = async () => {
        throw new Error("provider unavailable");
      };
      return session;
    };
    const server = await startTestServer({ config, hermes: new HermesHarness(), provider });
    await readyClient(server.url, { expectedSnapshotReason: "reconnect" });

    await waitUntil(() => provider.latest.notificationCalls.length === 3);
    await delay(800);
    expect(provider.latest.notificationCalls).toHaveLength(3);
    expect(provider.latest.notifications.items).toEqual([]);
    const storedNotification = storedTask(config.tasks.stateFile, record.taskId)?.notification;
    expect(storedNotification).toMatchObject({ unread: true });
    expect(storedNotification?.announcedAt).toBeUndefined();
  });

  it("runs multiple disjoint read-only tasks concurrently and reports out-of-order completion by stable task id", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({
      config: testConfig({ tasks: { trustDeclaredReadOnly: true } }),
      hermes,
      provider,
    });
    const client = await readyClient(server.url);

    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("parallel_a", "Inspect repository A", {
        execution_mode: "parallel_read_only",
        resource_keys: ["repo:a"],
      }),
    });
    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("parallel_b", "Inspect repository B", {
        execution_mode: "parallel_read_only",
        resource_keys: ["repo:b"],
      }),
    });
    const firstReceipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "parallel_a");
    const secondReceipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "parallel_b");
    const firstTaskId = String(firstReceipt.response.task_id);
    const secondTaskId = String(secondReceipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 2);

    hermes.complete(hermes.runIdForInput("Inspect repository B"), "B finished first");
    const secondCompleted = await client.messages.wait("task.completed", (message) => message.taskId === secondTaskId);
    hermes.complete(hermes.runIdForInput("Inspect repository A"), "A finished second");
    const firstCompleted = await client.messages.wait("task.completed", (message) => message.taskId === firstTaskId);

    expect(secondCompleted.result.output).toBe("B finished first");
    expect(firstCompleted.result.output).toBe("A finished second");
    const completionOrder = client.messages.observed
      .filter((message) => message.type === "task.completed")
      .map((message) => message.taskId);
    expect(completionOrder).toEqual([secondTaskId, firstTaskId]);
  });

  it("correlates exact queued/running/terminal task.stop races without broad cancellation", async () => {
    const config = testConfig({ tasks: { maxConcurrent: 1 } });
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const client = await readyClient(server.url);

    provider.emit({ type: "tool_call", call: backgroundTaskCall("stop_active", "Active mutation") });
    provider.emit({ type: "tool_call", call: backgroundTaskCall("stop_queued", "Queued mutation") });
    const activeReceipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "stop_active");
    const queuedReceipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "stop_queued");
    const activeTaskId = String(activeReceipt.response.task_id);
    const queuedTaskId = String(queuedReceipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    await waitForStoredTask(config.tasks.stateFile, queuedTaskId, "queued");

    send(client.socket, { type: "task.stop", id: "stop_queue_req", taskId: queuedTaskId, reason: "No longer needed" });
    await expect(client.messages.wait(
      "task.cancelled",
      (message) => message.taskId === queuedTaskId && message.requestId === "stop_queue_req",
    )).resolves.toMatchObject({ taskId: queuedTaskId, requestId: "stop_queue_req" });
    expect(hermes.stopCalls).toEqual([]);

    const activeRunId = hermes.runIdForInput("Active mutation");
    send(client.socket, { type: "task.stop", id: "stop_active_req", taskId: activeTaskId, reason: "Please stop" });
    await expect(client.messages.wait(
      "task.stopping",
      (message) => message.taskId === activeTaskId && message.requestId === "stop_active_req",
    )).resolves.toMatchObject({ taskId: activeTaskId, requestId: "stop_active_req" });
    expect(hermes.stopCalls).toEqual([activeRunId]);

    hermes.cancel(activeRunId);
    await client.messages.wait("task.cancelled", (message) => message.taskId === activeTaskId);
    send(client.socket, { type: "task.stop", id: "terminal_stop_req", taskId: activeTaskId });
    await expect(client.messages.wait(
      "task.cancelled",
      (message) => message.taskId === activeTaskId && message.requestId === "terminal_stop_req",
    )).resolves.toMatchObject({ requestId: "terminal_stop_req" });
    expect(hermes.stopCalls).toEqual([activeRunId]);
  });

  it("withdraws an unknown notice when an ambiguous exact stop resumes recovery", async () => {
    const config = testConfig({ tasks: { pollIntervalMs: 25 } });
    const hermes = new HermesHarness();
    let stopAttempts = 0;
    hermes.stopBehavior = async (runId) => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("connection closed before exact stop acknowledgement");
      return { run_id: runId, status: "stopping" };
    };
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const client = await readyClient(server.url);

    provider.emit({ type: "tool_call", call: backgroundTaskCall("ambiguous_stop", "Stop recovery task") });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "ambiguous_stop");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);

    send(client.socket, { type: "task.stop", id: "ambiguous_stop_req", taskId });
    await expect(client.messages.wait(
      "task.unknown",
      (message) => message.taskId === taskId && message.requestId === "ambiguous_stop_req",
    )).resolves.toMatchObject({ taskId, requestId: "ambiguous_stop_req" });
    const unknownNotice = await client.messages.wait(
      "task.notification",
      (message) => message.taskId === taskId
        && message.notification.kind === "unknown"
        && message.notification.acknowledged === false,
    );
    const stopping = await client.messages.wait(
      "task.stopping",
      (message) => message.taskId === taskId,
    );
    const withdrawal = await client.messages.wait(
      "task.notification",
      (message) => message.taskId === taskId
        && message.notification.notificationId === unknownNotice.notification.notificationId
        && message.notification.acknowledged === true,
    );

    expect(withdrawal.sequence).toBeGreaterThanOrEqual(stopping.sequence);
    expect(stopAttempts).toBe(2);
    expect(await storedTask(config.tasks.stateFile, taskId)).toMatchObject({
      status: "stopping",
      notification: { unread: false },
    });
  });

  it("correlates task.list/task.get and rejects dead approval controls during protocol validation", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    provider.emit({ type: "tool_call", call: backgroundTaskCall("lookup_task", "Lookup task") });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "lookup_task");
    const taskId = String(receipt.response.task_id);

    send(client.socket, { type: "task.list", id: "list_req", limit: 10 });
    await expect(client.messages.wait("task.snapshot", (message) => message.requestId === "list_req")).resolves
      .toMatchObject({ reason: "list", requestId: "list_req", tasks: [expect.objectContaining({ taskId })] });
    send(client.socket, { type: "task.get", id: "get_req", taskId });
    await expect(client.messages.wait("task.snapshot", (message) => message.requestId === "get_req")).resolves
      .toMatchObject({ reason: "get", requestId: "get_req", tasks: [expect.objectContaining({ taskId })] });

    send(client.socket, {
      type: "approval.respond",
      id: "approval_req",
      taskId,
      approvalId: "approval_opaque",
      choice: "once",
    });
    await expect(client.messages.wait("session.error", (message) => message.requestId === "approval_req")).resolves
      .toMatchObject({ code: "client_message_failed", requestId: "approval_req", recoverable: false });
    expect(hermes.approvalCalls).toEqual([]);
  });

  it("isolates trusted client identities and does not reveal or stop another owner's task", async () => {
    const config = testConfig({ server: { trustClientIdentity: true } });
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config, hermes, provider });
    const alice = await readyClient(server.url, { profileId: "alice", userLabel: "Alice" });
    const bob = await readyClient(server.url, { profileId: "bob", userLabel: "Bob" });

    provider.emit({ type: "tool_call", call: backgroundTaskCall("alice_task", "Alice private work") }, 0);
    const receipt = await provider.connection(0).toolResponses.wait((entry) => entry.call.id === "alice_task");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    expect(hermes.startCalls[0]?.sessionKey).toContain(":profile:alice:user:alice");

    send(bob.socket, { type: "task.get", id: "bob_get", taskId });
    await expect(bob.messages.wait("task.snapshot", (message) => message.requestId === "bob_get")).resolves
      .toMatchObject({ tasks: [] });
    send(bob.socket, { type: "task.stop", id: "bob_stop", taskId });
    await expect(bob.messages.wait("session.error", (message) => message.requestId === "bob_stop")).resolves
      .toMatchObject({ code: "client_message_failed", requestId: "bob_stop" });
    expect(hermes.stopCalls).toEqual([]);

    send(alice.socket, { type: "task.get", id: "alice_get", taskId });
    await expect(alice.messages.wait("task.snapshot", (message) => message.requestId === "alice_get")).resolves
      .toMatchObject({ tasks: [expect.objectContaining({ taskId })] });
  });

  it("returns an actionable protocol error to legacy v2 clients before provider startup", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await connectClient(server.url);

    send(client.socket, { type: "session.start", id: "legacy_v2", protocolVersion: 2 });
    await expect(client.messages.wait("session.error")).resolves.toMatchObject({
      code: "unsupported_protocol_version",
      requestId: "legacy_v2",
      recoverable: false,
      message: expect.stringMatching(/protocol v2.*protocols v3, v4.*Upgrade/),
    });
    expect(hermes.assertRunsCalls).toBe(0);
    expect(provider.connections).toHaveLength(0);
  });
});

describe("realtime provider lifecycle boundaries", () => {
  it("sanitizes Hermes and realtime startup failures with request correlation", async () => {
    const hermesFailure = new HermesHarness();
    hermesFailure.assertError = new Error("HERMES_STARTUP_SECRET");
    const firstServer = await startTestServer({
      config: testConfig(),
      hermes: hermesFailure,
      provider: new RecordingLiveAdapter(),
    });
    const first = await connectClient(firstServer.url);
    send(first.socket, { type: "session.start", id: "hermes_start_fail", protocolVersion: 3 });
    const hermesError = await first.messages.wait("session.error");
    expect(hermesError).toMatchObject({ code: "session_start_failed", requestId: "hermes_start_fail", recoverable: true });
    expect(hermesError.message).toContain("Hermes Agent is not ready");
    expect(JSON.stringify(hermesError)).not.toContain("HERMES_STARTUP_SECRET");

    const secondServer = await startTestServer({
      config: testConfig(),
      hermes: new HermesHarness(),
      provider: new FailingConnectAdapter("REALTIME_STARTUP_SECRET"),
    });
    const second = await connectClient(secondServer.url);
    send(second.socket, { type: "session.start", id: "provider_start_fail", protocolVersion: 3 });
    const providerError = await second.messages.wait("session.error");
    expect(providerError).toMatchObject({ code: "session_start_failed", requestId: "provider_start_fail", recoverable: true });
    expect(providerError.message).toContain("failed to start");
    expect(JSON.stringify(providerError)).not.toContain("REALTIME_STARTUP_SECRET");
  });

  it("waits for provider open, buffers safe pre-ready events, and times out a provider that never opens", async () => {
    const delayed = new RecordingLiveAdapter({ autoOpen: false });
    const delayedServer = await startTestServer({ config: testConfig(), hermes: new HermesHarness(), provider: delayed });
    const delayedClient = await connectClient(delayedServer.url);
    send(delayedClient.socket, { type: "session.start", id: "delayed_open", protocolVersion: 3 });
    await waitUntil(() => delayed.connections.length === 1);
    delayed.emit({ type: "text", text: "Buffered before ready.", speaker: "system", final: true });
    await delayedClient.messages.expectNone("session.ready", 30);
    delayed.open();
    await expect(delayedClient.messages.wait("session.ready")).resolves.toMatchObject({ requestId: "delayed_open" });
    await expect(delayedClient.messages.wait("transcript.delta")).resolves.toMatchObject({
      speaker: "system",
      text: "Buffered before ready.",
      final: true,
    });

    const neverOpen = new RecordingLiveAdapter({ autoOpen: false });
    const timeoutServer = await startTestServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 20 } }),
      hermes: new HermesHarness(),
      provider: neverOpen,
    });
    const timeoutClient = await connectClient(timeoutServer.url);
    send(timeoutClient.socket, { type: "session.start", id: "never_open", protocolVersion: 3 });
    await expect(timeoutClient.messages.wait("session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      requestId: "never_open",
      message: "Realtime provider did not become ready within 20ms.",
    });
    expect(neverOpen.latest.closeCalls).toBe(1);
  });

  it("bounds a provider connection that never resolves", async () => {
    const server = await startTestServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 20 } }),
      hermes: new HermesHarness(),
      provider: new NeverConnectAdapter(),
    });
    const client = await connectClient(server.url);
    send(client.socket, { type: "session.start", id: "never_connect", protocolVersion: 3 });
    await expect(client.messages.wait("session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      requestId: "never_connect",
      message: "Realtime provider did not connect within 20ms.",
    });
  });

  it.each(["error", "close"] as const)("latches a provider %s before ready and never emits session.ready", async (kind) => {
    const provider = new RecordingLiveAdapter({ autoOpen: false });
    const server = await startTestServer({ config: testConfig(), hermes: new HermesHarness(), provider });
    const client = await connectClient(server.url);
    send(client.socket, { type: "session.start", id: `pre_ready_${kind}`, protocolVersion: 3 });
    await waitUntil(() => provider.connections.length === 1);
    if (kind === "error") provider.error(new Error("PRE_READY_SECRET"));
    else provider.closeFromProvider({ code: 1006, reason: "PRE_READY_SECRET" });

    const failed = await client.messages.wait("session.error");
    expect(failed).toMatchObject({ code: "session_start_failed", requestId: `pre_ready_${kind}` });
    expect(JSON.stringify(failed)).not.toContain("PRE_READY_SECRET");
    provider.open();
    await client.messages.expectNone("session.ready", 50);
  });

  it("sanitizes post-ready provider errors and closes on an unexpected provider close", async () => {
    const logger = fakeLogger();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes: new HermesHarness(), provider, logger });
    const client = await readyClient(server.url);

    provider.error(new Error("POST_READY_PROVIDER_SECRET"));
    const error = await client.messages.wait("session.error");
    expect(error).toMatchObject({ code: "realtime_provider_error", recoverable: true });
    expect(JSON.stringify(error)).not.toContain("POST_READY_PROVIDER_SECRET");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("POST_READY_PROVIDER_SECRET");

    provider.closeFromProvider({ code: 1006, reason: "PROVIDER_CLOSE_SECRET" });
    await expect(client.messages.wait("session.error", (message) => message.code === "realtime_provider_closed")).resolves
      .toMatchObject({ recoverable: true });
    await expect(client.messages.waitForClose()).resolves.toMatchObject({ code: 1011 });
  });

  it("bounds a provider that never confirms close", async () => {
    const logger = fakeLogger();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes: new HermesHarness(), provider, logger });
    const client = await readyClient(server.url);
    provider.latest.closeBehavior = async () => new Promise<never>(() => undefined);

    send(client.socket, { type: "session.close", id: "hung_provider_close", detach: true });
    await expect(client.messages.waitForClose(7_000)).resolves.toMatchObject({ code: 1000 });
    expect(provider.latest.closeCalls).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "failed to confirm realtime provider closure",
      expect.objectContaining({ error: expect.stringContaining("deadline") }),
    );
  }, 8_000);
});

describe("transport, tool-call, and notification safety", () => {
  it("forwards bounded transcript/audio metadata and fails closed on oversized provider output", async () => {
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({
      config: testConfig({ server: { maxAudioBytes: 4 } }),
      hermes: new HermesHarness(),
      provider,
    });
    const client = await readyClient(server.url);

    provider.emit({ type: "text", text: "Spoken input", speaker: "user", final: true });
    provider.emit({
      type: "audio",
      audio: {
        data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        mimeType: "audio/pcm;rate=24000",
        itemId: "audio_item_1",
        contentIndex: 0,
      },
    });
    await expect(client.messages.wait("transcript.delta")).resolves.toMatchObject({
      speaker: "user",
      text: "Spoken input",
      final: true,
    });
    await expect(client.messages.wait("audio.output")).resolves.toMatchObject({
      itemId: "audio_item_1",
      contentIndex: 0,
    });

    provider.emit({ type: "text", text: "x".repeat(20_001) });
    await expect(client.messages.wait("session.error")).resolves.toMatchObject({
      code: "realtime_provider_event_invalid",
      message: "Realtime provider emitted an invalid event.",
    });
    await expect(client.messages.waitForClose()).resolves.toMatchObject({ code: 1011 });
  });

  it("fails closed when a provider emits an oversized audio frame", async () => {
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({
      config: testConfig({ server: { maxAudioBytes: 2 } }),
      hermes: new HermesHarness(),
      provider,
    });
    const client = await readyClient(server.url);
    provider.emit({
      type: "audio",
      audio: { data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "audio/pcm;rate=24000" },
    });
    await expect(client.messages.wait("session.error")).resolves.toMatchObject({
      code: "realtime_provider_event_invalid",
      message: "Realtime provider emitted an invalid event.",
    });
    await expect(client.messages.waitForClose()).resolves.toMatchObject({ code: 1011 });
  });

  it("rejects oversized text and malformed PCM before forwarding them to the provider", async () => {
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({
      config: testConfig({ server: { maxTextChars: 4, maxAudioBytes: 4 } }),
      hermes: new HermesHarness(),
      provider,
    });
    const client = await readyClient(server.url);
    send(client.socket, { type: "text.input", id: "too_long", text: "12345" });
    await expect(client.messages.wait("session.error", (message) => message.requestId === "too_long")).resolves
      .toMatchObject({ code: "client_message_failed", requestId: "too_long" });
    expect(provider.latest.textInputs).toEqual([]);

    send(client.socket, {
      type: "audio.input",
      id: "odd_pcm",
      data: Buffer.from([1]).toString("base64"),
      mimeType: "audio/pcm;rate=24000",
    });
    await expect(client.messages.wait("session.error", (message) => message.requestId === "odd_pcm")).resolves
      .toMatchObject({ code: "client_message_failed", requestId: "odd_pcm", message: expect.stringContaining("even") });
    expect(provider.latest.audioInputs).toEqual([]);
  });

  it("closes a client that outruns the bounded inbound queue", async () => {
    const provider = new RecordingLiveAdapter();
    const blocked = deferred<void>();
    provider.sessionFactory = (params) => {
      const session = new RecordingLiveSession(params);
      session.textBehavior = async () => blocked.promise;
      session.closeBehavior = async () => blocked.resolve();
      return session;
    };
    const server = await startTestServer({ config: testConfig(), hermes: new HermesHarness(), provider });
    const client = await readyClient(server.url);
    for (let index = 0; index < 270; index += 1) {
      send(client.socket, { type: "text.input", id: `flood_${index}`, text: "queued" });
    }
    await expect(client.messages.wait("session.error", (message) => message.code === "client_input_backpressure")).resolves
      .toMatchObject({ recoverable: false });
    await expect(client.messages.waitForClose()).resolves.toMatchObject({ code: 1009 });
  });

  it("keeps response.cancel separate from durable task cancellation", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    provider.emit({ type: "tool_call", call: backgroundTaskCall("cancel_voice_task", "Keep task alive") });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "cancel_voice_task");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    await client.messages.wait("task.started", (message) => message.taskId === taskId);

    send(client.socket, {
      type: "response.cancel",
      id: "cancel_voice",
      reason: "interrupted",
      truncate: { itemId: "item_1", contentIndex: 0, audioEndMs: 320 },
    });
    await expect(client.messages.wait("log", (message) => message.message.includes("cancellation requested"))).resolves
      .toMatchObject({ level: "info" });
    expect(provider.latest.cancelCalls).toEqual([
      { reason: "interrupted", truncate: { itemId: "item_1", contentIndex: 0, audioEndMs: 320 } },
    ]);
    expect(hermes.stopCalls).toEqual([]);
    send(client.socket, { type: "task.get", id: "still_running", taskId });
    await expect(client.messages.wait("task.snapshot", (message) => message.requestId === "still_running")).resolves
      .toMatchObject({ tasks: [expect.objectContaining({ taskId, state: "running" })] });
  });

  it("deduplicates exact provider tool-call replay and closes on conflicting id reuse", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    const call = backgroundTaskCall("dedupe_call", "Perform exactly once");
    provider.emit({ type: "tool_call", call });
    const first = await provider.latest.toolResponses.wait((entry) => entry.call.id === call.id);
    provider.emit({ type: "tool_call", call: structuredClone(call) });
    const replay = await provider.latest.toolResponses.wait((entry) => entry.call.id === call.id);
    expect(replay.response).toEqual(first.response);
    await waitUntil(() => hermes.startCalls.length === 1);

    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("dedupe_call", "Different mutation under reused id"),
    });
    await expect(client.messages.wait("session.error")).resolves.toMatchObject({
      code: "realtime_tool_call_conflict",
      recoverable: false,
    });
    await expect(client.messages.waitForClose()).resolves.toMatchObject({ code: 1011 });
    expect(hermes.startCalls).toHaveLength(1);
    expect(hermes.stopCalls).toEqual([]);
  });

  it("tombstones evicted tool-call ids and fails closed instead of repeating a mutation", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    const mutatingCall = backgroundTaskCall("old_mutation", "Execute this mutation exactly once");

    provider.emit({ type: "tool_call", call: mutatingCall });
    await provider.latest.toolResponses.wait((entry) => entry.call.id === mutatingCall.id);
    await waitUntil(() => hermes.startCalls.length === 1);

    // The detailed response cache retains 256 calls. The next completed call
    // compacts the oldest id and fingerprint into the lifetime replay ledger.
    for (let index = 1; index <= 256; index += 1) {
      const call: LiveToolCall = {
        id: `ledger_fill_${index}`,
        name: "list_background_tasks",
        args: { include_completed: false },
      };
      provider.emit({ type: "tool_call", call });
      await provider.latest.toolResponses.wait((entry) => entry.call.id === call.id);
    }

    provider.emit({ type: "tool_call", call: structuredClone(mutatingCall) });
    await expect(client.messages.wait("session.error")).resolves.toMatchObject({
      code: "realtime_tool_call_replay_expired",
      recoverable: false,
    });
    await expect(client.messages.waitForClose()).resolves.toMatchObject({ code: 1011 });
    expect(hermes.startCalls).toHaveLength(1);
  }, 15_000);

  it("lets an accepted background task survive provider tool-call cancellation", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    provider.emit({ type: "tool_call", call: backgroundTaskCall("cancel_receipt", "Durable after cancellation") });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "cancel_receipt");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    const runId = hermes.runIdForInput("Durable after cancellation");

    provider.emit({ type: "tool_call_cancelled", callIds: ["cancel_receipt"] });
    await expect(client.messages.wait("log", (message) => message.message.includes("cancelled a tool call"))).resolves
      .toMatchObject({ level: "info" });
    expect(hermes.stopCalls).toEqual([]);
    hermes.complete(runId, "Still completed");
    await expect(client.messages.wait("task.completed", (message) => message.taskId === taskId)).resolves
      .toMatchObject({ result: { output: "Still completed" } });
  });

  it("waits for provider idle before injecting a generic notification with no raw task data", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    provider.emit({ type: "response", status: "started", responseId: "busy_response" });
    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("idle_notice", "Secret task input", { title: "Secret task title" }),
    });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "idle_notice");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    hermes.complete(hermes.runIdForInput("Secret task input"), "Secret task output");
    await client.messages.wait("task.completed", (message) => message.taskId === taskId);
    await delay(40);
    expect(provider.latest.notifications.items).toEqual([]);

    provider.emit({ type: "response", status: "completed", responseId: "busy_response" });
    const notification = await provider.latest.notifications.wait();
    expect(notification.announcement).toBe("Your background task is finished. The result is ready in the task inbox.");
    expect(notification.context).toMatch(/^\[HERMES_LIVE_TASK_EVENT_V1:[a-f0-9]{32}\]/);
    expect(JSON.stringify(notification)).not.toContain("Secret task input");
    expect(JSON.stringify(notification)).not.toContain("Secret task title");
    expect(JSON.stringify(notification)).not.toContain("Secret task output");
  });

  it.each(["user speech", "provider response"] as const)(
    "rechecks conversation state after an asynchronous notification claim when %s begins",
    async (busyKind) => {
      const config = testConfig();
      const hermes = new HermesHarness();
      const store = new FileTaskStore({
        directory: dirname(config.tasks.stateFile),
        filename: basename(config.tasks.stateFile),
        maxRecords: config.tasks.historyLimit + config.tasks.maxConcurrent + config.tasks.maxQueued,
        retentionMs: config.tasks.retentionMs,
        terminalReserveSlots: config.tasks.maxConcurrent,
      });
      const supervisor = new TaskSupervisor({
        store,
        hermes,
        maxConcurrent: config.tasks.maxConcurrent,
        maxQueued: config.tasks.maxQueued,
        pollIntervalMs: config.tasks.pollIntervalMs,
      });
      const claimEntered = deferred<void>();
      const releaseClaim = deferred<void>();
      const originalClaim = supervisor.claimNotificationAnnouncement.bind(supervisor);
      vi.spyOn(supervisor, "claimNotificationAnnouncement").mockImplementation(async (...args) => {
        claimEntered.resolve();
        await releaseClaim.promise;
        return originalClaim(...args);
      });
      const provider = new RecordingLiveAdapter();
      const server = await startServer({
        config,
        hermes,
        liveModel: provider,
        taskSupervisor: supervisor,
        logger: fakeLogger(),
      });
      openServers.push(server);
      const client = await readyClient(server.url);

      provider.emit({
        type: "tool_call",
        call: backgroundTaskCall(`claim_race_${busyKind.replace(" ", "_")}`, "Finish during claim"),
      });
      const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.name === "start_background_task");
      const taskId = String(receipt.response.task_id);
      await waitUntil(() => hermes.startCalls.length === 1);
      hermes.complete(hermes.runIdForInput("Finish during claim"), "done");
      await client.messages.wait("task.completed", (message) => message.taskId === taskId);
      await claimEntered.promise;

      if (busyKind === "user speech") {
        provider.emit({ type: "input_speech_started", provider: "openai", itemId: "claim_race_speech" });
      } else {
        provider.emit({ type: "response", status: "started", responseId: "claim_race_response" });
      }
      releaseClaim.resolve();
      await delay(40);
      expect(provider.latest.notifications.items).toEqual([]);

      if (busyKind === "user speech") {
        provider.emit({ type: "input_speech_stopped", provider: "openai", itemId: "claim_race_speech" });
        await delay(20);
        expect(provider.latest.notifications.items).toEqual([]);
        provider.emit({ type: "response", status: "started", responseId: "claim_race_turn" });
        provider.emit({ type: "response", status: "completed", responseId: "claim_race_turn" });
      } else {
        provider.emit({ type: "response", status: "completed", responseId: "claim_race_response" });
      }
      await expect(provider.latest.notifications.wait()).resolves.toMatchObject({
        announcement: "Your background task is finished. The result is ready in the task inbox.",
      });
    },
  );

  it("waits for the OpenAI VAD turn response before releasing a pending completion notice", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    provider.emit({ type: "input_speech_started", provider: "openai", itemId: "speech_1" });
    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("vad_notice", "Finish while the user is speaking"),
    });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "vad_notice");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    hermes.complete(hermes.runIdForInput("Finish while the user is speaking"), "done");
    await client.messages.wait("task.completed", (message) => message.taskId === taskId);
    await delay(40);
    expect(provider.latest.notifications.items).toEqual([]);

    provider.emit({ type: "input_speech_stopped", provider: "openai", itemId: "speech_1" });
    await delay(40);
    expect(provider.latest.notifications.items).toEqual([]);
    provider.emit({ type: "response", status: "started", responseId: "vad_turn_response" });
    provider.emit({ type: "response", status: "completed", responseId: "vad_turn_response" });
    await expect(provider.latest.notifications.wait()).resolves.toMatchObject({
      announcement: "Your background task is finished. The result is ready in the task inbox.",
    });
  });

  it("keeps the VAD gate through a delayed out-of-band notification lifecycle", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);

    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("scoped_notice_first", "Finish before the user speaks"),
    });
    const firstReceipt = await provider.latest.toolResponses.wait(
      (entry) => entry.call.id === "scoped_notice_first",
    );
    const firstTaskId = String(firstReceipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    hermes.complete(hermes.runIdForInput("Finish before the user speaks"), "done");
    await client.messages.wait("task.completed", (message) => message.taskId === firstTaskId);
    await waitUntil(() => provider.latest.notificationCalls.length === 1);

    provider.emit({ type: "input_speech_started", provider: "openai", itemId: "scoped_speech" });
    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("scoped_notice_second", "Finish during the user's turn"),
    });
    const secondReceipt = await provider.latest.toolResponses.wait(
      (entry) => entry.call.id === "scoped_notice_second",
    );
    const secondTaskId = String(secondReceipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 2);
    hermes.complete(hermes.runIdForInput("Finish during the user's turn"), "done");
    await client.messages.wait("task.completed", (message) => message.taskId === secondTaskId);
    expect(provider.latest.notificationCalls).toHaveLength(1);

    provider.emit({ type: "input_speech_stopped", provider: "openai", itemId: "scoped_speech" });
    provider.emit({
      type: "response",
      status: "started",
      responseId: "scoped_task_notice",
      scope: "task_notification",
    });
    provider.emit({
      type: "response",
      status: "completed",
      responseId: "scoped_task_notice",
      scope: "task_notification",
    });
    await delay(40);
    expect(provider.latest.notificationCalls).toHaveLength(1);

    provider.emit({
      type: "response",
      status: "started",
      responseId: "scoped_vad_turn",
      scope: "conversation",
    });
    provider.emit({
      type: "response",
      status: "completed",
      responseId: "scoped_vad_turn",
      scope: "conversation",
    });
    await waitUntil(() => provider.latest.notificationCalls.length === 2);
  });

  it("releases a pending completion notice when a late final user transcript makes the conversation idle", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    provider.emit({ type: "input_speech_started", provider: "openai", itemId: "late_transcript_speech" });
    provider.emit({
      type: "tool_call",
      call: backgroundTaskCall("late_transcript_notice", "Finish before the final transcript"),
    });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "late_transcript_notice");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    hermes.complete(hermes.runIdForInput("Finish before the final transcript"), "done");
    await client.messages.wait("task.completed", (message) => message.taskId === taskId);

    provider.emit({ type: "response", status: "completed", responseId: "response_before_transcript" });
    await delay(40);
    expect(provider.latest.notifications.items).toEqual([]);

    provider.emit({ type: "text", speaker: "user", text: "final transcript", final: true });
    await expect(provider.latest.notifications.wait()).resolves.toMatchObject({
      announcement: "Your background task is finished. The result is ready in the task inbox.",
    });
  });

  it("contains every approval fail-closed without exposing an actionable approval", async () => {
    const hermes = new HermesHarness();
    const provider = new RecordingLiveAdapter();
    const server = await startTestServer({ config: testConfig(), hermes, provider });
    const client = await readyClient(server.url);
    provider.emit({ type: "tool_call", call: backgroundTaskCall("approval_task", "Dangerous task") });
    const receipt = await provider.latest.toolResponses.wait((entry) => entry.call.id === "approval_task");
    const taskId = String(receipt.response.task_id);
    await waitUntil(() => hermes.startCalls.length === 1);
    const runId = hermes.runIdForInput("Dangerous task");

    hermes.pushEvent(runId, {
      event: "approval.request",
      run_id: runId,
      approval_id: "opaque_upstream_id",
      command: "RAW_APPROVAL_COMMAND",
    });
    await waitUntil(() => hermes.stopCalls.includes(runId));
    expect(hermes.approvalCalls).toEqual([
      expect.objectContaining({ runId, choice: "deny", options: expect.objectContaining({ resolveAll: true }) }),
    ]);
    await expect(client.messages.wait("task.stopping", (message) => message.taskId === taskId)).resolves
      .toMatchObject({ taskId });
    expect(client.messages.observed.some((message) => message.type === "task.waiting_for_approval")).toBe(false);
    expect(JSON.stringify(client.messages.observed)).not.toContain("RAW_APPROVAL_COMMAND");
  });
});

describe("WebSocket exposure controls", () => {
  it("requires configured auth while allowing the browser query-token path", async () => {
    const config = testConfig({ server: { authToken: "gateway-secret", allowUnauthenticated: false } });
    const server = await startTestServer({ config, hermes: new HermesHarness(), provider: new RecordingLiveAdapter() });
    await expectUpgradeRejected(toWebSocketUrl(server.url), { origin: server.url }).then((status) => expect(status).toBe(401));

    const url = new URL(toWebSocketUrl(server.url));
    url.searchParams.set("token", "gateway-secret");
    const authenticated = await connectClient(url.toString());
    send(authenticated.socket, { type: "session.start", protocolVersion: 3 });
    await expect(authenticated.messages.wait("session.ready")).resolves.toMatchObject({ protocolVersion: 3 });
  });

  it("enforces origin and concurrent-session limits while allowing headerless native clients", async () => {
    const config = testConfig({ server: { maxSessions: 1 } });
    const server = await startTestServer({ config, hermes: new HermesHarness(), provider: new RecordingLiveAdapter() });
    await expectUpgradeRejected(toWebSocketUrl(server.url), { origin: "https://attacker.example" })
      .then((status) => expect(status).toBe(403));

    const native = await connectClient(server.url, { origin: false });
    await expectUpgradeRejected(toWebSocketUrl(server.url), { origin: server.url })
      .then((status) => expect(status).toBe(503));
    native.socket.terminate();
    await native.messages.waitForClose();
  });

  it("closes oversized WebSocket payloads before parsing client JSON", async () => {
    const config = testConfig({ server: { maxAudioBytes: 2, maxTextChars: 2 } });
    const server = await startTestServer({ config, hermes: new HermesHarness(), provider: new RecordingLiveAdapter() });
    const client = await connectClient(server.url);
    client.socket.send(Buffer.alloc(8_192, 1));
    await expect(client.messages.waitForClose()).resolves.toMatchObject({ code: 1009 });
  });
});

async function startTestServer(options: {
  config: AppConfig;
  hermes: HermesRunsPort;
  provider: LiveModelAdapter;
  logger?: Logger;
}): Promise<TestServer> {
  const server = await startServer({
    config: options.config,
    hermes: options.hermes,
    liveModel: options.provider,
    logger: options.logger ?? fakeLogger(),
  });
  openServers.push(server);
  return server;
}

async function connectClient(
  serverUrl: string,
  options: { origin?: string | false } = {},
): Promise<{ socket: WebSocket; messages: SocketMessages }> {
  const websocketUrl = toWebSocketUrl(serverUrl);
  const parsed = new URL(websocketUrl);
  const defaultOrigin = `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
  const headers = options.origin === false ? {} : { origin: options.origin ?? defaultOrigin };
  const socket = new WebSocket(websocketUrl, { headers });
  openSockets.push(socket);
  const messages = new SocketMessages(socket);
  await waitForOpen(socket);
  return { socket, messages };
}

async function readyClient(
  serverUrl: string,
  options: {
    profileId?: string;
    userLabel?: string;
    expectedSnapshotReason?: "initial" | "reconnect";
  } = {},
): Promise<{
  socket: WebSocket;
  messages: SocketMessages;
  ready: JsonMessage;
  initialSnapshot: JsonMessage;
}> {
  const client = await connectClient(serverUrl);
  send(client.socket, {
    type: "session.start",
    protocolVersion: 3,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.userLabel ? { userLabel: options.userLabel } : {}),
  });
  const ready = await client.messages.wait("session.ready");
  const initialSnapshot = await client.messages.wait("task.snapshot");
  expect(initialSnapshot.reason).toBe(options.expectedSnapshotReason ?? "initial");
  return { ...client, ready, initialSnapshot };
}

function send(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

function backgroundTaskCall(
  id: string,
  message: string,
  extra: Record<string, unknown> = {},
): LiveToolCall {
  return {
    id,
    name: "start_background_task",
    args: { message, ...extra },
  };
}

function testConfig(overrides: {
  server?: Partial<AppConfig["server"]>;
  hermes?: Partial<AppConfig["hermes"]>;
  tasks?: Partial<AppConfig["tasks"]>;
} = {}): AppConfig {
  const stateFile = createTaskStateFile();
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      allowUnauthenticated: false,
      sessionPrefix: "agent:main:hermes-live",
      defaultProfileId: "default",
      defaultUserLabel: "voice",
      trustClientIdentity: false,
      maxSessions: 8,
      maxAudioBytes: 2_000_000,
      maxTextChars: 20_000,
      providerReadyTimeoutMs: 250,
      demoEnabled: false,
      ...overrides.server,
    },
    hermes: {
      baseUrl: "http://127.0.0.1:8642",
      model: "hermes-agent",
      timeoutMs: 30_000,
      streamIdleTimeoutMs: 120_000,
      ...overrides.hermes,
    },
    tasks: {
      stateFile,
      maxConcurrent: 3,
      trustDeclaredReadOnly: false,
      maxQueued: 32,
      historyLimit: 200,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      pollIntervalMs: 25,
      ...overrides.tasks,
    },
    realtime: { provider: "mock", model: "test-live-model" },
    gemini: { model: "gemini-live-test", enterprise: false, location: "us-central1" },
    openai: {
      baseUrl: "wss://api.openai.com/v1/realtime",
      model: "gpt-realtime-test",
      voice: "marin",
      reasoningEffort: "low",
      turnDetection: "disabled",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
    },
  } as AppConfig;
}

function createTaskStateFile(): string {
  const directory = mkdtempSync(join(temporaryRoot, "hermes-live-v3-ws-"));
  chmodSync(directory, 0o700);
  stateDirectories.push(directory);
  return join(directory, "tasks-v1.json");
}

async function seedTaskState(config: AppConfig, records: TaskRecord[]): Promise<void> {
  const store = new FileTaskStore({
    directory: dirname(config.tasks.stateFile),
    filename: basename(config.tasks.stateFile),
    maxRecords: config.tasks.historyLimit + config.tasks.maxConcurrent + config.tasks.maxQueued,
    retentionMs: config.tasks.retentionMs,
    terminalReserveSlots: config.tasks.maxConcurrent,
  });
  for (const record of records) await store.put(record);
  await store.close();
}

function seededRunningTask(
  ownerIdentity: string,
  input: string,
  now: number,
  runId: string,
): TaskRecord {
  const queued = createTaskRecord({ ownerIdentity, input, now });
  const dispatching = transitionTask(queued, "dispatching", { now: now + 1 });
  return transitionTask(dispatching, "running", { now: now + 2, runId });
}

function seededCompletedTask(
  ownerIdentity: string,
  input: string,
  now: number,
  runId: string,
  acknowledged: boolean,
): TaskRecord {
  const running = seededRunningTask(ownerIdentity, input, now, runId);
  const completed = transitionTask(running, "completed", {
    now: now + 3,
    output: `${input} result`,
    summary: "Task completed.",
  });
  return acknowledged ? acknowledgeTaskNotification(completed, now + 4) : completed;
}

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

class SocketMessages {
  readonly observed: JsonMessage[] = [];
  private readonly pending: JsonMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: JsonMessage) => boolean;
    resolve: (message: JsonMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private closed?: { code: number; reason: string };
  private readonly closeWaiters: Array<(value: { code: number; reason: string }) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8")) as JsonMessage;
      this.observed.push(message);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter!.timeout);
        waiter!.resolve(message);
      } else {
        this.pending.push(message);
      }
    });
    socket.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString("utf8") };
      for (const resolve of this.closeWaiters.splice(0)) resolve(this.closed);
    });
  }

  wait(
    type: string,
    filter: (message: JsonMessage) => boolean = () => true,
    timeoutMs = 2_000,
  ): Promise<JsonMessage> {
    const predicate = (message: JsonMessage) => message.type === type && filter(message);
    const pendingIndex = this.pending.findIndex(predicate);
    if (pendingIndex >= 0) return Promise.resolve(this.pending.splice(pendingIndex, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${type}. Observed: ${this.observed.map((item) => item.type).join(", ")}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async expectNone(type: string, durationMs: number): Promise<void> {
    if (this.pending.some((message) => message.type === type)) {
      throw new Error(`Unexpected existing ${type} message.`);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        predicate: (message: JsonMessage) => message.type === type,
        resolve: (_message: JsonMessage) => reject(new Error(`Unexpected ${type} message.`)),
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        }, durationMs),
      };
      this.waiters.push(waiter);
    });
  }

  waitForClose(timeoutMs = 2_000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close.")), timeoutMs);
      this.closeWaiters.push((value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  }
}

class RecordingLiveAdapter implements LiveModelAdapter {
  readonly connections: RecordingLiveSession[] = [];
  sessionFactory?: (params: LiveModelConnectParams) => RecordingLiveSession;

  constructor(private readonly options: { autoOpen?: boolean } = {}) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    const session = this.sessionFactory?.(params) ?? new RecordingLiveSession(params);
    this.connections.push(session);
    if (this.options.autoOpen !== false) queueMicrotask(() => params.callbacks.onOpen?.());
    return session;
  }

  get latest(): RecordingLiveSession {
    const value = this.connections.at(-1);
    if (!value) throw new Error("Realtime provider has no connection.");
    return value;
  }

  connection(index: number): RecordingLiveSession {
    const value = this.connections[index];
    if (!value) throw new Error(`Realtime provider connection ${index} does not exist.`);
    return value;
  }

  emit(event: LiveModelEvent, connectionIndex = this.connections.length - 1): void {
    this.connection(connectionIndex).params.callbacks.onEvent(event);
  }

  open(connectionIndex = this.connections.length - 1): void {
    this.connection(connectionIndex).params.callbacks.onOpen?.();
  }

  error(error: unknown, connectionIndex = this.connections.length - 1): void {
    this.connection(connectionIndex).params.callbacks.onError?.(error);
  }

  closeFromProvider(event?: unknown, connectionIndex = this.connections.length - 1): void {
    this.connection(connectionIndex).params.callbacks.onClose?.(event);
  }
}

class RecordingLiveSession implements LiveModelSession {
  readonly toolResponses = new RecordQueue<{ call: LiveToolCall; response: Record<string, unknown> }>();
  readonly notifications = new RecordQueue<LiveTaskNotification>();
  readonly notificationCalls: LiveTaskNotification[] = [];
  readonly textInputs: string[] = [];
  readonly audioInputs: LiveModelAudio[] = [];
  readonly cancelCalls: Array<{ reason?: string; truncate?: unknown }> = [];
  closeCalls = 0;
  textBehavior?: (text: string) => Promise<void>;
  notificationBehavior?: (notification: LiveTaskNotification) => Promise<void>;
  closeBehavior?: () => Promise<void>;

  constructor(readonly params: LiveModelConnectParams) {}

  async sendRealtimeAudio(audio: LiveModelAudio): Promise<void> {
    this.audioInputs.push(structuredClone(audio));
  }

  async sendText(text: string): Promise<void> {
    this.textInputs.push(text);
    await this.textBehavior?.(text);
  }

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(reason?: string, truncate?: any): Promise<boolean> {
    this.cancelCalls.push({ ...(reason ? { reason } : {}), ...(truncate ? { truncate: structuredClone(truncate) } : {}) });
    return true;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    this.toolResponses.push({ call: structuredClone(call), response: structuredClone(response) });
  }

  async sendTaskNotification(notification: LiveTaskNotification): Promise<void> {
    this.notificationCalls.push(structuredClone(notification));
    await this.notificationBehavior?.(structuredClone(notification));
    this.notifications.push(structuredClone(notification));
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeBehavior?.();
  }
}

class FailingConnectAdapter implements LiveModelAdapter {
  constructor(private readonly message: string) {}

  async connect(_params: LiveModelConnectParams): Promise<LiveModelSession> {
    throw new Error(this.message);
  }
}

class NeverConnectAdapter implements LiveModelAdapter {
  async connect(_params: LiveModelConnectParams): Promise<LiveModelSession> {
    return new Promise<never>(() => undefined);
  }
}

class RecordQueue<T> {
  readonly items: T[] = [];
  private readonly pending: T[] = [];
  private readonly waiters: Array<{
    predicate: (value: T) => boolean;
    resolve: (value: T) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  push(value: T): void {
    this.items.push(value);
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(value));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timeout);
      waiter!.resolve(value);
    } else {
      this.pending.push(value);
    }
  }

  wait(predicate: (value: T) => boolean = () => true, timeoutMs = 2_000): Promise<T> {
    const index = this.pending.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.pending.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const waiterIndex = this.waiters.indexOf(waiter);
          if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
          reject(new Error("Timed out waiting for recorded value."));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

class HermesHarness implements HermesRunsPort {
  readonly baseUrl = "http://127.0.0.1:8642";
  readonly startCalls: StartRunParams[] = [];
  readonly getCalls: string[] = [];
  readonly streamCalls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly historyCalls: string[] = [];
  readonly chatCalls: Array<{ sessionId: string; message: string }> = [];
  readonly sessions = new Map<string, HermesSessionSummary>();
  readonly approvalCalls: Array<{
    runId: string;
    choice: ApprovalChoice;
    options?: { approvalId?: string; resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string };
  }> = [];
  assertRunsCalls = 0;
  assertError?: Error;
  startBehavior?: (params: StartRunParams, signal?: AbortSignal) => Promise<StartRunResult>;
  stopBehavior?: (runId: string) => Promise<{ run_id: string; status: "stopping" }>;
  historyBehavior?: (sessionId: string) => Promise<HermesSessionHistory>;
  chatBehavior?: (sessionId: string, message: string) => Promise<HermesSessionChatResult>;
  private runCounter = 0;
  private readonly snapshots = new Map<string, HermesRunSnapshot>();
  private readonly streams = new Map<string, HermesEventQueue>();

  async health(): Promise<Record<string, unknown>> {
    return { status: "ok" };
  }

  async capabilities(): Promise<HermesCapabilities> {
    return this.supportedCapabilities();
  }

  async assertRunsSupported(): Promise<HermesCapabilities> {
    this.assertRunsCalls += 1;
    if (this.assertError) throw this.assertError;
    return this.supportedCapabilities();
  }

  async assertSessionsSupported(): Promise<HermesCapabilities> {
    return this.supportedCapabilities();
  }

  async listSessions(): Promise<HermesSessionSummary[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }

  async createSession(options?: { title?: string }): Promise<HermesSessionSummary> {
    const session = { id: `session_${this.sessions.size + 1}`, ...(options?.title ? { title: options.title } : {}) };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async getSession(sessionId: string): Promise<HermesSessionSummary> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Hermes session was not found.");
    return structuredClone(session);
  }

  async getSessionHistory(sessionId: string): Promise<HermesSessionHistory> {
    this.historyCalls.push(sessionId);
    return this.historyBehavior?.(sessionId) ?? { sessionId, messages: [] };
  }

  async chatSession(sessionId: string, message: string): Promise<HermesSessionChatResult> {
    this.chatCalls.push({ sessionId, message });
    return this.chatBehavior?.(sessionId, message) ?? { sessionId, content: "Hermes answer" };
  }

  async startRun(params: StartRunParams, signal?: AbortSignal): Promise<StartRunResult> {
    this.startCalls.push(structuredClone(params));
    const result = this.startBehavior
      ? await this.startBehavior(params, signal)
      : { runId: `run_${++this.runCounter}`, status: "queued" };
    this.stream(result.runId);
    if (!this.snapshots.has(result.runId)) {
      this.snapshots.set(result.runId, { object: "hermes.run", run_id: result.runId, status: "running" });
    }
    return result;
  }

  async getRun(runId: string): Promise<HermesRunSnapshot> {
    this.getCalls.push(runId);
    return structuredClone(this.snapshots.get(runId)
      ?? { object: "hermes.run", run_id: runId, status: "running" });
  }

  async stopRun(runId: string, _options?: AbortSignal | HermesRequestOptions): Promise<{ run_id: string; status: "stopping" }> {
    this.stopCalls.push(runId);
    const result = this.stopBehavior
      ? await this.stopBehavior(runId)
      : { run_id: runId, status: "stopping" as const };
    this.snapshots.set(runId, { object: "hermes.run", run_id: runId, status: "stopping" });
    return result;
  }

  async submitApproval(
    runId: string,
    choice: ApprovalChoice,
    options?: { approvalId?: string; resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string },
  ): Promise<ApprovalResult> {
    this.approvalCalls.push({ runId, choice, options });
    return { run_id: runId, choice, resolved: 1 };
  }

  streamRunEvents(runId: string, options?: AbortSignal | HermesRequestOptions): AsyncGenerator<HermesRunEvent> {
    this.streamCalls.push(runId);
    return this.stream(runId).iterate(requestSignal(options));
  }

  runIdForInput(input: string): string {
    const index = this.startCalls.findIndex((params) => params.input === input);
    if (index < 0) throw new Error(`Hermes did not receive input: ${input}`);
    return `run_${index + 1}`;
  }

  pushEvent(runId: string, event: HermesRunEvent): void {
    this.stream(runId).push(event);
  }

  complete(runId: string, output: string): void {
    const snapshot: HermesRunSnapshot = {
      object: "hermes.run",
      run_id: runId,
      status: "completed",
      output,
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    };
    this.snapshots.set(runId, snapshot);
    this.pushEvent(runId, {
      event: "run.completed",
      run_id: runId,
      output,
      usage: { ...snapshot.usage },
    });
  }

  cancel(runId: string): void {
    this.snapshots.set(runId, { object: "hermes.run", run_id: runId, status: "cancelled" });
    this.pushEvent(runId, { event: "run.cancelled", run_id: runId });
  }

  private supportedCapabilities(): HermesCapabilities {
    return {
      model: "hermes-agent",
      features: {
        run_submission: true,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
        run_approval_response_by_id: false,
      },
    };
  }

  private stream(runId: string): HermesEventQueue {
    const current = this.streams.get(runId);
    if (current) return current;
    const created = new HermesEventQueue();
    this.streams.set(runId, created);
    return created;
  }
}

class HermesEventQueue {
  private readonly values: HermesRunEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<HermesRunEvent>) => void> = [];

  push(event: HermesRunEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  async *iterate(signal?: AbortSignal): AsyncGenerator<HermesRunEvent> {
    while (!signal?.aborted) {
      const next = await this.next(signal);
      if (next.done) return;
      yield next.value;
    }
  }

  private next(signal?: AbortSignal): Promise<IteratorResult<HermesRunEvent>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (signal?.aborted) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      const finish = (result: IteratorResult<HermesRunEvent>) => {
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => {
        const index = this.waiters.indexOf(finish);
        if (index >= 0) this.waiters.splice(index, 1);
        finish({ done: true, value: undefined });
      };
      this.waiters.push(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function requestSignal(options?: AbortSignal | HermesRequestOptions): AbortSignal | undefined {
  return options instanceof AbortSignal ? options : options?.signal;
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/v1/live";
  return parsed.toString();
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket open.")), 2_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function expectUpgradeRejected(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for rejected WebSocket upgrade.")), 2_000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error("WebSocket unexpectedly opened."));
    });
    socket.once("error", () => undefined);
  });
}

async function waitForStoredTask(stateFile: string, taskId: string, status: string): Promise<void> {
  await waitUntil(() => storedTask(stateFile, taskId)?.status === status);
}

function storedTask(stateFile: string, taskId: string): JsonMessage | undefined {
  if (!existsSync(stateFile)) return undefined;
  try {
    const document = JSON.parse(readFileSync(stateFile, "utf8")) as { tasks?: JsonMessage[] };
    return document.tasks?.find((task) => task.taskId === taskId);
  } catch {
    return undefined;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for test condition.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): {
  promise: Promise<T>;
  settled: boolean;
  resolve(value?: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const result = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve(value?: T) {
      result.settled = true;
      resolvePromise(value as T);
    },
    reject(error: unknown) {
      result.settled = true;
      rejectPromise(error);
    },
  };
  return result;
}
