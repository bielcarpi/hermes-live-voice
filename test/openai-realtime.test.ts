import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeAudioAppend, normalizeOpenAIRealtimeEvent } from "../src/openai/realtime.js";

describe("OpenAI Realtime adapter helpers", () => {
  it("normalizes audio and transcript deltas", () => {
    expect(normalizeOpenAIRealtimeEvent({ type: "response.output_audio.delta", delta: "abc" })).toContainEqual({
      type: "audio",
      audio: { data: "abc", mimeType: "audio/pcm;rate=24000" },
    });
    expect(normalizeOpenAIRealtimeEvent({ type: "response.output_audio_transcript.delta", delta: "hi" })).toContainEqual({
      type: "text",
      text: "hi",
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
});
