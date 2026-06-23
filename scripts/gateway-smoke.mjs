import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";

const prompt = "hello from gateway smoke";
const expectedOutput = "gateway smoke ok";
const runId = "run_gateway_smoke";
const observed = {
  capabilities: false,
  events: false,
  startRun: false,
  sessionKey: "",
  startRunBody: undefined,
  hermesError: undefined,
};

const hermesServer = createServer((req, res) => {
  void handleHermesRequest(req, res).catch((error) => {
    observed.hermesError = error instanceof Error ? error : new Error(String(error));
    writeJson(res, 500, { error: observed.hermesError.message });
  });
});

await listen(hermesServer, 0, "127.0.0.1");
const hermesPort = portOf(hermesServer);
const gatewayPort = await reservePort();
const gateway = spawn(process.execPath, ["dist/cli.js", "serve"], {
  env: {
    ...process.env,
    HERMES_BASE_URL: `http://127.0.0.1:${hermesPort}`,
    HERMES_MODEL: "hermes-agent",
    HERMES_API_KEY: "",
    HERMES_LIVE_ALLOW_ORIGIN: "",
    HERMES_LIVE_AUTH_TOKEN: "",
    HERMES_LIVE_DEMO_ENABLED: "false",
    HERMES_LIVE_HERMES_TIMEOUT_MS: "5000",
    HERMES_LIVE_HOST: "127.0.0.1",
    HERMES_LIVE_PORT: String(gatewayPort),
    HERMES_LIVE_PROVIDER: "mock",
    HERMES_LIVE_SESSION_PREFIX: "agent:main:hermes-live",
    HERMES_LIVE_LOG_LEVEL: "warn",
    NODE_ENV: "test",
    PORT: String(gatewayPort),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let gatewayExited = false;
gateway.stdout.on("data", (chunk) => {
  stdout = appendBounded(stdout, chunk.toString("utf8"));
});
gateway.stderr.on("data", (chunk) => {
  stderr = appendBounded(stderr, chunk.toString("utf8"));
});
const gatewayExit = once(gateway, "exit").then(([code, signal]) => {
  gatewayExited = true;
  return { code, signal };
});

try {
  await waitForHttpOk(`http://127.0.0.1:${gatewayPort}/ready`, 6_000);

  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/live`, {
    headers: { origin: `http://127.0.0.1:${gatewayPort}` },
  });
  const inbox = createInbox(socket);
  await waitForOpen(socket, 5_000);

  socket.send(JSON.stringify({ type: "session.start", profileId: "smoke", userLabel: "gateway-smoke" }));
  const ready = await inbox.next("session.ready");
  if (ready.model !== "mock-live") {
    throw new Error(`Gateway session advertised unexpected model: ${JSON.stringify(ready.model)}.`);
  }

  socket.send(JSON.stringify({ type: "text.input", text: prompt }));
  const started = await inbox.next("run.started");
  if (started.runId !== runId) {
    throw new Error(`Gateway emitted unexpected run id: ${JSON.stringify(started.runId)}.`);
  }
  const completed = await inbox.next("run.completed");
  if (completed.output !== expectedOutput) {
    throw new Error(`Gateway output mismatch. Expected ${JSON.stringify(expectedOutput)}, got ${JSON.stringify(completed.output)}.`);
  }

  socket.close(1000, "gateway smoke complete");
  await waitForSocketClose(socket, 2_000);

  if (!observed.capabilities) {
    throw new Error("Gateway did not call Hermes /v1/capabilities.");
  }
  if (!observed.startRun) {
    throw new Error("Gateway did not start a Hermes run.");
  }
  if (!observed.events) {
    throw new Error("Gateway did not consume Hermes run events.");
  }
  if (observed.hermesError) {
    throw observed.hermesError;
  }

  console.log("Gateway smoke ok");
} finally {
  await stopChild(gateway, gatewayExit, () => gatewayExited);
  await closeServer(hermesServer);
}

async function handleHermesRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/v1/capabilities") {
    observed.capabilities = true;
    writeJson(res, 200, {
      object: "hermes.capabilities",
      model: "hermes-agent",
      features: {
        run_submission: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/runs") {
    const body = await readJson(req);
    const sessionKey = String(req.headers["x-hermes-session-key"] ?? "");
    observed.startRun = true;
    observed.sessionKey = sessionKey;
    observed.startRunBody = body;

    if (!sessionKey.includes("agent:main:hermes-live:profile:smoke:user:gateway-smoke")) {
      throw new Error(`Unexpected Hermes session key: ${JSON.stringify(sessionKey)}.`);
    }
    if (body.model !== "hermes-agent") {
      throw new Error(`Unexpected Hermes model: ${JSON.stringify(body.model)}.`);
    }
    if (body.input !== prompt) {
      throw new Error(`Unexpected Hermes input: ${JSON.stringify(body.input)}.`);
    }
    if (typeof body.session_id !== "string" || !body.session_id.startsWith("live_")) {
      throw new Error(`Unexpected Hermes session_id: ${JSON.stringify(body.session_id)}.`);
    }

    writeJson(res, 200, { run_id: runId, status: "started" });
    return;
  }

  if (req.method === "GET" && url.pathname === `/v1/runs/${runId}/events`) {
    observed.events = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "close",
    });
    res.write('event: message.delta\ndata: {"delta":"gateway "}\n\n');
    res.write('event: message.delta\ndata: {"delta":"smoke ok"}\n\n');
    res.end('event: run.completed\ndata: {"usage":{"source":"gateway-smoke"}}\n\n');
    return;
  }

  if (req.method === "POST" && url.pathname === `/v1/runs/${runId}/stop`) {
    writeJson(res, 200, { run_id: runId, status: "stopping" });
    return;
  }

  writeJson(res, 404, { error: `Unhandled fake Hermes route: ${req.method} ${url.pathname}` });
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
  }
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function createInbox(socket) {
  const queued = [];
  let pending = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "session.error" || message.type === "run.failed") {
      const error = new Error(`Gateway emitted ${message.type}: ${message.message ?? message.error ?? JSON.stringify(message)}`);
      const waiters = pending;
      pending = [];
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      queued.push(message);
      return;
    }

    const index = pending.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) {
      const [waiter] = pending.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queued.push(message);
  });

  socket.on("close", (code, reason) => {
    const error = new Error(`Gateway WebSocket closed before expected message: ${code} ${reason.toString("utf8")}`);
    const waiters = pending;
    pending = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  socket.on("error", (error) => {
    const waiters = pending;
    pending = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  return {
    next(type, timeoutMs = 5_000) {
      const index = queued.findIndex((message) => message.type === type);
      if (index >= 0) {
        const [message] = queued.splice(index, 1);
        return Promise.resolve(message);
      }
      const terminal = queued.find((message) => message.type === "session.error" || message.type === "run.failed");
      if (terminal) {
        return Promise.reject(new Error(`Gateway emitted ${terminal.type}: ${terminal.message ?? terminal.error ?? JSON.stringify(terminal)}`));
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          reject,
          timer: setTimeout(() => {
            pending = pending.filter((candidate) => candidate !== waiter);
            reject(new Error(`Timed out waiting for gateway message ${type}. Queued: ${JSON.stringify(queued)}`));
          }, timeoutMs),
        };
        pending.push(waiter);
      });
    },
  };
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (gatewayExited) {
      const exit = await gatewayExit;
      throw new Error(`Gateway exited before readiness: ${exit.code ?? "null"} ${exit.signal ?? "null"}\n${stdout}\n${stderr}`);
    }
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}: ${body}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${String(lastError)}\n${stdout}\n${stderr}`);
}

async function waitForOpen(socket, timeoutMs) {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  await promiseWithTimeout(once(socket, "open"), timeoutMs, "Timed out waiting for gateway WebSocket open.");
}

async function waitForSocketClose(socket, timeoutMs) {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await promiseWithTimeout(once(socket, "close"), timeoutMs, "Timed out waiting for gateway WebSocket close.");
}

async function reservePort() {
  const server = createServer();
  await listen(server, 0, "127.0.0.1");
  const port = portOf(server);
  await closeServer(server);
  return port;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function portOf(server) {
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Server did not expose a TCP port.");
  }
  return address.port;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopChild(child, exitPromise, hasExited) {
  if (!hasExited()) {
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exitPromise.then(() => true),
      delay(2_000).then(() => false),
    ]);
    if (!stopped && !hasExited()) {
      child.kill("SIGKILL");
      await exitPromise.catch(() => undefined);
    }
  }
}

function appendBounded(current, next, max = 20_000) {
  const combined = current + next;
  return combined.length > max ? combined.slice(combined.length - max) : combined;
}

async function promiseWithTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
