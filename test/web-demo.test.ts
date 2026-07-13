import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("web demo behavior", () => {
  it("interrupts provider output when provider-managed speech starts", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({ type: "input.speech_started", provider: "openai", audioStartMs: 320 });

    expect(harness.audio.interrupt).toHaveBeenCalledWith("provider detected user speech");
    expect(harness.elements.log.entries.at(-1)?.strong.textContent).toBe("speech");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("started at 320ms");
  });

  it("renders Hermes run deltas as readable output", () => {
    const harness = loadWebDemo();

    harness.api.handleMessage({ type: "run.event", event: { event: "message.delta", delta: "hello" } });

    expect(harness.elements.log.entries.at(-1)?.strong.textContent).toBe("hermes");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("hello");
  });

  it("keeps provider interruption separate from stopping a Hermes task", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.client.activeRunId = "run_1";

    harness.elements.interrupt.click();
    harness.elements.stop.click();

    expect(harness.audio.interrupt).toHaveBeenCalledWith("demo user interrupted speech");
    expect(harness.client.stopRun).toHaveBeenCalledWith("demo user stopped Hermes task");
  });

  it("limits opaque approvals to once or deny", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_1",
      event: { event: "approval.request", approval_id: "approval_1" },
    });

    expect(harness.elements.log.buttonLabels.at(-1)).toEqual(["once", "deny"]);
  });

  it("requires an inspectable pattern before offering permanent approval", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_1",
      approval: {
        command: "npm publish",
        patternKey: "\u001b[31m\u202e",
        choices: ["once", "always", "deny"],
        allowPermanent: true,
      },
    });

    expect(harness.elements.log.buttonLabels.at(-1)).toEqual(["once", "deny"]);
  });

  it("keeps approvals FIFO and reconfirms permanent policy changes", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_1",
      approval: {
        approvalId: "approval_1",
        command: "npm test",
        patternKey: "terminal:npm-test",
        choices: ["once", "always", "deny"],
        allowPermanent: true,
      },
    });
    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_1",
      approval: {
        approvalId: "approval_2",
        command: "npm publish",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });

    const first = harness.elements.log.entries.at(-2)?.buttons ?? [];
    const second = harness.elements.log.entries.at(-1)?.buttons ?? [];
    expect(first.every((button) => !button.disabled)).toBe(true);
    expect(second.every((button) => button.disabled)).toBe(true);
    second[0]?.click();
    expect(harness.client.respondToApproval).not.toHaveBeenCalled();

    const always = first.find((button) => button.textContent === "always");
    always?.click();
    expect(harness.client.respondToApproval).not.toHaveBeenCalled();
    expect(always?.textContent).toBe("confirm always");
    always?.click();
    expect(harness.client.respondToApproval).toHaveBeenCalledWith("always", "run_1");

    harness.api.handleMessage({
      type: "approval.responded",
      runId: "run_1",
      choice: "always",
      resolved: 1,
    });
    expect(second.every((button) => !button.disabled)).toBe(true);
  });
});

function loadWebDemo(): {
  api: { connect(): Promise<void>; handleMessage(message: unknown): void };
  elements: Record<string, TestElement>;
  client: FakeHermesLiveClient;
  audio: FakeHermesLiveAudio;
} {
  FakeHermesLiveClient.instances = [];
  FakeHermesLiveAudio.instances = [];
  const elements = {
    gateway: new TestElement("gateway"),
    token: new TestElement("token"),
    connect: new TestElement("connect"),
    mic: new TestElement("mic"),
    interrupt: new TestElement("interrupt"),
    stop: new TestElement("stop"),
    "text-form": new TestElement("text-form"),
    text: new TestElement("text"),
    send: new TestElement("send"),
    status: new TestElement("status"),
    log: new TestElement("log"),
  };
  const document = {
    querySelector(selector: string): TestElement {
      const id = selector.startsWith("#") ? selector.slice(1) : selector;
      const element = elements[id as keyof typeof elements];
      if (!element) throw new Error(`Missing test element for selector ${selector}`);
      return element;
    },
    createElement(tagName: string): TestElement {
      return new TestElement(tagName);
    },
  };
  const source = readFileSync(new URL("../apps/web-demo/app.js", import.meta.url), "utf8")
    .replace(
      'import { HermesLiveAudio, HermesLiveClient } from "/hermes-live-client.js";',
      "const { HermesLiveAudio, HermesLiveClient } = globalThis.__clientModule;",
    );
  const context = vm.createContext({
    __clientModule: { HermesLiveAudio: FakeHermesLiveAudio, HermesLiveClient: FakeHermesLiveClient },
    clearTimeout,
    console,
    document,
    Error,
    location: { protocol: "http:", host: "127.0.0.1:8788" },
    Promise,
    setTimeout,
  });

  vm.runInContext(`${source}\nglobalThis.__webDemoTestApi = { connect, handleMessage };`, context, {
    filename: "apps/web-demo/app.js",
  });
  const api = (context as any).__webDemoTestApi as { connect(): Promise<void>; handleMessage(message: unknown): void };
  return {
    api,
    elements,
    get client() {
      const client = FakeHermesLiveClient.instances.at(-1);
      if (!client) throw new Error("Expected demo client.");
      return client;
    },
    get audio() {
      const audio = FakeHermesLiveAudio.instances.at(-1);
      if (!audio) throw new Error("Expected demo audio.");
      return audio;
    },
  };
}

class FakeHermesLiveClient {
  static instances: FakeHermesLiveClient[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  connected = false;
  state = "idle";
  activeRunId = "";
  stopRun = vi.fn();
  respondToApproval = vi.fn();
  sendText = vi.fn();

  constructor(_options: unknown) {
    FakeHermesLiveClient.instances.push(this);
  }

  on(type: string, listener: (event: any) => void): () => void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.state = "ready";
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.state = "closed";
  }
}

class FakeHermesLiveAudio {
  static instances: FakeHermesLiveAudio[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  microphoneActive = false;
  interrupt = vi.fn();
  play = vi.fn(async () => true);
  clearPlayback = vi.fn();

  constructor(_client: FakeHermesLiveClient, _options: unknown) {
    FakeHermesLiveAudio.instances.push(this);
  }

  on(type: string, listener: (event: any) => void): () => void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  async startMicrophone(): Promise<void> {
    this.microphoneActive = true;
  }

  async stopMicrophone(): Promise<void> {
    this.microphoneActive = false;
  }

  async dispose(): Promise<void> {}
}

class TestElement {
  className = "";
  disabled = false;
  entries: Array<{ strong: TestElement; pre: TestElement; buttons: TestElement[] }> = [];
  buttonLabels: string[][] = [];
  scrollHeight = 0;
  scrollTop = 0;
  textContent = "";
  type = "";
  value = "";
  private strong?: TestElement;
  private pre?: TestElement;
  private inner = "";
  private listeners = new Map<string, Array<(event: any) => void>>();
  private children: TestElement[] = [];

  constructor(readonly tagName: string) {}

  get innerHTML(): string {
    return this.inner;
  }

  set innerHTML(value: string) {
    this.inner = value;
  }

  addEventListener(event: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener({ preventDefault() {} });
  }

  append(...children: TestElement[]): void {
    this.children.push(...children);
    for (const child of children) {
      if (child.className === "entry") {
        const actions = child.children.find((entry) => entry.className === "approval-actions");
        this.entries.push({
          strong: child.childElement("strong"),
          pre: child.childElement("pre"),
          buttons: actions ? actions.children.filter((entry) => entry.tagName === "button") : [],
        });
        if (actions) {
          this.buttonLabels.push(
            actions.children.filter((entry) => entry.tagName === "button").map((entry) => entry.textContent),
          );
        }
      }
    }
    this.scrollHeight = this.entries.length;
  }

  querySelector(selector: string): TestElement {
    if (selector === "strong" || selector === "pre") return this.childElement(selector);
    throw new Error(`Unsupported querySelector(${selector}) on ${this.tagName}`);
  }

  querySelectorAll(selector: string): TestElement[] {
    if (selector === "button") return this.children.filter((child) => child.tagName === "button");
    return [];
  }

  private childElement(selector: "strong" | "pre"): TestElement {
    if (selector === "strong") {
      this.strong ??= new TestElement("strong");
      return this.strong;
    }
    this.pre ??= new TestElement("pre");
    return this.pre;
  }
}
