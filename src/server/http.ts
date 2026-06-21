import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { realtimeProviderConfigured, type AppConfig } from "../config.js";
import { HermesClient } from "../hermes/client.js";
import type { Logger } from "../logger.js";
import { createLiveModelAdapter } from "../realtime/factory.js";
import type { LiveModelAdapter } from "../realtime/live.js";
import { LiveGatewaySession } from "../session/live-session.js";
import { serveStatic } from "./static.js";

export interface StartServerOptions {
  config: AppConfig;
  logger: Logger;
  hermes?: HermesClient;
  liveModel?: LiveModelAdapter;
}

export async function startServer({ config, logger, hermes: providedHermes, liveModel: providedLiveModel }: StartServerOptions): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const hermes = providedHermes ?? new HermesClient(config.hermes);
  const liveModel = providedLiveModel ?? createLiveModelAdapter(config);
  const demoRoot = resolveDemoRoot();
  const sessions = new Set<LiveGatewaySession>();

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, { config, hermes, demoRoot });
    } catch (error) {
      logger.error("http handler failed", { error: String(error) });
      json(req, res, 500, { status: "error", error: String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/v1/live") {
      socket.destroy();
      return;
    }
    if (!isWebSocketOriginAllowed(req, config)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isAuthorized(req, config, url, { allowQueryToken: true })) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new LiveGatewaySession(ws, { config, hermes, liveModel, logger });
      sessions.add(session);
      ws.once("close", () => sessions.delete(session));
      session.bind();
      wss.emit("connection", ws, req);
    });
  });

  try {
    await listenHttpServer(server, config.server.port, config.server.host);
  } catch (error) {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    throw error;
  }
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.server.port;
  const url = `http://${config.server.host}:${port}`;
  logger.info("hermes-live listening", { url });

  return {
    url,
    close: async () => {
      await Promise.allSettled(Array.from(sessions, (session) => session.close()));
      for (const client of wss.clients) {
        client.close(1001, "server shutdown");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: { config: AppConfig; hermes: HermesClient; demoRoot: string },
): Promise<void> {
  addCors(req, res, options.config);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    json(req, res, 200, { status: "ok", service: "hermes-live" });
    return;
  }
  if (requiresHttpAuth(url.pathname) && !isAuthorized(req, options.config, url, { allowQueryToken: false })) {
    json(req, res, 401, { status: "unauthorized" });
    return;
  }
  if (url.pathname === "/ready") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    const checks: Record<string, unknown> = {};
    let ready = true;
    try {
      checks.hermes = await options.hermes.assertRunsSupported();
    } catch (error) {
      ready = false;
      checks.hermes = { ok: false, error: String(error) };
    }
    const realtimeOk = realtimeProviderConfigured(options.config);
    if (!realtimeOk) {
      ready = false;
    }
    checks.realtime = {
      ok: realtimeOk,
      provider: options.config.realtime.provider,
      model: options.config.realtime.model,
      ...(options.config.realtime.provider === "gemini" ? { enterprise: options.config.gemini.enterprise } : {}),
      ...(options.config.realtime.provider === "openai" ? { baseUrl: options.config.openai.baseUrl } : {}),
    };
    json(req, res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", checks });
    return;
  }
  if (url.pathname === "/v1/capabilities") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    json(req, res, 200, {
      object: "hermes_live.capabilities",
      service: "hermes-live",
      websocket: { path: "/v1/live", protocol: "json-base64-audio" },
      features: {
        auth_required: Boolean(options.config.server.authToken),
        gemini_live: options.config.realtime.provider === "gemini",
        openai_realtime: options.config.realtime.provider === "openai",
        mock_live: options.config.realtime.provider === "mock",
        hermes_runs: true,
        hermes_run_events: true,
        hermes_stop: true,
        hermes_approval: true,
        browser_demo: options.config.server.demoEnabled,
        optional_hermes_plugin: true,
      },
    });
    return;
  }
  if (options.config.server.demoEnabled && serveStatic(req, res, { root: options.demoRoot })) {
    return;
  }
  json(req, res, 404, { status: "not_found" });
}

function isAuthorized(req: IncomingMessage, config: AppConfig, url: URL, options: { allowQueryToken: boolean }): boolean {
  if (!config.server.authToken) {
    return true;
  }
  const bearer = bearerToken(req.headers.authorization);
  const queryToken = options.allowQueryToken ? url.searchParams.get("token") : undefined;
  return secureTokenEqual(bearer, config.server.authToken) || secureTokenEqual(queryToken, config.server.authToken);
}

function requiresHttpAuth(pathname: string): boolean {
  return pathname === "/ready" || pathname === "/v1/capabilities";
}

function isWebSocketOriginAllowed(req: IncomingMessage, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (config.server.allowOrigin === "*") {
    return true;
  }
  if (config.server.allowOrigin) {
    return origin === config.server.allowOrigin;
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function addCors(req: IncomingMessage, res: ServerResponse, config: AppConfig): void {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }
  if (config.server.allowOrigin === "*" || config.server.allowOrigin === origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  }
}

function isGetOrHead(req: IncomingMessage): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string): void {
  json(req, res, 405, { status: "method_not_allowed", allow }, { allow });
}

function json(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(payload);
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const [scheme, ...rest] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) {
    return undefined;
  }
  return rest[0];
}

function secureTokenEqual(actual: string | null | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function resolveDemoRoot(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return join(current, "..", "..", "apps", "web-demo");
}

function listenHttpServer(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`Failed to start hermes-live on ${host}:${port}: ${error.message}`));
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
