#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
let observedSessionUpdate = false;

server.on("connection", (socket) => {
  // Send session.created immediately on connection — this is how hf-realtime-voice works.
  socket.send(JSON.stringify({ type: "session.created" }));

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "session.update") {
      const session = message.session ?? {};
      // Assert required fields present
      if (!session.instructions) {
        throw new Error(`session.update missing instructions: ${JSON.stringify(message)}`);
      }
      if (!session.audio?.output?.voice) {
        throw new Error(`session.update missing audio.output.voice: ${JSON.stringify(message)}`);
      }
      if (!Array.isArray(session.tools) || session.tools.length === 0) {
        throw new Error(`session.update missing tools: ${JSON.stringify(message)}`);
      }
      if (!session.tool_choice) {
        throw new Error(`session.update missing tool_choice: ${JSON.stringify(message)}`);
      }
      // Assert fields that must be ABSENT for local provider
      if ("model" in session) {
        throw new Error(`session.update must not include model for local provider: ${JSON.stringify(message)}`);
      }
      if ("turn_detection" in session) {
        throw new Error(`session.update must not include turn_detection for local provider: ${JSON.stringify(message)}`);
      }
      if (session.audio?.input !== undefined) {
        throw new Error(`session.update must not include audio.input for local provider: ${JSON.stringify(message)}`);
      }
      observedSessionUpdate = true;
    }
  });
});

await once(server, "listening");
const address = server.address();
const port = typeof address === "object" && address ? address.port : undefined;
if (!port) {
  throw new Error("Fake local Realtime server did not bind a port.");
}

try {
  const child = spawn(process.execPath, ["dist/cli.js", "provider-smoke"], {
    env: {
      ...process.env,
      HERMES_LIVE_PROVIDER: "local",
      HERMES_LOCAL_REALTIME_BASE_URL: `ws://127.0.0.1:${port}/v1/realtime`,
      HERMES_LOCAL_REALTIME_VOICE: "Aiden",
      HERMES_LIVE_PROVIDER_SMOKE_TIMEOUT_MS: "5000",
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

  const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timeout);

  if (code !== 0 || signal) {
    throw new Error(`CLI provider smoke failed with code ${code ?? "null"} signal ${signal ?? "null"}\n${stdout}\n${stderr}`);
  }
  const report = JSON.parse(stdout);
  if (report.ok !== true || report.provider !== "local" || report.model !== "hf-realtime-voice" || report.connected !== true) {
    throw new Error(`CLI provider smoke returned an invalid report:\n${stdout}`);
  }
  if (!observedSessionUpdate) {
    throw new Error("CLI provider smoke did not send session.update.");
  }

  console.log("CLI provider smoke ok");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
}
