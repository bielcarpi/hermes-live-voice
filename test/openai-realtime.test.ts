import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenAIConversationItemTruncate,
  buildOpenAIRealtimeAudioAppend,
  buildOpenAIResponseCancel,
  buildOpenAISessionUpdate,
  normalizeOpenAIRealtimeEvent,
  OpenAIRealtimeAdapter,
} from "../src/adapters/outbound/realtime/openai-realtime.adapter.js";

describe("OpenAI Realtime adapter helpers", () => {
  it("normalizes audio and transcript deltas", () => {
    const audioEvents = normalizeOpenAIRealtimeEvent({ type: "response.output_audio.delta", delta: "abc", item_id: "item_1", content_index: 0 });

    expect(audioEvents).toContainEqual({
      type: "audio",
      audio: { data: "abc", mimeType: "audio/pcm;rate=24000", itemId: "item_1", contentIndex: 0 },
    });
    expect(audioEvents).toHaveLength(1);
    expect(normalizeOpenAIRealtimeEvent({ type: "response.audio.delta", delta: "legacy-audio" })).toContainEqual({
      type: "audio",
      audio: { data: "legacy-audio", mimeType: "audio/pcm;rate=24000" },
    });
    expect(normalizeOpenAIRealtimeEvent({ type: "response.output_audio_transcript.delta", delta: "hi" })).toContainEqual({
      type: "text",
      text: "hi",
    });
    expect(normalizeOpenAIRealtimeEvent({ type: "response.audio_transcript.delta", delta: "older hi" })).toContainEqual({
      type: "text",
      text: "older hi",
    });
  });

  it("normalizes function call argument events", () => {
    expect(
      normalizeOpenAIRealtimeEvent({
        type: "response.function_call_arguments.done",
        call_id: "call_1",
        name: "start_hermes_run",
        arguments: '{"message":"hello"}',
      }),
    ).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "start_hermes_run", args: { message: "hello" } },
    });
  });

  it("orders function calls before a terminal response from the same provider event", () => {
    const events = normalizeOpenAIRealtimeEvent({
      type: "response.done",
      response: {
        id: "resp_tool",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call_combined",
          name: "start_hermes_run",
          arguments: '{"message":"inspect"}',
        }],
      },
    });

    expect(events.map((event) => event.type)).toEqual(["tool_call", "response"]);
    expect(events[1]).toMatchObject({ type: "response", status: "completed", responseId: "resp_tool" });
  });

  it("normalizes speech-start events for VAD interruption handling", () => {
    expect(
      normalizeOpenAIRealtimeEvent({
        type: "input_audio_buffer.speech_started",
        item_id: "item_1",
        audio_start_ms: 320,
      }),
    ).toContainEqual({
      type: "input_speech_started",
      provider: "openai",
      itemId: "item_1",
      audioStartMs: 320,
    });
  });

  it("normalizes provider response lifecycle events", () => {
    expect(
      normalizeOpenAIRealtimeEvent({ type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
    ).toContainEqual({ type: "response", status: "started", responseId: "resp_1" });
    expect(
      normalizeOpenAIRealtimeEvent({ type: "response.done", response: { id: "resp_1", status: "completed" } }),
    ).toContainEqual({ type: "response", status: "completed", responseId: "resp_1" });
    expect(
      normalizeOpenAIRealtimeEvent({ type: "response.done", response: { id: "resp_2", status: "failed" } }),
    ).toContainEqual({
      type: "response",
      status: "failed",
      responseId: "resp_2",
      error: "OpenAI Realtime response failed.",
    });
  });

  it("builds PCM append events at 24 kHz", () => {
    const input = Buffer.alloc(48).toString("base64");

    expect(buildOpenAIRealtimeAudioAppend({ data: input, mimeType: "audio/pcm;rate=16000" })).toEqual({
      type: "input_audio_buffer.append",
      audio: expect.any(String),
    });
  });

  it("requires matching G.711 mime types", () => {
    expect(() =>
      buildOpenAIRealtimeAudioAppend({ data: "abc", mimeType: "audio/pcm;rate=24000" }, "g711_ulaw"),
    ).toThrow(/audio\/pcmu/);
  });

  it("builds response cancellation events", () => {
    expect(buildOpenAIResponseCancel()).toEqual({ type: "response.cancel" });
    expect(buildOpenAIConversationItemTruncate({ itemId: "item_1", contentIndex: 0, audioEndMs: 123.6 })).toEqual({
      type: "conversation.item.truncate",
      item_id: "item_1",
      content_index: 0,
      audio_end_ms: 124,
    });
  });

  it("builds session updates for push-to-talk and VAD modes", () => {
    const disabled = buildOpenAISessionUpdate(testOpenAIConfig({ turnDetection: "disabled" }), "hello");
    const semanticVad = buildOpenAISessionUpdate(testOpenAIConfig({ turnDetection: "semantic_vad" }), "hello");

    expect((disabled.session.audio as any).input.turn_detection).toBeNull();
    expect((semanticVad.session.audio as any).input.turn_detection).toEqual({ type: "semantic_vad" });
    expect(semanticVad.session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1",
      reasoning: { effort: "low" },
      parallel_tool_calls: false,
      tool_choice: "auto",
    });

    const realtime15 = buildOpenAISessionUpdate(testOpenAIConfig({ model: "gpt-realtime-1.5" }), "hello");
    expect(realtime15.session).toMatchObject({ model: "gpt-realtime-1.5" });
    expect(realtime15.session).not.toHaveProperty("reasoning");
    expect(realtime15.session).not.toHaveProperty("parallel_tool_calls");
  });

  it("fails direct adapter connects with a clear credential error", async () => {
    await expect(new OpenAIRealtimeAdapter(testOpenAIConfig({ apiKey: undefined })).connect(testConnectParams())).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("closes the provider socket when OpenAI rejects the initial session update", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      server.once("connection", (socket) => {
        socket.once("message", (raw) => {
          const message = JSON.parse(raw.toString("utf8"));
          expect(message).toMatchObject({ type: "session.update" });
          socket.send(JSON.stringify({ type: "error", error: { message: "invalid session" } }));
        });
        socket.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString("utf8") });
        });
      });
    });
    const adapter = new OpenAIRealtimeAdapter(
      testOpenAIConfig({
        apiKey: "test-key",
        baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
      }),
    );

    try {
      await expect(
        adapter.connect({
          sessionId: "live_openai_test",
          systemInstruction: "test",
          callbacks: { onEvent: () => undefined },
        }),
      ).rejects.toThrow("message=invalid session");
      await expect(withTimeout(closed, 2_000, "Timed out waiting for failed OpenAI socket to close.")).resolves.toEqual({
        code: 1011,
        reason: "OpenAI Realtime session start failed",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("rejects malformed JSON before session readiness without leaking the provider socket", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const closed = deferred<{ code: number; reason: string }>();
    server.once("connection", (socket) => {
      socket.once("message", () => socket.send("not-json"));
      socket.once("close", (code, reason) => {
        closed.resolve({ code, reason: reason.toString("utf8") });
      });
    });
    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));

    try {
      await expect(adapter.connect(testConnectParams())).rejects.toThrow("not valid JSON");
      await expect(withTimeout(closed.promise, 1_000, "Malformed startup socket did not close."))
        .resolves.toMatchObject({ code: 1011 });
    } finally {
      await closeServer(server);
    }
  });

  it("does not confirm OpenAI closure until the provider socket closes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const providerClosed = deferred<void>();
    server.once("connection", (socket) => {
      socket.once("message", () => socket.send(JSON.stringify({ type: "session.updated" })));
      socket.once("close", () => providerClosed.resolve());
    });
    const onClose = vi.fn();
    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    const session = await adapter.connect({
      ...testConnectParams(),
      callbacks: { onEvent: () => undefined, onClose },
    });

    try {
      await session.close();
      expect(onClose).toHaveBeenCalledTimes(1);
      await expect(providerClosed.promise).resolves.toBeUndefined();
    } finally {
      await session.close();
      await closeServer(server);
    }
  });

  it("bounds OpenAI session setup and closes an unacknowledged socket", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const providerClosed = deferred<void>();
    server.once("connection", (socket) => {
      socket.once("close", () => providerClosed.resolve());
    });
    const adapter = new OpenAIRealtimeAdapter(
      testOpenAIConfig({
        apiKey: "test-key",
        baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
      }),
      20,
    );

    try {
      await expect(adapter.connect(testConnectParams())).rejects.toThrow("did not acknowledge session.update within 20ms");
      await expect(withTimeout(providerClosed.promise, 1_000, "Timed out waiting for OpenAI startup cleanup."))
        .resolves.toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("defers a fast tool follow-up until the response that requested the tool is terminal", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const clientMessages: any[] = [];
    const toolResponseFinished = deferred<void>();
    const toolOutputReceived = deferred<void>();
    const secondResponseCreate = deferred<void>();
    let upstream: import("ws").WebSocket | undefined;

    server.once("connection", (socket) => {
      upstream = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        clientMessages.push(message);
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
          return;
        }
        if (message.type === "response.create") {
          const responseCreateCount = clientMessages.filter((entry) => entry.type === "response.create").length;
          if (responseCreateCount === 1) {
            socket.send(JSON.stringify({ type: "response.created", response: { status: "in_progress" } }));
            socket.send(JSON.stringify({
              type: "response.function_call_arguments.done",
              call_id: "call_1",
              name: "get_hermes_run_status",
              arguments: '{"run_id":"run_1"}',
            }));
          } else if (responseCreateCount === 2) {
            secondResponseCreate.resolve();
          }
          return;
        }
        if (message.type === "conversation.item.create" && message.item?.type === "function_call_output") {
          toolOutputReceived.resolve();
        }
      });
    });

    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_tool_serialization",
        systemInstruction: "test",
        callbacks: {
          onEvent: (event) => {
            if (event.type !== "tool_call") return;
            void session?.sendToolResponse(event.call, { ok: true, status: "running" }).then(
              () => toolResponseFinished.resolve(),
              (error) => toolResponseFinished.reject(error),
            );
          },
        },
      });

      await session.sendText("check the run");
      await withTimeout(toolResponseFinished.promise, 1_000, "Tool response was not sent.");
      await withTimeout(toolOutputReceived.promise, 1_000, "Tool output did not reach OpenAI.");
      expect(clientMessages.filter((entry) => entry.type === "response.create")).toHaveLength(1);

      upstream?.send(JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [{
            type: "function_call",
            call_id: "call_1",
            name: "get_hermes_run_status",
            arguments: '{"run_id":"run_1"}',
          }],
        },
      }));
      await withTimeout(secondResponseCreate.promise, 1_000, "Deferred response.create was not sent.");

      const toolOutputIndex = clientMessages.findIndex(
        (entry) => entry.type === "conversation.item.create" && entry.item?.type === "function_call_output",
      );
      const secondResponseIndex = clientMessages.map((entry) => entry.type).lastIndexOf("response.create");
      expect(toolOutputIndex).toBeGreaterThanOrEqual(0);
      expect(secondResponseIndex).toBeGreaterThan(toolOutputIndex);
      expect(clientMessages.filter((entry) => entry.type === "response.create")).toHaveLength(2);
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });

  it("sends a same-event tool result before releasing a queued response", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const clientMessages: any[] = [];
    const responseStarted = deferred<void>();
    const toolOutputReceived = deferred<void>();
    const secondResponseCreate = deferred<void>();
    let upstream: import("ws").WebSocket | undefined;

    server.once("connection", (socket) => {
      upstream = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        clientMessages.push(message);
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (message.type === "response.create") {
          const count = clientMessages.filter((entry) => entry.type === "response.create").length;
          if (count === 1) {
            socket.send(JSON.stringify({
              type: "response.created",
              response: { id: "resp_tool", status: "in_progress" },
            }));
            responseStarted.resolve();
          } else if (count === 2) {
            secondResponseCreate.resolve();
          }
        } else if (
          message.type === "conversation.item.create" &&
          message.item?.type === "function_call_output"
        ) {
          toolOutputReceived.resolve();
        }
      });
    });

    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_same_event_tool_serialization",
        systemInstruction: "test",
        callbacks: {
          onEvent: (event) => {
            if (event.type !== "tool_call") return;
            void session?.sendToolResponse(event.call, { ok: true, status: "running" });
          },
        },
      });
      await session.sendText("first question");
      await withTimeout(responseStarted.promise, 1_000, "OpenAI response did not start.");
      await session.sendText("queued question");

      upstream?.send(JSON.stringify({
        type: "response.done",
        response: {
          id: "resp_tool",
          status: "completed",
          output: [{
            type: "function_call",
            call_id: "call_same_event",
            name: "get_hermes_run_status",
            arguments: '{"run_id":"run_1"}',
          }],
        },
      }));

      await withTimeout(toolOutputReceived.promise, 1_000, "Tool output did not reach OpenAI.");
      await withTimeout(secondResponseCreate.promise, 1_000, "Queued response was not released after the tool output.");
      const toolOutputIndex = clientMessages.findIndex(
        (entry) => entry.type === "conversation.item.create" && entry.item?.type === "function_call_output",
      );
      const secondResponseIndex = clientMessages.map((entry) => entry.type).lastIndexOf("response.create");
      expect(secondResponseIndex).toBeGreaterThan(toolOutputIndex);
      expect(clientMessages.filter((entry) => entry.type === "response.create")).toHaveLength(2);
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });

  it("waits for cancellation acknowledgement before creating a queued text response", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const clientMessages: any[] = [];
    const responseStarted = deferred<void>();
    const cancelReceived = deferred<void>();
    const queuedTextReceived = deferred<void>();
    const secondResponseCreate = deferred<void>();
    let upstream: import("ws").WebSocket | undefined;

    server.once("connection", (socket) => {
      upstream = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        clientMessages.push(message);
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
          return;
        }
        if (message.type === "response.create") {
          const responseCreateCount = clientMessages.filter((entry) => entry.type === "response.create").length;
          if (responseCreateCount === 1) {
            socket.send(JSON.stringify({
              type: "response.created",
              response: { id: "resp_1", status: "in_progress" },
            }));
          } else if (responseCreateCount === 2) {
            secondResponseCreate.resolve();
          }
          return;
        }
        if (message.type === "response.cancel") cancelReceived.resolve();
        if (
          message.type === "conversation.item.create" &&
          message.item?.content?.[0]?.text === "next question"
        ) {
          queuedTextReceived.resolve();
        }
      });
    });

    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_cancel_serialization",
        systemInstruction: "test",
        callbacks: {
          onEvent: (event) => {
            if (event.type === "response" && event.status === "started") responseStarted.resolve();
          },
        },
      });

      await session.sendText("first question");
      await withTimeout(responseStarted.promise, 1_000, "OpenAI response did not start.");
      await expect(session.cancelResponse("interrupted")).resolves.toBe(true);
      await session.sendText("next question");
      await withTimeout(cancelReceived.promise, 1_000, "OpenAI did not receive response.cancel.");
      await withTimeout(queuedTextReceived.promise, 1_000, "Queued text did not reach OpenAI.");
      expect(clientMessages.filter((entry) => entry.type === "response.create")).toHaveLength(1);

      upstream?.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_1", status: "cancelled" },
      }));
      await withTimeout(secondResponseCreate.promise, 1_000, "Queued text response was not created after cancellation.");

      const cancelIndex = clientMessages.findIndex((entry) => entry.type === "response.cancel");
      const secondResponseIndex = clientMessages.map((entry) => entry.type).lastIndexOf("response.create");
      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(secondResponseIndex).toBeGreaterThan(cancelIndex);
      expect(clientMessages.filter((entry) => entry.type === "response.create")).toHaveLength(2);
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });

  it("fails closed when OpenAI does not acknowledge response cancellation", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const clientMessages: any[] = [];
    const responseStarted = deferred<void>();
    const adapterError = deferred<unknown>();
    const providerClosed = deferred<{ code: number; reason: string }>();

    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        clientMessages.push(message);
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (message.type === "response.create") {
          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_timeout", status: "in_progress" },
          }));
        }
      });
      socket.once("close", (code, reason) => {
        providerClosed.resolve({ code, reason: reason.toString("utf8") });
      });
    });

    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_cancel_timeout",
        systemInstruction: "test",
        callbacks: {
          onEvent: (event) => {
            if (event.type === "response" && event.status === "started") responseStarted.resolve();
          },
          onError: (error) => adapterError.resolve(error),
        },
      });

      await session.sendText("first question");
      await withTimeout(responseStarted.promise, 1_000, "OpenAI response did not start.");
      vi.useFakeTimers();
      try {
        await expect(session.cancelResponse("interrupted")).resolves.toBe(true);
        await session.sendText("must stay queued");
        await vi.advanceTimersByTimeAsync(2_000);
      } finally {
        vi.useRealTimers();
      }

      await expect(withTimeout(adapterError.promise, 1_000, "Cancel timeout did not report an adapter error."))
        .resolves.toMatchObject({ message: "OpenAI Realtime did not confirm response cancellation within 2000ms." });
      await expect(withTimeout(providerClosed.promise, 1_000, "Cancel timeout did not close the provider socket."))
        .resolves.toEqual({ code: 1011, reason: "OpenAI Realtime cancel timeout" });
      expect(clientMessages.filter((entry) => entry.type === "response.create")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await session?.close();
      await closeServer(server);
    }
  });

  it("fails closed on a post-ready provider error instead of wedging response state", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const adapterError = deferred<unknown>();
    const providerClosed = deferred<{ code: number; reason: string }>();
    let responseCreates = 0;

    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (message.type === "response.create") {
          responseCreates += 1;
          socket.send(JSON.stringify({ type: "response.created", response: { status: "in_progress" } }));
          socket.send(JSON.stringify({ type: "error", error: { message: "provider rejected response" } }));
        }
      });
      socket.once("close", (code, reason) => {
        providerClosed.resolve({ code, reason: reason.toString("utf8") });
      });
    });

    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_provider_error",
        systemInstruction: "test",
        callbacks: {
          onEvent: () => undefined,
          onError: (error) => adapterError.resolve(error),
        },
      });
      await session.sendText("trigger provider error");

      await expect(withTimeout(adapterError.promise, 1_000, "Provider error was not reported."))
        .resolves.toMatchObject({ message: "provider rejected response" });
      await expect(withTimeout(providerClosed.promise, 1_000, "Provider error did not close the socket."))
        .resolves.toEqual({ code: 1011, reason: "OpenAI Realtime provider error" });
      expect(responseCreates).toBe(1);
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });

  it("fails closed on malformed post-ready provider JSON", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const adapterError = deferred<unknown>();
    const providerClosed = deferred<{ code: number; reason: string }>();

    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
          queueMicrotask(() => socket.send("not-json"));
        }
      });
      socket.once("close", (code, reason) => {
        providerClosed.resolve({ code, reason: reason.toString("utf8") });
      });
    });

    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_malformed_event",
        systemInstruction: "test",
        callbacks: {
          onEvent: () => undefined,
          onError: (error) => adapterError.resolve(error),
        },
      });
      await expect(withTimeout(adapterError.promise, 1_000, "Malformed provider event was not reported."))
        .resolves.toMatchObject({ message: "OpenAI Realtime event was not valid JSON." });
      await expect(withTimeout(providerClosed.promise, 1_000, "Malformed provider event did not close the socket."))
        .resolves.toEqual({ code: 1011, reason: "OpenAI Realtime provider error" });
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });

  it("fails closed instead of issuing a response before multiple tool outputs", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const adapterError = deferred<unknown>();
    const providerClosed = deferred<{ code: number; reason: string }>();
    const onEvent = vi.fn();

    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
          queueMicrotask(() => socket.send(JSON.stringify({
            type: "response.done",
            response: {
              status: "completed",
              output: [
                { type: "function_call", call_id: "call_1", name: "get_hermes_run_status", arguments: '{}' },
                { type: "function_call", call_id: "call_2", name: "stop_hermes_run", arguments: '{}' },
              ],
            },
          })));
        }
      });
      socket.once("close", (code, reason) => {
        providerClosed.resolve({ code, reason: reason.toString("utf8") });
      });
    });

    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    }));
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;
    try {
      session = await adapter.connect({
        sessionId: "live_openai_multiple_tools",
        systemInstruction: "test",
        callbacks: { onEvent, onError: (error) => adapterError.resolve(error) },
      });
      await expect(withTimeout(adapterError.promise, 1_000, "Multiple tool calls were not rejected."))
        .resolves.toMatchObject({ message: expect.stringContaining("multiple tool calls") });
      await expect(withTimeout(providerClosed.promise, 1_000, "Multiple tool calls did not close the provider socket."))
        .resolves.toEqual({ code: 1011, reason: "OpenAI Realtime provider error" });
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });
});

function testOpenAIConfig(
  overrides: Partial<Parameters<typeof buildOpenAISessionUpdate>[0]> = {},
): Parameters<typeof buildOpenAISessionUpdate>[0] {
  return {
    baseUrl: "wss://api.openai.com/v1/realtime",
    model: "gpt-realtime-2.1",
    voice: "marin",
    reasoningEffort: "low",
    turnDetection: "disabled",
    inputAudioFormat: "pcm16",
    outputAudioFormat: "pcm16",
    ...overrides,
  };
}

function testConnectParams(): Parameters<OpenAIRealtimeAdapter["connect"]>[0] {
  return {
    sessionId: "live_openai_test",
    systemInstruction: "test",
    callbacks: { onEvent: () => undefined },
  };
}

function portOf(server: WebSocketServer): number {
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("WebSocket server did not expose a TCP port.");
  }
  return address.port;
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
