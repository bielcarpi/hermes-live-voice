import { describe, expect, it, vi } from "vitest";
import {
  buildGeminiClientOptions,
  buildGeminiLiveConnectConfig,
  createGeminiLiveEventForwarder,
  buildGeminiRealtimeAudioInput,
  buildGeminiRealtimeTextInput,
  buildGeminiTaskNotificationInput,
  buildGeminiTextTurn,
  buildGeminiToolResponse,
  GeminiLiveAdapter,
  GeminiLiveSession,
  normalizeGeminiLiveMessage,
  officialGeminiApiBaseUrl,
} from "../src/adapters/outbound/realtime/gemini-live.adapter.js";

describe("Gemini Live adapter helpers", () => {
  it("enables input and output audio transcription for live sessions", () => {
    expect(buildGeminiLiveConnectConfig("test instruction")).toMatchObject({
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: "test instruction",
    });
  });

  it("pins official Gemini endpoints and ignores ambient SDK endpoint overrides", () => {
    const names = [
      "GOOGLE_GEMINI_BASE_URL",
      "GOOGLE_VERTEX_BASE_URL",
      "GOOGLE_GENAI_USE_ENTERPRISE",
      "GOOGLE_GENAI_USE_VERTEXAI",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    process.env.GOOGLE_GEMINI_BASE_URL = "http://127.0.0.1:9/gemini-credential-target";
    process.env.GOOGLE_VERTEX_BASE_URL = "http://127.0.0.1:9/vertex-credential-target";
    process.env.GOOGLE_GENAI_USE_ENTERPRISE = "true";
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";

    try {
      const developerConfig = testGeminiConfig({ enterprise: false, apiKey: "endpoint-sensitive-key" });
      expect(buildGeminiClientOptions(developerConfig)).toMatchObject({
        enterprise: false,
        apiKey: "endpoint-sensitive-key",
        httpOptions: { baseUrl: "https://generativelanguage.googleapis.com/" },
      });
      const developerClient = (new GeminiLiveAdapter(developerConfig) as any).createClient();
      expect(developerClient.apiClient.isVertexAI()).toBe(false);
      expect(developerClient.apiClient.getBaseUrl()).toBe("https://generativelanguage.googleapis.com/");
      expect(developerClient.apiClient.getWebsocketBaseUrl()).toBe("wss://generativelanguage.googleapis.com/");

      const vertexConfig = testGeminiConfig({
        enterprise: true,
        apiKey: undefined,
        project: "demo-project",
        location: "us-central1",
      });
      expect(buildGeminiClientOptions(vertexConfig)).toMatchObject({
        enterprise: true,
        project: "demo-project",
        location: "us-central1",
        httpOptions: { baseUrl: "https://us-central1-aiplatform.googleapis.com/" },
      });
      const vertexClient = (new GeminiLiveAdapter(vertexConfig) as any).createClient();
      expect(vertexClient.apiClient.isVertexAI()).toBe(true);
      expect(vertexClient.apiClient.getBaseUrl()).toBe("https://us-central1-aiplatform.googleapis.com/");
      expect(vertexClient.apiClient.getWebsocketBaseUrl()).toBe("wss://us-central1-aiplatform.googleapis.com/");

      expect(officialGeminiApiBaseUrl({ enterprise: true, location: "global" }))
        .toBe("https://aiplatform.googleapis.com/");
      expect(officialGeminiApiBaseUrl({ enterprise: true, location: "eu" }))
        .toBe("https://aiplatform.eu.rep.googleapis.com/");
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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

  it("normalizes Gemini tool-call cancellation ids", () => {
    expect(
      normalizeGeminiLiveMessage({
        toolCallCancellation: { ids: ["call_1", "call_2"] },
      }),
    ).toEqual([{ type: "tool_call_cancelled", callIds: ["call_1", "call_2"] }]);

    expect(
      normalizeGeminiLiveMessage({
        tool_call_cancellation: { ids: ["call_snake"] },
      }),
    ).toEqual([{ type: "tool_call_cancelled", callIds: ["call_snake"] }]);
  });

  it("preserves malformed Gemini tool-call cancellations for fail-closed gateway validation", () => {
    expect(
      normalizeGeminiLiveMessage({
        toolCallCancellation: { ids: ["call_1", 2] },
      }),
    ).toEqual([{ type: "tool_call_cancelled", callIds: [] }]);
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
    expect(events).toHaveLength(2);
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
    expect(events).toHaveLength(2);
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
    const session = new GeminiLiveSession(sdkSession, confirmedClose());

    await session.sendText("hello");

    expect(buildGeminiRealtimeTextInput("hello")).toEqual({ text: "hello" });
    expect(sdkSession.sendRealtimeInput).toHaveBeenCalledWith({ text: "hello" });
    expect(sdkSession.sendClientContent).not.toHaveBeenCalled();
  });

  it("sends the authenticated task marker through Gemini 3.1 realtime text input as best effort", async () => {
    const sdkSession = {
      sendRealtimeInput: vi.fn(async () => undefined),
      sendClientContent: vi.fn(async () => undefined),
    };
    const session = new GeminiLiveSession(sdkSession, confirmedClose());
    const notification = {
      context: "[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef] Task finished.",
      announcement: "Task finished.",
      rawOutput: "private Hermes output",
    } as any;

    await session.sendTaskNotification(notification);

    expect(sdkSession.sendRealtimeInput).toHaveBeenCalledOnce();
    expect(sdkSession.sendRealtimeInput).toHaveBeenCalledWith({ text: notification.context });
    expect(sdkSession.sendClientContent).not.toHaveBeenCalled();
    const rendered = JSON.stringify(sdkSession.sendRealtimeInput.mock.calls[0]);
    expect(rendered).not.toContain(notification.rawOutput);
    expect(buildGeminiTaskNotificationInput(notification)).toEqual(
      buildGeminiRealtimeTextInput(notification.context),
    );
  });

  it.each([
    ["invalid context", { context: "marker\nforged", announcement: "Done." }],
    ["invalid announcement", { context: "marker", announcement: "Done.\u0000" }],
  ])("rejects a task notification with %s before calling the Gemini SDK", async (_label, notification) => {
    const sdkSession = {
      sendRealtimeInput: vi.fn(async () => undefined),
      sendClientContent: vi.fn(async () => undefined),
    };
    const session = new GeminiLiveSession(sdkSession, confirmedClose());

    await expect(session.sendTaskNotification(notification)).rejects.toThrow(/Task notification/);
    expect(sdkSession.sendClientContent).not.toHaveBeenCalled();
    expect(sdkSession.sendRealtimeInput).not.toHaveBeenCalled();
  });

  it("fails closed rather than misusing client-content history for a Gemini 3.1 notification", async () => {
    const sdkSession = { sendClientContent: vi.fn(async () => undefined) };
    const session = new GeminiLiveSession(sdkSession, confirmedClose());

    await expect(session.sendTaskNotification({
      context: "[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef] Done.",
      announcement: "Done.",
    })).rejects.toThrow("does not support realtime text input");
    expect(sdkSession.sendClientContent).not.toHaveBeenCalled();
  });

  it("does not accept a Gemini notification until realtime input accepts it", async () => {
    const sdkError = new Error("Gemini realtime input rejected the marker");
    const sdkSession = {
      sendRealtimeInput: vi.fn(async () => {
        throw sdkError;
      }),
      sendClientContent: vi.fn(async () => undefined),
    };
    const session = new GeminiLiveSession(sdkSession, confirmedClose());

    await expect(session.sendTaskNotification({
      context: "[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef] Done.",
      announcement: "Done.",
    })).rejects.toBe(sdkError);
    expect(sdkSession.sendRealtimeInput).toHaveBeenCalledOnce();
    expect(sdkSession.sendClientContent).not.toHaveBeenCalled();
  });

  it("does not confirm Gemini closure until the SDK reports onclose", async () => {
    const closed = deferred<void>();
    let isClosed = false;
    const closeConfirmation = {
      promise: closed.promise,
      isClosed: () => isClosed,
      confirm: () => {
        isClosed = true;
        closed.resolve();
      },
    };
    const sdkSession = { close: vi.fn() };
    const session = new GeminiLiveSession(sdkSession, closeConfirmation, 1_000);
    let settled = false;

    const firstClose = session.close().then(() => {
      settled = true;
    });
    const secondClose = session.close();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(sdkSession.close).toHaveBeenCalledTimes(1);
    closeConfirmation.confirm();
    await Promise.all([firstClose, secondClose]);
    expect(settled).toBe(true);
  });

  it("rejects Gemini closure when the SDK never confirms onclose", async () => {
    const neverClosed = new Promise<void>(() => undefined);
    const session = new GeminiLiveSession(
      { close: vi.fn() },
      { promise: neverClosed, isClosed: () => false, confirm: () => undefined },
      10,
    );

    await expect(session.close()).rejects.toThrow("did not confirm closure within 10ms");
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
    await expect(
      new GeminiLiveAdapter(testGeminiConfig({ enterprise: true, project: "unsafe/project" })).connect(testConnectParams()),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
    await expect(
      new GeminiLiveAdapter(testGeminiConfig({ location: "us-central1/../../target" })).connect(testConnectParams()),
    ).rejects.toThrow(/GOOGLE_CLOUD_LOCATION/);
    await expect(
      new GeminiLiveAdapter(testGeminiConfig({ location: "a".repeat(64) })).connect(testConnectParams()),
    ).rejects.toThrow(/GOOGLE_CLOUD_LOCATION/);
    await expect(
      new GeminiLiveAdapter(testGeminiConfig({ apiVersion: "v1beta?key=secret" })).connect(testConnectParams()),
    ).rejects.toThrow(/GOOGLE_GENAI_API_VERSION/);
    await expect(
      new GeminiLiveAdapter(testGeminiConfig({ apiVersion: `v1${"1".repeat(32)}` })).connect(testConnectParams()),
    ).rejects.toThrow(/GOOGLE_GENAI_API_VERSION/);
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

function confirmedClose() {
  return { promise: Promise.resolve(), isClosed: () => true, confirm: () => undefined };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
