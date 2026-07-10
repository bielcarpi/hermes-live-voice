import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("web demo behavior", () => {
  it("cancels provider output when provider-managed speech starts", () => {
    const harness = loadWebDemo();

    harness.api.connect();
    const socket = lastSocket();
    harness.api.handleMessage({ type: "input.speech_started", provider: "openai", audioStartMs: 320 });
    const speechEntry = harness.elements.log.entries.at(-1)?.entry;
    const timingChip = speechEntry?.querySelector(".timing-chip");

    expect(socket.sent).toContainEqual({
      type: "response.cancel",
      reason: "provider detected user speech",
    });
    expect(harness.elements.log.entries.at(-1)?.strong?.textContent).toBe("speech");
    expect(timingChip?.hidden).toBe(true);
    expect(timingChip?.textContent).toBe("");
  });

  it("combines speech start and stop into one entry with rounded spoken duration chip", () => {
    const harness = loadWebDemo();

    harness.api.handleMessage({ type: "input.speech_started" });
    harness.api.handleMessage({ type: "input.speech_stopped", durationS: 3.572 });

    const speechEntries = harness.elements.log.entries.filter((entry) => entry.entry.dataset.kind === "speech");
    const timingChip = speechEntries[0]?.entry.querySelector(".timing-chip");
    const entryLabel = speechEntries[0]?.entry.querySelector(".entry-label");

    expect(speechEntries).toHaveLength(1);
    expect(entryLabel?.textContent).toBe("speech");
    expect(speechEntries[0]?.pre).toBeUndefined();
    expect(timingChip?.hidden).toBe(false);
    expect(timingChip?.textContent).toBe("spoken 3.6s");
  });

  it("keeps the speech timing chip hidden when duration is unavailable", () => {
    const harness = loadWebDemo();

    harness.api.handleMessage({ type: "input.speech_started" });
    harness.api.handleMessage({ type: "input.speech_stopped" });

    const speechEntry = harness.elements.log.entries.find((entry) => entry.entry.dataset.kind === "speech");
    const timingChip = speechEntry?.entry.querySelector(".timing-chip");

    expect(speechEntry?.strong?.textContent).toBe("speech");
    expect(speechEntry?.pre).toBeUndefined();
    expect(timingChip?.hidden).toBe(true);
    expect(timingChip?.textContent).toBe("");
  });

  it("renders agent run deltas as readable output", () => {
    const harness = loadWebDemo();

    harness.api.handleMessage({ type: "run.event", event: { event: "message.delta", delta: "hello" } });

    expect(harness.elements.log.entries.at(-1)?.strong?.textContent).toBe("agent");
    expect(harness.elements.log.entries.at(-1)?.pre?.textContent).toBe("hello");
  });

  it("renders one active filter pill per fixed kind on load", () => {
    const harness = loadWebDemo();
    const pills = harness.elements.filters.querySelectorAll(".filter-pill");

    expect(pills.map((pill) => pill.textContent)).toEqual([
      "you",
      "assistant",
      "agent",
      "run",
      "run.event",
      "session",
      "speech",
      "error",
      "approval",
      "log",
    ]);

    for (const pill of pills) {
      expect(pill.getAttribute("aria-pressed")).toBe("true");
      expect(pill.className).not.toContain("is-inactive");
    }
  });

  it("toggles speech entries with the speech filter pill", () => {
    const harness = loadWebDemo();
    harness.api.handleMessage({ type: "input.speech_started", audioStartMs: 120 });

    const speechEntry = harness.elements.log.entries.at(-1)?.entry;
    const speechPill = filterPill(harness, "speech");
    if (!speechEntry) {
      throw new Error("Expected a speech log entry.");
    }

    speechPill.click();
    expect(speechPill.getAttribute("aria-pressed")).toBe("false");
    expect(speechPill.className).toContain("is-inactive");
    expect(speechEntry.className).toContain("filter-hidden");

    speechPill.click();
    expect(speechPill.getAttribute("aria-pressed")).toBe("true");
    expect(speechPill.className).not.toContain("is-inactive");
    expect(speechEntry.className).not.toContain("filter-hidden");
  });

  it("sets data-kind on rendered log entries", () => {
    const harness = loadWebDemo();
    harness.api.handleMessage({ type: "input.speech_started", audioStartMs: 50 });

    const speechEntry = harness.elements.log.entries.at(-1)?.entry;
    expect(speechEntry?.dataset.kind).toBe("speech");
    expect(speechEntry?.getAttribute("data-kind")).toBe("speech");
  });

  it("shows a TTFA timing chip after assistant audio begins", () => {
    const harness = loadWebDemo();
    harness.api.connect();
    harness.clock.now = 100;
    harness.elements.text.value = "Hello";
    harness.elements["text-form"].dispatch("submit");

    harness.clock.now = 160;
    harness.api.handleMessage({
      type: "audio.output",
      data: pcmChunkBase64(100),
      mimeType: "audio/pcm;rate=24000",
      itemId: "assistant-1",
      contentIndex: 0,
    });

    const assistantEntry = harness.elements.log.entries[0]?.entry;
    const timingChip = assistantEntry?.querySelector(".timing-chip");
    expect(assistantEntry?.dataset.kind).toBe("assistant");
    expect(timingChip?.hidden).toBe(false);
    expect(timingChip?.textContent).toContain("TTFA 60ms");
  });

  it("accumulates spoken time across assistant audio chunks", () => {
    const harness = loadWebDemo();
    harness.api.connect();
    harness.clock.now = 200;
    harness.elements.text.value = "Status update";
    harness.elements["text-form"].dispatch("submit");

    harness.clock.now = 220;
    harness.api.handleMessage({
      type: "audio.output",
      data: pcmChunkBase64(100),
      mimeType: "audio/pcm;rate=24000",
      itemId: "assistant-2",
      contentIndex: 0,
    });
    harness.clock.now = 260;
    harness.api.handleMessage({
      type: "audio.output",
      data: pcmChunkBase64(200),
      mimeType: "audio/pcm;rate=24000",
      itemId: "assistant-2",
      contentIndex: 0,
    });

    const assistantEntry = harness.elements.log.entries[0]?.entry;
    const timingChip = assistantEntry?.querySelector(".timing-chip");
    expect(timingChip?.textContent).toContain("spoken 0.3s");
  });
});

type WebDemoApi = {
  connect(): void;
  handleMessage(message: unknown): void;
};

type TestHarness = {
  api: WebDemoApi;
  clock: { now: number };
  elements: Record<string, TestElement>;
};

type TestLogEntry = {
  entry: TestElement;
  strong: TestElement | undefined;
  pre: TestElement | undefined;
};

type TestEvent = {
  preventDefault(): void;
  data?: unknown;
};

function loadWebDemo(): TestHarness {
  FakeWebSocket.instances = [];
  const clock = { now: 0 };
  const elements: Record<string, TestElement> = {
    gateway: new TestElement("input"),
    token: new TestElement("input"),
    connect: new TestElement("button"),
    mic: new TestElement("button"),
    stop: new TestElement("button"),
    mute: new TestElement("button"),
    filters: new TestElement("div"),
    "text-form": new TestElement("form"),
    text: new TestElement("input"),
    status: new TestElement("p"),
    log: new TestElement("div"),
  };
  const document = {
    querySelector(selector: string): TestElement {
      const id = selector.startsWith("#") ? selector.slice(1) : selector;
      const element = elements[id];
      if (!element) {
        throw new Error(`Missing test element for selector ${selector}`);
      }
      return element;
    },
    createElement(tagName: string): TestElement {
      return new TestElement(tagName);
    },
  };

  const source = readFileSync(new URL("../apps/web-demo/app.js", import.meta.url), "utf8").replace(
    /^import\s+\{\s*fireSound\s*,\s*toggleMute\s*\}\s+from\s+["']\.\/sounds\.js["'];\s*/m,
    "",
  );

  const context = vm.createContext({
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    DataView,
    Float32Array,
    Uint8Array,
    URL,
    WebSocket: FakeWebSocket,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    clearTimeout,
    document,
    fireSound: () => undefined,
    location: { protocol: "http:", host: "127.0.0.1:8788" },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    performance: { now: () => clock.now },
    setTimeout,
    toggleMute: () => false,
  });

  vm.runInContext(`${source}\nglobalThis.__webDemoTestApi = { connect, handleMessage };`, context, {
    filename: "apps/web-demo/app.js",
  });

  const api = (context as vm.Context & { __webDemoTestApi: WebDemoApi }).__webDemoTestApi;
  return { api, clock, elements };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly sent: unknown[] = [];
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: URL) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(_event: string, _listener: (...args: unknown[]) => void): void {}

  close(): void {
    this.readyState = 3;
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }
}

class FakeAudioContext {
  readonly destination = {};
  currentTime = 0;
  readonly sampleRate: number;
  state: "running" | "suspended" | "closed" = "running";

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24000;
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createBuffer(_channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length, sampleRate);
  }

  createBufferSource(): FakeAudioBufferSource {
    return new FakeAudioBufferSource(this);
  }

  async resume(): Promise<void> {
    this.state = "running";
  }
}

class FakeAudioBuffer {
  readonly duration: number;

  constructor(readonly length: number, readonly sampleRate: number) {
    this.duration = sampleRate === 0 ? 0 : length / sampleRate;
  }

  copyToChannel(_samples: Float32Array, _channel: number): void {}
}

class FakeAudioBufferSource {
  buffer?: FakeAudioBuffer;
  private endedListeners: Array<() => void> = [];

  constructor(private readonly context: FakeAudioContext) {}

  addEventListener(event: string, listener: () => void): void {
    if (event === "ended") {
      this.endedListeners.push(listener);
    }
  }

  connect(_destination: object): void {}

  start(startAt: number): void {
    this.context.currentTime = startAt + (this.buffer?.duration ?? 0);
  }

  stop(): void {
    for (const listener of this.endedListeners) {
      listener();
    }
    this.endedListeners = [];
  }
}

class FakeAudioWorkletNode {
  readonly port = {
    addEventListener: (_event: string, _listener: (...args: unknown[]) => void) => undefined,
    onmessage: null as ((event: TestEvent) => void) | null,
    postMessage: (_message: unknown) => undefined,
    removeEventListener: (_event: string, _listener: (...args: unknown[]) => void) => undefined,
  };

  constructor(_context: FakeAudioContext, _name: string) {}

  disconnect(): void {}
}

class TestElement {
  className = "";
  dataset: Record<string, string> = {};
  disabled = false;
  entries: TestLogEntry[] = [];
  hidden = false;
  scrollHeight = 0;
  scrollTop = 0;
  type = "";
  value = "";
  readonly children: TestElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: TestEvent) => void>>();
  private ownText = "";

  constructor(readonly tagName: string) {}

  get innerHTML(): string {
    return this.ownText;
  }

  set innerHTML(value: string) {
    this.ownText = value;
    this.children.length = 0;
    this.refreshEntries();
  }

  get textContent(): string {
    if (this.children.length === 0) {
      return this.ownText;
    }
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
    this.refreshEntries();
  }

  addEventListener(event: string, listener: (event: TestEvent) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  append(...children: TestElement[]): void {
    this.ownText = "";
    for (const child of children) {
      this.children.push(child);
    }
    this.refreshEntries();
  }

  click(): void {
    if (this.disabled) {
      return;
    }
    this.dispatch("click");
  }

  dispatch(event: string, overrides: Partial<TestEvent> = {}): void {
    const listeners = this.listeners.get(event) ?? [];
    const payload: TestEvent = {
      preventDefault: () => undefined,
      ...overrides,
    };
    for (const listener of listeners) {
      listener(payload);
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  prepend(...children: TestElement[]): void {
    this.ownText = "";
    this.children.unshift(...children);
    this.refreshEntries();
  }

  querySelector(selector: string): TestElement | undefined {
    return this.findFirst(selector);
  }

  querySelectorAll(selector: string): TestElement[] {
    const matches: TestElement[] = [];
    this.collectMatches(selector, matches);
    return matches;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "data-kind") {
      this.dataset.kind = value;
    }
  }

  private collectMatches(selector: string, matches: TestElement[]): void {
    for (const child of this.children) {
      if (child.matches(selector)) {
        matches.push(child);
      }
      child.collectMatches(selector, matches);
    }
  }

  private findFirst(selector: string): TestElement | undefined {
    for (const child of this.children) {
      if (child.matches(selector)) {
        return child;
      }
      const nested = child.findFirst(selector);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this.className.split(/\s+/).filter(Boolean).includes(className);
    }
    return this.tagName === selector;
  }

  private refreshEntries(): void {
    this.entries = this.children
      .filter((child) => child.className.split(/\s+/).filter(Boolean).includes("entry"))
      .map((entry) => ({
        entry,
        strong: entry.querySelector("strong"),
        pre: entry.querySelector("pre"),
      }));
    this.scrollHeight = this.entries.length;
  }
}

function filterPill(harness: TestHarness, kind: string): TestElement {
  const pill = harness.elements.filters.querySelectorAll(".filter-pill").find((candidate) => candidate.dataset.kind === kind);
  if (!pill) {
    throw new Error(`Missing filter pill for ${kind}`);
  }
  return pill;
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("Expected web demo to create a WebSocket.");
  }
  return socket;
}

function pcmChunkBase64(durationMs: number, sampleRate = 24000): string {
  const sampleCount = Math.round((sampleRate * durationMs) / 1000);
  return Buffer.alloc(sampleCount * 2).toString("base64");
}
