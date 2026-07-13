import { describe, expect, it, vi } from "vitest";
import {
  buildGeminiLiveConnectConfig,
  createGeminiLiveEventForwarder,
  buildGeminiRealtimeAudioInput,
  buildGeminiRealtimeTextInput,
  buildGeminiTextTurn,
  buildGeminiToolResponse,
  GeminiLiveAdapter,
  GeminiLiveSession,
  normalizeGeminiLiveMessage,
} from "../src/adapters/outbound/realtime/gemini-live.adapter.js";

describe("Gemini Live adapter helpers", () => {
  it("enables input and output audio transcription for live sessions", () => {
    expect(buildGeminiLiveConnectConfig("test instruction")).toMatchObject({
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: "test instruction",
    });
  });

  it("emits one response start per Gemini turn before assistant output", () => {
    const events: any[] = [];
    const forward = createGeminiLiveEventForwarder((event) => events.push(event));

    forward({ serverContent: { outputTranscription: { text: "Hello", finished: false } } });
    forward({ serverContent: { outputTranscription: { text: " there", finished: true } } });
    forward({ serverContent: { turnComplete: true } });
    forward({ serverContent: { outputTranscription: { text: "Next turn", finished: true }, turnComplete: true } });

    expect(events.filter((event) => event.type === "response" && event.status === "started")).toHaveLength(2);
    expect(events[0]).toEqual({ type: "response", status: "started" });
    expect(events).toContainEqual({ type: "response", status: "completed" });
  });

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
    expect(events).toContainEqual({ type: "response", status: "completed" });
  });

  it("normalizes input and output transcriptions with speaker and final metadata", () => {
    const events = normalizeGeminiLiveMessage({
      serverContent: {
        inputTranscription: { text: "What time is it?", finished: true },
        outputTranscription: { text: "It is noon.", finished: false },
      },
    });

    expect(events).toContainEqual({
      type: "text",
      speaker: "user",
      text: "What time is it?",
      final: true,
    });
    expect(events).toContainEqual({
      type: "text",
      speaker: "assistant",
      text: "It is noon.",
      final: false,
    });
  });

  it("normalizes interim input transcription as a non-final user delta", () => {
    expect(
      normalizeGeminiLiveMessage({
        server_content: {
          interim_input_transcription: { text: "What ti", finished: true },
        },
      }),
    ).toContainEqual({ type: "text", speaker: "user", text: "What ti", final: false });
  });

  it("falls back to interim text while the standard input transcript is empty", () => {
    expect(
      normalizeGeminiLiveMessage({
        serverContent: {
          inputTranscription: { text: "", finished: false },
          interimInputTranscription: { text: "Still speaking", finished: false },
        },
      }),
    ).toContainEqual({ type: "text", speaker: "user", text: "Still speaking", final: false });
  });

  it("does not duplicate authoritative transcriptions through interim or model text", () => {
    const events = normalizeGeminiLiveMessage({
      serverContent: {
        inputTranscription: { text: "Hello", finished: true },
        interimInputTranscription: { text: "Hello", finished: false },
        outputTranscription: { text: "Hi there", finished: true },
        modelTurn: { parts: [{ text: "Hi there" }] },
      },
    });

    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", speaker: "user", text: "Hello", final: true },
      { type: "text", speaker: "assistant", text: "Hi there", final: true },
    ]);
  });

  it("normalizes Gemini interruption lifecycle", () => {
    expect(normalizeGeminiLiveMessage({ serverContent: { interrupted: true } })).toContainEqual({
      type: "response",
      status: "cancelled",
    });
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
