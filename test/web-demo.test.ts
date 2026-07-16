import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("web demo v3 task inbox", () => {
  it("keeps voice primary while describing durable background work honestly", () => {
    const html = readFileSync(new URL("../apps/web-demo/index.html", import.meta.url), "utf8");
    const source = readFileSync(new URL("../apps/web-demo/app.js", import.meta.url), "utf8");

    expect(html).toContain("Hermes, now with a real-time voice.");
    expect(html).toContain("Voice can disconnect without cancelling tasks.");
    expect(html).toContain('id="task-inbox-title"');
    expect(html).not.toContain('id="stop"');
    for (const token of [
      ["active", "RunId"],
      ["stop", "Run"],
      ["run", "Id"],
      ["appro", "val.request"],
      ["respondToAppro", "val"],
      ["waiting_for_appro", "val"],
    ].map((parts) => parts.join(""))) {
      expect(source).not.toContain(token);
    }
  });

  it("interrupts provider output when provider-managed speech starts", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();

    expect(harness.audio.primePlayback).toHaveBeenCalledOnce();
    harness.api.handleMessage({ type: "input.speech_started", provider: "openai", audioStartMs: 320 });

    expect(harness.audio.interrupt).toHaveBeenCalledWith("provider detected user speech");
    expect(harness.elements.log.entries.at(-1)?.strong.textContent).toBe("speech");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("started at 320ms");
  });

  it("renders overlapping and out-of-order tasks from the authoritative SDK snapshot", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.client.emitSnapshot(taskSnapshotState({
      activeTasks: [
        task("task_alpha", "running", 8, { title: "Review API", updatedAt: 800 }),
        task("task_beta", "queued", 3, { title: "Run tests", updatedAt: 300 }),
      ],
      recentTasks: [task("task_done", "completed", 5, {
        title: "Check docs",
        updatedAt: 500,
        result: { summary: "Docs are current.", truncated: false },
      })],
    }));

    expect(harness.elements.taskSummary.textContent).toBe("2 active · 1 recent");
    expect(taskCards(harness)).toHaveLength(3);
    expect(taskCards(harness).map((card) => card.dataset.taskId)).toEqual([
      "task_alpha",
      "task_beta",
      "task_done",
    ]);
    expect(findText(taskCards(harness)[0]!, "task-state")).toContain("Running");
    expect(findText(taskCards(harness)[1]!, "task-state")).toContain("Queued");
  });

  it("stops the exact selected task without interrupting speech or another task", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.client.emitSnapshot(taskSnapshotState({
      activeTasks: [task("task_one", "running", 2), task("task_two", "running", 4)],
    }));

    taskButton(taskCards(harness)[1]!, "Stop task").click();
    expect(harness.client.stopTask).toHaveBeenCalledWith(
      "task_two",
      "stopped from Hermes Live web demo",
    );
    expect(harness.audio.interrupt).not.toHaveBeenCalled();
  });

  it("shows stable task IDs, result details, and exact unread acknowledgement", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    const completed = task("task_result_stable", "completed", 6, {
      title: "Audit repository",
      result: { summary: "Everything passed.", output: "Full verified result", truncated: false },
    });
    harness.client.emitSnapshot(taskSnapshotState({
      recentTasks: [completed],
      unreadNotifications: [{
        taskId: completed.taskId,
        notificationId: "notification_stable",
        kind: "completed",
        delivery: "when_idle",
        message: "Audit repository finished.",
        createdAt: 600,
        acknowledged: false,
      }],
    }));

    const card = taskCards(harness)[0]!;
    expect(findText(card, "code")).toContain("task_result_stable");
    expect(findText(card, "pre")).toContain("Full verified result");
    expect(harness.elements.taskBadge.textContent).toBe("1");
    expect(harness.elements.taskBadge.getAttribute("aria-label")).toContain("1 unread task update");

    taskButton(card, "Mark read").click();
    expect(harness.client.acknowledgeNotification).toHaveBeenCalledWith(
      "task_result_stable",
      "notification_stable",
    );
  });

  it("keeps an older unread result visible beyond the recent-task display limit", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    const recent = Array.from({ length: 20 }, (_, index) => task(`task_recent_${index}`, "completed", 30 - index, {
      result: { summary: `Result ${index}`, truncated: false },
    }));
    const unreadTask = recent[18]!;
    const notification = {
      taskId: unreadTask.taskId,
      notificationId: "notification_old_unread",
      kind: "completed",
      delivery: "when_idle",
      message: "An older result still needs attention.",
      createdAt: 100,
      acknowledged: false,
    };
    harness.client.emitSnapshot(taskSnapshotState({
      recentTasks: recent,
      unreadNotifications: [notification],
    }));

    const cards = taskCards(harness);
    const unreadCards = cards.filter((card) => card.dataset.unread === "true");
    const unreadCard = cards.find((card) => card.dataset.taskId === unreadTask.taskId);
    expect(cards).toHaveLength(13);
    expect(unreadCards).toHaveLength(1);
    expect(unreadCard).toBeDefined();
    expect(findText(unreadCard!, "task-card__notification")).toContain(notification.message);
    expect(findText(unreadCard!, "pre")).toContain("Result 18");
    expect(harness.elements.taskBadge.textContent).toBe("1");

    taskButton(unreadCard!, "Mark read").click();
    expect(harness.client.acknowledgeNotification).toHaveBeenCalledWith(
      unreadTask.taskId,
      notification.notificationId,
    );
  });

  it("preserves task cards when voice disconnects and never claims disconnect cancels them", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.client.emitSnapshot(taskSnapshotState({
      activeTasks: [task("task_durable", "running", 2)],
    }));
    harness.client.connected = false;
    harness.client.state = "closed";
    harness.client.emitSnapshot({ ...harness.client.getSnapshot(), connection: "closed" });
    harness.client.emit("close", { code: 1000, clean: true, reason: "detached" });

    expect(taskCards(harness)).toHaveLength(1);
    expect(taskCards(harness)[0]?.dataset.taskId).toBe("task_durable");
    expect(taskButton(taskCards(harness)[0]!, "Stop task").disabled).toBe(true);
    expect(harness.client.stopTask).not.toHaveBeenCalled();
  });

  it("surfaces task completion feedback without rendering raw protocol objects", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.api.handleMessage({
      type: "task.notification",
      taskId: "task_feedback",
      sequence: 4,
      occurredAt: 400,
      notification: {
        notificationId: "notification_feedback",
        kind: "completed",
        delivery: "when_idle",
        message: "Repository inspection finished.",
        createdAt: 400,
        acknowledged: false,
      },
    });

    expect(harness.elements.log.entries.at(-1)?.strong.textContent).toBe("task");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toBe("Repository inspection finished.");
  });

  it("keeps text input and speech interruption separate from background task controls", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.elements.text.value = "keep talking";
    harness.elements.form.submit();
    harness.elements.interrupt.click();

    expect(harness.client.sendText).toHaveBeenCalledWith("keep talking");
    expect(harness.audio.interrupt).toHaveBeenCalledWith("new text input");
    expect(harness.audio.interrupt).toHaveBeenCalledWith("demo user interrupted speech");
    expect(harness.client.stopTask).not.toHaveBeenCalled();
  });

  it("keeps mock/text-only sessions usable without offering audio controls or re-priming playback", async () => {
    const harness = loadWebDemo();
    harness.setAudioCapabilities({ input: { enabled: false }, output: { enabled: false } });
    await harness.api.connect();

    expect(harness.elements.text.disabled).toBe(false);
    expect(harness.elements.send.disabled).toBe(false);
    expect(harness.elements.mic.disabled).toBe(true);
    expect(harness.elements.interrupt.disabled).toBe(true);
    expect(harness.audio.primePlayback).toHaveBeenCalledOnce();

    harness.elements.text.value = "text-only task";
    harness.elements.form.submit();

    expect(harness.client.sendText).toHaveBeenCalledWith("text-only task");
    expect(harness.audio.primePlayback).toHaveBeenCalledOnce();
  });

  it("keeps fatal session status after the socket closes", async () => {
    const harness = loadWebDemo();
    await harness.api.connect();
    harness.api.handleMessage({
      type: "session.error",
      code: "session_shutdown_unconfirmed",
      message: "Reconnect to verify durable task state.",
      recoverable: false,
    });
    harness.client.emit("close", { code: 1011, clean: false, reason: "failed" });

    expect(harness.elements.status.textContent).toBe("Error");
    expect(harness.elements.log.entries.at(-1)?.pre.textContent).toContain("Reconnect to verify durable task state.");
  });
});

function loadWebDemo(): {
  api: {
    connect(): Promise<void>;
    handleMessage(message: unknown): void;
    renderTaskInbox(snapshot: unknown): void;
  };
  elements: ReturnType<typeof createElements>;
  client: FakeHermesLiveClient;
  audio: FakeHermesLiveAudio;
  setAudioCapabilities(audio: Record<string, unknown>): void;
} {
  FakeHermesLiveClient.instances = [];
  FakeHermesLiveClient.audioCapabilities = { input: { enabled: true }, output: { enabled: true } };
  FakeHermesLiveAudio.instances = [];
  const elements = createElements();
  const document = {
    querySelector(selector: string): TestElement {
      const id = selector.startsWith("#") ? selector.slice(1) : selector;
      const element = elements.byId[id];
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

  vm.runInContext(
    `${source}\nglobalThis.__webDemoTestApi = { connect, handleMessage, renderTaskInbox };`,
    context,
    { filename: "apps/web-demo/app.js" },
  );
  const api = (context as any).__webDemoTestApi;
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
    setAudioCapabilities(audio) {
      FakeHermesLiveClient.audioCapabilities = audio;
    },
  };
}

function createElements() {
  const byId: Record<string, TestElement> = {};
  for (const id of [
    "gateway",
    "token",
    "connect",
    "mic",
    "interrupt",
    "text-form",
    "text",
    "send",
    "status",
    "log",
    "tasks",
    "task-badge",
    "task-summary",
  ]) {
    byId[id] = new TestElement(id === "text-form" ? "form" : "div", id);
  }
  return {
    byId,
    gateway: byId.gateway!,
    token: byId.token!,
    connect: byId.connect!,
    mic: byId.mic!,
    interrupt: byId.interrupt!,
    form: byId["text-form"]!,
    text: byId.text!,
    send: byId.send!,
    status: byId.status!,
    log: byId.log!,
    tasks: byId.tasks!,
    taskBadge: byId["task-badge"]!,
    taskSummary: byId["task-summary"]!,
  };
}

function taskCards(harness: ReturnType<typeof loadWebDemo>): TestElement[] {
  return harness.elements.tasks.children.filter((child) => child.className === "task-card");
}

function taskButton(card: TestElement, label: string): TestElement {
  const button = card.descendants().find((child) => child.tagName === "button" && child.textContent === label);
  if (!button) throw new Error(`Missing ${label} button.`);
  return button;
}

function findText(element: TestElement, selector: string): string {
  return element.descendants(true)
    .filter((child) => child.tagName === selector || child.className.includes(selector))
    .map((child) => child.textContent)
    .join(" ");
}

function taskSnapshotState(overrides: Record<string, unknown> = {}) {
  return {
    connection: "ready",
    session: undefined,
    tasks: [],
    activeTasks: [],
    recentTasks: [],
    unreadNotifications: [],
    ...overrides,
  };
}

function task(taskId: string, state: string, sequence: number, overrides: Record<string, any> = {}) {
  return {
    taskId,
    state,
    sequence,
    title: taskId,
    createdAt: 100,
    updatedAt: sequence * 100,
    ...overrides,
  };
}

class FakeHermesLiveClient {
  static instances: FakeHermesLiveClient[] = [];
  static audioCapabilities: Record<string, unknown> = {
    input: { enabled: true },
    output: { enabled: true },
  };
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly subscribers = new Set<(snapshot: any) => void>();
  connected = false;
  state = "idle";
  session?: Record<string, any>;
  snapshot = taskSnapshotState({ connection: "idle" });
  disconnectError?: Error;
  stopTask = vi.fn();
  acknowledgeNotification = vi.fn();
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

  subscribe(listener: (snapshot: any) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  getSnapshot(): any {
    return this.snapshot;
  }

  emitSnapshot(snapshot: any): void {
    this.snapshot = snapshot;
    this.state = snapshot.connection;
    this.connected = snapshot.connection === "ready";
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.state = "ready";
    this.emitSnapshot({ ...this.snapshot, connection: "ready" });
    const realtime = { audio: FakeHermesLiveClient.audioCapabilities };
    this.session = { realtime };
    this.emit("message", {
      type: "session.ready",
      protocolVersion: 3,
      sessionId: "test_session",
      realtime,
      tasks: { durable: true, parallel: true },
    });
  }

  async disconnect(): Promise<void> {
    if (this.disconnectError) throw this.disconnectError;
    this.connected = false;
    this.state = "closed";
    this.emitSnapshot({ ...this.snapshot, connection: "closed" });
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
  dataset: Record<string, string> = {};
  disabled = false;
  entries: Array<{ element: TestElement; strong: TestElement; pre: TestElement }> = [];
  focused = false;
  scrollHeight = 0;
  scrollTop = 0;
  textContent = "";
  title = "";
  type = "";
  value = "";
  dateTime = "";
  children: TestElement[] = [];
  private strong?: TestElement;
  private pre?: TestElement;
  private inner = "";
  private listeners = new Map<string, Array<(event: any) => void>>();
  private attributes = new Map<string, string>();

  constructor(readonly tagName: string, readonly id = "") {}

  get childElementCount(): number {
    return this.children.length;
  }

  get innerHTML(): string {
    return this.inner;
  }

  set innerHTML(value: string) {
    this.inner = value;
    if (value === "") this.children = [];
  }

  addEventListener(event: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  click(): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") ?? []) listener({ preventDefault() {} });
  }

  submit(): void {
    for (const listener of this.listeners.get("submit") ?? []) listener({ preventDefault() {} });
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
    if (this.id === "log") {
      for (const child of children.filter((entry) => entry.className === "entry")) {
        this.entries.push({
          element: child,
          strong: child.querySelector("strong"),
          pre: child.querySelector("pre"),
        });
      }
      this.scrollHeight = this.entries.length;
    }
  }

  querySelector(selector: string): TestElement {
    if (selector === "strong" || selector === "pre") return this.childElement(selector);
    throw new Error(`Unsupported querySelector(${selector}) on ${this.tagName}`);
  }

  querySelectorAll(selector: string): TestElement[] {
    if (selector === ".entry") return this.entries.map((entry) => entry.element);
    return [];
  }

  descendants(includeSelf = false): TestElement[] {
    const own: TestElement[] = includeSelf ? [this] : [];
    return [...own, ...this.children.flatMap((child) => [child, ...child.descendants()])];
  }

  remove(): void {}

  private childElement(selector: "strong" | "pre"): TestElement {
    if (selector === "strong") {
      this.strong ??= new TestElement("strong");
      return this.strong;
    }
    this.pre ??= new TestElement("pre");
    return this.pre;
  }
}
