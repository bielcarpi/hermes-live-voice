import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("web demo behavior", () => {
  it("interrupts provider output when provider-managed speech starts", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    expect(harness.audio.primePlayback).toHaveBeenCalledOnce();

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

  it("shows disconnect failures instead of leaving an unhandled rejection", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.client.disconnectError = new Error("Verify the active Hermes task");

    harness.elements.connect.click();
    await vi.waitFor(() => expect(harness.elements.status.textContent).toBe("Error"));

    expect(harness.elements.log.entries.at(-1)?.strong.textContent).toBe("error");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("Verify the active Hermes task");
  });

  it("limits opaque approvals to deny", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_1",
      event: { event: "approval.request", approval_id: "approval_1" },
    });

    expect(harness.elements.log.buttonLabels.at(-1)).toEqual(["deny"]);
  });

  it("requires an inspectable pattern before offering permanent approval", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_1",
      approval: {
        approvalId: "approval_1",
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
    expect(first[0]?.focused).toBe(true);
    expect(first.every((button) => !button.disabled)).toBe(true);
    expect(second.every((button) => button.disabled)).toBe(true);
    second[0]?.click();
    expect(harness.client.respondToApproval).not.toHaveBeenCalled();

    const always = first.find((button) => button.textContent === "always");
    always?.click();
    expect(harness.client.respondToApproval).not.toHaveBeenCalled();
    expect(always?.textContent).toBe("confirm always");
    always?.click();
    expect(harness.client.respondToApproval).toHaveBeenCalledWith("always", "run_1", { approvalId: "approval_1" });

    harness.api.handleMessage({
      type: "approval.responded",
      requestId: "response_1",
      runId: "run_1",
      approvalId: "approval_1",
      choice: "always",
      resolved: 1,
    });
    expect(second.every((button) => !button.disabled)).toBe(true);
    expect(second[0]?.focused).toBe(true);
  });

  it("announces approval requests and their queue status as live regions", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_accessible",
      approval: {
        approvalId: "approval_accessible",
        command: "npm test",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });

    const entry = harness.elements.log.entries.at(-1);
    expect(entry?.element.getAttribute("role")).toBe("region");
    expect(entry?.element.getAttribute("aria-live")).toBe("assertive");
    expect(entry?.queueStatus?.getAttribute("role")).toBe("status");
    expect(entry?.queueStatus?.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps an approval actionable when sending the response fails", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.client.respondToApproval.mockImplementationOnce(() => {
      throw new Error("Gateway connection closed");
    });

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_1",
      approval: {
        approvalId: "approval_retry",
        command: "npm test",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });
    const buttons = harness.elements.log.entries.at(-1)?.buttons ?? [];
    buttons.find((button) => button.textContent === "once")?.click();

    expect(harness.elements.status.textContent).toBe("Error");
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("Gateway connection closed");
  });

  it("invalidates queued approvals when the socket closes", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_close",
      approval: {
        approvalId: "approval_close",
        command: "npm test",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });
    const buttons = harness.elements.log.entries.at(-1)?.buttons ?? [];

    harness.client.emit("close");
    buttons.find((button) => button.textContent === "once")?.click();

    expect(harness.elements.status.textContent).toBe("Disconnected");
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(harness.client.respondToApproval).not.toHaveBeenCalled();
  });

  it("invalidates queued approvals after a fatal session error", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_fatal",
      approval: {
        approvalId: "approval_fatal",
        command: "npm publish",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });
    const buttons = harness.elements.log.entries.at(-1)?.buttons ?? [];

    harness.api.handleMessage({
      type: "session.error",
      code: "session_shutdown_unconfirmed",
      error: "Session shutdown could not be confirmed.",
      recoverable: false,
    });
    buttons.find((button) => button.textContent === "once")?.click();

    expect(harness.elements.status.textContent).toBe("Error");
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(harness.client.respondToApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["run.completed", { output: "done" }],
    ["run.failed", { error: "failed" }],
    ["run.stopped", { status: "cancelled" }],
  ])("invalidates queued approvals on terminal %s events", async (type, detail) => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "approval.request",
      runId: "run_terminal",
      approval: {
        approvalId: "approval_terminal",
        command: "npm publish",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });
    const buttons = harness.elements.log.entries.at(-1)?.buttons ?? [];

    harness.api.handleMessage({ type, runId: "run_terminal", ...detail });
    buttons[0]?.click();

    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(harness.client.respondToApproval).not.toHaveBeenCalled();
  });

  it("keeps fatal session status after the socket closes", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "session.error",
      code: "session_shutdown_unconfirmed",
      message: "Verify the active Hermes task.",
      recoverable: false,
    });
    harness.client.emit("close");

    expect(harness.elements.status.textContent).toBe("Error");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toContain("Verify the active Hermes task.");
  });

  it("treats legacy uncorrelated approval containment as fatal", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    harness.api.handleMessage({
      type: "session.error",
      code: "hermes_approval_identity_unsupported",
      message: "The run was stopped; verify its final state in Hermes before retrying.",
      recoverable: false,
    });

    expect(harness.elements.status.textContent).toBe("Error");
    expect(harness.audio.clearPlayback).toHaveBeenCalledOnce();
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toContain("verify its final state");
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
  disconnectError?: Error;
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

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.state = "ready";
  }

  async disconnect(): Promise<void> {
    if (this.disconnectError) throw this.disconnectError;
    this.connected = false;
    this.state = "closed";
  }
}

class FakeHermesLiveAudio {
  static instances: FakeHermesLiveAudio[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  microphoneActive = false;
  primePlayback = vi.fn(async () => undefined);
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
  entries: Array<{
    element: TestElement;
    strong: TestElement;
    pre: TestElement;
    buttons: TestElement[];
    queueStatus?: TestElement;
  }> = [];
  buttonLabels: string[][] = [];
  focused = false;
  id = "";
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
  private attributes = new Map<string, string>();

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

  focus(): void {
    this.focused = true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  append(...children: TestElement[]): void {
    this.children.push(...children);
    for (const child of children) {
      if (child.className === "entry") {
        const actions = child.children.find((entry) => entry.className === "approval-actions");
        this.entries.push({
          element: child,
          strong: child.childElement("strong"),
          pre: child.childElement("pre"),
          buttons: actions ? actions.children.filter((entry) => entry.tagName === "button") : [],
          queueStatus: actions?.children.find((entry) => entry.className === "approval-queue-status"),
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
