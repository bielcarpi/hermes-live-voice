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
    expect(audioEvents.at(-1)).toMatchObject({ type: "raw" });
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
        name: "start_agent_run",
        arguments: '{"message":"hello"}',
      }),
    ).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "start_agent_run", args: { message: "hello" } },
    });
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

  it("normalizes speech-stop events for VAD interruption handling", () => {
    expect(
      normalizeOpenAIRealtimeEvent({
        type: "input_audio_buffer.speech_stopped",
        duration_s: 1.5,
        audio_end_ms: 1500,
      }),
    ).toContainEqual({
      type: "input_speech_stopped",
      provider: "openai",
      durationS: 1.5,
      audioEndMs: 1500,
    });
    expect(
      normalizeOpenAIRealtimeEvent({
        type: "input_audio_buffer.speech_stopped",
      }),
    ).toContainEqual({
      type: "input_speech_stopped",
      provider: "openai",
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
      model: "gpt-realtime-2",
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
      ).rejects.toEqual({ message: "invalid session" });
      await expect(withTimeout(closed, 2_000, "Timed out waiting for failed OpenAI socket to close.")).resolves.toEqual({
        code: 1011,
        reason: "OpenAI Realtime session start failed",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("defers a tool follow-up during cancel-in-flight until the server confirms response.cancelled", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const clientMessages: any[] = [];
    let socketRef: import("ws").WebSocket | undefined;

    server.once("connection", (socket) => {
      socketRef = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        clientMessages.push(message);
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (message.type === "response.create") {
          const created = clientMessages.filter((m) => m.type === "response.create").length;
          if (created === 1) {
            // First response.create -> mark as in-flight so cancelResponse has something to cancel.
            socket.send(JSON.stringify({ type: "response.created", response: { status: "in_progress" } }));
          }
        }
      });
    });

    const adapter = new OpenAIRealtimeAdapter(
      testOpenAIConfig({ apiKey: "test-key", baseUrl: `ws://127.0.0.1:${port}/v1/realtime` }),
    );
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_test",
        systemInstruction: "test",
        callbacks: { onEvent: () => undefined },
      });

      // Kick off a response and wait for the server to acknowledge response.created.
      await session.sendText("hello");
      await waitFor(() => clientMessages.some((m) => m.type === "response.create"), 500);
      await new Promise((r) => setTimeout(r, 20));

      // Cancel while the response is active.
      const cancelled = await session.cancelResponse("interrupted");
      expect(cancelled).toBe(true);
      await waitFor(() => clientMessages.some((m) => m.type === "response.cancel"), 500);

      const framesBeforeTool = clientMessages.length;
      // Immediately issue a tool response -> must defer because cancel-in-flight keeps busy=true.
      await session.sendToolResponse({ id: "call_1", name: "generate_agent_random_number", args: {} }, { ok: true });
      await new Promise((r) => setTimeout(r, 50));

      const framesAfterTool = clientMessages.slice(framesBeforeTool);
      expect(framesAfterTool.some((m) => m.type === "conversation.item.create")).toBe(true);
      // No new response.create should have appeared yet.
      expect(framesAfterTool.filter((m) => m.type === "response.create")).toHaveLength(0);

      // Now simulate the server confirming the cancel.
      socketRef?.send(JSON.stringify({ type: "response.cancelled" }));
      await waitFor(
        () => clientMessages.filter((m) => m.type === "response.create").length === 2,
        1_000,
        "deferred response.create never fired",
      );

      // Verify ordering: response.cancel comes before the second response.create.
      const cancelIdx = clientMessages.findIndex((m) => m.type === "response.cancel");
      const secondCreateIdx = clientMessages.map((m) => m.type).lastIndexOf("response.create");
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      expect(secondCreateIdx).toBeGreaterThan(cancelIdx);
      expect(clientMessages.filter((m) => m.type === "response.create")).toHaveLength(2);
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });

  it("fires the deferred follow-up via the 2s fallback timer when cancel confirmation never arrives", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const clientMessages: any[] = [];

    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        clientMessages.push(message);
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (message.type === "response.create") {
          const created = clientMessages.filter((m) => m.type === "response.create").length;
          if (created === 1) {
            socket.send(JSON.stringify({ type: "response.created", response: { status: "in_progress" } }));
          }
        }
        // Deliberately never send response.cancelled — the fallback timer must recover.
      });
    });

    const adapter = new OpenAIRealtimeAdapter(
      testOpenAIConfig({ apiKey: "test-key", baseUrl: `ws://127.0.0.1:${port}/v1/realtime` }),
    );
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_test",
        systemInstruction: "test",
        callbacks: { onEvent: () => undefined },
      });

      await session.sendText("hello");
      await waitFor(() => clientMessages.some((m) => m.type === "response.create"), 500);
      await new Promise((r) => setTimeout(r, 20));

      // Switch to fake timers BEFORE cancelResponse so its setTimeout is a fake timer we can advance.
      vi.useFakeTimers();
      try {
        await session.cancelResponse("interrupted");
        await session.sendToolResponse({ id: "call_1", name: "generate_agent_random_number", args: {} }, { ok: true });
        // Advance past the 2s fallback.
        await vi.advanceTimersByTimeAsync(2000);
      } finally {
        vi.useRealTimers();
      }

      await waitFor(
        () => clientMessages.filter((m) => m.type === "response.create").length === 2,
        1_000,
        "fallback timer never fired the deferred response.create",
      );
      expect(clientMessages.filter((m) => m.type === "response.create")).toHaveLength(2);
    } finally {
      await session?.close();
      await closeServer(server);
    }
  });

  it("defers the follow-up response.create when a tool resolves while the announcing response is still active", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);
    const clientMessages: any[] = [];
    const secondResponseCreate = deferred<void>();

    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        clientMessages.push(message);
        const responseCreateCount = clientMessages.filter((m) => m.type === "response.create").length;
        if (message.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (message.type === "response.create" && responseCreateCount === 1) {
          socket.send(JSON.stringify({ type: "response.created", response: { status: "in_progress" } }));
          socket.send(
            JSON.stringify({
              type: "response.function_call_arguments.done",
              call_id: "call_1",
              name: "generate_agent_random_number",
              arguments: "{}",
            }),
          );
        } else if (message.type === "response.create" && responseCreateCount === 2) {
          secondResponseCreate.resolve();
        } else if (message.type === "conversation.item.create" && message.item?.type === "function_call_output") {
          socket.send(JSON.stringify({ type: "response.done", response: { status: "completed" } }));
        }
      });
    });

    const adapter = new OpenAIRealtimeAdapter(
      testOpenAIConfig({ apiKey: "test-key", baseUrl: `ws://127.0.0.1:${port}/v1/realtime` }),
    );
    let session: Awaited<ReturnType<OpenAIRealtimeAdapter["connect"]>> | undefined;

    try {
      session = await adapter.connect({
        sessionId: "live_openai_test",
        systemInstruction: "test",
        callbacks: {
          onEvent: (event) => {
            if (event.type === "tool_call") {
              void session?.sendToolResponse(event.call, { ok: true, value: 42 });
            }
          },
        },
      });
      await session.sendText("get me a random number");
      await withTimeout(secondResponseCreate.promise, 2_000, "Tool response never triggered a follow-up response.create.");
      expect(clientMessages.filter((m) => m.type === "response.create")).toHaveLength(2);
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
    model: "gpt-realtime-2",
    voice: "echo",
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
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message = "waitFor predicate never became true",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
