#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
let observedSessionUpdate;
let observedAuthorization = "";
let observedSafetyIdentifier = "";
let observedModel = "";

server.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "ws://127.0.0.1");
  observedAuthorization = String(request.headers.authorization ?? "");
  observedSafetyIdentifier = String(request.headers["openai-safety-identifier"] ?? "");
  observedModel = url.searchParams.get("model") ?? "";
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "session.update") {
      observedSessionUpdate = message;
      socket.send(JSON.stringify({ type: "session.updated", session: { type: "realtime", model: observedModel } }));
    }
  });
});

await once(server, "listening");
const address = server.address();
const port = typeof address === "object" && address ? address.port : undefined;
if (!port) {
  throw new Error("Fake OpenAI Realtime server did not bind a port.");
}

try {
  const child = spawn(process.execPath, ["dist/cli.js", "provider-smoke"], {
    env: {
      ...process.env,
      HERMES_LIVE_PROVIDER: "openai",
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_REALTIME_BASE_URL: `ws://127.0.0.1:${port}/v1/realtime`,
      OPENAI_REALTIME_MODEL: "gpt-realtime-2",
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
  if (report.ok !== true || report.provider !== "openai" || report.model !== "gpt-realtime-2" || report.connected !== true) {
    throw new Error(`CLI provider smoke returned an invalid report:\n${stdout}`);
  }
  if (!observedSessionUpdate) {
    throw new Error("CLI provider smoke did not send session.update.");
  }
  const inputFormat = observedSessionUpdate.session?.audio?.input?.format;
  const outputFormat = observedSessionUpdate.session?.audio?.output?.format;
  if (
    inputFormat?.type !== "audio/pcm"
    || inputFormat?.rate !== 24_000
    || outputFormat?.type !== "audio/pcm"
    || outputFormat?.rate !== 24_000
  ) {
    throw new Error("CLI provider smoke sent an invalid OpenAI PCM session format.");
  }
  if (observedAuthorization !== "Bearer test-openai-key") {
    throw new Error(`Unexpected authorization header: ${JSON.stringify(observedAuthorization)}.`);
  }
  if (observedModel !== "gpt-realtime-2") {
    throw new Error(`Unexpected OpenAI model query: ${JSON.stringify(observedModel)}.`);
  }
  if (!/^[a-f0-9]{64}$/.test(observedSafetyIdentifier)) {
    throw new Error(`OpenAI safety identifier was not a hashed value: ${JSON.stringify(observedSafetyIdentifier)}.`);
  }

  console.log("CLI provider smoke ok");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
}
