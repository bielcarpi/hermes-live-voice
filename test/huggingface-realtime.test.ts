import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveModelEvent } from "../src/application/live-gateway/ports/realtime-model.port.js";
import {
  buildHuggingFaceSessionUpdate,
  HuggingFaceRealtimeAdapter,
} from "../src/adapters/outbound/realtime/huggingface-realtime.adapter.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("Hugging Face speech-to-speech adapter", () => {
  it("builds the upstream OpenAI Realtime wire contract at 24 kHz", () => {
    const update = buildHuggingFaceSessionUpdate(localConfig(), "Keep talking while tasks run.");

    expect(update).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "Keep talking while tasks run.",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "Aiden" },
        },
        tool_choice: "auto",
      },
    });
    expect((update.session.tools as unknown[]).length).toBeGreaterThan(0);
    expect(update.session).not.toHaveProperty("model");
  });

  it("uses session.created readiness and preserves local audio, transcripts, and tools", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const onOpen = vi.fn();
    const adapter = new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    );
    const session = await adapter.connect({
      sessionId: "local_session",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event), onOpen },
    });

    await waitUntil(() => harness.messages.length === 1);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(harness.requestUrl).toBe("/v1/realtime");
    expect(harness.authorization).toBeUndefined();
    expect(harness.messages[0]).toMatchObject({ type: "session.update" });

    await session.sendRealtimeAudio({
      data: Buffer.alloc(1_600).toString("base64"),
      mimeType: "audio/pcm;rate=16000",
    });
    await session.sendAudioStreamEnd();
    await session.sendText("What is running?");
    await waitUntil(() => harness.messages.length >= 4);
    expect(harness.messages.slice(1, 4).map((message) => message.type)).toEqual([
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "conversation.item.create",
    ]);
    await waitUntil(() => harness.messages.length >= 5);
    expect(harness.messages[4]).toEqual({ type: "response.create" });

    harness.send({ type: "response.created", response: { id: "resp_local", status: "in_progress" } });
    harness.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input_1",
      transcript: "What is running?",
    });
    harness.send({
      type: "response.output_audio_transcript.done",
      response_id: "resp_local",
      transcript: "I am checking it.",
    });
    harness.send({
      type: "response.output_audio.delta",
      response_id: "resp_local",
      item_id: "item_1",
      content_index: 0,
      delta: "cGNt",
    });
    harness.send({
      type: "response.function_call_arguments.done",
      response_id: "resp_local",
      call_id: "call_1",
      name: "get_background_task",
      arguments: '{"task_id":"task_1"}',
    });
    harness.send({ type: "response.done", response: { id: "resp_local", status: "completed" } });
    await waitUntil(() => events.some((event) => event.type === "response" && event.status === "completed"));

    expect(events).toContainEqual({ type: "text", text: "What is running?", speaker: "user", final: true });
    expect(events).toContainEqual({ type: "text", text: "I am checking it.", speaker: "assistant", final: true });
    expect(events).toContainEqual({
      type: "audio",
      audio: { data: "cGNt", mimeType: "audio/pcm;rate=24000", itemId: "item_1", contentIndex: 0 },
    });
    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "get_background_task", args: { task_id: "task_1" } },
    });

    await session.close();
  });

  it("rejects a configuration error emitted after session.created", async () => {
    const harness = await createHarness();
    const pending = new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_bad_config",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined },
    });
    await waitUntil(() => harness.messages.length === 1);
    harness.send({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown or invalid event: session.update" },
    });

    await expect(pending).rejects.toThrow(/Unknown or invalid event: session\.update/u);
  });

  it("lets upstream VAD own voice responses and waits to speak task notifications", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_vad",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });
    await waitUntil(() => harness.messages.length === 1);

    harness.send({ type: "input_audio_buffer.speech_started", item_id: "input_2", audio_start_ms: 100 });
    harness.send({ type: "input_audio_buffer.speech_stopped", item_id: "input_2", audio_end_ms: 900 });
    await waitUntil(() => events.some((event) => event.type === "input_speech_stopped"));
    await session.sendTaskNotification?.({
      context: "[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef]",
      announcement: "The background task is ready.",
    });
    await delay(20);
    expect(harness.messages).toHaveLength(1);

    harness.send({ type: "response.created", response: { id: "resp_voice", status: "in_progress" } });
    harness.send({ type: "response.done", response: { id: "resp_voice", status: "completed" } });
    await waitUntil(() => harness.messages.length === 2);
    expect(harness.messages[1]).toMatchObject({
      type: "response.create",
      response: {
        conversation: "none",
        tools: [],
        tool_choice: "none",
        metadata: { hermes_live_purpose: "task_notification" },
      },
    });
    expect(JSON.stringify(harness.messages[1])).toContain("The background task is ready.");

    await session.close();
  });

  it("cancels active output without sending unsupported truncation events", async () => {
    const harness = await createHarness();
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_cancel",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined },
    });
    await session.sendText("Speak");
    await waitUntil(() => harness.messages.length === 3);
    harness.send({ type: "response.created", response: { id: "resp_cancel", status: "in_progress" } });
    await delay(10);

    await expect(session.cancelResponse("barge-in", {
      itemId: "item_1",
      contentIndex: 0,
      audioEndMs: 100,
    })).resolves.toBe(true);
    await waitUntil(() => harness.messages.length === 4);
    expect(harness.messages[3]).toEqual({ type: "response.cancel" });
    expect(harness.messages.some((message) => message.type === "conversation.item.truncate")).toBe(false);

    harness.send({ type: "response.done", response: { id: "resp_cancel", status: "cancelled" } });
    await session.close();
  });

  it("does not flush queued speech between an upstream barge-in cancellation and speech_started", async () => {
    const harness = await createHarness();
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_barge_in",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined },
    });
    await session.sendText("Tell me something long");
    await waitUntil(() => harness.messages.length === 3);
    harness.send({ type: "response.created", response: { id: "resp_talking", status: "in_progress" } });
    await session.sendTaskNotification?.({
      context: "[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef]",
      announcement: "The task finished.",
    });

    harness.send({
      type: "response.done",
      response: {
        id: "resp_talking",
        status: "cancelled",
        status_details: { type: "cancelled", reason: "turn_detected" },
      },
    });
    await delay(20);
    expect(harness.messages).toHaveLength(3);

    harness.send({ type: "input_audio_buffer.speech_started", item_id: "input_3", audio_start_ms: 100 });
    harness.send({ type: "input_audio_buffer.speech_stopped", item_id: "input_3", audio_end_ms: 900 });
    await delay(20);
    expect(harness.messages).toHaveLength(3);

    harness.send({ type: "response.created", response: { id: "resp_reply", status: "in_progress" } });
    harness.send({ type: "response.done", response: { id: "resp_reply", status: "completed" } });
    await waitUntil(() => harness.messages.length === 4);
    expect(harness.messages[3]).toMatchObject({
      type: "response.create",
      response: { metadata: { hermes_live_purpose: "task_notification" } },
    });

    await session.close();
  });
});

function localConfig() {
  return {
    url: "ws://127.0.0.1:8765/v1/realtime",
    voice: "Aiden",
    allowRemote: false,
  };
}

async function createHarness(): Promise<{
  url: string;
  messages: any[];
  requestUrl?: string;
  authorization?: string;
  send(value: unknown): void;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  let socket: WebSocket | undefined;
  const state: {
    url: string;
    messages: any[];
    requestUrl?: string;
    authorization?: string;
    send(value: unknown): void;
  } = {
    url: `ws://127.0.0.1:${address.port}/v1/realtime`,
    messages: [],
    send(value) {
      if (!socket) throw new Error("Test client is not connected.");
      socket.send(JSON.stringify(value));
    },
  };
  server.on("connection", (client, request) => {
    socket = client;
    state.requestUrl = request.url;
    state.authorization = request.headers.authorization;
    client.on("message", (raw) => state.messages.push(JSON.parse(raw.toString("utf8"))));
    client.send(JSON.stringify({ type: "session.created", session: { id: "local_test", type: "realtime" } }));
  });
  return state;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for local realtime test condition.");
    await delay(5);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
