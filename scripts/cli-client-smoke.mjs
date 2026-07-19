import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";

const taskPrompt = "hello from cli";
const retainedResultPrompt = "hello retained result from cli";
const directPrompt = "hello direct from cli";
const audioOnlyPrompt = "hello audio only from cli";
const failedTaskPrompt = "hello failed task from cli";
const unknownTaskPrompt = "hello unknown task from cli";
const cleanClosePrompt = "hello clean close from cli";
const invalidOutputPrompt = "hello invalid output from cli";
const mismatchedGetPrompt = "hello mismatched get from cli";
const expectedTaskOutput = "cli ok";
const expectedRetainedOutput = "retained cli ok";
const expectedDirectOutput = "direct cli ok";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const stalledSockets = new Set();
const stalledHandshakeServer = createServer((socket) => {
  stalledSockets.add(socket);
  socket.once("close", () => stalledSockets.delete(socket));
});
const receivedPrompts = new Set();
const socketPrompts = new WeakMap();
let retainedResultFetched = false;

server.on("connection", (socket, request) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "session.start") {
      if (message.protocolVersion !== 4) {
        throw new Error(`CLI smoke expected protocol v4, received ${String(message.protocolVersion)}.`);
      }
      if (request.url === "/session-timeout") return;
      if (request.url === "/oversized-message") {
        socket.send(JSON.stringify({ type: "log", level: "info", message: "x".repeat(2_700_100) }));
        return;
      }
      if (request.url === "/invalid-ready") {
        socket.send(JSON.stringify({ type: "session.ready", protocolVersion: 4, sessionId: "live_cli_smoke" }));
        return;
      }
      if (request.url === "/wrong-version") {
        socket.send(JSON.stringify({ ...readyMessage(), protocolVersion: 2 }));
        return;
      }
      socket.send(JSON.stringify(readyMessage()));
      socket.send(JSON.stringify({
        type: "task.snapshot",
        reason: "initial",
        tasks: [{
          taskId: "task_existing",
          sequence: 8,
          state: "running",
          title: "Existing task",
          createdAt: 80,
          updatedAt: 88,
          startedAt: 81,
          progress: { message: "Already running before this one-shot request" },
        }],
        truncated: false,
      }));
      return;
    }
    if (message.type === "text.input") {
      receivedPrompts.add(message.text);
      socketPrompts.set(socket, message.text);
      if (message.text === directPrompt) {
        socket.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "direct " }));
        socket.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "cli ok" }));
        socket.send(JSON.stringify({ type: "response.completed" }));
        return;
      }
      if (message.text === audioOnlyPrompt) {
        socket.send(JSON.stringify({ type: "audio.output", data: "AAA=", mimeType: "audio/pcm;rate=24000" }));
        socket.send(JSON.stringify({ type: "response.completed" }));
        return;
      }
      if (message.text === cleanClosePrompt) {
        socket.close(1000, "clean close without terminal event");
        return;
      }
      if (message.text === invalidOutputPrompt) {
        socket.send(JSON.stringify(taskAccepted("task_invalid_output")));
        socket.send(JSON.stringify({
          type: "task.completed",
          taskId: "task_invalid_output",
          sequence: 2,
          occurredAt: 102,
          result: { summary: "invalid", output: 42, truncated: false },
        }));
        return;
      }
      if (message.text === failedTaskPrompt) {
        socket.send(JSON.stringify(taskAccepted("task_failed")));
        socket.send(JSON.stringify({
          type: "task.failed",
          taskId: "task_failed",
          sequence: 2,
          occurredAt: 102,
          error: { code: "test_failure", message: "simulated failure", recoverable: false },
        }));
        return;
      }
      if (message.text === unknownTaskPrompt) {
        socket.send(JSON.stringify(taskAccepted("task_unknown")));
        socket.send(JSON.stringify({
          type: "task.unknown",
          taskId: "task_unknown",
          sequence: 2,
          occurredAt: 102,
          error: { code: "state_unknown", message: "cannot prove outcome", recoverable: false },
        }));
        return;
      }
      if (message.text === retainedResultPrompt || message.text === mismatchedGetPrompt) {
        const taskId = message.text === retainedResultPrompt ? "task_retained" : "task_mismatch";
        socket.send(JSON.stringify(taskAccepted(taskId)));
        socket.send(JSON.stringify({
          type: "task.completed",
          taskId,
          sequence: 2,
          occurredAt: 102,
          result: { summary: "Result retained by the gateway", truncated: false },
        }));
        return;
      }
      if (message.text === taskPrompt) {
        socket.send(JSON.stringify({
          type: "task.accepted",
          taskId: "task_existing",
          sequence: 9,
          occurredAt: 99,
          state: "accepted",
          title: "Existing task",
        }));
      }
      socket.send(JSON.stringify(taskAccepted("task_cli_smoke")));
      socket.send(JSON.stringify({
        type: "task.started",
        taskId: "task_cli_smoke",
        sequence: 2,
        occurredAt: 102,
        title: "CLI smoke",
      }));
      socket.send(JSON.stringify({
        type: "task.completed",
        taskId: "task_cli_smoke",
        sequence: 3,
        occurredAt: 103,
        result: { summary: expectedTaskOutput, output: expectedTaskOutput, truncated: false },
      }));
      return;
    }
    if (message.type === "task.get") {
      const prompt = socketPrompts.get(socket);
      if (prompt === retainedResultPrompt) {
        retainedResultFetched = true;
        socket.send(JSON.stringify({
          type: "task.snapshot",
          reason: "get",
          requestId: message.id,
          tasks: [{
            taskId: "task_retained",
            sequence: 2,
            state: "completed",
            title: "Retained result",
            createdAt: 100,
            updatedAt: 102,
            finishedAt: 102,
            result: { summary: expectedRetainedOutput, output: expectedRetainedOutput, truncated: false },
          }],
          truncated: false,
        }));
      } else if (prompt === mismatchedGetPrompt) {
        socket.send(JSON.stringify({
          type: "task.snapshot",
          reason: "get",
          requestId: message.id,
          tasks: [{
            taskId: "task_wrong",
            sequence: 2,
            state: "completed",
            createdAt: 100,
            updatedAt: 102,
            result: { summary: "wrong", output: "wrong", truncated: false },
          }],
          truncated: false,
        }));
      }
    }
  });
});

await once(server, "listening");
stalledHandshakeServer.listen(0, "127.0.0.1");
await once(stalledHandshakeServer, "listening");

const address = server.address();
const port = typeof address === "object" && address ? address.port : undefined;
if (!port) throw new Error("CLI smoke gateway did not bind a port.");
const stalledAddress = stalledHandshakeServer.address();
const stalledPort = typeof stalledAddress === "object" && stalledAddress ? stalledAddress.port : undefined;
if (!stalledPort) throw new Error("CLI smoke stalled-handshake server did not bind a port.");

try {
  await runClient(port, taskPrompt, expectedTaskOutput, { httpOrigin: true });
  await runClient(port, retainedResultPrompt, expectedRetainedOutput);
  await runClient(port, directPrompt, expectedDirectOutput);
  await runClient(port, audioOnlyPrompt, "", {
    expectFailure: true,
    stderrIncludes: "Realtime provider completed without text output",
  });
  await runClient(port, failedTaskPrompt, "", {
    expectFailure: true,
    stderrIncludes: "Hermes task failed: simulated failure",
  });
  await runClient(port, unknownTaskPrompt, "", {
    expectFailure: true,
    stderrIncludes: "Hermes task outcome is unknown: cannot prove outcome",
  });
  await runClient(port, mismatchedGetPrompt, "", {
    expectFailure: true,
    stderrIncludes: "task.get snapshot did not match the accepted Hermes task",
  });
  await runClient(port, cleanClosePrompt, "", {
    expectFailure: true,
    stderrIncludes: "Gateway WebSocket closed before completing the request: 1000 clean close without terminal event",
  });
  await runClient(port, invalidOutputPrompt, "", {
    expectFailure: true,
    stderrIncludes: "task.completed did not match the bounded protocol-v4 schema",
  });
  await runClient(port, "invalid ready", "", {
    path: "/invalid-ready",
    expectFailure: true,
    stderrIncludes: "session.ready did not match the bounded protocol-v4 schema",
  });
  await runClient(port, "wrong version", "", {
    path: "/wrong-version",
    expectFailure: true,
    stderrIncludes: "Gateway protocol mismatch: expected v4, received 2",
  });
  await runClient(port, "session timeout", "", {
    path: "/session-timeout",
    readyTimeoutMs: 50,
    expectFailure: true,
    stderrIncludes: "Gateway did not complete the WebSocket/session.ready handshake within 50ms",
  });
  await runClient(port, "oversized message", "", {
    path: "/oversized-message",
    expectFailure: true,
    stderrIncludes: "Max payload size exceeded",
  });
  await runClient(stalledPort, "stalled handshake", "", {
    readyTimeoutMs: 50,
    expectFailure: true,
    stderrIncludesAny: [
      "Opening handshake has timed out",
      "Gateway did not complete the WebSocket/session.ready handshake within 50ms",
    ],
  });
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
  for (const socket of stalledSockets) socket.destroy();
  await new Promise((resolve, reject) =>
    stalledHandshakeServer.close((error) => (error ? reject(error) : resolve(undefined))),
  );
}

for (const expectedPrompt of [
  taskPrompt,
  retainedResultPrompt,
  directPrompt,
  audioOnlyPrompt,
  failedTaskPrompt,
  unknownTaskPrompt,
  mismatchedGetPrompt,
  cleanClosePrompt,
  invalidOutputPrompt,
]) {
  if (!receivedPrompts.has(expectedPrompt)) throw new Error(`CLI smoke gateway did not receive prompt: ${expectedPrompt}`);
}
if (!retainedResultFetched) throw new Error("One-shot CLI did not fetch a retained task result with task.get.");

function readyMessage() {
  return {
    type: "session.ready",
    protocolVersion: 4,
    sessionId: "live_cli_smoke",
    model: "mock-live",
    hermes: {},
    realtime: {
      provider: "mock",
      model: "mock-live",
      audio: { input: { enabled: false }, output: { enabled: false }, turnDetection: "none" },
    },
    tasks: {
      scope: "owner",
      sequence: "per_task",
      reconnect: "snapshot",
      durable: true,
      parallel: true,
      maxConcurrent: 3,
      maxRetained: 200,
      supports: { list: true, get: true, stop: true, followUp: true, resume: false, notificationAck: true },
    },
    conversation: { mode: "new", sessionId: "session_cli_smoke", title: "CLI smoke" },
  };
}

function taskAccepted(taskId) {
  return {
    type: "task.accepted",
    taskId,
    sequence: 1,
    occurredAt: 101,
    state: "accepted",
    title: "CLI smoke",
  };
}

async function runClient(port, prompt, expectedOutput, options = {}) {
  const child = spawn(process.execPath, ["dist/cli.js", "client", prompt], {
    env: {
      ...process.env,
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_CLIENT_RESULT_TIMEOUT_MS: String(options.resultTimeoutMs ?? 2_000),
      ...(options.readyTimeoutMs ? { HERMES_LIVE_CLIENT_READY_TIMEOUT_MS: String(options.readyTimeoutMs) } : {}),
      HERMES_LIVE_URL: options.httpOrigin
        ? `http://127.0.0.1:${port}`
        : `ws://127.0.0.1:${port}${options.path ?? "/v1/live"}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timeout);

  if (options.expectFailure) {
    if (code === 0 || signal) {
      throw new Error(`CLI smoke expected failure but got code ${code ?? "null"} signal ${signal ?? "null"}\n${stderr}`);
    }
    if (options.stderrIncludes && !stderr.includes(options.stderrIncludes)) {
      throw new Error(`CLI smoke stderr mismatch. Expected it to include ${JSON.stringify(options.stderrIncludes)}, got:\n${stderr}`);
    }
    if (options.stderrIncludesAny && !options.stderrIncludesAny.some((expected) => stderr.includes(expected))) {
      throw new Error(
        `CLI smoke stderr mismatch. Expected it to include one of ${JSON.stringify(options.stderrIncludesAny)}, got:\n${stderr}`,
      );
    }
    return;
  }
  if (code !== 0 || signal) {
    throw new Error(`CLI smoke failed with code ${code ?? "null"} signal ${signal ?? "null"}\n${stderr}`);
  }
  if (stdout.trim() !== expectedOutput) {
    throw new Error(`CLI smoke stdout mismatch. Expected ${JSON.stringify(expectedOutput)}, got ${JSON.stringify(stdout.trim())}.`);
  }
}
