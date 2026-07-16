import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { LiveModelEvent } from "../src/application/live-gateway/ports/realtime-model.port.js";
import {
  buildOpenAIConversationItemTruncate,
  buildOpenAIRealtimeAudioAppend,
  buildOpenAIResponseCancel,
  buildOpenAISessionUpdate,
  buildOpenAITaskNotificationResponse,
  normalizeOpenAIRealtimeEvent,
  OPENAI_MAX_HANDLED_TOOL_CALLS,
  OPENAI_MAX_QUEUED_RESPONSE_REQUESTS,
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

  it("only extracts tools from completed response-scoped call events", () => {
    const call = {
      type: "function_call",
      call_id: "call_untrusted_item",
      name: "start_hermes_run",
      arguments: '{"message":"must not run"}',
    };

    expect(normalizeOpenAIRealtimeEvent({
      type: "conversation.item.created",
      item: call,
    })).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
    expect(normalizeOpenAIRealtimeEvent({
      type: "response.output_item.added",
      response_id: "resp_1",
      item: call,
    })).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
    expect(normalizeOpenAIRealtimeEvent({
      type: "response.output_item.done",
      response_id: "resp_1",
      item: { ...call, status: "in_progress" },
    })).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
    expect(normalizeOpenAIRealtimeEvent({
      type: "response.done",
      response: { id: "resp_1", status: "cancelled", output: [call] },
    })).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
    expect(normalizeOpenAIRealtimeEvent({
      type: "response.output_item.done",
      response_id: "resp_1",
      item: { ...call, status: "completed" },
    })).toContainEqual({
      type: "tool_call",
      call: {
        id: "call_untrusted_item",
        name: "start_hermes_run",
        args: { message: "must not run" },
      },
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

  it("normalizes VAD speech boundaries for interruption and notification handling", () => {
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
    expect(
      normalizeOpenAIRealtimeEvent({
        type: "input_audio_buffer.speech_stopped",
        item_id: "item_1",
        audio_end_ms: 910,
      }),
    ).toContainEqual({
      type: "input_speech_stopped",
      provider: "openai",
      itemId: "item_1",
      audioEndMs: 910,
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
    expect(
      normalizeOpenAIRealtimeEvent({ type: "response.done", response: { id: "resp_3", status: "incomplete" } }),
    ).toContainEqual({
      type: "response",
      status: "failed",
      responseId: "resp_3",
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
    expect(buildOpenAIResponseCancel("resp_notice")).toEqual({
      type: "response.cancel",
      response_id: "resp_notice",
    });
    expect(buildOpenAIResponseCancel("resp_notice", "cancel_1")).toEqual({
      type: "response.cancel",
      event_id: "cancel_1",
      response_id: "resp_notice",
    });
    expect(buildOpenAIConversationItemTruncate({ itemId: "item_1", contentIndex: 0, audioEndMs: 123.6 })).toEqual({
      type: "conversation.item.truncate",
      item_id: "item_1",
      content_index: 0,
      audio_end_ms: 124,
    });
  });

  it("builds a no-context, out-of-band audio notification that cannot call tools", () => {
    const context = "[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef] private marker";
    const announcement = "The repository review is ready.";
    const response = buildOpenAITaskNotificationResponse({
      context,
      announcement,
      rawOutput: "private Hermes output must never cross this boundary",
    } as any);

    expect(response).toEqual({
      conversation: "none",
      input: [],
      instructions: `Say exactly this one short task-status sentence and nothing else: ${JSON.stringify(announcement)}`,
      output_modalities: ["audio"],
      tools: [],
      tool_choice: "none",
      metadata: { hermes_live_purpose: "task_notification" },
    });
    expect(JSON.stringify(response)).not.toContain(context);
    expect(JSON.stringify(response)).not.toContain("private Hermes output");
  });

  it.each([
    ["a non-object notification", null],
    ["a missing context", { announcement: "Done." }],
    ["an empty context", { context: "", announcement: "Done." }],
    ["a blank context", { context: "   ", announcement: "Done." }],
    ["an overlong context", { context: "x".repeat(1_001), announcement: "Done." }],
    ["a context control character", { context: "marker\nforged", announcement: "Done." }],
    ["a context C1 control character", { context: "marker\u0085forged", announcement: "Done." }],
    ["a missing announcement", { context: "marker" }],
    ["an empty announcement", { context: "marker", announcement: "" }],
    ["a blank announcement", { context: "marker", announcement: "   " }],
    ["an overlong announcement", { context: "marker", announcement: "x".repeat(501) }],
    ["an announcement control character", { context: "marker", announcement: "Done.\u0000" }],
  ])("rejects %s before creating a task-notification response", (_label, notification) => {
    expect(() => buildOpenAITaskNotificationResponse(notification as any)).toThrow(/Task notification/);
  });

  it("accepts task-notification fields exactly at their documented bounds", () => {
    const response = buildOpenAITaskNotificationResponse({
      context: "c".repeat(1_000),
      announcement: "a".repeat(500),
    });

    expect(response.instructions).toContain("a".repeat(500));
  });

  it("builds session updates for push-to-talk and VAD modes", () => {
    const disabled = buildOpenAISessionUpdate(testOpenAIConfig({ turnDetection: "disabled" }), "hello");
    const semanticVad = buildOpenAISessionUpdate(testOpenAIConfig({ turnDetection: "semantic_vad" }), "hello");

    expect((disabled.session.audio as any).input.turn_detection).toBeNull();
    expect((semanticVad.session.audio as any).input.turn_detection).toEqual({
      type: "semantic_vad",
      create_response: false,
      interrupt_response: true,
    });
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

  it.each([
    ["pcm16", { type: "audio/pcm", rate: 24_000 }],
    ["g711_ulaw", { type: "audio/pcmu" }],
    ["g711_alaw", { type: "audio/pcma" }],
  ] as const)("builds the current OpenAI %s format for both audio directions", (format, expected) => {
    const update = buildOpenAISessionUpdate(testOpenAIConfig({
      inputAudioFormat: format,
      outputAudioFormat: format,
    }), "hello");

    const audio = update.session.audio as {
      input: { format: unknown };
      output: { format: unknown };
    };
    expect(audio.input.format).toEqual(expected);
    expect(audio.output.format).toEqual(expected);
  });

  it.each([
    {
      inputAudioFormat: "g711_ulaw",
      outputAudioFormat: "pcm16",
      expectedInput: { type: "audio/pcmu" },
      expectedOutput: { type: "audio/pcm", rate: 24_000 },
    },
    {
      inputAudioFormat: "pcm16",
      outputAudioFormat: "g711_alaw",
      expectedInput: { type: "audio/pcm", rate: 24_000 },
      expectedOutput: { type: "audio/pcma" },
    },
  ] as const)(
    "keeps mixed OpenAI input and output formats in their configured directions",
    ({ inputAudioFormat, outputAudioFormat, expectedInput, expectedOutput }) => {
      const update = buildOpenAISessionUpdate(testOpenAIConfig({ inputAudioFormat, outputAudioFormat }), "hello");
      const audio = update.session.audio as {
        input: { format: unknown };
        output: { format: unknown };
      };

      expect(audio.input.format).toEqual(expectedInput);
      expect(audio.output.format).toEqual(expectedOutput);
    },
  );

  it("sends the required 24 kHz PCM output rate on the provider wire", async () => {
    const harness = await createOpenAITestHarness();
    try {
      expect(harness.clientMessages[0]).toMatchObject({
        type: "session.update",
        session: {
          audio: {
            input: { format: { type: "audio/pcm", rate: 24_000 } },
            output: { format: { type: "audio/pcm", rate: 24_000 } },
          },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("fails direct adapter connects with a clear credential error", async () => {
    await expect(new OpenAIRealtimeAdapter(testOpenAIConfig({ apiKey: undefined })).connect(testConnectParams())).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("never follows a provider redirect or makes a second authenticated connection", async () => {
    const target = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(target, "listening");
    const targetPort = portOf(target);
    let targetConnections = 0;
    let targetAuthorization: string | undefined;
    target.on("connection", (socket, request) => {
      targetConnections += 1;
      targetAuthorization = request.headers.authorization;
      socket.terminate();
    });

    const redirector = createServer();
    let redirectRequests = 0;
    let initialAuthorization: string | undefined;
    redirector.on("upgrade", (request, socket) => {
      redirectRequests += 1;
      initialAuthorization = request.headers.authorization;
      socket.end([
        "HTTP/1.1 302 Found",
        `Location: ws://127.0.0.1:${targetPort}/v1/realtime`,
        "Connection: close",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"));
    });
    redirector.listen(0, "127.0.0.1");
    await once(redirector, "listening");
    const redirectPort = portOfHttp(redirector);
    const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
      apiKey: "redirect-sensitive-key",
      baseUrl: `ws://127.0.0.1:${redirectPort}/v1/realtime`,
    }), 500, 500);

    try {
      await expect(adapter.connect(testConnectParams())).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(redirectRequests).toBe(1);
      expect(initialAuthorization).toBe("Bearer redirect-sensitive-key");
      expect(targetConnections).toBe(0);
      expect(targetAuthorization).toBeUndefined();
    } finally {
      await closeHttpServer(redirector);
      await closeServer(target);
    }
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

  it("sends an idle task notification as an audio out-of-band response, never a user item", async () => {
    const harness = await createOpenAITestHarness();
    const notification = taskNotification("Repository review");

    try {
      await harness.session.sendTaskNotification?.({
        ...notification,
        rawOutput: "private raw Hermes output",
      } as any);
      const responses = await waitForResponseCreates(harness.clientMessages, 1);

      expect(responses[0]).toEqual({
        type: "response.create",
        response: buildOpenAITaskNotificationResponse(notification),
      });
      expect(harness.clientMessages).not.toContainEqual(
        expect.objectContaining({ type: "conversation.item.create" }),
      );
      expect(JSON.stringify(responses[0])).not.toContain(notification.context);
      expect(JSON.stringify(responses[0])).not.toContain("private raw Hermes output");
    } finally {
      await harness.close();
    }
  });

  it("releases a queued response after OpenAI reports an incomplete terminal response", async () => {
    const responseStarted = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type === "response" && event.status === "started") responseStarted.resolve();
      },
    });

    try {
      await harness.session.sendText("initial question");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_incomplete", status: "in_progress" },
      }));
      await withTimeout(responseStarted.promise, 1_000, "Initial response did not start.");

      await harness.session.sendText("continue after the incomplete response");
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(1);
      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_incomplete", status: "incomplete" },
      }));

      const responses = await waitForResponseCreates(harness.clientMessages, 2);
      expect(responses[1]).toEqual({ type: "response.create" });
    } finally {
      await harness.close();
    }
  });

  it("serializes typed input behind the adapter-scheduled VAD response", async () => {
    const vadResponseStarted = deferred<void>();
    const speechStopped = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type === "response" && event.status === "started") vadResponseStarted.resolve();
        if (event.type === "input_speech_stopped") speechStopped.resolve();
      },
    }, { turnDetection: "semantic_vad" });

    try {
      harness.upstream.send(JSON.stringify({
        type: "input_audio_buffer.speech_stopped",
        item_id: "item_voice",
        audio_end_ms: 900,
      }));
      await withTimeout(speechStopped.promise, 1_000, "Speech-stopped event was not delivered.");
      let responses = await waitForResponseCreates(harness.clientMessages, 1);
      expect(responses[0]).toEqual({ type: "response.create" });

      await harness.session.sendText("typed while the VAD response is being created");
      expect(harness.clientMessages.filter((message) => message.type === "conversation.item.create")).toHaveLength(0);
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(1);

      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_vad", status: "in_progress", conversation_id: "conv_test" },
      }));
      await withTimeout(vadResponseStarted.promise, 1_000, "Scheduled VAD response did not start.");
      await vi.waitFor(() => expect(
        harness.clientMessages.filter((message) => message.type === "conversation.item.create"),
      ).toHaveLength(1));
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(1);

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_vad", status: "completed", conversation_id: "conv_test" },
      }));
      responses = await waitForResponseCreates(harness.clientMessages, 2);
      expect(responses[1]).toEqual({ type: "response.create" });
    } finally {
      await harness.close();
    }
  });

  it("serializes an interrupted out-of-band notice before VAD and drains later typed input", async () => {
    const lifecycleEvents: LiveModelEvent[] = [];
    const speechStarted = deferred<void>();
    const speechStopped = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        lifecycleEvents.push(event);
        if (event.type === "input_speech_started") speechStarted.resolve();
        if (event.type === "input_speech_stopped") speechStopped.resolve();
      },
    }, { turnDetection: "semantic_vad" });

    try {
      await harness.session.sendTaskNotification?.(taskNotification("Overlapping task"));
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_notice_overlap",
          status: "in_progress",
          conversation_id: null,
          metadata: { hermes_live_purpose: "task_notification" },
        },
      }));
      await vi.waitFor(() => expect(lifecycleEvents).toContainEqual(expect.objectContaining({
        type: "response",
        status: "started",
        responseId: "resp_notice_overlap",
        scope: "task_notification",
      })));

      harness.upstream.send(JSON.stringify({
        type: "input_audio_buffer.speech_started",
        item_id: "item_overlap",
        audio_start_ms: 100,
      }));
      await withTimeout(speechStarted.promise, 1_000, "Speech-started event was not delivered.");
      await expect(harness.session.cancelResponse("barge in")).resolves.toBe(true);
      await vi.waitFor(() => expect(harness.clientMessages).toContainEqual(expect.objectContaining({
        type: "response.cancel",
        response_id: "resp_notice_overlap",
      })));

      harness.upstream.send(JSON.stringify({
        type: "input_audio_buffer.speech_stopped",
        item_id: "item_overlap",
        audio_end_ms: 700,
      }));
      await withTimeout(speechStopped.promise, 1_000, "Speech-stopped event was not delivered.");
      await harness.session.sendText("typed behind the spoken turn");
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(1);
      expect(harness.clientMessages.filter((message) => message.type === "conversation.item.create")).toHaveLength(0);

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: {
          id: "resp_notice_overlap",
          status: "cancelled",
          conversation_id: null,
          metadata: { hermes_live_purpose: "task_notification" },
        },
      }));
      let responses = await waitForResponseCreates(harness.clientMessages, 2);
      expect(responses[1]).toEqual({ type: "response.create" });

      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_vad_overlap", status: "in_progress", conversation_id: "conv_overlap" },
      }));
      await vi.waitFor(() => expect(
        harness.clientMessages.filter((message) => message.type === "conversation.item.create"),
      ).toHaveLength(1));
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(2);

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_vad_overlap", status: "completed", conversation_id: "conv_overlap" },
      }));
      responses = await waitForResponseCreates(harness.clientMessages, 3);
      expect(responses[2]).toEqual({ type: "response.create" });
    } finally {
      await harness.close();
    }
  });

  it("waits for an out-of-band response id before sending its exact cancellation", async () => {
    const lifecycleEvents: LiveModelEvent[] = [];
    const harness = await createOpenAITestHarness({
      onEvent: (event) => lifecycleEvents.push(event),
    });
    try {
      await harness.session.sendTaskNotification?.(taskNotification("Pending notice"));
      await waitForResponseCreates(harness.clientMessages, 1);
      await expect(harness.session.cancelResponse("cancel pending notice")).resolves.toBe(true);
      expect(harness.clientMessages.filter((message) => message.type === "response.cancel")).toHaveLength(0);

      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_pending_notice",
          status: "in_progress",
        },
      }));
      await vi.waitFor(() => expect(harness.clientMessages).toContainEqual(expect.objectContaining({
        type: "response.cancel",
        response_id: "resp_pending_notice",
      })));
      expect(lifecycleEvents).toContainEqual(expect.objectContaining({
        type: "response",
        status: "started",
        responseId: "resp_pending_notice",
        scope: "task_notification",
      }));
    } finally {
      await harness.close();
    }
  });

  it("preserves FIFO order, coalesces adjacent default responses, and never coalesces notifications", async () => {
    const responseStarted = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type === "response" && event.status === "started") responseStarted.resolve();
      },
    });
    const firstNotification = taskNotification("First task");
    const secondNotification = taskNotification("Second task");

    try {
      await harness.session.sendText("initial question");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_initial", status: "in_progress" },
      }));
      await withTimeout(responseStarted.promise, 1_000, "Initial response did not start.");

      await harness.session.sendText("queued question one");
      await harness.session.sendText("queued question two");
      await harness.session.sendTaskNotification?.(firstNotification);
      await harness.session.sendTaskNotification?.(secondNotification);
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(1);

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_initial", status: "completed" },
      }));
      let responses = await waitForResponseCreates(harness.clientMessages, 2);
      expect(responses[1]).toEqual({ type: "response.create" });

      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_default", status: "in_progress" },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_default", status: "completed" },
      }));
      responses = await waitForResponseCreates(harness.clientMessages, 3);
      expect(responses[2]).toEqual({
        type: "response.create",
        response: buildOpenAITaskNotificationResponse(firstNotification),
      });

      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_notice_1", status: "in_progress" },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_notice_1", status: "completed" },
      }));
      responses = await waitForResponseCreates(harness.clientMessages, 4);
      expect(responses[3]).toEqual({
        type: "response.create",
        response: buildOpenAITaskNotificationResponse(secondNotification),
      });
      expect(
        harness.clientMessages.filter((message) => message.type === "conversation.item.create"),
      ).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it("keeps arrival order when a notification is queued before an ordinary response", async () => {
    const responseStarted = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type === "response" && event.status === "started") responseStarted.resolve();
      },
    });
    const notification = taskNotification("Earlier task");

    try {
      await harness.session.sendText("initial question");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_fifo_initial", status: "in_progress" },
      }));
      await withTimeout(responseStarted.promise, 1_000, "Initial response did not start.");

      await harness.session.sendTaskNotification?.(notification);
      await harness.session.sendText("later ordinary question");
      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_fifo_initial", status: "completed" },
      }));
      let responses = await waitForResponseCreates(harness.clientMessages, 2);
      expect(responses[1]).toEqual({
        type: "response.create",
        response: buildOpenAITaskNotificationResponse(notification),
      });

      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_fifo_notice", status: "in_progress" },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_fifo_notice", status: "completed" },
      }));
      responses = await waitForResponseCreates(harness.clientMessages, 3);
      expect(responses[2]).toEqual({ type: "response.create" });
    } finally {
      await harness.close();
    }
  });

  it("ignores duplicate terminal events instead of releasing two queued responses concurrently", async () => {
    const responseStarted = deferred<void>();
    const lifecycleEvents: any[] = [];
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type !== "response") return;
        lifecycleEvents.push(event);
        if (event.status === "started") responseStarted.resolve();
      },
    });
    const firstNotification = taskNotification("First duplicate-race task");
    const secondNotification = taskNotification("Second duplicate-race task");

    try {
      await harness.session.sendText("initial question");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_duplicate", status: "in_progress" },
      }));
      await withTimeout(responseStarted.promise, 1_000, "Initial response did not start.");
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_duplicate", status: "in_progress" },
      }));
      await harness.session.sendTaskNotification?.(firstNotification);
      await harness.session.sendTaskNotification?.(secondNotification);

      const terminal = JSON.stringify({
        type: "response.done",
        response: { id: "resp_duplicate", status: "completed" },
      });
      harness.upstream.send(terminal);
      harness.upstream.send(terminal);
      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { status: "completed" },
      }));
      let responses = await waitForResponseCreates(harness.clientMessages, 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(2);
      expect(lifecycleEvents.filter((event) => event.status === "completed")).toHaveLength(1);
      expect(lifecycleEvents.filter((event) => event.status === "started")).toHaveLength(1);
      expect(responses[1]).toEqual({
        type: "response.create",
        response: buildOpenAITaskNotificationResponse(firstNotification),
      });

      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_duplicate_notice", status: "in_progress" },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_duplicate_notice", status: "completed" },
      }));
      responses = await waitForResponseCreates(harness.clientMessages, 3);
      expect(responses[2]).toEqual({
        type: "response.create",
        response: buildOpenAITaskNotificationResponse(secondNotification),
      });
    } finally {
      await harness.close();
    }
  });

  it("bounds the response queue, preserves its ordinary head, and clears it on close", async () => {
    const responseStarted = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type === "response" && event.status === "started") responseStarted.resolve();
      },
    });

    try {
      await harness.session.sendText("initial question");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_bounded", status: "in_progress" },
      }));
      await withTimeout(responseStarted.promise, 1_000, "Initial response did not start.");

      await harness.session.sendText("ordinary response must remain first");
      for (let index = 0; index < OPENAI_MAX_QUEUED_RESPONSE_REQUESTS - 1; index += 1) {
        await harness.session.sendTaskNotification?.(taskNotification(`Queued task ${index}`));
      }
      await expect(
        harness.session.sendTaskNotification?.(taskNotification("Overflow task")),
      ).rejects.toThrow(`exceeded ${OPENAI_MAX_QUEUED_RESPONSE_REQUESTS}`);
      const conversationItemsBeforeRejectedTurn = harness.clientMessages.filter(
        (message) => message.type === "conversation.item.create",
      ).length;
      await expect(harness.session.sendText("must not be partially written"))
        .rejects.toThrow(`exceeded ${OPENAI_MAX_QUEUED_RESPONSE_REQUESTS}`);
      expect(harness.clientMessages.filter(
        (message) => message.type === "conversation.item.create",
      )).toHaveLength(conversationItemsBeforeRejectedTurn);
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(1);

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_bounded", status: "completed" },
      }));
      const responses = await waitForResponseCreates(harness.clientMessages, 2);
      expect(responses[1]).toEqual({ type: "response.create" });

      await harness.session.close();
      await expect(
        harness.session.sendTaskNotification?.(taskNotification("After close")),
      ).rejects.toThrow("session is closing");
      expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(2);
    } finally {
      await harness.close();
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
            socket.send(JSON.stringify({
              type: "response.created",
              response: { id: "resp_tool_serialization", status: "in_progress" },
            }));
            socket.send(JSON.stringify({
              type: "response.function_call_arguments.done",
              response_id: "resp_tool_serialization",
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
          id: "resp_tool_serialization",
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

  it("drops wrong or missing response payload identities without poisoning tool replay state", async () => {
    const events: LiveModelEvent[] = [];
    const harness = await createOpenAITestHarness({
      onEvent: (event) => events.push(event),
    });

    try {
      harness.upstream.send(JSON.stringify({
        type: "conversation.item.created",
        item: {
          type: "function_call",
          call_id: "call_unsolicited_item",
          name: "start_hermes_run",
          arguments: '{"message":"must not run"}',
        },
      }));
      await harness.session.sendText("start a response for correlation checks");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_correlation_active", status: "in_progress" },
      }));
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "response",
        status: "started",
        responseId: "resp_correlation_active",
      })));

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: {
          id: "resp_correlation_wrong",
          status: "completed",
          output: [{
            type: "function_call",
            status: "completed",
            call_id: "call_wrong_terminal",
            name: "start_hermes_run",
            arguments: '{"message":"wrong terminal"}',
          }],
        },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_correlation_wrong",
        call_id: "call_wrong_payload",
        name: "start_hermes_run",
        arguments: '{"message":"wrong payload"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "call_missing_identity",
        name: "start_hermes_run",
        arguments: '{"message":"missing identity"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_audio.delta",
        response_id: "resp_correlation_wrong",
        delta: "wrong-audio",
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_text.delta",
        response_id: "resp_correlation_wrong",
        delta: "wrong text",
      }));

      harness.upstream.send(JSON.stringify({
        type: "response.output_audio.delta",
        response_id: "resp_correlation_active",
        delta: "correct-audio",
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_text.delta",
        response_id: "resp_correlation_active",
        delta: "correct text",
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_correlation_active",
        call_id: "call_wrong_terminal",
        name: "start_hermes_run",
        arguments: '{"message":"wrong terminal"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_correlation_active",
        call_id: "call_wrong_payload",
        name: "start_hermes_run",
        arguments: '{"message":"wrong payload"}',
      }));

      await vi.waitFor(() => expect(events.filter((event) => event.type === "tool_call")).toHaveLength(2));
      expect(events.filter((event) => event.type === "tool_call").map((event) => event.call.id)).toEqual([
        "call_wrong_terminal",
        "call_wrong_payload",
      ]);
      expect(events.filter((event) => event.type === "audio").map((event) => event.audio.data)).toEqual([
        "correct-audio",
      ]);
      expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
        "correct text",
      ]);
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "response",
        status: "completed",
        responseId: "resp_correlation_wrong",
      }));
    } finally {
      await harness.close();
    }
  });

  it.each(["created", "terminal"] as const)(
    "fails closed when a %s response lifecycle event omits its response id",
    async (phase) => {
      const events: LiveModelEvent[] = [];
      const adapterError = deferred<unknown>();
      const harness = await createOpenAITestHarness({
        onEvent: (event) => events.push(event),
        onError: (error) => adapterError.resolve(error),
      });
      const providerClosed = once(harness.upstream, "close");

      try {
        await harness.session.sendText("response with malformed lifecycle identity");
        await waitForResponseCreates(harness.clientMessages, 1);
        if (phase === "terminal") {
          harness.upstream.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_before_anonymous_terminal", status: "in_progress" },
          }));
          await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
            type: "response",
            status: "started",
            responseId: "resp_before_anonymous_terminal",
          })));
          harness.upstream.send(JSON.stringify({
            type: "response.done",
            response: {
              status: "completed",
              output: [{
                type: "function_call",
                status: "completed",
                call_id: "call_anonymous_terminal",
                name: "start_hermes_run",
                arguments: '{"message":"anonymous terminal"}',
              }],
            },
          }));
        } else {
          harness.upstream.send(JSON.stringify({
            type: "response.created",
            response: { status: "in_progress" },
          }));
        }

        await expect(withTimeout(adapterError.promise, 1_000, "Missing lifecycle identity was not rejected."))
          .resolves.toMatchObject({ message: expect.stringContaining("exact") });
        await expect(withTimeout(providerClosed, 1_000, "Missing lifecycle identity did not close OpenAI."))
          .resolves.toBeDefined();
        expect(events.filter((event) => event.type === "tool_call")).toHaveLength(0);
        expect(events).not.toContainEqual(expect.objectContaining({
          type: "response",
          status: "completed",
        }));
      } finally {
        await harness.close();
      }
    },
  );

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

  it("suppresses exact-response tool completions while cancellation is pending without poisoning replay state", async () => {
    const events: LiveModelEvent[] = [];
    const cancellationBarrier = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        events.push(event);
        if (event.type === "text" && event.text === "cancel barrier") cancellationBarrier.resolve();
      },
    });

    try {
      await harness.session.sendText("response that will be interrupted");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_cancel_tools", status: "in_progress" },
      }));
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "response",
        status: "started",
        responseId: "resp_cancel_tools",
      })));
      await expect(harness.session.cancelResponse("interrupt tool generation")).resolves.toBe(true);
      await vi.waitFor(() => expect(
        harness.clientMessages.filter((message) => message.type === "response.cancel"),
      ).toHaveLength(1));

      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_cancel_tools",
        call_id: "call_cancel_args",
        name: "start_hermes_run",
        arguments: '{"message":"cancelled args"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_item.done",
        response_id: "resp_cancel_tools",
        item: {
          type: "function_call",
          status: "completed",
          call_id: "call_cancel_item",
          name: "start_hermes_run",
          arguments: '{"message":"cancelled item"}',
        },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_text.delta",
        response_id: "resp_cancel_tools",
        delta: "cancel barrier",
      }));
      await withTimeout(cancellationBarrier.promise, 1_000, "Cancellation tool barrier was not delivered.");
      expect(events.filter((event) => event.type === "tool_call")).toHaveLength(0);

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: {
          id: "resp_cancel_tools",
          status: "completed",
          output: [{
            type: "function_call",
            status: "completed",
            call_id: "call_cancel_terminal",
            name: "start_hermes_run",
            arguments: '{"message":"cancelled terminal"}',
          }],
        },
      }));
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "response",
        status: "completed",
        responseId: "resp_cancel_tools",
      })));
      expect(events.filter((event) => event.type === "tool_call")).toHaveLength(0);
      await harness.session.sendText("response after cancellation");
      await waitForResponseCreates(harness.clientMessages, 2);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_after_cancel_tools", status: "in_progress" },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_after_cancel_tools",
        call_id: "call_cancel_args",
        name: "start_hermes_run",
        arguments: '{"message":"cancelled args"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_item.done",
        response_id: "resp_after_cancel_tools",
        item: {
          type: "function_call",
          status: "completed",
          call_id: "call_cancel_item",
          name: "start_hermes_run",
          arguments: '{"message":"cancelled item"}',
        },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_after_cancel_tools",
        call_id: "call_cancel_terminal",
        name: "start_hermes_run",
        arguments: '{"message":"cancelled terminal"}',
      }));
      await vi.waitFor(() => expect(events.filter((event) => event.type === "tool_call")).toHaveLength(3));
    } finally {
      await harness.close();
    }
  });

  it("suppresses tool completions as soon as server VAD interrupts the active response", async () => {
    const events: LiveModelEvent[] = [];
    const vadBarrier = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        events.push(event);
        if (event.type === "text" && event.text === "VAD barrier") vadBarrier.resolve();
      },
    }, { turnDetection: "semantic_vad" });

    try {
      await harness.session.sendText("response interrupted before the client cancel round trip");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_vad_tool_gap", status: "in_progress" },
      }));
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "response",
        status: "started",
        responseId: "resp_vad_tool_gap",
      })));

      harness.upstream.send(JSON.stringify({
        type: "input_audio_buffer.speech_started",
        item_id: "item_vad_tool_gap",
        audio_start_ms: 120,
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_vad_tool_gap",
        call_id: "call_vad_args",
        name: "start_hermes_run",
        arguments: '{"message":"VAD args"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_item.done",
        response_id: "resp_vad_tool_gap",
        item: {
          type: "function_call",
          status: "completed",
          call_id: "call_vad_item",
          name: "start_hermes_run",
          arguments: '{"message":"VAD item"}',
        },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_text.delta",
        response_id: "resp_vad_tool_gap",
        delta: "VAD barrier",
      }));
      await withTimeout(vadBarrier.promise, 1_000, "VAD tool barrier was not delivered.");
      expect(events.filter((event) => event.type === "tool_call")).toHaveLength(0);
      expect(harness.clientMessages.filter((message) => message.type === "response.cancel")).toHaveLength(0);

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp_vad_tool_gap", status: "cancelled" },
      }));
      await harness.session.sendText("response after VAD interruption");
      await waitForResponseCreates(harness.clientMessages, 2);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_after_vad_tool_gap", status: "in_progress" },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_after_vad_tool_gap",
        call_id: "call_vad_args",
        name: "start_hermes_run",
        arguments: '{"message":"VAD args"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_item.done",
        response_id: "resp_after_vad_tool_gap",
        item: {
          type: "function_call",
          status: "completed",
          call_id: "call_vad_item",
          name: "start_hermes_run",
          arguments: '{"message":"VAD item"}',
        },
      }));
      await vi.waitFor(() => expect(events.filter((event) => event.type === "tool_call")).toHaveLength(2));
    } finally {
      await harness.close();
    }
  });

  it.each(["error_before_done", "done_before_error"] as const)(
    "keeps a correlated no-active cancel race recoverable when %s",
    async (order) => {
      const lifecycleEvents: LiveModelEvent[] = [];
      const adapterErrors: unknown[] = [];
      const harness = await createOpenAITestHarness({
        onEvent: (event) => lifecycleEvents.push(event),
        onError: (error) => adapterErrors.push(error),
      });

      try {
        await harness.session.sendText("response that server VAD may cancel first");
        await waitForResponseCreates(harness.clientMessages, 1);
        harness.upstream.send(JSON.stringify({
          type: "response.created",
          response: { id: "resp_cancel_race", status: "in_progress", conversation_id: "conv_cancel_race" },
        }));
        await vi.waitFor(() => expect(lifecycleEvents).toContainEqual(expect.objectContaining({
          type: "response",
          status: "started",
          responseId: "resp_cancel_race",
        })));

        await expect(harness.session.cancelResponse("client followed server VAD interruption")).resolves.toBe(true);
        await harness.session.sendText("queued after the interruption");
        await vi.waitFor(() => expect(
          harness.clientMessages.filter((message) => message.type === "response.cancel"),
        ).toHaveLength(1));
        const cancel = harness.clientMessages.find((message) => message.type === "response.cancel");
        expect(cancel).toMatchObject({
          type: "response.cancel",
          response_id: "resp_cancel_race",
          event_id: expect.stringMatching(/^cancel_[0-9a-f-]{36}$/),
        });

        const terminal = {
          type: "response.done",
          response: {
            id: "resp_cancel_race",
            status: "cancelled",
            conversation_id: "conv_cancel_race",
          },
        };
        const benignCancelError = {
          type: "error",
          event_id: "server_cancel_race_error",
          error: {
            type: "invalid_request_error",
            code: "response_cancel_not_active",
            message: "Cancellation failed because no response is active.",
            param: null,
            event_id: cancel.event_id,
          },
        };
        if (order === "error_before_done") {
          harness.upstream.send(JSON.stringify(benignCancelError));
          await waitForResponseCreates(harness.clientMessages, 2);
          harness.upstream.send(JSON.stringify(terminal));
        } else {
          harness.upstream.send(JSON.stringify(terminal));
          await waitForResponseCreates(harness.clientMessages, 2);
          harness.upstream.send(JSON.stringify(benignCancelError));
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(adapterErrors).toEqual([]);
        expect(harness.upstream.readyState).toBe(WebSocket.OPEN);
        expect(openAIResponseCreates(harness.clientMessages)).toHaveLength(2);
        expect(lifecycleEvents.filter(
          (event) => event.type === "response"
            && event.status === "cancelled"
            && event.responseId === "resp_cancel_race",
        )).toHaveLength(1);
      } finally {
        await harness.close();
      }
    },
  );

  it("drops a delayed tool-bearing terminal event after a recoverable cancel race", async () => {
    const events: LiveModelEvent[] = [];
    const adapterErrors: unknown[] = [];
    const harness = await createOpenAITestHarness({
      onEvent: (event) => events.push(event),
      onError: (error) => adapterErrors.push(error),
    });

    try {
      await harness.session.sendText("response cancelled by the provider first");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_stale_tool", status: "in_progress" },
      }));
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "response",
        status: "started",
        responseId: "resp_stale_tool",
      })));
      await expect(harness.session.cancelResponse("race with provider cancellation")).resolves.toBe(true);
      await harness.session.sendText("next response after the race");
      await vi.waitFor(() => expect(
        harness.clientMessages.filter((message) => message.type === "response.cancel"),
      ).toHaveLength(1));
      const cancel = harness.clientMessages.find((message) => message.type === "response.cancel");
      harness.upstream.send(JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "response_cancel_not_active",
          message: "Cancellation failed because no response is active.",
          event_id: cancel.event_id,
        },
      }));
      await waitForResponseCreates(harness.clientMessages, 2);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_after_stale_tool", status: "in_progress" },
      }));
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "response",
        status: "started",
        responseId: "resp_after_stale_tool",
      })));

      harness.upstream.send(JSON.stringify({
        type: "response.done",
        response: {
          id: "resp_stale_tool",
          status: "completed",
          output: [{
            type: "function_call",
            status: "completed",
            call_id: "call_delayed_after_cancel",
            name: "start_hermes_run",
            arguments: '{"message":"delayed after cancel"}',
          }],
        },
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_after_stale_tool",
        call_id: "call_delayed_after_cancel",
        name: "start_hermes_run",
        arguments: '{"message":"delayed after cancel"}',
      }));

      await vi.waitFor(() => expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1));
      expect(events.filter((event) => event.type === "tool_call").map((event) => event.call.id)).toEqual([
        "call_delayed_after_cancel",
      ]);
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "response",
        status: "completed",
        responseId: "resp_stale_tool",
      }));
      expect(adapterErrors).toEqual([]);
      expect(harness.upstream.readyState).toBe(WebSocket.OPEN);
    } finally {
      await harness.close();
    }
  });

  it.each([
    { name: "an uncorrelated cancel error", correlated: false, code: "response_cancel_not_active" },
    { name: "a correlated non-cancel-race error", correlated: true, code: "invalid_event" },
  ])("fails closed on $name", async ({ correlated, code }) => {
    const adapterError = deferred<unknown>();
    const responseStarted = deferred<void>();
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type === "response" && event.status === "started") responseStarted.resolve();
      },
      onError: (error) => adapterError.resolve(error),
    });

    try {
      await harness.session.sendText("response before a fatal provider error");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_fatal_cancel", status: "in_progress", conversation_id: "conv_fatal" },
      }));
      await withTimeout(responseStarted.promise, 1_000, "OpenAI response did not start.");
      await expect(harness.session.cancelResponse("create a correlated cancel id")).resolves.toBe(true);
      await vi.waitFor(() => expect(
        harness.clientMessages.filter((message) => message.type === "response.cancel"),
      ).toHaveLength(1));
      const cancel = harness.clientMessages.find((message) => message.type === "response.cancel");
      const providerClosed = once(harness.upstream, "close");

      harness.upstream.send(JSON.stringify({
        type: "error",
        event_id: "server_fatal_cancel_error",
        error: {
          type: "invalid_request_error",
          code,
          message: "Provider rejected the cancellation event.",
          param: null,
          event_id: correlated ? cancel.event_id : "cancel_unrelated",
        },
      }));

      await expect(withTimeout(adapterError.promise, 1_000, "Adapter did not surface the provider error."))
        .resolves.toMatchObject({ code });
      await expect(withTimeout(providerClosed, 1_000, "Adapter did not close after the provider error."))
        .resolves.toBeDefined();
    } finally {
      await harness.close();
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
          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_provider_error", status: "in_progress" },
          }));
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

  it("fails closed when the lifetime tool-call ledger is full instead of evicting replay ids", async () => {
    const acceptedLimit = deferred<void>();
    const replayBarrier = deferred<void>();
    const adapterError = deferred<unknown>();
    let acceptedToolCalls = 0;
    const harness = await createOpenAITestHarness({
      onEvent: (event) => {
        if (event.type === "tool_call") {
          acceptedToolCalls += 1;
          if (acceptedToolCalls === OPENAI_MAX_HANDLED_TOOL_CALLS) acceptedLimit.resolve();
        } else if (event.type === "text" && event.text === "ledger barrier") {
          replayBarrier.resolve();
        }
      },
      onError: (error) => adapterError.resolve(error),
    });
    const providerClosed = deferred<{ code: number; reason: string }>();
    harness.upstream.once("close", (code, reason) => {
      providerClosed.resolve({ code, reason: reason.toString("utf8") });
    });

    try {
      await harness.session.sendText("fill the bounded tool-call ledger");
      await waitForResponseCreates(harness.clientMessages, 1);
      harness.upstream.send(JSON.stringify({
        type: "response.created",
        response: { id: "resp_tool_ledger", status: "in_progress" },
      }));
      for (let index = 0; index < OPENAI_MAX_HANDLED_TOOL_CALLS; index += 1) {
        harness.upstream.send(JSON.stringify({
          type: "response.function_call_arguments.done",
          response_id: "resp_tool_ledger",
          call_id: `bounded_call_${index}`,
          name: "start_background_task",
          arguments: JSON.stringify({ message: `Mutation ${index}` }),
        }));
      }
      await withTimeout(acceptedLimit.promise, 5_000, "OpenAI tool-call ledger did not reach its limit.");
      expect(acceptedToolCalls).toBe(OPENAI_MAX_HANDLED_TOOL_CALLS);

      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_tool_ledger",
        call_id: "bounded_call_0",
        name: "start_background_task",
        arguments: '{"message":"Mutation 0"}',
      }));
      harness.upstream.send(JSON.stringify({
        type: "response.output_audio_transcript.delta",
        response_id: "resp_tool_ledger",
        delta: "ledger barrier",
      }));
      await withTimeout(replayBarrier.promise, 2_000, "Exact replay was not processed before the ledger barrier.");
      expect(acceptedToolCalls).toBe(OPENAI_MAX_HANDLED_TOOL_CALLS);

      harness.upstream.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp_tool_ledger",
        call_id: "must_not_evict_an_old_id",
        name: "start_background_task",
        arguments: '{"message":"Must fail closed"}',
      }));

      await expect(withTimeout(adapterError.promise, 2_000, "Tool-call ledger overflow was not rejected."))
        .resolves.toMatchObject({
          message: `OpenAI Realtime exceeded the safe lifetime limit of ${OPENAI_MAX_HANDLED_TOOL_CALLS} tool calls.`,
        });
      await expect(withTimeout(providerClosed.promise, 2_000, "Tool-call ledger overflow did not close OpenAI."))
        .resolves.toEqual({ code: 1011, reason: "OpenAI Realtime provider error" });
      expect(acceptedToolCalls).toBe(OPENAI_MAX_HANDLED_TOOL_CALLS);
    } finally {
      await harness.close();
    }
  }, 15_000);

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
        } else if (message.type === "response.create") {
          socket.send(JSON.stringify({
            type: "response.created",
            response: { id: "resp_multiple_tools", status: "in_progress" },
          }));
          socket.send(JSON.stringify({
            type: "response.done",
            response: {
              id: "resp_multiple_tools",
              status: "completed",
              output: [
                { type: "function_call", call_id: "call_1", name: "get_hermes_run_status", arguments: '{}' },
                { type: "function_call", call_id: "call_2", name: "stop_hermes_run", arguments: '{}' },
              ],
            },
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
        sessionId: "live_openai_multiple_tools",
        systemInstruction: "test",
        callbacks: { onEvent, onError: (error) => adapterError.resolve(error) },
      });
      await session.sendText("trigger multiple tool calls");
      await expect(withTimeout(adapterError.promise, 1_000, "Multiple tool calls were not rejected."))
        .resolves.toMatchObject({ message: expect.stringContaining("multiple tool calls") });
      await expect(withTimeout(providerClosed.promise, 1_000, "Multiple tool calls did not close the provider socket."))
        .resolves.toEqual({ code: 1011, reason: "OpenAI Realtime provider error" });
      expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "tool_call" }));
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

async function createOpenAITestHarness(
  callbacks: Parameters<OpenAIRealtimeAdapter["connect"]>[0]["callbacks"] = {
    onEvent: () => undefined,
  },
  configOverrides: Partial<Parameters<typeof buildOpenAISessionUpdate>[0]> = {},
): Promise<{
  server: WebSocketServer;
  upstream: import("ws").WebSocket;
  clientMessages: any[];
  session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>>;
  close(): Promise<void>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const clientMessages: any[] = [];
  const upstreamReady = deferred<import("ws").WebSocket>();
  server.once("connection", (socket) => {
    upstreamReady.resolve(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      clientMessages.push(message);
      if (message.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated" }));
      }
    });
  });
  const adapter = new OpenAIRealtimeAdapter(testOpenAIConfig({
    apiKey: "test-key",
    baseUrl: `ws://127.0.0.1:${portOf(server)}/v1/realtime`,
    ...configOverrides,
  }));
  const session = await adapter.connect({
    sessionId: "live_openai_notification_test",
    systemInstruction: "test",
    callbacks,
  });
  const upstream = await upstreamReady.promise;
  return {
    server,
    upstream,
    clientMessages,
    session,
    close: async () => {
      await session.close();
      await closeServer(server);
    },
  };
}

function openAIResponseCreates(clientMessages: any[]): any[] {
  return clientMessages.filter((message) => message.type === "response.create");
}

async function waitForResponseCreates(clientMessages: any[], count: number): Promise<any[]> {
  await vi.waitFor(() => expect(openAIResponseCreates(clientMessages)).toHaveLength(count));
  return openAIResponseCreates(clientMessages);
}

function taskNotification(label: string): { context: string; announcement: string } {
  return {
    context: `[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef] ${label} finished.`,
    announcement: `${label} finished.`,
  };
}

function portOf(server: WebSocketServer): number {
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("WebSocket server did not expose a TCP port.");
  }
  return address.port;
}

function portOfHttp(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("HTTP server did not expose a TCP port.");
  }
  return address.port;
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
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
