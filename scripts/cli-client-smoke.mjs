import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const prompt = "hello from cli";
const expectedOutput = "cli ok";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
let receivedPrompt = false;

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "session.start") {
      socket.send(JSON.stringify({ type: "session.ready", sessionId: "live_cli_smoke", model: "mock-live", hermes: {} }));
      return;
    }
    if (message.type === "text.input") {
      receivedPrompt = message.text === prompt;
      socket.send(JSON.stringify({ type: "run.started", runId: "run_cli_smoke", sessionId: "live_cli_smoke" }));
      socket.send(JSON.stringify({ type: "run.completed", runId: "run_cli_smoke", output: expectedOutput }));
    }
  });
});

await once(server, "listening");

const address = server.address();
const port = typeof address === "object" && address ? address.port : undefined;
if (!port) {
  throw new Error("CLI smoke gateway did not bind a port.");
}

const child = spawn(process.execPath, ["dist/cli.js", "client", prompt], {
  env: {
    ...process.env,
    HERMES_LIVE_PROVIDER: "mock",
    HERMES_LIVE_URL: `ws://127.0.0.1:${port}/v1/live`,
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
await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));

if (code !== 0 || signal) {
  throw new Error(`CLI smoke failed with code ${code ?? "null"} signal ${signal ?? "null"}\n${stderr}`);
}
if (!receivedPrompt) {
  throw new Error("CLI smoke gateway did not receive the expected text.input prompt.");
}
if (stdout.trim() !== expectedOutput) {
  throw new Error(`CLI smoke stdout mismatch. Expected ${JSON.stringify(expectedOutput)}, got ${JSON.stringify(stdout.trim())}.`);
}
