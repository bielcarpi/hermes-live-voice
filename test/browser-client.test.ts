import { describe, expect, it, vi } from "vitest";
import {
  HermesLiveAudio,
  HermesLiveClient,
  arrayBufferToBase64,
  buildGatewayWebSocketUrl,
  validateServerMessage,
} from "../clients/browser/hermes-live-client.js";

describe("HermesLiveClient", () => {
  it("connects through session readiness and sends correlated commands", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();

    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: "session.start", id: "req_1", profileId: "demo" });
    socket.message(readyMessage("live_1"));

    await expect(connection).resolves.toMatchObject({ sessionId: "live_1" });
    expect(client.connected).toBe(true);
    expect(client.getSnapshot()).toMatchObject({ connection: "ready", run: { state: "idle" } });

    expect(client.sendText(" inspect this repo ")).toBe("req_2");
    expect(socket.sent.at(-1)).toEqual({ type: "text.input", id: "req_2", text: "inspect this repo" });

    socket.message({ type: "run.started", runId: "run_1", sessionId: "live_1" });
    await flushMessages();
    expect(client.getSnapshot().run).toEqual({ state: "running", runId: "run_1" });
    expect(client.stopRun()).toBe("req_3");
    expect(client.getSnapshot().run).toEqual({ state: "stopping", runId: "run_1" });
  });

  it("rejects recoverable startup errors immediately instead of waiting for timeout", async () => {
    const client = createClient({ connectTimeoutMs: 10_000 });
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message({
      type: "session.error",
      code: "session_start_failed",
      message: "Provider did not connect",
      recoverable: true,
    });

    await expect(connection).rejects.toThrow("Provider did not connect");
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 1008 });
  });

  it("rejects malformed readiness messages", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message({ type: "session.ready", protocolVersion: 1 });

    await expect(connection).rejects.toThrow(/requires sessionId/);
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 1003 });
  });

  it("decodes only the addressed typed-array slice", async () => {
    const client = createClient();
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    const json = JSON.stringify(readyMessage("live_slice"));
    const payload = Buffer.from(`junk${json}junk`);
    socket.message(payload.subarray(4, payload.length - 4));

    await expect(connection).resolves.toMatchObject({ sessionId: "live_slice" });
  });

  it("drops microphone frames when the WebSocket is backed up", async () => {
    const client = createClient({ maxBufferedAmountBytes: 10 });
    const dropped = vi.fn();
    client.on("audio.dropped", dropped);
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
    socket.bufferedAmount = 11;

    expect(client.sendAudio(new Uint8Array([0, 0]))).toBeUndefined();
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "websocket_backpressure" }));
    expect(socket.sent.some((message) => message.type === "audio.input")).toBe(false);
  });

  it("supports async same-origin URL providers without retaining gateway tokens in public state", async () => {
    const client = createClient({
      url: undefined,
      webSocketUrlProvider: async () => "wss://dashboard.example/api/plugins/hermes-live/live?ticket=one-use",
      token: undefined,
    });
    const connection = client.connect();
    const socket = await nextSocket();

    expect(socket.url.toString()).toContain("ticket=one-use");
    expect("token" in client).toBe(false);
    expect("tokenProvider" in client).toBe(false);
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
  });

  it("accepts ephemeral loopback auth URLs from the dashboard host", async () => {
    const client = createClient({
      url: undefined,
      webSocketUrlProvider: async () => "ws://127.0.0.1:3000/api/plugins/hermes-live/live?token=host-session",
      token: undefined,
    });
    const connection = client.connect();
    const socket = await nextSocket();

    expect(socket.url.searchParams.get("token")).toBe("host-session");
    expect(client.getSnapshot()).not.toHaveProperty("token");
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
  });

  it("ignores messages from a replaced socket generation", async () => {
    const client = createClient();
    const firstConnection = client.connect();
    const first = await nextSocket();
    first.open();
    first.message(readyMessage("old"));
    await firstConnection;
    await client.disconnect();

    const secondConnection = client.connect();
    const second = await nextSocket();
    first.message({ type: "run.started", runId: "stale", sessionId: "old" });
    second.open();
    second.message(readyMessage("new"));
    await secondConnection;
    await flushMessages();

    expect(client.session?.sessionId).toBe("new");
    expect(client.activeRunId).toBe("");
  });

  it("forwards unknown future messages without treating them as malformed", async () => {
    const client = createClient();
    const unknown = vi.fn();
    client.on("unknownmessage", unknown);
    const connection = client.connect();
    const socket = await nextSocket();
    socket.open();
    socket.message(readyMessage("live_1"));
    await connection;
    socket.message({ type: "future.event", value: 42 });
    await flushMessages();

    expect(unknown).toHaveBeenCalledWith({ type: "future.event", value: 42 });
  });
});

describe("HermesLiveAudio", () => {
  it("serializes concurrent audio chunks onto one playback context", async () => {
    const contexts: FakeAudioContext[] = [];
    const audio = createAudio({
      audioContextFactory: (options: AudioContextOptions) => {
        const context = new FakeAudioContext(options);
        contexts.push(context);
        return context as unknown as AudioContext;
      },
    });
    const frame = pcmFrame([0, 1000, -1000, 0]);

    await Promise.all([
      audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000", itemId: "one" }),
      audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=16000", itemId: "one" }),
    ]);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sources).toHaveLength(2);
    expect(contexts[0]?.sources[1]?.startedAt).toBeGreaterThan(contexts[0]?.sources[0]?.startedAt ?? 0);
    await audio.dispose();
  });

  it("invalidates serialized playback that has not scheduled when interrupted", async () => {
    const resumed = deferred<void>();
    const context = new FakeAudioContext({});
    context.state = "suspended";
    context.resume = vi.fn(async () => resumed.promise);
    const client = audioClient();
    const audio = createAudio({ client, audioContextFactory: () => context as unknown as AudioContext });
    const frame = pcmFrame([0, 1]);

    const first = audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" });
    const second = audio.play({ type: "audio.output", data: frame, mimeType: "audio/pcm;rate=24000" });
    await Promise.resolve();
    audio.interrupt("test interruption");
    resumed.resolve();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(context.sources).toHaveLength(0);
    expect(client.cancelResponse).toHaveBeenCalledWith("test interruption", undefined);
    await audio.dispose();
  });

  it("stops a late microphone stream when disposed during permission", async () => {
    const permission = deferred<MediaStream>();
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const contextFactory = vi.fn(() => new FakeAudioContext({}) as unknown as AudioContext);
    const audio = createAudio({
      mediaDevices: { getUserMedia: vi.fn(async () => permission.promise) },
      audioContextFactory: contextFactory,
    });

    const starting = audio.startMicrophone();
    await Promise.resolve();
    const disposing = audio.dispose();
    permission.resolve(stream);
    await Promise.all([starting, disposing]);

    expect(track.stop).toHaveBeenCalledOnce();
    expect(contextFactory).not.toHaveBeenCalled();
    expect(audio.microphoneState).toBe("disposed");
  });

  it("rejects negotiated G.711 microphone sessions before requesting permission", async () => {
    const client = audioClient() as ReturnType<typeof audioClient> & { session: unknown };
    client.session = {
      realtime: {
        audio: { input: { enabled: true, mimeType: "audio/pcmu;rate=8000" } },
      },
    };
    const getUserMedia = vi.fn();
    const audio = createAudio({ client, mediaDevices: { getUserMedia } });

    await expect(audio.startMicrophone()).rejects.toThrow(/supports PCM16 input/);
    expect(getUserMedia).not.toHaveBeenCalled();
    await audio.dispose();
  });

  it("rejects non-PCM provider output instead of corrupting it", async () => {
    const audio = createAudio();

    await expect(
      audio.play({ type: "audio.output", data: "AA==", mimeType: "audio/pcmu;rate=8000" }),
    ).rejects.toThrow(/supports PCM16 output/);
    await audio.dispose();
  });

  it("bounds queued playback and emits a drop diagnostic", async () => {
    const dropped = vi.fn();
    const audio = createAudio({ maxQueuedAudioMs: 1 });
    audio.on("audio.dropped", dropped);

    await expect(
      audio.play({ type: "audio.output", data: pcmFrame(new Array(100).fill(0)), mimeType: "audio/pcm;rate=24000" }),
    ).resolves.toBe(false);
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ reason: "playback_backpressure" }));
    await audio.dispose();
  });
});

describe("browser client utilities", () => {
  it("keeps credentials separate from the configured URL", () => {
    expect(buildGatewayWebSocketUrl("wss://voice.example/v1/live", "secret").searchParams.get("token")).toBe("secret");
    expect(() => buildGatewayWebSocketUrl("wss://voice.example/v1/live?token=secret")).toThrow(/separately/);
  });

  it("encodes typed-array slices without surrounding bytes", () => {
    const bytes = new Uint8Array([9, 1, 2, 9]);
    expect(arrayBufferToBase64(bytes.subarray(1, 3))).toBe(Buffer.from([1, 2]).toString("base64"));
  });

  it("validates state-changing server messages", () => {
    expect(() => validateServerMessage({ type: "run.started", runId: "run" })).toThrow(/sessionId/);
  });
});

function createClient(overrides: Record<string, unknown> = {}): HermesLiveClient {
  FakeWebSocket.instances = [];
  let request = 0;
  return new HermesLiveClient({
    url: "ws://127.0.0.1:8788/v1/live",
    profileId: "demo",
    requestIdFactory: () => `req_${++request}`,
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    ...overrides,
  });
}

function readyMessage(sessionId: string) {
  return {
    type: "session.ready",
    protocolVersion: 1,
    sessionId,
    model: "mock-live",
    hermes: {},
    realtime: {
      provider: "mock",
      model: "mock-live",
      audio: { input: { enabled: false }, output: { enabled: false }, turnDetection: "none" },
    },
  };
}

async function nextSocket(): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("Expected a fake WebSocket.");
  return socket;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: Array<Record<string, any>> = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  readyState = 0;
  bufferedAmount = 0;

  constructor(readonly url: URL) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    const data = typeof value === "string" || ArrayBuffer.isView(value)
      ? value
      : JSON.stringify(value);
    this.emit("message", { data });
  }

  send(payload: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function createAudio(overrides: Record<string, unknown> = {}): HermesLiveAudio {
  const client = (overrides.client as ReturnType<typeof audioClient> | undefined) ?? audioClient();
  const { client: _client, ...options } = overrides;
  return new HermesLiveAudio(client as any, {
    audioContextFactory: (config) => new FakeAudioContext(config) as unknown as AudioContext,
    audioWorkletNodeFactory: () => ({}) as AudioWorkletNode,
    decodeBase64: (value) => Buffer.from(value, "base64").toString("binary"),
    mediaDevices: { getUserMedia: vi.fn() },
    ...options,
  });
}

function audioClient() {
  return {
    connected: true,
    on: vi.fn(() => () => undefined),
    cancelResponse: vi.fn(),
    sendAudio: vi.fn(),
    endAudio: vi.fn(),
  };
}

class FakeAudioContext {
  state: AudioContextState = "running";
  sampleRate: number;
  currentTime = 0;
  destination = {};
  sources: FakeBufferSource[] = [];
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  resume: () => Promise<void> = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor(options: AudioContextOptions) {
    this.sampleRate = options.sampleRate ?? 48_000;
  }

  createBuffer(_channels: number, length: number, rate: number) {
    return {
      duration: length / rate,
      copyToChannel: vi.fn(),
    };
  }

  createBufferSource() {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
}

class FakeBufferSource {
  buffer?: { duration: number };
  startedAt = 0;
  connect = vi.fn();
  stop = vi.fn();
  private ended?: () => void;

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.ended = listener;
  }

  start(at: number): void {
    this.startedAt = at;
  }
}

function pcmFrame(samples: number[]): string {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer.toString("base64");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMessages(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
