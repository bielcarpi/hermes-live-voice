import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("web demo behavior", () => {
  it("cancels provider output when provider-managed speech starts", () => {
    const harness = loadWebDemo();

    harness.api.connect();
    const socket = lastSocket();
    harness.api.handleMessage({ type: "input.speech_started", provider: "openai", audioStartMs: 320 });

    expect(socket.sent).toContainEqual({
      type: "response.cancel",
      reason: "provider detected user speech",
    });
    expect(harness.elements.log.entries.at(-1)?.strong.textContent).toBe("speech");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("started at 320ms");
  });

  it("renders Hermes run deltas as readable output", () => {
    const harness = loadWebDemo();

    harness.api.handleMessage({ type: "run.event", event: { event: "message.delta", delta: "hello" } });

    expect(harness.elements.log.entries.at(-1)?.strong.textContent).toBe("hermes");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("hello");
  });
});

function loadWebDemo(): {
  api: { connect(): void; handleMessage(message: unknown): void };
  elements: Record<string, TestElement>;
} {
  FakeWebSocket.instances = [];
  const elements = {
    gateway: new TestElement("gateway"),
    token: new TestElement("token"),
    connect: new TestElement("connect"),
    mic: new TestElement("mic"),
    stop: new TestElement("stop"),
    "text-form": new TestElement("text-form"),
    text: new TestElement("text"),
    status: new TestElement("status"),
    log: new TestElement("log"),
  };
  const document = {
    querySelector(selector: string): TestElement {
      const id = selector.startsWith("#") ? selector.slice(1) : selector;
      const element = elements[id as keyof typeof elements];
      if (!element) {
        throw new Error(`Missing test element for selector ${selector}`);
      }
      return element;
    },
    createElement(tagName: string): TestElement {
      return new TestElement(tagName);
    },
  };
  const source = readFileSync(new URL("../apps/web-demo/app.js", import.meta.url), "utf8");
  const context = vm.createContext({
    AudioContext: class {},
    AudioWorkletNode: class {},
    DataView,
    Float32Array,
    Uint8Array,
    URL,
    WebSocket: FakeWebSocket,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    clearTimeout,
    document,
    location: { protocol: "http:", host: "127.0.0.1:8788" },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    setTimeout,
  });

  vm.runInContext(`${source}\nglobalThis.__webDemoTestApi = { connect, handleMessage };`, context, {
    filename: "apps/web-demo/app.js",
  });
  const api = (context as any).__webDemoTestApi as { connect(): void; handleMessage(message: unknown): void };
  return { api, elements };
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

  addEventListener(_event: string, _listener: (...args: any[]) => void): void {}

  close(): void {
    this.readyState = 3;
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }
}

class TestElement {
  className = "";
  disabled = false;
  entries: Array<{ strong: TestElement; pre: TestElement }> = [];
  scrollHeight = 0;
  scrollTop = 0;
  textContent = "";
  type = "";
  value = "";
  private strong?: TestElement;
  private pre?: TestElement;
  private inner = "";

  constructor(readonly tagName: string) {}

  get innerHTML(): string {
    return this.inner;
  }

  set innerHTML(value: string) {
    this.inner = value;
  }

  addEventListener(_event: string, _listener: (...args: any[]) => void): void {}

  append(...children: TestElement[]): void {
    for (const child of children) {
      if (child.className === "entry") {
        this.entries.push({ strong: child.childElement("strong"), pre: child.childElement("pre") });
      }
    }
    this.scrollHeight = this.entries.length;
  }

  querySelector(selector: string): TestElement {
    if (selector === "strong" || selector === "pre") return this.childElement(selector);
    throw new Error(`Unsupported querySelector(${selector}) on ${this.tagName}`);
  }

  querySelectorAll(_selector: string): TestElement[] {
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

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("Expected web demo to create a WebSocket.");
  }
  return socket;
}
