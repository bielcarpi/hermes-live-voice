import { describe, expect, it } from "vitest";
import { buildGeminiRealtimeAudioInput, buildGeminiTextTurn, normalizeGeminiLiveMessage } from "../src/gemini/live.js";

describe("Gemini Live adapter helpers", () => {
  it("normalizes function calls from Gemini toolCall messages", () => {
    const events = normalizeGeminiLiveMessage({
      toolCall: {
        functionCalls: [{ id: "call_1", name: "start_hermes_run", args: { message: "hello" } }],
      },
    });

    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "start_hermes_run", args: { message: "hello" } },
    });
  });

  it("normalizes text and audio parts", () => {
    const events = normalizeGeminiLiveMessage({
      serverContent: {
        modelTurn: {
          parts: [{ text: "hello" }, { inlineData: { data: "abc", mimeType: "audio/pcm;rate=24000" } }],
        },
      },
    });

    expect(events).toContainEqual({ type: "text", text: "hello" });
    expect(events).toContainEqual({ type: "audio", audio: { data: "abc", mimeType: "audio/pcm;rate=24000" } });
    expect(events.at(-1)).toMatchObject({ type: "raw" });
  });

  it("builds Gemini audio input at the Gemini sample rate", () => {
    const input = Buffer.alloc(48).toString("base64");

    expect(buildGeminiRealtimeAudioInput({ data: input, mimeType: "audio/pcm;rate=24000" }).audio.mimeType).toBe(
      "audio/pcm;rate=16000",
    );
  });

  it("builds Gemini text turns for sendClientContent", () => {
    expect(buildGeminiTextTurn("hello")).toEqual({
      turns: [{ role: "user", parts: [{ text: "hello" }] }],
      turnComplete: true,
    });
  });
});
