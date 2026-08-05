import { describe, expect, it, vi } from "vitest";
import {
  gatewayOrigin,
  probeGatewayEndpoint,
  probeGatewayReadiness,
  readBoundedGatewayJson,
} from "../src/cli/gateway-probe.js";

describe("gateway probes", () => {
  it("uses a connectable loopback origin for wildcard listeners", () => {
    expect(gatewayOrigin("0.0.0.0", 8788)).toBe("http://127.0.0.1:8788");
    expect(gatewayOrigin("::", 8788)).toBe("http://[::1]:8788");
  });

  it("distinguishes Hermes Live from another HTTP service", async () => {
    const own = await probeGatewayEndpoint("127.0.0.1", 8788, {
      fetch: async () => jsonResponse({ status: "ok", service: "hermes-live" }),
    });
    const other = await probeGatewayEndpoint("127.0.0.1", 8788, {
      fetch: async () => jsonResponse({ status: "ok", service: "codex-live-voice" }),
    });
    expect(own).toBe("hermes-live");
    expect(other).toBe("occupied");
  });

  it("uses a TCP fallback when the listener is not HTTP", async () => {
    const tcpProbe = vi.fn(async () => true);
    const result = await probeGatewayEndpoint("127.0.0.1", 8788, {
      fetch: async () => { throw new Error("invalid HTTP response"); },
      tcpProbe,
    });
    expect(result).toBe("occupied");
    expect(tcpProbe).toHaveBeenCalledWith("127.0.0.1", 8788, 1_000);
  });

  it("treats a refused HTTP and TCP connection as available", async () => {
    await expect(probeGatewayEndpoint("127.0.0.1", 8788, {
      fetch: async () => { throw new Error("refused"); },
      tcpProbe: async () => false,
    })).resolves.toBe("available");
  });

  it("requires readiness to identify Hermes Live", async () => {
    await expect(probeGatewayReadiness("http://127.0.0.1:8788", {
      fetch: async () => jsonResponse({ status: "ready", service: "codex-live-voice" }),
    })).resolves.toEqual({
      ok: false,
      error: "The configured port belongs to another service, not Hermes Live Voice.",
    });
    await expect(probeGatewayReadiness("http://127.0.0.1:8788", {
      authToken: "secret",
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        return jsonResponse({ status: "ready", service: "hermes-live" });
      },
    })).resolves.toEqual({ ok: true });
  });

  it("uses public health to diagnose an auth response from the wrong service", async () => {
    await expect(probeGatewayReadiness("http://127.0.0.1:8788", {
      fetch: async (url) => String(url).endsWith("/health")
        ? jsonResponse({ status: "ok", service: "codex-live-voice" })
        : jsonResponse({ status: "unauthorized" }, 401),
    })).resolves.toEqual({
      ok: false,
      error: "The configured port belongs to another service, not Hermes Live Voice.",
    });
  });

  it("bounds gateway response bodies", async () => {
    const response = new Response("x".repeat(64 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    });
    await expect(readBoundedGatewayJson(response)).rejects.toThrow(/too large/u);
  });

  it("rejects mislabeled probe bodies before parsing them", async () => {
    const response = new Response('{"status":"ok","service":"hermes-live"}', {
      headers: { "content-type": "text/html" },
    });
    await expect(readBoundedGatewayJson(response)).rejects.toThrow(/not JSON/u);
  });
});

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
