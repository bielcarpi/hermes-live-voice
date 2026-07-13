import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";

const hermesPrompt = "hello from cli";
const directPrompt = "hello direct from cli";
const audioOnlyPrompt = "hello audio only from cli";
const cleanClosePrompt = "hello clean close from cli";
const invalidOutputPrompt = "hello invalid output from cli";
const expectedHermesOutput = "cli ok";
const expectedDirectOutput = "direct cli ok";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const stalledSockets = new Set();
const stalledHandshakeServer = createServer((socket) => {
  stalledSockets.add(socket);
  socket.once("close", () => stalledSockets.delete(socket));
});
const receivedPrompts = new Set();

server.on("connection", (socket, request) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "session.start") {
      if (request.url === "/session-timeout") return;
      if (request.url === "/oversized-message") {
        socket.send(JSON.stringify({ type: "log", message: "x".repeat(2_700_100) }));
        return;
      }
      if (request.url === "/invalid-ready") {
        socket.send(JSON.stringify({ type: "session.ready", sessionId: "live_cli_smoke", model: "mock-live" }));
        return;
      }
      socket.send(JSON.stringify({
        type: "session.ready",
        protocolVersion: 2,
        sessionId: "live_cli_smoke",
        model: "mock-live",
        hermes: {},
      }));
      return;
    }
    if (message.type === "text.input") {
      receivedPrompts.add(message.text);
      if (message.text === directPrompt) {
        socket.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "direct " }));
        socket.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "cli ok" }));
        socket.send(JSON.stringify({ type: "response.completed" }));
        return;
      }
      if (message.text === audioOnlyPrompt) {
        socket.send(JSON.stringify({ type: "response.completed" }));
        return;
      }
      if (message.text === cleanClosePrompt) {
        socket.close(1000, "clean close without terminal event");
        return;
      }
      if (message.text === invalidOutputPrompt) {
        socket.send(JSON.stringify({ type: "run.started", runId: "run_cli_smoke", sessionId: "live_cli_smoke" }));
        socket.send(JSON.stringify({ type: "run.completed", runId: "run_cli_smoke", output: 42 }));
        return;
      }
      socket.send(JSON.stringify({ type: "run.started", runId: "run_cli_smoke", sessionId: "live_cli_smoke" }));
      socket.send(JSON.stringify({ type: "run.completed", runId: "run_cli_smoke", output: expectedHermesOutput }));
    }
  });
});

await once(server, "listening");
stalledHandshakeServer.listen(0, "127.0.0.1");
await once(stalledHandshakeServer, "listening");

const address = server.address();
const port = typeof address === "object" && address ? address.port : undefined;
if (!port) {
  throw new Error("CLI smoke gateway did not bind a port.");
}
const stalledAddress = stalledHandshakeServer.address();
const stalledPort = typeof stalledAddress === "object" && stalledAddress ? stalledAddress.port : undefined;
if (!stalledPort) {
  throw new Error("CLI smoke stalled-handshake server did not bind a port.");
}

try {
  await runClient(port, hermesPrompt, expectedHermesOutput, { httpOrigin: true });
  await runClient(port, directPrompt, expectedDirectOutput);
  await runClient(port, audioOnlyPrompt, "", {
    expectFailure: true,
    stderrIncludes: "Realtime provider completed without text output",
  });
  await runClient(port, cleanClosePrompt, "", {
    expectFailure: true,
    stderrIncludes: "Gateway WebSocket closed before completing the request: 1000 clean close without terminal event",
  });
  await runClient(port, invalidOutputPrompt, "", {
    expectFailure: true,
    stderrIncludes: "Gateway run.completed output must be a bounded string",
  });
  await runClient(port, "invalid ready", "", {
    path: "/invalid-ready",
    expectFailure: true,
    stderrIncludes: "Gateway session.ready protocolVersion must be an integer",
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

for (const expectedPrompt of [hermesPrompt, directPrompt, audioOnlyPrompt, cleanClosePrompt, invalidOutputPrompt]) {
  if (!receivedPrompts.has(expectedPrompt)) {
    throw new Error(`CLI smoke gateway did not receive prompt: ${expectedPrompt}`);
  }
}

async function runClient(port, prompt, expectedOutput, options = {}) {
  const child = spawn(process.execPath, ["dist/cli.js", "client", prompt], {
    env: {
      ...process.env,
      HERMES_LIVE_PROVIDER: "mock",
      ...(options.readyTimeoutMs ? { HERMES_LIVE_CLIENT_READY_TIMEOUT_MS: String(options.readyTimeoutMs) } : {}),
      HERMES_LIVE_URL: options.httpOrigin
        ? `http://127.0.0.1:${port}`
        : `ws://127.0.0.1:${port}${options.path ?? "/v1/live"}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 5_000);

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
