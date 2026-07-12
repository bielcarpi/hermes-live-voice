import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
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
        name: "start_hermes_run",
        arguments: '{"message":"hello"}',
      }),
    ).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "start_hermes_run", args: { message: "hello" } },
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
