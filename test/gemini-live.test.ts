import { describe, expect, it, vi } from "vitest";
import {
  buildGeminiRealtimeAudioInput,
  buildGeminiRealtimeTextInput,
  buildGeminiTextTurn,
  buildGeminiToolResponse,
  GeminiLiveAdapter,
  GeminiLiveSession,
  normalizeGeminiLiveMessage,
} from "../src/adapters/outbound/realtime/gemini-live.adapter.js";

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

  it("normalizes top-level Gemini audio data", () => {
    const events = normalizeGeminiLiveMessage({
      data: "base64-audio",
      serverContent: { turnComplete: true },
    });

    expect(events).toContainEqual({
      type: "audio",
      audio: { data: "base64-audio", mimeType: "audio/pcm;rate=24000" },
    });
    expect(events.at(-1)).toMatchObject({ type: "raw" });
  });

  it("still unwraps SDK or event wrappers whose data field contains a message object", () => {
    const events = normalizeGeminiLiveMessage({
      data: {
        serverContent: {
          modelTurn: {
            parts: [{ text: "wrapped hello" }],
          },
        },
      },
    });

    expect(events).toContainEqual({ type: "text", text: "wrapped hello" });
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

  it("sends live text through realtime input before client-content history", async () => {
    const sdkSession = {
      sendRealtimeInput: vi.fn(async () => undefined),
      sendClientContent: vi.fn(async () => undefined),
    };
    const session = new GeminiLiveSession(sdkSession);

    await session.sendText("hello");

    expect(buildGeminiRealtimeTextInput("hello")).toEqual({ text: "hello" });
    expect(sdkSession.sendRealtimeInput).toHaveBeenCalledWith({ text: "hello" });
    expect(sdkSession.sendClientContent).not.toHaveBeenCalled();
  });

  it("builds Gemini tool responses with the function call id", () => {
    expect(buildGeminiToolResponse({ id: "call_1", name: "start_hermes_run", args: {} }, { ok: true })).toEqual({
      functionResponses: [{ id: "call_1", name: "start_hermes_run", response: { ok: true } }],
    });
    expect(() => buildGeminiToolResponse({ name: "start_hermes_run", args: {} }, { ok: false })).toThrow(/did not include an id/);
  });

  it("fails direct adapter connects with clear credential errors", async () => {
    await expect(new GeminiLiveAdapter(testGeminiConfig({ apiKey: undefined })).connect(testConnectParams())).rejects.toThrow(
      /GEMINI_API_KEY/,
    );
    await expect(
      new GeminiLiveAdapter(testGeminiConfig({ enterprise: true, project: undefined })).connect(testConnectParams()),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
  });
});

function testGeminiConfig(overrides: Partial<ConstructorParameters<typeof GeminiLiveAdapter>[0]> = {}): ConstructorParameters<
  typeof GeminiLiveAdapter
>[0] {
  return {
    apiKey: "test-key",
    model: "gemini-3.1-flash-live-preview",
    enterprise: false,
    location: "us-central1",
    ...overrides,
  };
}

function testConnectParams(): Parameters<GeminiLiveAdapter["connect"]>[0] {
  return {
    sessionId: "live_gemini_test",
    systemInstruction: "test",
    callbacks: { onEvent: () => undefined },
  };
}
