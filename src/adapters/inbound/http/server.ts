import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { assertGatewayExposureConfig, assertHermesApiConfig, assertRealtimeProviderConfig, type AppConfig } from "../../../config.js";
import type { HermesRunsPort } from "../../../application/live-gateway/ports/hermes-runs.port.js";
import { LiveGatewaySession } from "../../../application/live-gateway/live-gateway-session.js";
import type { LiveModelAdapter } from "../../../application/live-gateway/ports/realtime-model.port.js";
import { HermesClient } from "../../outbound/hermes/hermes-runs.client.js";
import { createLiveModelAdapter } from "../../outbound/realtime/factory.js";
import type { Logger } from "../../../logger.js";
import { buildReadinessReport } from "../../../readiness.js";
import { serveStatic } from "./static.js";
import { WebSocketClientConnection } from "./websocket-client-connection.js";
import { errorToMessage } from "../../../domain/error-message.js";
import { HERMES_LIVE_PROTOCOL_VERSION } from "../../../domain/protocol/version.js";
import { realtimeClientCapabilities } from "../../../application/live-gateway/client-capabilities.js";

export interface StartServerOptions {
  config: AppConfig;
  logger: Logger;
  hermes?: HermesRunsPort;
  liveModel?: LiveModelAdapter;
}

export async function startServer({ config, logger, hermes: providedHermes, liveModel: providedLiveModel }: StartServerOptions): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  assertGatewayExposureConfig(config);
  if (!providedHermes) {
    assertHermesApiConfig(config);
  }
  if (!providedLiveModel) {
    assertRealtimeProviderConfig(config);
  }
  const hermes = providedHermes ?? new HermesClient(config.hermes);
  const liveModel = providedLiveModel ?? createLiveModelAdapter(config);
  const demoRoot = resolveDemoRoot();
  const browserClientRoot = resolveBrowserClientRoot();
  const sessions = new Set<LiveGatewaySession>();

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, {
        config,
        hermes,
        demoRoot,
        browserClientRoot,
        requireHermesApiKey: !providedHermes,
        requireRealtimeProviderConfig: !providedLiveModel,
      });
    } catch (error) {
      const message = errorToMessage(error);
      logger.error("http handler failed", { error: message });
      json(req, res, 500, { status: "error", error: "Internal server error." });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: clientWebSocketMaxPayload(config) });
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
    if (sessions.size >= config.server.maxSessions) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new LiveGatewaySession(new WebSocketClientConnection(ws), { config, hermes, liveModel, logger });
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
      const closing = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      server.closeIdleConnections();
      server.closeAllConnections();
      await closing;
    },
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    config: AppConfig;
    hermes: HermesRunsPort;
    demoRoot: string;
    browserClientRoot: string;
    requireHermesApiKey: boolean;
    requireRealtimeProviderConfig: boolean;
  },
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
    const report = await buildReadinessReport(options.config, {
      hermes: options.hermes,
      requireHermesApiKey: options.requireHermesApiKey,
      requireRealtimeProviderConfig: options.requireRealtimeProviderConfig,
    });
    json(req, res, report.ok ? 200 : 503, {
      status: report.ok ? "ready" : "not_ready",
      checks: {
        gateway: report.gateway,
        hermes: report.hermes,
        realtime: report.realtime,
      },
    });
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
      protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
      websocket: { path: "/v1/live", protocol: "json-base64-audio" },
      realtime: realtimeClientCapabilities(options.config),
      features: {
        auth_required: Boolean(options.config.server.authToken),
        server_managed_identity: !options.config.server.trustClientIdentity,
        run_event_detail: options.config.server.runEventDetail,
        max_sessions: options.config.server.maxSessions,
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
  if (
    options.config.server.demoEnabled &&
    (url.pathname === "/hermes-live-client.js" || url.pathname === "/mic-worklet.js") &&
    serveStatic(req, res, { root: options.browserClientRoot })
  ) {
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

  const originUrl = parseBrowserOrigin(origin);
  const requestHost = originUrl
    ? parseHttpHost(req.headers.host, originUrl.protocol === "https:" ? "https:" : "http:")
    : undefined;
  return (
    originUrl !== undefined &&
    requestHost !== undefined &&
    isLoopbackHostname(originUrl.hostname) &&
    isLoopbackHostname(requestHost.hostname) &&
    effectivePort(originUrl) === effectivePort(requestHost)
  );
}

function parseBrowserOrigin(origin: string): URL | undefined {
  if (origin !== origin.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== origin
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseHttpHost(host: string | undefined, protocol: "http:" | "https:"): URL | undefined {
  if (!host || host !== host.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(`${protocol}//${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

function effectivePort(url: URL): string | undefined {
  if (url.protocol === "http:") {
    return url.port || "80";
  }
  if (url.protocol === "https:") {
    return url.port || "443";
  }
  return undefined;
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
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
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

function clientWebSocketMaxPayload(config: AppConfig): number {
  const base64AudioBytes = Math.ceil((config.server.maxAudioBytes * 4) / 3);
  const textBytes = config.server.maxTextChars * 4;
  return Math.max(base64AudioBytes, textBytes) + 4096;
}

function resolveDemoRoot(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return join(current, "..", "..", "..", "..", "apps", "web-demo");
}

function resolveBrowserClientRoot(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return join(current, "..", "..", "..", "..", "clients", "browser");
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
