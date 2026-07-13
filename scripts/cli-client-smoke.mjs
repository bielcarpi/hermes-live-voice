import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const hermesPrompt = "hello from cli";
const directPrompt = "hello direct from cli";
const audioOnlyPrompt = "hello audio only from cli";
const cleanClosePrompt = "hello clean close from cli";
const expectedHermesOutput = "cli ok";
const expectedDirectOutput = "direct cli ok";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const receivedPrompts = new Set();

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "session.start") {
      socket.send(JSON.stringify({ type: "session.ready", sessionId: "live_cli_smoke", model: "mock-live", hermes: {} }));
      return;
    }
    if (message.type === "text.input") {
      receivedPrompts.add(message.text);
      if (message.text === directPrompt) {
        socket.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "direct " }));
        socket.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "cli ok" }));
        socket.send(JSON.stringify({ type: "realtime.message", message: { type: "response.done" } }));
        return;
      }
      if (message.text === audioOnlyPrompt) {
        socket.send(JSON.stringify({ type: "realtime.message", message: { type: "response.done" } }));
        return;
      }
      if (message.text === cleanClosePrompt) {
        socket.close(1000, "clean close without terminal event");
        return;
      }
      socket.send(JSON.stringify({ type: "run.started", runId: "run_cli_smoke", sessionId: "live_cli_smoke" }));
      socket.send(JSON.stringify({ type: "run.completed", runId: "run_cli_smoke", output: expectedHermesOutput }));
    }
  });
});

await once(server, "listening");

const address = server.address();
const port = typeof address === "object" && address ? address.port : undefined;
if (!port) {
  throw new Error("CLI smoke gateway did not bind a port.");
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
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
}

for (const expectedPrompt of [hermesPrompt, directPrompt, audioOnlyPrompt, cleanClosePrompt]) {
  if (!receivedPrompts.has(expectedPrompt)) {
    throw new Error(`CLI smoke gateway did not receive prompt: ${expectedPrompt}`);
  }
}

async function runClient(port, prompt, expectedOutput, options = {}) {
  const child = spawn(process.execPath, ["dist/cli.js", "client", prompt], {
    env: {
      ...process.env,
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_URL: options.httpOrigin
        ? `http://127.0.0.1:${port}`
        : `ws://127.0.0.1:${port}/v1/live`,
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
    return;
  }
  if (code !== 0 || signal) {
    throw new Error(`CLI smoke failed with code ${code ?? "null"} signal ${signal ?? "null"}\n${stderr}`);
  }
  if (stdout.trim() !== expectedOutput) {
    throw new Error(`CLI smoke stdout mismatch. Expected ${JSON.stringify(expectedOutput)}, got ${JSON.stringify(stdout.trim())}.`);
  }
}
