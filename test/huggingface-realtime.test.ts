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

  it("lets the managed compatibility runtime defer voice-turn routing to Hermes Live", () => {
    const update = buildHuggingFaceSessionUpdate(
      { ...localConfig(), ownsTurnRouting: true },
      "Keep talking while tasks run.",
    );

    expect(update.session).toMatchObject({
      audio: { input: { turn_detection: { create_response: false } } },
    });
  });

  it("only advertises actions available to the negotiated voice session", () => {
    const update = buildHuggingFaceSessionUpdate(
      localConfig(),
      "Keep talking while tasks run.",
      ["start_background_task", "pause_voice_input"],
    );

    expect((update.session.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      "start_background_task",
      "pause_voice_input",
    ]);
    expect(JSON.stringify(update.session.tools)).not.toContain("description\":\"The complete");
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
      "input_audio_buffer.append",
      "conversation.item.create",
    ]);
    expect(Buffer.from(harness.messages[2].audio, "base64")).toEqual(Buffer.alloc(48_000));
    expect(harness.messages.some((message) => message.type === "input_audio_buffer.commit")).toBe(false);
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
    expect(events).not.toContainEqual({ type: "text", text: "I am checking it.", speaker: "assistant", final: true });
    expect(events).toContainEqual({
      type: "audio",
      audio: { data: "cGNt", mimeType: "audio/pcm;rate=24000", itemId: "item_1", contentIndex: 0 },
    });
    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "get_background_task", args: { task_id: "task_1" } },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "response", status: "failed" }));

    await session.close();
  });

  it("releases buffered assistant text when a local response completes without a tool call", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_direct_text",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Say hello");
    await waitUntil(() => harness.messages.some((message) => message.type === "response.create"));
    harness.send({ type: "response.created", response: { id: "resp_text", status: "in_progress" } });
    harness.send({
      type: "response.output_audio_transcript.done",
      response_id: "resp_text",
      transcript: "Hello there.",
    });
    await delay(10);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "text", speaker: "assistant" }));

    harness.send({ type: "response.done", response: { id: "resp_text", status: "completed" } });
    await waitUntil(() => events.some((event) => event.type === "response" && event.status === "completed"));
    expect(events).toContainEqual({ type: "text", text: "Hello there.", speaker: "assistant", final: true });
    expect(events.findIndex((event) => event.type === "text" && event.speaker === "assistant"))
      .toBeLessThan(events.findIndex((event) => event.type === "response" && event.status === "completed"));

    await session.close();
  });

  it("coalesces completed transcript chunks from speech-to-speech 0.2.12 into one turn", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_chunked_completed_transcript",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Say hello");
    await waitUntil(() => harness.messages.some((message) => message.type === "response.create"));
    harness.send({ type: "response.created", response: { id: "resp_chunked", status: "in_progress" } });
    harness.send({
      type: "response.output_audio_transcript.done",
      response_id: "resp_chunked",
      transcript: "Hello",
    });
    harness.send({
      type: "response.output_audio_transcript.done",
      response_id: "resp_chunked",
      transcript: " world.",
    });
    harness.send({ type: "response.done", response: { id: "resp_chunked", status: "completed" } });

    await waitUntil(() => events.some((event) => event.type === "response" && event.status === "completed"));
    expect(events.filter((event) => event.type === "text" && event.speaker === "assistant")).toEqual([
      { type: "text", text: "Hello world.", speaker: "assistant", final: true },
    ]);

    await session.close();
  });

  it("prefers one authoritative completed transcript over its preceding deltas", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_delta_and_completed_transcript",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Say hello");
    await waitUntil(() => harness.messages.some((message) => message.type === "response.create"));
    harness.send({ type: "response.created", response: { id: "resp_delta", status: "in_progress" } });
    harness.send({
      type: "response.output_audio_transcript.delta",
      response_id: "resp_delta",
      delta: "Hel",
    });
    harness.send({
      type: "response.output_audio_transcript.delta",
      response_id: "resp_delta",
      delta: "lo",
    });
    harness.send({
      type: "response.output_audio_transcript.done",
      response_id: "resp_delta",
      transcript: "Hello",
    });
    harness.send({ type: "response.done", response: { id: "resp_delta", status: "completed" } });

    await waitUntil(() => events.some((event) => event.type === "response" && event.status === "completed"));
    expect(events.filter((event) => event.type === "text" && event.speaker === "assistant")).toEqual([
      { type: "text", text: "Hello", speaker: "assistant", final: true },
    ]);

    await session.close();
  });

  it("suppresses local assistant text and audio emitted after a tool call", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_tool_output_suppression",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Delegate this task");
    await waitUntil(() => harness.messages.some((message) => message.type === "response.create"));
    harness.send({ type: "response.created", response: { id: "resp_tool", status: "in_progress" } });
    harness.send({
      type: "response.output_audio_transcript.done",
      response_id: "resp_tool",
      transcript: "I already did it.",
    });
    harness.send({
      type: "response.function_call_arguments.done",
      response_id: "resp_tool",
      call_id: "call_tool",
      name: "start_background_task",
      arguments: '{"message":"Do the complete requested work"}',
    });
    harness.send({
      type: "response.output_audio.delta",
      response_id: "resp_tool",
      item_id: "item_tool",
      content_index: 0,
      delta: "c3VwcHJlc3M=",
    });
    harness.send({ type: "response.done", response: { id: "resp_tool", status: "completed" } });
    await waitUntil(() => events.some((event) => event.type === "response" && event.status === "completed"));

    expect(events).toContainEqual({
      type: "tool_call",
      call: {
        id: "call_tool",
        name: "start_background_task",
        args: { message: "Do the complete requested work" },
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "text", speaker: "assistant" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "audio" }));

    await session.close();
  });

  it("reports a completed local turn with no speech, text, or tool call as failed", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_empty_response",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Delegate this task");
    await waitUntil(() => harness.messages.some((message) => message.type === "response.create"));
    harness.send({ type: "response.created", response: { id: "resp_empty", status: "in_progress" } });
    harness.send({ type: "response.done", response: { id: "resp_empty", status: "completed" } });
    await waitUntil(() => events.some((event) => event.type === "response" && event.status === "failed"));

    expect(events).toContainEqual({
      type: "response",
      status: "failed",
      responseId: "resp_empty",
      scope: "conversation",
      error: "The local voice model returned no usable reply. Try again or switch voice provider.",
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "response", status: "completed" }));

    await session.close();
  });

  it("closes a local session whose provider never settles a response", async () => {
    const harness = await createHarness();
    const onError = vi.fn();
    const onClose = vi.fn();
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
      30,
    ).connect({
      sessionId: "local_stalled_response",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined, onError, onClose },
    });

    await session.sendText("Never answer this turn");
    await waitUntil(() => harness.messages.some((message) => message.type === "response.create"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(String(onError.mock.calls[0]?.[0])).toContain("exceeded 30ms");
  });

  it("closes local sessions idempotently and waits for pipeline reuse", async () => {
    const harness = await createHarness();
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
      1_000,
      40,
    ).connect({
      sessionId: "local_pipeline_release",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined },
    });

    const startedAt = Date.now();
    const firstClose = session.close();
    expect(session.close()).toBe(firstClose);
    const [providerClose] = await Promise.all([harness.waitForClose(), firstClose]);

    expect(providerClose).toEqual({ code: 1000, reason: "session closed" });
    expect(harness.closeEvents).toHaveLength(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
  });

  it("turns successful task receipts into deterministic local speech", async () => {
    const harness = await createHarness();
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_tool_receipt",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined },
    });

    await session.sendToolResponse(
      { id: "call_receipt", name: "start_background_task", args: { message: "untrusted delegated task" } },
      {
        spoken_response: "I've started that in the background. You can keep talking.",
        ok: true,
        task_id: "task_0123456789abcdef0123456789abcdef",
      },
    );
    await waitUntil(() => harness.messages.length === 3);

    expect(harness.messages[1]).toMatchObject({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call_receipt" },
    });
    expect(harness.messages[2]).toMatchObject({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        tools: [],
        tool_choice: "none",
        metadata: { hermes_live_purpose: "tool_receipt" },
      },
    });
    expect(harness.messages[2].response.instructions).toContain(JSON.stringify(
      "I've started that in the background. You can keep talking.",
    ));
    expect(harness.messages[2].response).not.toHaveProperty("conversation", "none");

    await session.close();
  });

  it("routes an explicit managed voice delegation with the exact final transcript", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_delegation",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });
    await waitUntil(() => harness.messages.length === 1);

    harness.send({ type: "input_audio_buffer.speech_started", item_id: "input_route", audio_start_ms: 100 });
    harness.send({ type: "input_audio_buffer.speech_stopped", item_id: "input_route", audio_end_ms: 900 });
    harness.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input_route",
      transcript: "Please delegate this task in the background: reply with exactly ROUTED OK.",
    });
    await waitUntil(() => events.some((event) => event.type === "tool_call"));

    const tool = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    expect(tool?.call).toMatchObject({
      name: "start_background_task",
      args: { message: "Please delegate this task in the background: reply with exactly ROUTED OK." },
    });
    expect(tool?.call.id).toMatch(/^call_local_[a-f0-9]{32}$/u);
    expect(harness.messages).toHaveLength(1);

    await session.sendToolResponse(tool!.call, {
      spoken_response: "I've started that in the background. You can keep talking.",
      ok: true,
      task_id: "task_0123456789abcdef0123456789abcdef",
    });
    await waitUntil(() => harness.messages.length === 2);
    expect(harness.messages[1]).toMatchObject({
      type: "response.create",
      response: {
        conversation: "none",
        tools: [],
        tool_choice: "none",
        metadata: { hermes_live_purpose: "tool_receipt" },
      },
    });
    expect(harness.messages.some((message) => message.type === "conversation.item.create")).toBe(false);

    harness.send({ type: "response.created", response: { id: "resp_routed_receipt", status: "in_progress" } });
    harness.send({
      type: "response.output_audio.delta",
      response_id: "resp_routed_receipt",
      item_id: "item_routed_receipt",
      content_index: 0,
      delta: "cGNt",
    });
    harness.send({ type: "response.done", response: { id: "resp_routed_receipt", status: "completed" } });
    await waitUntil(() => events.some((event) => event.type === "response" && event.status === "completed"));
    expect(events).toContainEqual({
      type: "response",
      status: "started",
      responseId: "resp_routed_receipt",
      scope: "conversation",
    });

    await session.sendText("Stop it.");
    await waitUntil(() => events.filter((event) => event.type === "tool_call").length === 2);
    expect(events.filter((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call")[1]?.call).toMatchObject({
      name: "stop_background_task",
      args: { task_id: "task_0123456789abcdef0123456789abcdef" },
    });
    await session.close();
  });

  it("retains a final transcript that arrives before speech_stopped", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_reordered_transcript",
      systemInstruction: "You are Hermes.",
      availableTools: ["start_background_task"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    harness.send({ type: "input_audio_buffer.speech_started", item_id: "input_reordered", audio_start_ms: 10 });
    harness.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input_reordered",
      transcript: "Inspect the repository and run the tests.",
    });
    await delay(10);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));

    harness.send({ type: "input_audio_buffer.speech_stopped", item_id: "input_reordered", audio_end_ms: 500 });
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      call: {
        name: "start_background_task",
        args: { message: "Inspect the repository and run the tests." },
      },
    });
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(harness.messages).toHaveLength(1);

    await session.close();
  });

  it("starts a normal managed voice response only after the final transcript", async () => {
    const harness = await createHarness();
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_conversation",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined },
    });
    await waitUntil(() => harness.messages.length === 1);

    harness.send({ type: "input_audio_buffer.speech_started", item_id: "input_chat", audio_start_ms: 100 });
    harness.send({ type: "input_audio_buffer.speech_stopped", item_id: "input_chat", audio_end_ms: 900 });
    await delay(10);
    expect(harness.messages).toHaveLength(1);
    harness.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input_chat",
      transcript: "How are you today?",
    });
    await waitUntil(() => harness.messages.length === 2);
    expect(harness.messages[1]).toEqual({ type: "response.create" });

    harness.send({ type: "response.created", response: { id: "resp_chat", status: "in_progress" } });
    harness.send({ type: "response.done", response: { id: "resp_chat", status: "completed" } });
    await session.close();
  });

  it("routes every ordinary turn in a selected Hermes chat without a local tool decision", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_saved_chat",
      systemInstruction: "You are Hermes.",
      availableTools: ["continue_hermes_conversation", "start_background_task"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("What did we decide yesterday?");
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const tool = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    expect(tool?.call).toMatchObject({
      name: "continue_hermes_conversation",
      args: { message: "What did we decide yesterday?" },
    });
    expect(harness.messages.some((message) => message.type === "response.create")).toBe(false);

    await session.sendToolResponse(tool!.call, {
      ok: true,
      message: "We decided to ship the smaller release first.",
    });
    await waitUntil(() => harness.messages.some((message) =>
      message.response?.metadata?.hermes_live_purpose === "conversation_answer"));
    const answer = harness.messages.find((message) =>
      message.response?.metadata?.hermes_live_purpose === "conversation_answer");
    expect(answer.response).toMatchObject({
      conversation: "none",
      tools: [],
      tool_choice: "none",
      metadata: {
        hermes_live_purpose: "conversation_answer",
        hermes_live_exact_speech: "We decided to ship the smaller release first.",
      },
    });

    await session.close();
  });

  it("keeps clear saved-chat work off the live conversation path", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_saved_chat_work",
      systemInstruction: "You are Hermes.",
      availableTools: ["continue_hermes_conversation", "start_background_task"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Inspect the repository and run the tests.");
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const tool = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    expect(tool?.call).toMatchObject({
      name: "start_background_task",
      args: { message: "Inspect the repository and run the tests." },
    });
    expect(harness.messages.some((message) => message.type === "response.create")).toBe(false);

    await session.close();
  });

  it("routes a clear unbound work request directly to durable Hermes execution", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_unbound_work",
      systemInstruction: "You are Hermes.",
      availableTools: ["start_background_task", "list_background_tasks"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Inspect the repository and run the tests.");
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const tool = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    expect(tool?.call).toMatchObject({
      name: "start_background_task",
      args: { message: "Inspect the repository and run the tests." },
    });
    expect(harness.messages.some((message) => message.type === "response.create")).toBe(false);

    await session.close();
  });

  it("answers a managed latest-task question from one bounded tool snapshot with tools disabled", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_task_question",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Tell me the exact result of my latest background task.");
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const tool = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    expect(tool?.call).toMatchObject({
      name: "list_background_tasks",
      args: { include_completed: true },
    });
    await session.sendToolResponse(tool!.call, {
      ok: true,
      tasks: [{
        taskId: "task_0123456789abcdef0123456789abcdef",
        state: "completed",
        result: { summary: "VOICE PIPELINE OK", truncated: false },
      }],
    });
    await waitUntil(() => harness.messages.some((message) =>
      message.type === "response.create" && message.response?.metadata?.hermes_live_purpose === "task_query"));
    const query = harness.messages.find((message) => message.response?.metadata?.hermes_live_purpose === "task_query");
    expect(query.response).toMatchObject({
      conversation: "none",
      tools: [],
      tool_choice: "none",
      metadata: { hermes_live_purpose: "task_query" },
    });
    expect(JSON.stringify(query.response.input)).toContain("VOICE PIPELINE OK");
    expect(query.response.instructions).toContain("untrusted data");
    expect(query.response.instructions).toContain("Never invent");

    harness.send({ type: "response.created", response: { id: "resp_task_query", status: "in_progress" } });
    harness.send({
      type: "response.output_audio.delta",
      response_id: "resp_task_query",
      item_id: "item_task_query",
      content_index: 0,
      delta: "cGNt",
    });
    harness.send({ type: "response.done", response: { id: "resp_task_query", status: "completed" } });
    await session.close();
  });

  it("resolves a spoken latest-task stop to one validated exact task id", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_stop_latest",
      systemInstruction: "You are Hermes.",
      availableTools: ["list_background_tasks", "stop_background_task"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Stop the latest background task.");
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const list = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    expect(list?.call).toMatchObject({
      name: "list_background_tasks",
      args: { include_completed: false },
    });
    await session.sendToolResponse(list!.call, {
      ok: true,
      tasks: [
        { taskId: "invalid_task", state: "running" },
        { taskId: "task_0123456789abcdef0123456789abcdef", state: "running" },
        { taskId: "task_abcdef0123456789abcdef0123456789", state: "completed" },
      ],
    });
    await waitUntil(() => events.filter((event) => event.type === "tool_call").length === 2);
    const stop = events.filter((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call")[1];
    expect(stop?.call).toMatchObject({
      name: "stop_background_task",
      args: { task_id: "task_0123456789abcdef0123456789abcdef" },
    });
    expect(harness.messages.some((message) => message.type === "response.create")).toBe(false);

    await session.close();
  });

  it("asks which task to stop when an unqualified voice command matches multiple active tasks", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_stop_ambiguous",
      systemInstruction: "You are Hermes.",
      availableTools: ["list_background_tasks", "stop_background_task"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Stop the background task.");
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const list = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    await session.sendToolResponse(list!.call, {
      ok: true,
      tasks: [
        { taskId: "task_0123456789abcdef0123456789abcdef", state: "running" },
        { taskId: "task_abcdef0123456789abcdef0123456789", state: "accepted" },
      ],
    });

    await waitUntil(() => harness.messages.some((message) =>
      message.type === "response.create"
      && message.response?.metadata?.hermes_live_exact_speech
        === "You have 2 active tasks. Say which one you want me to stop."));
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(harness.messages.at(-1)).toMatchObject({
      type: "response.create",
      response: {
        conversation: "none",
        tools: [],
        tool_choice: "none",
        metadata: {
          hermes_live_purpose: "tool_receipt",
          hermes_live_exact_speech: "You have 2 active tasks. Say which one you want me to stop.",
        },
      },
    });

    await session.close();
  });

  it("resolves a spoken task title to one validated active task", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_stop_named",
      systemInstruction: "You are Hermes.",
      availableTools: ["list_background_tasks", "stop_background_task"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await session.sendText("Stop the repository audit task.");
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const list = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    await session.sendToolResponse(list!.call, {
      ok: true,
      tasks: [
        {
          taskId: "task_0123456789abcdef0123456789abcdef",
          state: "running",
          title: "Research the latest Hermes release notes",
        },
        {
          taskId: "task_abcdef0123456789abcdef0123456789",
          state: "running",
          title: "Audit the repository security boundaries",
        },
      ],
    });
    await waitUntil(() => events.filter((event) => event.type === "tool_call").length === 2);
    expect(events.filter((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call")[1]?.call).toMatchObject({
      name: "stop_background_task",
      args: { task_id: "task_abcdef0123456789abcdef0123456789" },
    });
    expect(harness.messages.some((message) => message.type === "response.create")).toBe(false);

    await session.close();
  });

  it("starts a spoken follow-up from the newest validated finished task", async () => {
    const harness = await createHarness();
    const events: LiveModelEvent[] = [];
    const session = await new HuggingFaceRealtimeAdapter(
      { ...localConfig(), url: harness.url, ownsTurnRouting: true },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_managed_follow_up",
      systemInstruction: "You are Hermes.",
      availableTools: ["list_background_tasks", "follow_up_background_task"],
      callbacks: { onEvent: (event) => events.push(event) },
    });

    const message = "Use the result of the latest task to write the summary.";
    await session.sendText(message);
    await waitUntil(() => events.some((event) => event.type === "tool_call"));
    const list = events.find((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call");
    await session.sendToolResponse(list!.call, {
      ok: true,
      tasks: [
        { taskId: "task_0123456789abcdef0123456789abcdef", state: "running" },
        { taskId: "task_abcdef0123456789abcdef0123456789", state: "completed" },
      ],
    });
    await waitUntil(() => events.filter((event) => event.type === "tool_call").length === 2);
    const followUp = events.filter((event): event is Extract<LiveModelEvent, { type: "tool_call" }> =>
      event.type === "tool_call")[1];
    expect(followUp?.call).toMatchObject({
      name: "follow_up_background_task",
      args: { task_id: "task_abcdef0123456789abcdef0123456789", message },
    });
    expect(harness.messages.some((entry) => entry.type === "response.create")).toBe(false);

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

  it("retries a transient busy managed pipeline without leaking pre-ready callbacks", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      if (connections === 1) {
        socket.send(JSON.stringify({
          type: "error",
          error: { message: "All 1 session slots are in use. Disconnect an existing client first." },
        }));
        return;
      }
      socket.send(JSON.stringify({
        type: "session.created",
        session: { id: "local_retried", type: "realtime" },
      }));
    });
    const onError = vi.fn();
    const onClose = vi.fn();
    const onOpen = vi.fn();
    const session = await new HuggingFaceRealtimeAdapter(
      {
        ...localConfig(),
        url: `ws://127.0.0.1:${address.port}/v1/realtime`,
        ownsTurnRouting: true,
      },
      1_000,
      1_000,
    ).connect({
      sessionId: "local_busy_retry",
      systemInstruction: "You are Hermes.",
      callbacks: { onEvent: () => undefined, onError, onClose, onOpen },
    });

    expect(connections).toBe(2);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await session.close();
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
    expect(events).toContainEqual({
      type: "response",
      status: "started",
      responseId: "resp_voice",
      scope: "conversation",
    });
    harness.send({ type: "response.created", response: { id: "resp_notification", status: "in_progress" } });
    await waitUntil(() => events.some((event) =>
      event.type === "response" && event.responseId === "resp_notification"));
    expect(events).toContainEqual({
      type: "response",
      status: "started",
      responseId: "resp_notification",
      scope: "task_notification",
    });

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
  closeEvents: Array<{ code: number; reason: string }>;
  waitForClose(): Promise<{ code: number; reason: string }>;
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
    closeEvents: Array<{ code: number; reason: string }>;
    waitForClose(): Promise<{ code: number; reason: string }>;
    send(value: unknown): void;
  } = {
    url: `ws://127.0.0.1:${address.port}/v1/realtime`,
    messages: [],
    closeEvents: [],
    waitForClose: () => closed,
    send(value) {
      if (!socket) throw new Error("Test client is not connected.");
      socket.send(JSON.stringify(value));
    },
  };
  let resolveClosed!: (event: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });
  server.on("connection", (client, request) => {
    socket = client;
    state.requestUrl = request.url;
    state.authorization = request.headers.authorization;
    client.on("message", (raw) => state.messages.push(JSON.parse(raw.toString("utf8"))));
    client.on("close", (code, reason) => {
      const event = { code, reason: reason.toString("utf8") };
      state.closeEvents.push(event);
      resolveClosed(event);
    });
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
