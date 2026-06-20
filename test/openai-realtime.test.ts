import { describe, expect, it } from "vitest";
import {
  buildOpenAIConversationItemTruncate,
  buildOpenAIRealtimeAudioAppend,
  buildOpenAIResponseCancel,
  buildOpenAISessionUpdate,
  normalizeOpenAIRealtimeEvent,
} from "../src/openai/realtime.js";

describe("OpenAI Realtime adapter helpers", () => {
  it("normalizes audio and transcript deltas", () => {
    expect(normalizeOpenAIRealtimeEvent({ type: "response.output_audio.delta", delta: "abc", item_id: "item_1", content_index: 0 })).toContainEqual({
      type: "audio",
      audio: { data: "abc", mimeType: "audio/pcm;rate=24000", itemId: "item_1", contentIndex: 0 },
    });
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
  });
});

function testOpenAIConfig(
  overrides: Partial<Parameters<typeof buildOpenAISessionUpdate>[0]> = {},
): Parameters<typeof buildOpenAISessionUpdate>[0] {
  return {
    baseUrl: "wss://api.openai.com/v1/realtime",
    model: "gpt-realtime-2",
    voice: "marin",
    reasoningEffort: "low",
    turnDetection: "disabled",
    inputAudioFormat: "pcm16",
    outputAudioFormat: "pcm16",
    ...overrides,
  };
}
