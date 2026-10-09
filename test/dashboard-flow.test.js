import { once } from "node:events";
import React, { act } from "react";
import { Window } from "happy-dom";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const sourceUrl = new URL("../plugins/hermes-live/dashboard/dist/index.js", import.meta.url);
let mountSequence = 0;
const cleanups = [];
const taskId = "task_0123456789abcdef0123456789abcdef";
const completedTask = {
  taskId, kind: "background", rootTaskId: taskId, state: "completed",
  sequence: 1, createdAt: 1_000, updatedAt: 2_000,
  title: "Repository audit", result: { summary: "Audit summary", truncated: true },
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard conversation and task flow", () => {
  it("attaches to Hermes's selected chat without a separate picker or composer", async () => {
    const page = await mountDashboard({ chatId: "saved_chat" });
    await page.click("Start voice");
    await page.waitFor(() => expect(page.requests[0]?.type).toBe("session.start"));
    expect(page.requests[0].conversation).toEqual({ mode: "resume", sessionId: "saved_chat" });
    expect(page.document.querySelector("select, textarea, form")).toBeNull();
  });

  it("requires selecting the conversation in Hermes before starting voice", async () => {
    const page = await mountDashboard({ chatId: null });
    expect(page.button("Start voice").disabled).toBe(true);
    expect(page.document.body.textContent).toContain("Select a saved chat in Hermes");
    expect(page.requests).toHaveLength(0);
  });

  it("keeps speech interruption separate from exact task stop", async () => {
    const running = { ...completedTask, state: "running", result: undefined };
    const page = await mountDashboard({ tasks: [running] });
    await page.click("Start voice");
    await page.waitFor(() => expect(page.button("Interrupt speech")).toBeDefined());
    await page.click("Interrupt speech");
    await page.waitFor(() => expect(page.requests.some((request) => request.type === "response.cancel")).toBe(true));
    expect(page.requests.some((request) => request.type === "task.stop")).toBe(false);
    await page.click("Stop task");
    await page.waitFor(() => expect(page.requests.find((request) => request.type === "task.stop")?.taskId).toBe(taskId));
    expect(page.document.querySelector("[data-voice-tasks]").open).toBe(false);
  });

  it("reconnects to the same native chat after ending voice", async () => {
    const page = await mountDashboard();
    await page.click("Start voice");
    await page.waitFor(() => expect(page.button("End voice")).toBeDefined());
    await page.click("End voice");
    await page.waitFor(() => expect(page.button("Start voice")).toBeDefined());
    await page.click("Start voice");
    await page.waitFor(() => expect(page.requests.filter((request) => request.type === "session.start")).toHaveLength(2));
    expect(page.requests.filter((request) => request.type === "session.start")[1].conversation)
      .toEqual({ mode: "resume", sessionId: "chat_1" });
  });

  it("detaches voice on native chat navigation before allowing reconnection", async () => {
    const page = await mountDashboard();
    await page.click("Start voice");
    await page.waitFor(() => expect(page.button("End voice")).toBeDefined());
    await page.navigate("/chat?resume=chat_2");
    await page.waitFor(() => expect(page.requests.some((request) => request.type === "session.close")).toBe(true));
    await page.waitFor(() => expect(page.button("Start voice")).toBeDefined());
    await page.click("Start voice");
    await page.waitFor(() => expect(page.requests.filter((request) => request.type === "session.start")).toHaveLength(2));
    expect(page.requests.filter((request) => request.type === "session.start")[1].conversation)
      .toEqual({ mode: "resume", sessionId: "chat_2" });
    await page.navigate("/sessions");
    await page.waitFor(() => expect(page.button("Start voice")?.disabled).toBe(true));
  });

  it("keeps another result read pending when one request fails", async () => {
    const second = { ...completedTask, taskId: "task_abcdef0123456789abcdef0123456789", rootTaskId: "task_abcdef0123456789abcdef0123456789", title: "Second audit" };
    const page = await mountDashboard({ tasks: [completedTask, second], deferResults: true });
    await page.click("Start voice");
    await page.waitFor(() => expect(page.document.querySelectorAll("[data-voice-result]")).toHaveLength(2));
    await act(async () => {
      for (const result of page.document.querySelectorAll("[data-voice-result]")) result.open = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await page.waitFor(() => expect(page.requests.filter((request) => request.type === "task.get")).toHaveLength(2));
    const read = page.requests.find((request) => request.type === "task.get" && request.taskId === taskId);
    await page.send({ type: "session.error", code: "task_read_failed", message: "Fixture read failed", recoverable: true, requestId: read.id });
    const secondCard = [...page.document.querySelectorAll("[data-voice-task]")].find((card) => card.textContent.includes("Second audit"));
    expect(secondCard.textContent).toContain("Loading result");
    expect(secondCard.querySelector("[data-voice-result] button").disabled).toBe(true);
  });

  it("requests full results once while a read is pending and lets a failed read be retried", async () => {
    const page = await mountDashboard({ tasks: [completedTask], deferResults: true });
    await page.click("Start voice");
    await page.waitFor(() => expect(page.document.querySelector("[data-voice-result]")).not.toBeNull());
    await page.openResult();
    await page.waitFor(() => expect(page.requests.filter((request) => request.type === "task.get")).toHaveLength(1));
    await page.openResult(false);
    await page.openResult();
    expect(page.requests.filter((request) => request.type === "task.get")).toHaveLength(1);
    const read = page.requests.find((request) => request.type === "task.get");
    await page.send({ type: "session.error", code: "task_read_failed", message: "Fixture read failed. Try again.", recoverable: true, requestId: read.id });
    await page.waitFor(() => expect(page.button("Load full result").disabled).toBe(false));
    await page.click("Load full result");
    await page.waitFor(() => expect(page.requests.filter((request) => request.type === "task.get")).toHaveLength(2));
    const retry = page.requests.filter((request) => request.type === "task.get")[1];
    const output = "Full output. ".repeat(1_500) + "END OF RETAINED RESULT";
    await page.send({ type: "task.snapshot", reason: "get", requestId: retry.id,
      tasks: [{ ...completedTask, result: { summary: "Audit summary", output, truncated: false } }], truncated: false });
    await page.waitFor(() => expect(page.document.querySelector("[data-voice-result] pre").textContent).toBe(output));
  });
});

async function mountDashboard({ tasks = [], chatId = "chat_1", deferResults = false } = {}) {
  const window = new Window({ url: "http://127.0.0.1:9119/chat" + (chatId ? "?resume=" + chatId : ""), settings: {
    disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true,
  } });
  for (const [name, value] of Object.entries({
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, WebSocket, IS_REACT_ACT_ENVIRONMENT: true,
  })) vi.stubGlobal(name, value);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const requests = [];
  let newChats = 0;
  let failNextConnection = false;
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    requests.push(request);
    const send = (value) => socket.send(JSON.stringify(value));
    if (request.type === "session.start") {
      if (failNextConnection) {
        failNextConnection = false;
        send({ type: "session.error", code: "fixture_startup_failed", requestId: request.id, message: "Fixture startup failed", recoverable: true });
        return;
      }
      const conversationId = request.conversation.mode === "resume" ? request.conversation.sessionId : `chat_${++newChats}`;
      send({ type: "session.ready", protocolVersion: 6, sessionId: `live_${requests.length}`, model: "fixture",
        hermes: { model: "fixture-hermes" },
        realtime: { provider: "mock", model: "fixture", audio: { input: { enabled: false }, output: { enabled: false }, turnDetection: "disabled" } },
        conversation: { mode: request.conversation.mode, sessionId: conversationId, title: `Chat ${conversationId}` },
        tasks: { scope: "owner", sequence: "per_task", reconnect: "snapshot", durable: true, parallel: false, maxConcurrent: 1, maxRetained: 200,
          supports: { list: true, get: true, stop: true, followUp: true, resume: false, notificationAck: true } },
      });
      send({ type: "task.snapshot", reason: "initial", tasks, truncated: false });
      send({ type: "transcript.delta", speaker: "assistant", text: `Reply for ${conversationId}`, final: true });
    } else if (request.type === "session.close") socket.close(1000, "detached");
    else if (request.type === "task.get" && !deferResults) send({ type: "task.snapshot", reason: "get", requestId: request.id, tasks: [], truncated: false });
  }));
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  let Component;
  window.__HERMES_PLUGINS__ = { register: () => {}, registerSlot: (_name, slot, page) => { expect(slot).toBe("chat:top"); Component = page; } };
  window.__HERMES_PLUGIN_SDK__ = {
    React, hooks: React,
    components: {
      Button: ({ outlined, size, ...props }) => React.createElement("button", props),
      Card: (props) => React.createElement("section", props),
      CardContent: (props) => React.createElement("div", props),
      Badge: ({ variant, ...props }) => React.createElement("span", props),
    },
    fetchJSON: async () => ({ configured: true, reachable: true, ready: true }),
    buildWsUrl: () => `ws://127.0.0.1:${server.address().port}/live`,
  };
  const script = window.document.createElement("script");
  script.setAttribute("data-hermes-plugin", "hermes-live");
  script.src = sourceUrl.href;
  window.document.head.appendChild(script);
  await import(sourceUrl.href + "?mount=" + ++mountSequence);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await window.happyDOM.abort();
  });
  await act(async () => root.render(React.createElement(Component)));
  const button = (label) => [...window.document.querySelectorAll("button")].find((item) => item.textContent === label);
  const waitFor = async (assertion) => vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assertion();
  });
  await waitFor(() => expect(button("Start voice")).toBeDefined());
  return {
    window, document: window.document, requests, button, waitFor,
    failNextConnection() { failNextConnection = true; },
    async navigate(path) { await act(async () => {
      window.history.pushState({}, "", path);
      await new Promise((resolve) => setTimeout(resolve, 280));
    }); },
    async click(label) { await act(async () => {
      button(label).click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }); },
    async openResult(open = true) { await act(async () => {
      const result = window.document.querySelector("[data-voice-result]");
      result.open = open;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }); },
    async send(message) { await act(async () => {
      for (const socket of server.clients) socket.send(JSON.stringify(message));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }); },
  };
}
