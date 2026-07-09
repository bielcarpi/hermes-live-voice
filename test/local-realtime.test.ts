import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import {
  buildLocalSessionUpdate,
  buildLocalRealtimeAudioAppend,
  normalizeLocalRealtimeEvent,
  LocalRealtimeAdapter,
  LOCAL_REALTIME_PCM_SAMPLE_RATE,
} from "../src/adapters/outbound/realtime/local-realtime.adapter.js";

describe("Local Realtime adapter helpers", () => {
  it("buildLocalSessionUpdate returns exactly the expected object with no extra keys", () => {
    const result = buildLocalSessionUpdate(testLocalConfig(), "be helpful");

    expect(result).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "be helpful",
        audio: { output: { voice: "alloy" } },
        tools: expect.any(Array),
        tool_choice: "auto",
      },
    });
    expect(Object.keys(result.session)).toEqual(["type", "instructions", "audio", "tools", "tool_choice"]);
  });

  it("normalizeLocalRealtimeEvent normalizes audio delta to mimeType audio/pcm;rate=16000 with itemId and contentIndex", () => {
    const events = normalizeLocalRealtimeEvent({
      type: "response.output_audio.delta",
      delta: "abc",
      item_id: "item_1",
      content_index: 0,
    });

    expect(events).toContainEqual({
      type: "audio",
      audio: { data: "abc", mimeType: "audio/pcm;rate=16000", itemId: "item_1", contentIndex: 0 },
    });
    expect(events.at(-1)).toMatchObject({ type: "raw" });

    const legacyEvents = normalizeLocalRealtimeEvent({ type: "response.audio.delta", delta: "legacy" });
    expect(legacyEvents).toContainEqual({
      type: "audio",
      audio: { data: "legacy", mimeType: "audio/pcm;rate=16000" },
    });
  });

  it("normalizeLocalRealtimeEvent normalizes text and transcript deltas", () => {
    expect(
      normalizeLocalRealtimeEvent({ type: "response.output_audio_transcript.delta", delta: "hello" }),
    ).toContainEqual({ type: "text", text: "hello" });

    expect(
      normalizeLocalRealtimeEvent({ type: "response.audio_transcript.delta", delta: "older hi" }),
    ).toContainEqual({ type: "text", text: "older hi" });

    expect(
      normalizeLocalRealtimeEvent({ type: "response.output_text.delta", delta: "text delta" }),
    ).toContainEqual({ type: "text", text: "text delta" });
  });

  it("normalizeLocalRealtimeEvent normalizes input_audio_buffer.speech_started to input_speech_started with provider local", () => {
    expect(
      normalizeLocalRealtimeEvent({
        type: "input_audio_buffer.speech_started",
        item_id: "item_2",
        audio_start_ms: 480,
      }),
    ).toContainEqual({
      type: "input_speech_started",
      provider: "local",
      itemId: "item_2",
      audioStartMs: 480,
    });

    const noExtras = normalizeLocalRealtimeEvent({ type: "input_audio_buffer.speech_started" });
    expect(noExtras).toContainEqual({ type: "input_speech_started", provider: "local" });
    const speechEvent = noExtras.find((e) => e.type === "input_speech_started");
    expect(speechEvent).not.toHaveProperty("itemId");
    expect(speechEvent).not.toHaveProperty("audioStartMs");
  });

  it("normalizeLocalRealtimeEvent normalizes response.function_call_arguments.done to a tool_call event", () => {
    expect(
      normalizeLocalRealtimeEvent({
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

  it("LOCAL_REALTIME_PCM_SAMPLE_RATE is 16000", () => {
    expect(LOCAL_REALTIME_PCM_SAMPLE_RATE).toBe(16_000);
  });

  it("buildLocalRealtimeAudioAppend returns input_audio_buffer.append at 16 kHz", () => {
    const input = Buffer.alloc(32).toString("base64");

    expect(buildLocalRealtimeAudioAppend({ data: input, mimeType: "audio/pcm;rate=16000" })).toEqual({
      type: "input_audio_buffer.append",
      audio: expect.any(String),
    });
  });

  it("integration: fake WS server sends session.created; first frame is session.update; connect() resolves", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);

    const firstFrame = new Promise<unknown>((resolve) => {
      server.once("connection", (socket) => {
        socket.once("message", (raw) => {
          resolve(JSON.parse(raw.toString("utf8")));
          socket.send(JSON.stringify({ type: "session.created" }));
        });
      });
    });

    const adapter = new LocalRealtimeAdapter(testLocalConfig({ baseUrl: `ws://127.0.0.1:${port}` }));

    try {
      const session = await withTimeout(
        adapter.connect({
          sessionId: "live_local_test",
          systemInstruction: "test instruction",
          callbacks: { onEvent: () => undefined },
        }),
        3_000,
        "connect() did not resolve in time",
      );

      const frame = await withTimeout(firstFrame, 1_000, "No frame received");
      expect(frame).toMatchObject({ type: "session.update", session: { type: "realtime" } });
      expect((frame as any).session).not.toHaveProperty("model");
      expect((frame as any).session).not.toHaveProperty("turn_detection");

      await session.close();
    } finally {
      await closeServer(server);
    }
  });

  it("integration: fake WS server closes with code 1008 concurrent session; connect() rejects with single-session limit", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);

    server.once("connection", (socket) => {
      socket.once("message", () => {
        socket.close(1008, "Only one concurrent session is supported");
      });
    });

    const adapter = new LocalRealtimeAdapter(testLocalConfig({ baseUrl: `ws://127.0.0.1:${port}` }));

    try {
      await expect(
        withTimeout(
          adapter.connect({
            sessionId: "live_local_test",
            systemInstruction: "test",
            callbacks: { onEvent: () => undefined },
          }),
          3_000,
          "connect() did not reject in time",
        ),
      ).rejects.toThrow(/single-session limit/);
    } finally {
      await closeServer(server);
    }
  });

  it("sendAudioStreamEnd sends NO frame to the server", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);

    const frames: unknown[] = [];
    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        frames.push(msg);
        if (msg.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.created" }));
        }
      });
    });

    const adapter = new LocalRealtimeAdapter(testLocalConfig({ baseUrl: `ws://127.0.0.1:${port}` }));

    try {
      const session = await withTimeout(
        adapter.connect({
          sessionId: "live_local_test",
          systemInstruction: "test",
          callbacks: { onEvent: () => undefined },
        }),
        3_000,
        "connect() did not resolve",
      );

      const framesBefore = frames.length;
      await session.sendAudioStreamEnd();
      await new Promise((r) => setTimeout(r, 50));

      expect(frames.length).toBe(framesBefore);

      await session.close();
    } finally {
      await closeServer(server);
    }
  });

  it("cancelResponse sends response.cancel only when busy; truncate arg produces no extra frame", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);

    const frames: unknown[] = [];
    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        frames.push(msg);
        if (msg.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.created" }));
        }
      });
    });

    const adapter = new LocalRealtimeAdapter(testLocalConfig({ baseUrl: `ws://127.0.0.1:${port}` }));

    try {
      const session = await withTimeout(
        adapter.connect({
          sessionId: "live_local_test",
          systemInstruction: "test",
          callbacks: { onEvent: () => undefined },
        }),
        3_000,
        "connect() did not resolve",
      );

      const notBusy = await session.cancelResponse("reason");
      expect(notBusy).toBe(false);
      const cancelFramesBefore = frames.length;

      await session.sendText("hello");
      await new Promise((r) => setTimeout(r, 20));

      const busyResult = await session.cancelResponse("interrupted", {
        itemId: "item_1",
        contentIndex: 0,
        audioEndMs: 500,
      });
      expect(busyResult).toBe(true);

      await new Promise((r) => setTimeout(r, 20));
      const cancelFrames = (frames as any[]).filter((f) => f.type === "response.cancel");
      expect(cancelFrames).toHaveLength(1);

      const truncateFrames = (frames as any[]).filter((f) => f.type === "conversation.item.truncate");
      expect(truncateFrames).toHaveLength(0);

      await session.close();
    } finally {
      await closeServer(server);
    }
  });

  it("sendNarration sends conversation.item.create + response.create when not busy; sends nothing when busy", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = portOf(server);

    const frames: unknown[] = [];
    server.once("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        frames.push(msg);
        if (msg.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.created" }));
        }
      });
    });

    const adapter = new LocalRealtimeAdapter(testLocalConfig({ baseUrl: `ws://127.0.0.1:${port}` }));

    try {
      const session = await withTimeout(
        adapter.connect({
          sessionId: "live_local_test",
          systemInstruction: "test",
          callbacks: { onEvent: () => undefined },
        }),
        3_000,
        "connect() did not resolve",
      );

      const framesBefore = frames.length;
      await session.sendNarration("hi");
      await new Promise((r) => setTimeout(r, 20));

      const narrationFrames = (frames as any[]).slice(framesBefore);
      expect(narrationFrames).toHaveLength(2);
      expect(narrationFrames[0]).toMatchObject({ type: "conversation.item.create" });
      expect(narrationFrames[1]).toMatchObject({ type: "response.create" });

      const busyFramesBefore = frames.length;
      await session.sendNarration("ignored because busy");
      await new Promise((r) => setTimeout(r, 20));
      expect(frames.length).toBe(busyFramesBefore);

      await session.close();
    } finally {
      await closeServer(server);
    }
  });
});

function testLocalConfig(overrides: Partial<{ baseUrl: string; voice: string }> = {}): { baseUrl: string; voice: string } {
  return {
    baseUrl: "ws://127.0.0.1:9999",
    voice: "alloy",
    ...overrides,
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
