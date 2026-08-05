import { connect } from "node:net";
import { HERMES_LIVE_SERVICE_ID } from "../service-identity.js";

const MAX_PROBE_BODY_BYTES = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

export type GatewayEndpointState = "available" | "hermes-live" | "occupied";

export interface GatewayEndpointProbeOptions {
  fetch?: typeof globalThis.fetch;
  tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  timeoutMs?: number;
}

export function gatewayOrigin(host: string, port: number): string {
  const rawHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const formattedHost = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  return `http://${formattedHost}:${port}`;
}

export async function probeGatewayEndpoint(
  host: string,
  port: number,
  options: GatewayEndpointProbeOptions = {},
): Promise<GatewayEndpointState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const origin = gatewayOrigin(host, port);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${origin}/health`, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readBoundedGatewayJson(response).catch(() => undefined);
    return response.ok
      && body?.status === "ok"
      && body.service === HERMES_LIVE_SERVICE_ID
      ? "hermes-live"
      : "occupied";
  } catch {
    const probeHost = new URL(origin).hostname.replace(/^\[|\]$/gu, "");
    const listening = await (options.tcpProbe ?? probeTcpEndpoint)(probeHost, port, timeoutMs)
      .catch(() => false);
    return listening ? "occupied" : "available";
  }
}

export async function probeGatewayReadiness(
  origin: string,
  options: {
    authToken?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${origin}/ready`, {
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const identity = await probeGatewayHealthIdentity(origin, options.fetch ?? globalThis.fetch, options.timeoutMs);
        if (identity === "other") {
          return { ok: false, error: "The configured port belongs to another service, not Hermes Live Voice." };
        }
      }
      return { ok: false, error: `Readiness returned HTTP ${response.status}.` };
    }
    const body = await readBoundedGatewayJson(response);
    if (body.service !== HERMES_LIVE_SERVICE_ID) {
      return { ok: false, error: "The configured port belongs to another service, not Hermes Live Voice." };
    }
    return body.status === "ready" || body.ok === true
      ? { ok: true }
      : { ok: false, error: "Gateway responded but reported that a dependency is not ready." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeGatewayHealthIdentity(
  origin: string,
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<"hermes-live" | "other" | "unknown"> {
  try {
    const response = await fetchImplementation(`${origin}/health`, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return "unknown";
    const body = await readBoundedGatewayJson(response);
    return body.service === HERMES_LIVE_SERVICE_ID ? "hermes-live" : "other";
  } catch {
    return "unknown";
  }
}

export async function readBoundedGatewayJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Gateway probe response is not JSON.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROBE_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Gateway probe response is too large.");
  }
  if (!response.body) throw new Error("Gateway probe response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROBE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Gateway probe response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gateway probe returned invalid JSON.");
  }
  return parsed as Record<string, unknown>;
}

async function probeTcpEndpoint(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(listening);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
