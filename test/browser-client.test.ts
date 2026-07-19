import { describe, expect, it, vi } from "vitest";
import {
  HermesLiveAudio,
  HermesLiveClient,
  arrayBufferToBase64,
  buildGatewayWebSocketUrl,
  validateServerMessage,
} from "../clients/browser/hermes-live-client.js";

describe("HermesLiveClient", () => {
  it("negotiates protocol v4 and sends the exact task command envelopes", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();

    socket.open();
    expect(socket.sent[0]).toEqual({
      type: "session.start",
      id: "req_1",
      protocolVersion: 4,
      profileId: "demo",
      conversation: { mode: "new" },
    });
    socket.message(readyMessage("live_1"));

    await expect(connection).resolves.toMatchObject({ sessionId: "live_1", protocolVersion: 4 });
    expect(client.connected).toBe(true);
    expect(client.getSnapshot()).toMatchObject({
      connection: "ready",
      tasks: [],
      activeTasks: [],
      recentTasks: [],
    });

    expect(client.sendText(" inspect this repo ")).toBe("req_2");
    expect(socket.sent.at(-1)).toEqual({ type: "text.input", id: "req_2", text: "inspect this repo" });
    expect(client.listTasks({ limit: 25 })).toBe("req_3");
    expect(socket.sent.at(-1)).toEqual({ type: "task.list", id: "req_3", limit: 25 });
    socket.message({ type: "task.snapshot", reason: "list", requestId: "req_3", tasks: [], truncated: false });
    await flushMessages();
    expect(client.getTask("task_one")).toBe("req_4");
    expect(socket.sent.at(-1)).toEqual({ type: "task.get", id: "req_4", taskId: "task_one" });
    socket.message({
      type: "task.snapshot",
      reason: "get",
      requestId: "req_4",
      tasks: [taskSnapshot("task_one", "running", 1)],
      truncated: false,
    });
    await flushMessages();
    expect(client.tasks[0]).toMatchObject({ taskId: "task_one", state: "running" });
  });

  it("can resume a selected Hermes conversation without application glue", async () => {
    const client = createClient({ conversation: { mode: "resume", sessionId: "saved_chat" } });
    const connection = client.connect();
    const socket = await nextSocket();

    socket.open();
    expect(socket.sent[0]).toMatchObject({
      type: "session.start",
      protocolVersion: 4,
      conversation: { mode: "resume", sessionId: "saved_chat" },
    });
    socket.message({
      ...readyMessage("live_resume"),
      conversation: { mode: "resume", sessionId: "saved_chat", title: "Saved chat" },
    });
    await expect(connection).resolves.toMatchObject({
      conversation: { mode: "resume", sessionId: "saved_chat", title: "Saved chat" },
    });
  });

  it("tracks overlapping tasks independently and ignores out-of-order events per task", async () => {
    const { client, socket } = await connectedClient("live_parallel");
    const stale = vi.fn();
    client.on("task.stale", stale);

    socket.message(taskAccepted("task_a", 1, 100));
    socket.message(taskAccepted("task_b", 1, 101));
    socket.message({ type: "task.started", taskId: "task_a", sequence: 3, occurredAt: 300 });
    socket.message({
      type: "task.progress",
      taskId: "task_a",
      sequence: 2,
      occurredAt: 200,
      progress: { message: "stale progress", percent: 10 },
    });
    socket.message({
      type: "task.progress",
      taskId: "task_b",
      sequence: 2,
      occurredAt: 201,
      progress: { message: "second task", current: 1, total: 2 },
    });
    socket.message({
      type: "task.completed",
      taskId: "task_b",
      sequence: 3,
      occurredAt: 400,
      result: { summary: "done", truncated: false },
    });
    await flushMessages();

    expect(client.tasks).toHaveLength(2);
    expect(client.activeTasks.map((task) => task.taskId)).toEqual(["task_a"]);
    expect(client.recentTasks.map((task) => task.taskId)).toEqual(["task_b"]);
    expect(client.tasks.find((task) => task.taskId === "task_a")).toMatchObject({
      sequence: 3,
      state: "running",
    });
    expect(stale).toHaveBeenCalledWith({
      taskId: "task_a",
      type: "task.progress",
      sequence: 2,
      currentSequence: 3,
    });
  });

  it("treats reconnect snapshots as authoritative for retained client history", async () => {
    const client = createClient();
    const firstConnection = client.connect();
    const first = await nextSocket();
    first.open();
    first.message(readyMessage("live_before_reconnect"));
    await firstConnection;
    first.message({
      type: "task.snapshot",
      reason: "initial",
      tasks: [
        taskSnapshot("task_kept", "running", 4, { updatedAt: 400 }),
        taskSnapshot("task_absent", "running", 2, { updatedAt: 200 }),
        taskSnapshot("task_history", "completed", 3, { updatedAt: 300, finishedAt: 300 }),
      ],
      truncated: false,
    });
    await flushMessages();
    const disconnecting = client.disconnect();
    await vi.waitFor(() => expect(first.sent.at(-1)).toMatchObject({ type: "session.close", detach: true }));
    first.serverClose(1000, "detached");
    await disconnecting;
    expect(client.tasks.map((task) => task.taskId)).toEqual(["task_kept", "task_history", "task_absent"]);

    const secondConnection = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.message(readyMessage("live_after_reconnect"));
    await secondConnection;
    second.message({
      type: "task.snapshot",
      reason: "reconnect",
      tasks: [
        taskSnapshot("task_kept", "completed", 5, { updatedAt: 500, finishedAt: 500 }),
        taskSnapshot("task_new", "running", 1, { createdAt: 450, updatedAt: 450 }),
      ],
      truncated: false,
    });
    await flushMessages();

    expect(client.activeTasks.map((task) => task.taskId)).toEqual(["task_new"]);
    expect(client.recentTasks.map((task) => task.taskId)).toEqual(["task_kept"]);
    expect(client.tasks.some((task) => task.taskId === "task_history")).toBe(false);
    expect(client.tasks.some((task) => task.taskId === "task_absent")).toBe(false);
  });

  it("does not let stale list snapshots roll task state backward", async () => {
    const { client, socket } = await connectedClient("live_stale_snapshot");
    socket.message(taskAccepted("task_stable", 1, 100));
    socket.message({ type: "task.started", taskId: "task_stable", sequence: 5, occurredAt: 500 });
    await flushMessages();

    const requestId = client.listTasks();
    socket.message({
      type: "task.snapshot",
      reason: "list",
      requestId,
      tasks: [taskSnapshot("task_stable", "queued", 4, { updatedAt: 400 })],
      truncated: false,
    });
    await flushMessages();

    expect(client.tasks[0]).toMatchObject({ taskId: "task_stable", state: "running", sequence: 5 });
  });

  it("fails closed when an equal-sequence snapshot changes immutable task timestamps", async () => {
    const { client, socket } = await connectedClient("live_conflicting_snapshot_time");
    socket.message(taskAccepted("task_stable_identity", 1, 100));
    await flushMessages();

    const requestId = client.listTasks();
    socket.message({
      type: "task.snapshot",
      reason: "list",
      requestId,
      tasks: [taskSnapshot("task_stable_identity", "accepted", 1, { createdAt: 99 })],
      truncated: false,
    });

    await vi.waitFor(() => expect(socket.closeCalls.at(-1)).toMatchObject({
      code: 4000,
      reason: "invalid server message",
    }));
    expect(client.tasks[0]).toMatchObject({
      taskId: "task_stable_identity",
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it("fails closed when an equal-sequence lifecycle event contradicts a retained snapshot", async () => {
    const { client, socket } = await connectedClient("live_conflicting_snapshot_event");
    const requestId = client.listTasks();
    socket.message({
      type: "task.snapshot",
      reason: "list",
      requestId,
      tasks: [taskSnapshot("task_snapshot_revision", "running", 2, { startedAt: 200 })],
      truncated: false,
    });
    await flushMessages();

    socket.message({
      type: "task.completed",
      taskId: "task_snapshot_revision",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "contradictory completion", truncated: false },
    });

    await vi.waitFor(() => expect(socket.closeCalls.at(-1)).toMatchObject({
      code: 4000,
      reason: "invalid server message",
    }));
    expect(client.tasks[0]).toMatchObject({
      taskId: "task_snapshot_revision",
      state: "running",
      sequence: 2,
    });
  });

  it("rejects a task.get snapshot that mutates a different task", async () => {
    const { client, socket } = await connectedClient("live_get_correlation");
    const requestId = client.getTask("task_requested");
    socket.message({
      type: "task.snapshot",
      reason: "get",
      requestId,
      tasks: [taskSnapshot("task_substituted", "running", 1)],
      truncated: false,
    });

    await vi.waitFor(() => expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4000, reason: "invalid server message" }));
    expect(client.tasks).toEqual([]);
  });

  it("retains more than 256 task shells without evicting active tasks", async () => {
    const { client, socket } = await connectedClient("live_bounded_tasks");
    socket.message(taskAccepted("task_active", 1, 100));
    await flushMessages();
    for (let page = 0; page < 3; page += 1) {
      const requestId = client.listTasks({ limit: 100 });
      socket.message({
        type: "task.snapshot",
        reason: "list",
        requestId,
        tasks: Array.from({ length: 100 }, (_, index) =>
          taskSnapshot(`task_terminal_${page}_${index}`, "completed", 1)),
        truncated: page < 2,
      });
      await flushMessages();
    }

    expect(client.tasks).toHaveLength(301);
    expect(client.activeTasks.map((task) => task.taskId)).toEqual(["task_active"]);
  });

  it("compacts old task output while retaining every task shell and summary", async () => {
    const { client, socket } = await connectedClient("live_bounded_task_output");
    for (let page = 0; page < 3; page += 1) {
      socket.message({
        type: "task.snapshot",
        reason: "reconnect",
        tasks: Array.from({ length: page < 2 ? 100 : 57 }, (_, index) => {
          const ordinal = page * 100 + index;
          return taskSnapshot(`task_output_${ordinal}`, "completed", 1, {
            createdAt: ordinal + 1,
            updatedAt: ordinal + 1,
            finishedAt: ordinal + 1,
            result: {
              summary: `summary ${ordinal}`,
              output: `output ${ordinal}`,
              truncated: false,
            },
          });
        }),
        truncated: true,
      });
    }
    await flushMessages();

    expect(client.tasks).toHaveLength(257);
    expect(client.tasks.filter((task) => task.result?.output !== undefined)).toHaveLength(256);
    expect(client.tasks.find((task) => task.taskId === "task_output_0")?.result).toEqual({
      summary: "summary 0",
      truncated: true,
    });
    expect(client.tasks.find((task) => task.taskId === "task_output_256")?.result).toEqual({
      summary: "summary 256",
      output: "output 256",
      truncated: false,
    });
  });

  it("reconciles active state once while merging multiple bounded reconnect snapshots", async () => {
    const { client, socket } = await connectedClient("live_chunked_reconnect");
    socket.message(taskAccepted("task_stale_active", 1, 100));
    socket.message(taskAccepted("task_retained_terminal", 1, 101));
    socket.message({
      type: "task.completed",
      taskId: "task_retained_terminal",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "done", output: "done", truncated: false },
    });
    await flushMessages();

    socket.message(readyMessage("live_chunked_reconnect_2"));
    socket.message({
      type: "task.snapshot",
      reason: "reconnect",
      tasks: [taskSnapshot("task_new_terminal", "completed", 3)],
      truncated: true,
    });
    socket.message({
      type: "task.snapshot",
      reason: "reconnect",
      tasks: [taskSnapshot("task_current_active", "running", 4)],
      truncated: true,
    });
    await flushMessages();

    expect(client.tasks.map((task) => task.taskId)).toEqual(expect.arrayContaining([
      "task_new_terminal",
      "task_current_active",
    ]));
    expect(client.tasks.map((task) => task.taskId)).not.toContain("task_retained_terminal");
    expect(client.tasks.map((task) => task.taskId)).not.toContain("task_stale_active");
    expect(client.activeTasks.map((task) => task.taskId)).toEqual(["task_current_active"]);
  });

  it("hydrates more than 256 unread task notifications across reconnect frames", async () => {
    const { client, socket } = await connectedClient("live_large_unread_inbox");
    const close = vi.fn();
    client.on("close", close);

    for (let page = 0; page < 3; page += 1) {
      socket.message({
        type: "task.snapshot",
        reason: "reconnect",
        tasks: Array.from({ length: 100 }, (_, index) => {
          const ordinal = page * 100 + index;
          return taskSnapshot(`task_unread_${ordinal}`, "completed", 2, {
            createdAt: ordinal + 1,
            updatedAt: ordinal + 1,
            finishedAt: ordinal + 1,
          });
        }),
        truncated: true,
      });
    }
    for (let ordinal = 0; ordinal < 300; ordinal += 1) {
      socket.message(taskNotification(
        `task_unread_${ordinal}`,
        `notice_unread_${ordinal}`,
        2,
        false,
      ));
    }

    await vi.waitFor(() => {
      expect(client.tasks).toHaveLength(300);
      expect(client.getSnapshot().unreadNotifications).toHaveLength(300);
    });
    expect(socket.closeCalls).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it("stops only an explicit known task and applies the correlated acknowledgement", async () => {
    const { client, socket } = await connectedClient("live_stop");
    socket.message(taskAccepted("task_stop", 1, 100));
    socket.message(taskAccepted("task_other", 1, 101));
    await flushMessages();

    expect(() => client.stopTask("task_missing")).toThrow(/does not know task/);
    const requestId = client.stopTask("task_stop", "cancel this exact task");
    expect(socket.sent.at(-1)).toEqual({
      type: "task.stop",
      id: requestId,
      taskId: "task_stop",
      reason: "cancel this exact task",
    });
    expect(client.tasks.find((task) => task.taskId === "task_stop")?.state).toBe("accepted");
    socket.message({
      type: "task.stopping",
      taskId: "task_stop",
      sequence: 2,
      occurredAt: 200,
      requestId,
      reason: "cancel this exact task",
    });
    await flushMessages();

    expect(client.tasks.find((task) => task.taskId === "task_stop")?.state).toBe("stopping");
    expect(client.tasks.find((task) => task.taskId === "task_other")?.state).toBe("accepted");
  });

  it("correlates queued cancellation as the exact task.stop result", async () => {
    const { client, socket } = await connectedClient("live_stop_queued");
    const succeeded = vi.fn();
    client.on("request.succeeded", succeeded);
    socket.message({
      ...taskAccepted("task_queued", 1, 100),
      state: "queued",
    });
    await flushMessages();

    const requestId = client.stopTask("task_queued", "remove from queue");
    socket.message({
      type: "task.cancelled",
      taskId: "task_queued",
      sequence: 2,
      occurredAt: 200,
      requestId,
      reason: "Task cancelled: remove from queue",
    });
    await flushMessages();

    expect(client.tasks[0]).toMatchObject({ taskId: "task_queued", state: "cancelled", sequence: 2 });
    expect(succeeded).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      request: { type: "task.stop", taskId: "task_queued" },
      response: expect.objectContaining({ type: "task.cancelled", taskId: "task_queued" }),
    }));
  });

  it("correlates an idempotent stop readback for an already-terminal task", async () => {
    const { client, socket } = await connectedClient("live_stop_terminal");
    const succeeded = vi.fn();
    client.on("request.succeeded", succeeded);
    socket.message(taskAccepted("task_terminal", 1, 100));
    const terminal = {
      type: "task.completed",
      taskId: "task_terminal",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "already done", truncated: false },
    };
    socket.message(terminal);
    await flushMessages();

    const requestId = client.stopTask("task_terminal", "idempotent confirmation");
    socket.message({ ...terminal, requestId });
    await flushMessages();

    expect(client.tasks[0]).toMatchObject({ taskId: "task_terminal", state: "completed", sequence: 2 });
    expect(succeeded).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      request: { type: "task.stop", taskId: "task_terminal" },
      response: expect.objectContaining({ type: "task.completed", taskId: "task_terminal" }),
    }));
    expect(() => client.stopTask("task_terminal", "repeat", { id: requestId })).not.toThrow();
  });

  it("retains unread notifications until the exact correlated acknowledgement", async () => {
    const { client, socket } = await connectedClient("live_notification");
    socket.message(taskAccepted("task_notice", 1, 100));
    socket.message({
      type: "task.completed",
      taskId: "task_notice",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "finished", truncated: false },
    });
    // The lifecycle and first notification are complementary projections of
    // one task revision, so they intentionally share sequence 2.
    socket.message(taskNotification("task_notice", "notice_1", 2, false));
    await flushMessages();

    expect(client.getSnapshot().unreadNotifications).toEqual([
      expect.objectContaining({ taskId: "task_notice", notificationId: "notice_1", acknowledged: false }),
    ]);
    // Persisting "announced" advances the task sequence without changing the
    // stable notification identity or its creation timestamp.
    socket.message(taskNotification("task_notice", "notice_1", 3, false));
    await flushMessages();
    expect(client.tasks[0]).toMatchObject({ sequence: 3 });
    expect(client.getSnapshot().unreadNotifications[0]).toMatchObject({
      notificationId: "notice_1",
      createdAt: 200,
      acknowledged: false,
    });
    expect(() => client.acknowledgeNotification("task_notice", "notice_wrong")).toThrow(/exact unread/);
    const requestId = client.acknowledgeNotification("task_notice", "notice_1");
    expect(socket.sent.at(-1)).toEqual({
      type: "task.notification.ack",
      id: requestId,
      taskId: "task_notice",
      notificationId: "notice_1",
    });
    socket.message(taskNotification("task_notice", "notice_1", 4, true, requestId));
    await flushMessages();
    expect(client.getSnapshot().unreadNotifications).toEqual([]);
    socket.message(taskNotification("task_notice", "notice_1", 3, false));
    await flushMessages();
    expect(client.getSnapshot().unreadNotifications).toEqual([]);
  });

  it("withdraws an unknown notice during exact-stop recovery and publishes the terminal replacement", async () => {
    const { client, socket } = await connectedClient("live_replaced_notification");
    socket.message(taskAccepted("task_recovered_stop", 1, 100));
    socket.message({
      type: "task.unknown",
      taskId: "task_recovered_stop",
      sequence: 2,
      occurredAt: 200,
      error: { code: "task_state_unknown", message: "Stop response was ambiguous.", recoverable: false },
    });
    socket.message(taskNotification(
      "task_recovered_stop",
      "notice_unknown",
      2,
      false,
      undefined,
      "unknown",
    ));
    socket.message({
      type: "task.stopping",
      taskId: "task_recovered_stop",
      sequence: 3,
      occurredAt: 300,
      reason: "Exact stop recovered.",
    });
    socket.message(taskNotification(
      "task_recovered_stop",
      "notice_unknown",
      3,
      true,
      undefined,
      "unknown",
    ));
    await flushMessages();
    expect(client.getSnapshot().unreadNotifications).toEqual([]);
    socket.message({
      type: "task.cancelled",
      taskId: "task_recovered_stop",
      sequence: 4,
      occurredAt: 400,
      reason: "Stopped.",
    });
    socket.message(taskNotification(
      "task_recovered_stop",
      "notice_cancelled",
      4,
      false,
      undefined,
      "cancelled",
    ));
    await flushMessages();

    expect(client.getSnapshot().unreadNotifications).toEqual([
      expect.objectContaining({
        taskId: "task_recovered_stop",
        notificationId: "notice_cancelled",
        kind: "cancelled",
      }),
    ]);
    const requestId = client.acknowledgeNotification("task_recovered_stop", "notice_cancelled");
    expect(socket.sent.at(-1)).toEqual({
      type: "task.notification.ack",
      id: requestId,
      taskId: "task_recovered_stop",
      notificationId: "notice_cancelled",
    });
    expect(() => client.acknowledgeNotification("task_recovered_stop", "notice_unknown"))
      .toThrow(/exact unread/);
  });

  it("rejects a conflicting notification identity at the same task sequence", async () => {
    const { client, socket } = await connectedClient("live_conflicting_notification_identity");
    socket.message(taskAccepted("task_conflicting_notice", 1, 100));
    socket.message({
      type: "task.completed",
      taskId: "task_conflicting_notice",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "finished", truncated: false },
    });
    socket.message(taskNotification("task_conflicting_notice", "notice_original", 2, false));
    socket.message(taskNotification("task_conflicting_notice", "notice_conflict", 2, false));

    await vi.waitFor(() => expect(socket.closeCalls.at(-1)).toMatchObject({
      code: 4000,
      reason: "invalid server message",
    }));
    expect(client.getSnapshot().unreadNotifications).toEqual([
      expect.objectContaining({ notificationId: "notice_original" }),
    ]);
  });

  it("restores one durable unread inbox item per reconnect until its exact acknowledgement", async () => {
    const { client, socket: first } = await connectedClient("live_notice_first");
    const delivered = vi.fn();
    client.on("task.notification", (message) => {
      if (message.notification.acknowledged === false) delivered(message);
    });
    first.message(taskAccepted("task_notice_reconnect", 1, 100));
    first.message({
      type: "task.completed",
      taskId: "task_notice_reconnect",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "finished", truncated: false },
    });
    first.message(taskNotification("task_notice_reconnect", "notice_reconnect", 3, false));
    await flushMessages();
    expect(client.getSnapshot().unreadNotifications).toHaveLength(1);
    expect(delivered).toHaveBeenCalledTimes(1);

    let activeSocket = first;
    const reconnectWithUnread = async (connectionNumber: number): Promise<FakeWebSocket> => {
      const disconnecting = client.disconnect();
      await vi.waitFor(() => expect(activeSocket.sent.at(-1)).toMatchObject({
        type: "session.close",
        detach: true,
      }));
      activeSocket.serverClose(1000, "detached before notification ack");
      await disconnecting;

      const reconnecting = client.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(connectionNumber));
      const reconnected = FakeWebSocket.instances[connectionNumber - 1]!;
      reconnected.open();
      reconnected.message(readyMessage(`live_notice_reconnect_${connectionNumber}`));
      await reconnecting;
      reconnected.message({
        type: "task.snapshot",
        reason: "reconnect",
        tasks: [taskSnapshot("task_notice_reconnect", "completed", 3, {
          updatedAt: 300,
          finishedAt: 200,
        })],
        truncated: false,
      });
      reconnected.message(taskNotification("task_notice_reconnect", "notice_reconnect", 3, false));
      await flushMessages();

      expect(client.getSnapshot().unreadNotifications).toEqual([
        expect.objectContaining({
          taskId: "task_notice_reconnect",
          notificationId: "notice_reconnect",
          acknowledged: false,
        }),
      ]);
      expect(delivered).toHaveBeenCalledTimes(connectionNumber);
      return reconnected;
    };

    activeSocket = await reconnectWithUnread(2);
    const third = await reconnectWithUnread(3);
    const requestId = client.acknowledgeNotification("task_notice_reconnect", "notice_reconnect");
    third.message(taskNotification("task_notice_reconnect", "notice_reconnect", 4, true, requestId));
    await flushMessages();
    expect(client.getSnapshot().unreadNotifications).toEqual([]);

    const disconnecting = client.disconnect();
    await vi.waitFor(() => expect(third.sent.at(-1)).toMatchObject({ type: "session.close", detach: true }));
    third.serverClose(1000, "detached after notification ack");
    await disconnecting;
    const reconnecting = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4));
    const fourth = FakeWebSocket.instances[3]!;
    fourth.open();
    fourth.message(readyMessage("live_notice_after_ack"));
    await reconnecting;
    fourth.message({
      type: "task.snapshot",
      reason: "reconnect",
      tasks: [taskSnapshot("task_notice_reconnect", "completed", 4, {
        updatedAt: 400,
        finishedAt: 200,
      })],
      truncated: false,
    });
    await flushMessages();
    expect(client.getSnapshot().unreadNotifications).toEqual([]);
    expect(delivered).toHaveBeenCalledTimes(3);
  });

  it("applies complementary lifecycle and notification projections in either order at one sequence", async () => {
    const { client, socket } = await connectedClient("live_complementary_revision");
    socket.message(taskAccepted("task_reordered", 1, 100));
    socket.message(taskNotification("task_reordered", "notice_reordered", 2, false));
    socket.message({
      type: "task.completed",
      taskId: "task_reordered",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "finished", truncated: false },
    });
    await flushMessages();

    expect(client.tasks[0]).toMatchObject({ taskId: "task_reordered", state: "completed", sequence: 2 });
    expect(client.getSnapshot().unreadNotifications[0]).toMatchObject({
      taskId: "task_reordered",
      notificationId: "notice_reordered",
    });
  });

  it("treats an exact equal-sequence lifecycle replay as idempotent", async () => {
    const { client, socket } = await connectedClient("live_exact_lifecycle_replay");
    const completed = vi.fn();
    client.on("task.completed", completed);
    socket.message(taskAccepted("task_exact_replay", 1, 100));
    socket.message({
      type: "task.completed",
      taskId: "task_exact_replay",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "finished", truncated: false },
    });
    // Reordered object keys are still the same validated protocol revision.
    socket.message({
      result: { truncated: false, summary: "finished" },
      occurredAt: 200,
      sequence: 2,
      taskId: "task_exact_replay",
      type: "task.completed",
    });
    await flushMessages();

    expect(client.tasks[0]).toMatchObject({
      taskId: "task_exact_replay",
      state: "completed",
      sequence: 2,
      result: { summary: "finished" },
    });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toEqual([]);
  });

  it("fails closed on conflicting equal-sequence lifecycle content", async () => {
    const { client, socket } = await connectedClient("live_conflicting_lifecycle_replay");
    socket.message(taskAccepted("task_conflicting_lifecycle", 1, 100));
    socket.message({
      type: "task.completed",
      taskId: "task_conflicting_lifecycle",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "first result", truncated: false },
    });
    socket.message({
      type: "task.completed",
      taskId: "task_conflicting_lifecycle",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "conflicting result", truncated: false },
    });

    await vi.waitFor(() => expect(socket.closeCalls.at(-1)).toMatchObject({
      code: 4000,
      reason: "invalid server message",
    }));
    expect(client.tasks.find((task) => task.taskId === "task_conflicting_lifecycle")).toMatchObject({
      state: "completed",
      sequence: 2,
      result: { summary: "first result" },
    });
  });

  it("rejects an uncorrelated task mutation without changing task state", async () => {
    const { client, socket } = await connectedClient("live_uncorrelated");
    socket.message(taskAccepted("task_secure", 1, 100));
    await flushMessages();
    socket.message({
      type: "task.stopping",
      taskId: "task_secure",
      sequence: 2,
      occurredAt: 200,
      requestId: "request_not_ours",
      reason: "not requested here",
    });

    await vi.waitFor(() => expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4000, reason: "invalid server message" }));
    expect(client.tasks.find((task) => task.taskId === "task_secure")).toMatchObject({
      sequence: 1,
      state: "accepted",
    });
  });

  it("preserves tasks and notifications across detach", async () => {
    const { client, socket } = await connectedClient("live_detach");
    socket.message(taskAccepted("task_detached", 1, 100));
    socket.message({
      type: "task.started",
      taskId: "task_detached",
      sequence: 2,
      occurredAt: 200,
      title: "Detached task",
    });
    socket.message(taskNotification("task_detached", "notice_detached", 3, false));
    await flushMessages();

    const disconnecting = client.disconnect();
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "session.close", detach: true }));
    socket.serverClose(1000, "detached");
    await disconnecting;

    expect(client.getSnapshot()).toMatchObject({ connection: "closed", session: undefined });
    expect(client.tasks).toHaveLength(1);
    expect(client.tasks[0]).toMatchObject({ state: "running", sequence: 3 });
    expect(client.getSnapshot().unreadNotifications).toHaveLength(1);

    const reconnecting = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    reconnectedSocket.open();
    reconnectedSocket.message(readyMessage("live_detach_reconnected"));
    await reconnecting;
    reconnectedSocket.message({
      type: "task.snapshot",
      reason: "reconnect",
      tasks: [client.tasks[0]],
      truncated: false,
    });
    await flushMessages();
    expect(client.getSnapshot().unreadNotifications).toEqual([]);
  });

  it("rejects recoverable startup errors immediately instead of waiting for timeout", async () => {
    const client = createClient({ connectTimeoutMs: 10_000 });
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message({
      type: "session.error",
      code: "session_start_failed",
      message: "Provider did not connect",
      recoverable: true,
    });

    await expect(connection).rejects.toThrow("Provider did not connect");
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4000, reason: "session startup rejected" });
  });

  it("rejects malformed readiness messages", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message({ type: "session.ready", protocolVersion: 4 });

    await expect(connection).rejects.toThrow(/requires sessionId/);
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4000, reason: "invalid server message" });
  });

  it("rejects readiness correlated to a different session.start request", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message({ ...readyMessage("live_wrong_request"), requestId: "req_someone_else" });

    await expect(connection).rejects.toThrow(/did not match.*session\.start/);
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4000, reason: "invalid server message" });
  });

  it("rejects unsupported task states and notification kinds", () => {
    expect(() => validateServerMessage({
      type: "task.snapshot",
      reason: "initial",
      tasks: [taskSnapshot("task_paused", "paused", 1)],
      truncated: false,
    })).toThrow(/unsupported state/);
    expect(() => validateServerMessage({
      ...taskNotification("task_notice", "notice_attention", 2, false),
      notification: {
        ...taskNotification("task_notice", "notice_attention", 2, false).notification,
        kind: "attention",
      },
    })).toThrow(/unsupported kind/);
  });

  it("decodes only the addressed typed-array slice", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    const json = JSON.stringify(readyMessage("live_slice"));
    const payload = Buffer.from(`junk${json}junk`);
    socket.message(payload.subarray(4, payload.length - 4));

    await expect(connection).resolves.toMatchObject({ sessionId: "live_slice" });
  });

  it("applies inbound message limits in UTF-8 bytes", async () => {
    const payload = JSON.stringify({ ...readyMessage("live_utf8"), model: "🙂".repeat(30) });
    const client = createClient({ maxInboundMessageBytes: payload.length });
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(payload);

    await expect(connection).rejects.toThrow("server message exceeded the configured client limit");
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4000, reason: "invalid server message" });
  });

  it("drops microphone frames when the WebSocket is backed up", async () => {
    const client = createClient({ maxBufferedAmountBytes: 10 });
    const dropped = vi.fn();
    client.on("audio.dropped", dropped);
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
    socket.bufferedAmount = 11;

    expect(client.sendAudio(new Uint8Array([0, 0]))).toBeUndefined();
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "websocket_backpressure" }));
    expect(socket.sent.some((message) => message.type === "audio.input")).toBe(false);
  });

  it("supports async same-origin URL providers without retaining gateway tokens in public state", async () => {
    const client = createClient({
      url: undefined,
      webSocketUrlProvider: async () => "wss://dashboard.example/api/plugins/hermes-live/live?ticket=one-use",
      token: undefined,
    });
    const connection = client.connect();
    const socket = await nextSocket();

    expect(socket.url.toString()).toContain("ticket=one-use");
    expect("token" in client).toBe(false);
    expect("tokenProvider" in client).toBe(false);
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
  });

  it("accepts ephemeral loopback auth URLs from the dashboard host", async () => {
    const client = createClient({
      url: undefined,
      webSocketUrlProvider: async () => "ws://127.0.0.1:3000/api/plugins/hermes-live/live?token=host-session",
      token: undefined,
    });
    const connection = client.connect();
    const socket = await nextSocket();

    expect(socket.url.searchParams.get("token")).toBe("host-session");
    expect(client.getSnapshot()).not.toHaveProperty("token");
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
  });

  it("times out stalled ephemeral URL resolution before opening a socket", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient({
        url: undefined,
        webSocketUrlProvider: () => new Promise(() => undefined),
        connectTimeoutMs: 25,
      });
      const connection = client.connect();
      const result = expect(connection).rejects.toThrow("gateway URL or token did not resolve within 25ms");
      await vi.advanceTimersByTimeAsync(25);

      await result;
      expect(FakeWebSocket.instances).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts stalled ephemeral URL resolution", async () => {
    const controller = new AbortController();
    const client = createClient({
      url: undefined,
      webSocketUrlProvider: () => new Promise(() => undefined),
    });
    const connection = client.connect({ signal: controller.signal });
    controller.abort();

    await expect(connection).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("ignores messages from a replaced socket generation", async () => {
    const client = createClient();
    const firstConnection = client.connect();
    const first = await nextSocket();
    first.open();
    first.message(readyMessage("old"));
    await firstConnection;
    const disconnecting = client.disconnect();
    await vi.waitFor(() => expect(first.sent.some((message) => message.type === "session.close")).toBe(true));
    first.serverClose(1000, "session closed");
    await disconnecting;

    const secondConnection = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1]!;
    first.message(taskAccepted("task_stale", 1, 100));
    second.open();
    second.message(readyMessage("new"));
    await secondConnection;
    await flushMessages();

    expect(client.session?.sessionId).toBe("new");
    expect(client.tasks).toEqual([]);
  });

  it("forwards unknown future messages without treating them as malformed", async () => {
    const client = createClient();
    const unknown = vi.fn();
    client.on("unknownmessage", unknown);
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
    socket.message({ type: "future.event", value: 42 });
    await flushMessages();

    expect(unknown).toHaveBeenCalledWith({ type: "future.event", value: 42 });
  });

  it("waits for the gateway to confirm protocol shutdown", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;

    const disconnecting = client.disconnect(`line one\n${"🚫".repeat(100)}`);
    await vi.waitFor(() => expect(socket.sent.some((message) => message.type === "session.close")).toBe(true));
    expect(socket.sent.at(-1)).toMatchObject({ type: "session.close", detach: true });
    expect(socket.closeCalls).toEqual([]);
    socket.serverClose(1000, "session closed");
    await expect(disconnecting).resolves.toBeUndefined();
  });

  it("rejects abnormal shutdown with the gateway's actionable error", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(readyMessage("live_unconfirmed_close"));
    await connection;

    const disconnecting = client.disconnect();
    await vi.waitFor(() => expect(socket.sent.some((message) => message.type === "session.close")).toBe(true));
    socket.message({
      type: "session.error",
      code: "session_shutdown_unconfirmed",
      message: "Verify the active task state in Hermes.",
      recoverable: false,
    });

    await expect(disconnecting).rejects.toThrow("Verify the active task state in Hermes.");
    expect(client.getSnapshot()).toMatchObject({ connection: "closed", tasks: [] });
  });

  it("recovers to a reconnectable state when a browser never emits close", async () => {
    const client = createClient({ disconnectTimeoutMs: 25 });
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(readyMessage("live_stuck_close"));
    await connection;
    socket.suppressCloseEvent = true;

    await expect(client.disconnect("test stuck close")).rejects.toThrow("did not confirm session detach");
    expect(client.getSnapshot()).toMatchObject({
      connection: "closed",
      tasks: [],
    });
    expect(client.connected).toBe(false);
  });

  it("rejects protocol v2 readiness with an actionable upgrade message", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message({ ...readyMessage("legacy"), protocolVersion: 2 });

    await expect(connection).rejects.toThrow(/protocol version 2.*protocol v4.*upgrade/i);
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4000, reason: "invalid server message" });
  });
});

describe("HermesLiveAudio", () => {
  it("serializes concurrent audio chunks onto one playback context", async () => {
    const contexts: FakeAudioContext[] = [];
    const audio = createAudio({
      audioContextFactory: (options: AudioContextOptions) => {
        const context = new FakeAudioContext(options);
        contexts.push(context);
        return context as unknown as AudioContext;
      },
    });
    const frame = pcmFrame([0, 1000, -1000, 0]);

    await Promise.all([
      audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000", itemId: "one" }),
      audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=16000", itemId: "one" }),
    ]);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sources).toHaveLength(2);
    expect(contexts[0]?.sources[1]?.startedAt).toBeGreaterThan(contexts[0]?.sources[0]?.startedAt ?? 0);
    await audio.dispose();
  });

  it("invalidates serialized playback that has not scheduled when interrupted", async () => {
    const resumed = deferred<void>();
    const context = new FakeAudioContext({});
    context.state = "suspended";
    context.resume = vi.fn(async () => resumed.promise);
    const client = audioClient();
    const audio = createAudio({ client, audioContextFactory: () => context as unknown as AudioContext });
    const frame = pcmFrame([0, 1]);

    const first = audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" });
    const second = audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" });
    await Promise.resolve();
    audio.interrupt("test interruption");
    resumed.resolve();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(context.sources).toHaveLength(0);
    expect(client.cancelResponse).toHaveBeenCalledWith("test interruption", undefined);
    await audio.dispose();
  });

  it("bounds pending playback before a suspended context resumes and disposes without waiting", async () => {
    const context = new FakeAudioContext({});
    context.state = "suspended";
    context.resume = vi.fn(async () => await new Promise<void>(() => undefined));
    const dropped = vi.fn();
    const audio = createAudio({
      audioContextFactory: () => context as unknown as AudioContext,
      maxQueuedAudioMs: 3,
      playbackResumeTimeoutMs: 10_000,
    });
    audio.on("audio.dropped", dropped);
    const frame = pcmFrame(new Array(48).fill(0)); // 2ms at 24kHz.

    const first = audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" });
    const second = audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" });

    await expect(second).resolves.toBe(false);
    expect(context.resume).toHaveBeenCalledOnce();
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({
      reason: "playback_backpressure",
      queuedMs: 2,
      droppedMs: 2,
    }));
    await expect(audio.dispose()).resolves.toBeUndefined();
    await expect(first).resolves.toBe(false);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("bounds queued frame count even when frames have negligible duration", async () => {
    const context = new FakeAudioContext({});
    context.state = "suspended";
    context.resume = vi.fn(async () => await new Promise<void>(() => undefined));
    const dropped = vi.fn();
    const audio = createAudio({
      audioContextFactory: () => context as unknown as AudioContext,
      maxQueuedAudioFrames: 2,
      playbackResumeTimeoutMs: 10_000,
    });
    audio.on("audio.dropped", dropped);
    const message = {
      type: "audio.output" as const,
      data: pcmFrame([0]),
      mimeType: "audio/pcm;rate=192000",
    };

    const first = audio.play(message);
    const second = audio.play(message);
    await expect(audio.play(message)).resolves.toBe(false);
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "playback_backpressure" }));

    await audio.dispose();
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
  });

  it("primes browser playback synchronously from a user gesture and bounds a stalled resume", async () => {
    const context = new FakeAudioContext({});
    context.state = "suspended";
    context.resume = vi.fn(async () => await new Promise<void>(() => undefined));
    const audio = createAudio({
      audioContextFactory: () => context as unknown as AudioContext,
      playbackResumeTimeoutMs: 20,
    });

    const priming = audio.primePlayback();
    expect(context.resume).toHaveBeenCalledOnce();
    await expect(priming).rejects.toThrow(/did not start in time/);
    await audio.dispose();
  });

  it("suppresses late audio after interruption until the next response starts", async () => {
    const client = audioClient();
    const audio = createAudio({ client });
    const frame = pcmFrame([0, 1]);

    client.emit("response.started", {});
    audio.interrupt("stop this response");
    await expect(audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" })).resolves.toBe(false);

    client.emit("response.cancelled", {});
    await expect(audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" })).resolves.toBe(false);

    client.emit("response.started", {});
    await expect(audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" })).resolves.toBe(true);
    await audio.dispose();
  });

  it("stops a late microphone stream when disposed during permission", async () => {
    const permission = deferred<MediaStream>();
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const contextFactory = vi.fn(() => new FakeAudioContext({}) as unknown as AudioContext);
    const audio = createAudio({
      mediaDevices: { getUserMedia: vi.fn(async () => permission.promise) },
      audioContextFactory: contextFactory,
    });

    const starting = audio.startMicrophone();
    await Promise.resolve();
    const disposing = audio.dispose();
    permission.resolve(stream);
    await Promise.all([starting, disposing]);

    expect(track.stop).toHaveBeenCalledOnce();
    expect(contextFactory).not.toHaveBeenCalled();
    expect(audio.microphoneState).toBe("disposed");
  });

  it("stops without waiting for a microphone permission prompt that never settles", async () => {
    const getUserMedia = vi.fn()
      .mockImplementationOnce(async () => await new Promise<MediaStream>(() => undefined))
      .mockRejectedValueOnce(new Error("second permission attempt"));
    const audio = createAudio({ mediaDevices: { getUserMedia } });

    const starting = audio.startMicrophone();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await expect(audio.stopMicrophone({ endTurn: false })).resolves.toBeUndefined();
    await expect(starting).resolves.toBeUndefined();
    expect(audio.microphoneState).toBe("idle");
    await expect(audio.startMicrophone()).rejects.toThrow("second permission attempt");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await expect(audio.dispose()).resolves.toBeUndefined();
  });

  it("disposes without waiting for a capture context resume that never settles", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const context = new FakeAudioContext({});
    context.state = "suspended";
    context.resume = vi.fn(async () => await new Promise<void>(() => undefined));
    context.close = vi.fn(async () => await new Promise<void>(() => undefined));
    const audio = createAudio({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      audioContextFactory: () => context as unknown as AudioContext,
    });

    const starting = audio.startMicrophone();
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());

    await expect(audio.dispose()).resolves.toBeUndefined();
    await expect(starting).resolves.toBeUndefined();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(audio.microphoneState).toBe("disposed");
  });

  it("rejects negotiated G.711 microphone sessions before requesting permission", async () => {
    const client = audioClient() as ReturnType<typeof audioClient> & { session: unknown };
    client.session = {
      realtime: {
        audio: { input: { enabled: true, mimeType: "audio/pcmu;rate=8000" } },
      },
    };
    const getUserMedia = vi.fn();
    const audio = createAudio({ client, mediaDevices: { getUserMedia } });

    await expect(audio.startMicrophone()).rejects.toThrow(/supports PCM16 input/);
    expect(getUserMedia).not.toHaveBeenCalled();
    await audio.dispose();
  });

  it("rejects non-PCM provider output instead of corrupting it", async () => {
    const audio = createAudio();

    await expect(
      audio.play({ type: "audio.output", data: "AA==", mimeType: "audio/pcmu;rate=8000" }),
    ).rejects.toThrow(/supports PCM16 output/);
    await audio.dispose();
  });

  it.each([
    "audio/pcm",
    "audio/pcm;rate=7999",
    "audio/pcm;rate=192001",
    "audio/pcm;rate=24000;rate=16000",
  ])("rejects unsafe or ambiguous PCM output rate metadata: %s", async (mimeType) => {
    const audio = createAudio();

    await expect(
      audio.play({ type: "audio.output", data: "AAA=", mimeType }),
    ).rejects.toThrow(/requires exactly one rate between 8000 and 192000/);
    await audio.dispose();
  });

  it("rejects empty PCM output instead of admitting zero-duration queue entries", async () => {
    const audio = createAudio();

    await expect(
      audio.play({ type: "audio.output", data: "", mimeType: "audio/pcm;rate=24000" }),
    ).rejects.toThrow(/empty PCM16 audio frame/);
    await audio.dispose();
  });

  it("bounds queued playback and emits a drop diagnostic", async () => {
    const dropped = vi.fn();
    const audio = createAudio({ maxQueuedAudioMs: 1 });
    audio.on("audio.dropped", dropped);

    await expect(
      audio.play({ type: "audio.output", data: pcmFrame(new Array(100).fill(0)), mimeType: "audio/pcm;rate=24000" }),
    ).resolves.toBe(false);
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "playback_backpressure" }));
    await audio.dispose();
  });
});

describe("browser client utilities", () => {
  it("keeps credentials separate from the configured URL", () => {
    expect(buildGatewayWebSocketUrl("wss://voice.example/v1/live", "secret").searchParams.get("token")).toBe("secret");
    expect(() => buildGatewayWebSocketUrl("wss://voice.example/v1/live?token=secret")).toThrow(/separately/);
  });

  it("encodes typed-array slices without surrounding bytes", () => {
    const bytes = new Uint8Array([9, 1, 2, 9]);
    expect(arrayBufferToBase64(bytes.subarray(1, 3))).toBe(Buffer.from([1, 2]).toString("base64"));
  });

  it("validates state-changing server messages", () => {
    expect(() => validateServerMessage({ type: "task.started", taskId: "task_one" })).toThrow(/sequence/);
    expect(() => validateServerMessage({
      type: "task.snapshot",
      reason: "initial",
      tasks: [{ ...taskSnapshot("task_zero", "running", 1), sequence: 0 }],
      truncated: false,
    })).toThrow(/sequence/);
    expect(() => validateServerMessage({ type: "run.started", runId: "run" })).toThrow(/legacy protocol v2/);
  });

  it("rejects out-of-contract enums from known server messages", () => {
    expect(() => validateServerMessage({
      ...readyMessage("live_invalid_provider"),
      realtime: { ...readyMessage("x").realtime, provider: "other" },
    })).toThrow(/unsupported provider/);
    expect(() => validateServerMessage({
      ...readyMessage("live_invalid_vad"),
      realtime: {
        ...readyMessage("x").realtime,
        audio: { ...readyMessage("x").realtime.audio, turnDetection: "magic_vad" },
      },
    })).toThrow(/unsupported turnDetection/);
    expect(() => validateServerMessage({ type: "transcript.delta", speaker: "tool", text: "hi" }))
      .toThrow(/unsupported speaker/);
    expect(() => validateServerMessage({ type: "input.speech_started", provider: "gemini" }))
      .toThrow(/unsupported provider/);
    expect(() => validateServerMessage({ type: "log", level: "fatal", message: "no" }))
      .toThrow(/unsupported level/);
  });

  it.each([
    {
      name: "session model",
      maximum: 256,
      build: (text: string) => ({ ...readyMessage("live_model_bound"), model: text }),
    },
    {
      name: "audio MIME type",
      maximum: 128,
      build: (text: string) => ({ type: "audio.output", data: "AA==", mimeType: text }),
    },
    {
      name: "transcript",
      maximum: 20_000,
      build: (text: string) => ({ type: "transcript.delta", speaker: "assistant", text }),
    },
    {
      name: "task title",
      maximum: 256,
      build: (text: string) => ({ ...taskAccepted("task_title_bound", 1, 1), title: text }),
    },
    {
      name: "task progress message",
      maximum: 1_000,
      build: (text: string) => ({
        type: "task.progress",
        taskId: "task_progress_bound",
        sequence: 1,
        occurredAt: 1,
        progress: { message: text },
      }),
    },
    {
      name: "task progress stage",
      maximum: 128,
      build: (text: string) => ({
        type: "task.progress",
        taskId: "task_stage_bound",
        sequence: 1,
        occurredAt: 1,
        progress: { message: "working", stage: text },
      }),
    },
    {
      name: "task result summary",
      maximum: 4_000,
      build: (text: string) => ({
        type: "task.completed",
        taskId: "task_summary_bound",
        sequence: 1,
        occurredAt: 1,
        result: { summary: text, truncated: false },
      }),
    },
    {
      name: "task result output",
      maximum: 200_000,
      build: (text: string) => ({
        type: "task.completed",
        taskId: "task_output_bound",
        sequence: 1,
        occurredAt: 1,
        result: { output: text, truncated: false },
      }),
    },
    {
      name: "task error code",
      maximum: 128,
      build: (text: string) => ({
        type: "task.failed",
        taskId: "task_error_code_bound",
        sequence: 1,
        occurredAt: 1,
        error: { code: text, message: "failed", recoverable: false },
      }),
    },
    {
      name: "task error message",
      maximum: 2_000,
      build: (text: string) => ({
        type: "task.failed",
        taskId: "task_error_message_bound",
        sequence: 1,
        occurredAt: 1,
        error: { code: "failed", message: text, recoverable: false },
      }),
    },
    {
      name: "task notification message",
      maximum: 1_000,
      build: (text: string) => ({
        ...taskNotification("task_notification_bound", "notification_bound", 1, false),
        notification: {
          ...taskNotification("task_notification_bound", "notification_bound", 1, false).notification,
          message: text,
        },
      }),
    },
    {
      name: "task stop reason",
      maximum: 1_000,
      build: (text: string) => ({
        type: "task.stopping",
        taskId: "task_reason_bound",
        sequence: 1,
        occurredAt: 1,
        reason: text,
      }),
    },
    {
      name: "public log message",
      maximum: 2_000,
      build: (text: string) => ({ type: "log", level: "info", message: text }),
    },
    {
      name: "audio base64",
      maximum: 8_000_000,
      build: (text: string) => ({ type: "audio.output", data: text, mimeType: "audio/pcm;rate=24000" }),
    },
  ])("enforces the server-side $name ceiling", ({ maximum, build }) => {
    expect(() => validateServerMessage(build("x".repeat(maximum)))).not.toThrow();
    expect(() => validateServerMessage(build("x".repeat(maximum + 1)))).toThrow(/at most/);
  });

  it.each([
    {
      name: "request id",
      maximum: 128,
      build: (id: string) => ({ type: "session.error", code: "error", message: "failed", requestId: id }),
    },
    {
      name: "session id",
      maximum: 256,
      build: (id: string) => readyMessage(id),
    },
    {
      name: "task id",
      maximum: 256,
      build: (id: string) => ({ type: "task.started", taskId: id, sequence: 1, occurredAt: 1 }),
    },
    {
      name: "notification id",
      maximum: 256,
      build: (id: string) => taskNotification("task_notification_id_bound", id, 1, false),
    },
  ])("enforces the server-side $name ceiling", ({ maximum, build }) => {
    expect(() => validateServerMessage(build("a".repeat(maximum)))).not.toThrow();
    expect(() => validateServerMessage(build("a".repeat(maximum + 1)))).toThrow(/unsafe/);
  });

  it.each([
    {
      name: "Hermes capabilities",
      build: (data: Record<string, unknown>) => ({
        ...readyMessage("live_capabilities_json_bound"),
        hermes: { capabilities: data },
      }),
    },
    {
      name: "task usage",
      build: (data: Record<string, unknown>) => ({
        type: "task.completed",
        taskId: "task_usage_json_bound",
        sequence: 1,
        occurredAt: 1,
        result: { summary: "done", truncated: false, usage: data },
      }),
    },
    {
      name: "log metadata",
      build: (data: Record<string, unknown>) => ({ type: "log", level: "info", message: "ok", data }),
    },
  ])("enforces the 64k serialized JSON ceiling for $name", ({ build }) => {
    const exact = { value: "x".repeat(64_000 - JSON.stringify({ value: "" }).length) };
    const over = { value: `${exact.value}x` };
    expect(JSON.stringify(exact)).toHaveLength(64_000);
    expect(() => validateServerMessage(build(exact))).not.toThrow();
    expect(() => validateServerMessage(build(over))).toThrow(/64000 serialized/);
  });

  it("bounds JSON metadata keys and depth without recursive traversal or cyclic stringify", () => {
    const exactKey = { ["k".repeat(63_994)]: 0 };
    const overKey = { ["k".repeat(63_995)]: 0 };
    expect(JSON.stringify(exactKey)).toHaveLength(64_000);
    expect(() => validateServerMessage({ type: "log", level: "info", message: "key", data: exactKey }))
      .not.toThrow();
    expect(() => validateServerMessage({ type: "log", level: "info", message: "key", data: overKey }))
      .toThrow(/64000 serialized/);

    let exactDepth: unknown = 0;
    for (let depth = 0; depth < 31_994; depth += 1) exactDepth = [exactDepth];
    const overDepth: unknown = [exactDepth];
    // {"value":0} is 11 characters and each nested array adds two.
    expect(() => validateServerMessage({ type: "log", level: "info", message: "depth", data: { value: exactDepth } }))
      .not.toThrow();
    expect(() => validateServerMessage({ type: "log", level: "info", message: "depth", data: { value: overDepth } }))
      .toThrow(/64000 serialized/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateServerMessage({ type: "log", level: "info", message: "cycle", data: cyclic }))
      .toThrow(/circular JSON/);

    const getter = vi.fn(() => "executed");
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: getter });
    accessorArray.length = 1;
    expect(() => validateServerMessage({
      type: "log",
      level: "info",
      message: "accessor",
      data: { values: accessorArray },
    })).toThrow(/accessor instead of JSON data/);
    expect(getter).not.toHaveBeenCalled();
  });
});

function createClient(overrides: Record<string, unknown> = {}): HermesLiveClient {
  FakeWebSocket.instances = [];
  let request = 0;
  return new HermesLiveClient({
    url: "ws://127.0.0.1:8788/v1/live",
    profileId: "demo",
    requestIdFactory: () => `req_${++request}`,
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    ...overrides,
  });
}

function readyMessage(sessionId: string) {
  return {
    type: "session.ready",
    protocolVersion: 4,
    sessionId,
    model: "mock-live",
    hermes: {},
    realtime: {
      provider: "mock",
      model: "mock-live",
      audio: { input: { enabled: false }, output: { enabled: false }, turnDetection: "none" },
    },
    tasks: {
      scope: "owner",
      sequence: "per_task",
      reconnect: "snapshot",
      durable: true,
      parallel: true,
      maxConcurrent: 4,
      maxRetained: 256,
      supports: { list: true, get: true, stop: true, resume: false, notificationAck: true },
    },
    conversation: { mode: "new", sessionId: "hermes_session" },
  };
}

async function connectedClient(sessionId: string): Promise<{ client: HermesLiveClient; socket: FakeWebSocket }> {
  const client = createClient();
  const connection = client.connect();
  const socket = await nextSocket();
  socket.open();
  socket.message(readyMessage(sessionId));
  await connection;
  return { client, socket };
}

function taskAccepted(taskId: string, sequence: number, occurredAt: number) {
  return {
    type: "task.accepted",
    taskId,
    sequence,
    occurredAt,
    state: "accepted",
    title: taskId,
  };
}

function taskNotification(
  taskId: string,
  notificationId: string,
  sequence: number,
  acknowledged: boolean,
  requestId?: string,
  kind: "completed" | "failed" | "cancelled" | "unknown" = "completed",
) {
  return {
    type: "task.notification",
    taskId,
    sequence,
    occurredAt: sequence * 100,
    ...(requestId ? { requestId } : {}),
    notification: {
      notificationId,
      kind,
      delivery: "when_idle",
      message: `${taskId} finished`,
      createdAt: 200,
      acknowledged,
    },
  };
}

function taskSnapshot(
  taskId: string,
  state: string,
  sequence: number,
  overrides: Record<string, unknown> = {},
) {
  const stateFields: Record<string, unknown> = {};
  if (state === "completed") {
    stateFields.result = { summary: `${taskId} completed`, truncated: false };
    stateFields.finishedAt = sequence * 100;
  }
  if (state === "failed" || state === "unknown") {
    stateFields.error = { code: "task_error", message: `${taskId} error`, recoverable: false };
  }
  return {
    taskId,
    sequence,
    state,
    title: taskId,
    createdAt: 100,
    updatedAt: sequence * 100,
    ...stateFields,
    ...overrides,
  };
}

async function nextSocket(): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("Expected a fake WebSocket.");
  return socket;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: Array<Record<string, any>> = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  readyState = 0;
  bufferedAmount = 0;
  suppressCloseEvent = false;

  constructor(readonly url: URL) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    const data = typeof value === "string" || ArrayBuffer.isView(value)
      ? value
      : JSON.stringify(value);
    this.emit("message", { data });
  }

  send(payload: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1000, reason = ""): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("The close code is reserved.", "InvalidAccessError");
    }
    if (Buffer.byteLength(reason, "utf8") > 123) {
      throw new DOMException("The close reason is too long.", "SyntaxError");
    }
    this.closeCalls.push({ code, reason });
    if (this.suppressCloseEvent) {
      this.readyState = 2;
      return;
    }
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  serverClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function createAudio(overrides: Record<string, unknown> = {}): HermesLiveAudio {
  const client = (overrides.client as ReturnType<typeof audioClient> | undefined) ?? audioClient();
  const { client: _client, ...options } = overrides;
  return new HermesLiveAudio(client as any, {
    audioContextFactory: (config) => new FakeAudioContext(config) as unknown as AudioContext,
    audioWorkletNodeFactory: () => ({}) as AudioWorkletNode,
    decodeBase64: (value) => Buffer.from(value, "base64").toString("binary"),
    mediaDevices: { getUserMedia: vi.fn() },
    ...options,
  });
}

function audioClient() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  return {
    connected: true,
    on: vi.fn((type: string, listener: (value: unknown) => void) => {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
      return () => values.delete(listener);
    }),
    emit(type: string, value: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(value);
    },
    cancelResponse: vi.fn(),
    sendAudio: vi.fn(),
    endAudio: vi.fn(),
  };
}

class FakeAudioContext {
  state: AudioContextState = "running";
  sampleRate: number;
  currentTime = 0;
  destination = {};
  sources: FakeBufferSource[] = [];
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  resume: () => Promise<void> = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor(options: AudioContextOptions) {
    this.sampleRate = options.sampleRate ?? 48_000;
  }

  createBuffer(_channels: number, length: number, rate: number) {
    return {
      duration: length / rate,
      copyToChannel: vi.fn(),
    };
  }

  createBufferSource() {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
}

class FakeBufferSource {
  buffer?: { duration: number };
  startedAt = 0;
  connect = vi.fn();
  stop = vi.fn();
  private ended?: () => void;

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.ended = listener;
  }

  start(at: number): void {
    this.startedAt = at;
  }
}

function pcmFrame(samples: number[]): string {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer.toString("base64");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMessages(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}
