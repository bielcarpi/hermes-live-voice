import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HermesClient,
  MAX_HERMES_JSON_RESPONSE_BYTES,
} from "../src/adapters/outbound/hermes/hermes-runs.client.js";

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe("HermesClient", () => {
  it("rejects an unbounded idle watchdog in manually constructed clients", () => {
    expect(() => hermesClient({ streamIdleTimeoutMs: 0 })).toThrow(
      "Hermes event-stream idle timeout must be a positive timer-safe integer.",
    );
  });

  it("sends runs with the Hermes session key header when authenticated", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run_id: "run_123", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(
      client.startRun({
        input: "check the repo",
        sessionId: "live_1",
        sessionKey: "agent:main:hermes-live:profile:default:user:alice",
        instructions: "be brief",
      }),
    ).resolves.toEqual({ runId: "run_123", status: "queued" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/v1/runs",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer hermes-secret",
          "X-Hermes-Session-Key": "agent:main:hermes-live:profile:default:user:alice",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "hermes-agent",
      input: "check the repo",
      session_id: "live_1",
      instructions: "be brief",
    });
  });

  it.each([
    ["missing ids", { status: "queued" }],
    ["an unsafe snake-case id", { run_id: "run\nother", status: "queued" }],
    ["an unsafe camel-case alias", { run_id: "run_123", runId: "run\nother", status: "queued" }],
    ["conflicting aliases", { run_id: "run_123", runId: "run_other", status: "queued" }],
  ])("rejects start responses with %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.startRun({
      input: "check the repo",
      sessionId: "live_1",
      sessionKey: "agent:main:hermes-live:profile:default:user:alice",
    })).rejects.toThrow(/run|identifier/i);
  });

  it("omits the Hermes session key header when the Hermes client is unauthenticated", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run_id: "run_123", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient({ apiKey: undefined });

    await expect(
      client.startRun({
        input: "check the repo",
        sessionId: "live_1",
        sessionKey: "agent:main:hermes-live:profile:default:user:alice",
      }),
    ).resolves.toEqual({ runId: "run_123", status: "queued" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/v1/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({
          authorization: expect.any(String),
          "X-Hermes-Session-Key": expect.any(String),
        }),
      }),
    );
  });

  it("sends the Hermes session key header on run-scoped follow-up requests", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ run_id: "run_123", status: "running" }))
      .mockResolvedValueOnce(jsonResponse({ run_id: "run_123", status: "stopping" }))
      .mockResolvedValueOnce(jsonResponse({
        run_id: "run_123",
        approval_id: "approval_1",
        choice: "once",
        resolved: 1,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();
    const sessionKey = "agent:main:hermes-live:profile:default:user:alice";

    await client.getRun("run_123", { sessionKey });
    await client.stopRun("run_123", { sessionKey });
    await client.submitApproval("run_123", "once", { sessionKey, approvalId: "approval_1" });

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer hermes-secret",
            "X-Hermes-Session-Key": sessionKey,
          }),
        }),
      );
    }
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      choice: "once",
      resolve_all: false,
      approval_id: "approval_1",
    });
  });

  it.each([
    ["an empty object", {}],
    ["a missing run id", { status: "stopping" }],
    ["a missing status", { run_id: "run_123" }],
    ["another run id", { run_id: "run_other", status: "stopping" }],
    ["a running status", { run_id: "run_123", status: "running" }],
    ["an unknown status", { run_id: "run_123", status: "stopped" }],
    ["a conflicting camel-case alias", { run_id: "run_123", runId: "run_other", status: "stopping" }],
  ])("rejects stop responses with %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.stopRun("run_123")).rejects.toThrow("invalid stop confirmation");
  });

  it("treats even an exact approval-not-pending 409 as indeterminate", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: "approval_not_pending", message: "No approval is pending." },
    }), { status: 409, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.submitApproval("run_123", "deny", { resolveAll: true })).rejects.toThrow(
      "Hermes request failed: 409",
    );
  });

  it.each([
    ["a different structured code", JSON.stringify({ error: { code: "approval_not_active" } })],
    ["a top-level code", JSON.stringify({ code: "approval_not_pending" })],
    ["plain text containing the code", "approval_not_pending"],
  ])("rejects legacy approval 409 with %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.submitApproval("run_123", "deny", { resolveAll: true })).rejects.toThrow(
      "Hermes request failed: 409",
    );
  });

  it("also rejects approval-not-pending conflicts for targeted and positive requests", async () => {
    const errorBody = JSON.stringify({ error: { code: "approval_not_pending" } });
    fetchMock
      .mockResolvedValueOnce(new Response(errorBody, { status: 409 }))
      .mockResolvedValueOnce(new Response(errorBody, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.submitApproval("run_123", "deny", {
      resolveAll: true,
      approvalId: "approval_1",
    })).rejects.toThrow("Hermes request failed: 409");
    await expect(client.submitApproval("run_123", "once", { resolveAll: true })).rejects.toThrow(
      "Hermes request failed: 409",
    );
  });

  it("keeps AbortSignal shorthand support for run-scoped follow-up requests", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run_id: "run_123", status: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();
    const controller = new AbortController();

    await client.getRun("run_123", controller.signal);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8642/v1/runs/run_123");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects Hermes capabilities without required run features", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ features: { run_submission: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.assertRunsSupported()).rejects.toThrow(/run_events_sse, run_stop, run_approval_response/);
  });

  it("does not expose Hermes response bodies in request failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      "Authorization: Bearer hermes-secret; X-Hermes-Session-Key: private-scope",
      { status: 401 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("Hermes request failed: 401 /v1/capabilities"));
    expect(String(error)).not.toContain("hermes-secret");
    expect(String(error)).not.toContain("private-scope");
  });

  it("times out stalled JSON requests", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient({ timeoutMs: 25 });
    const result = expect(client.capabilities()).rejects.toThrow("Hermes request timed out after 25ms: /v1/capabilities");

    await vi.advanceTimersByTimeAsync(25);

    await result;
  });

  it("cancels Hermes JSON bodies that exceed the response safety limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_HERMES_JSON_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.getRun("run_oversized")).rejects.toThrow(
      `Hermes response exceeded the ${MAX_HERMES_JSON_RESPONSE_BYTES}-byte safety limit.`,
    );
    expect(cancelled).toBe(true);
  });

  it("streams run events through SSE with the Hermes session key header", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"event":"message.delta","delta":"hi"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"event":"run.completed","output":"done"}\n\n'));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();
    const sessionKey = "agent:main:hermes-live:profile:default:user:alice";

    const events = [];
    for await (const event of client.streamRunEvents("run_123", { sessionKey })) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: "message.delta", delta: "hi" },
      { event: "run.completed", output: "done" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/v1/runs/run_123/events",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({
          accept: "text/event-stream",
          authorization: "Bearer hermes-secret",
          "X-Hermes-Session-Key": sessionKey,
        }),
      }),
    );
  });

  it("keeps the request timeout on run-event response headers", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient({ timeoutMs: 25 });
    const result = expect(collectEvents(client.streamRunEvents("run_headers"))).rejects.toThrow(
      "Hermes events request timed out after 25ms: /v1/runs/{run_id}/events",
    );

    await vi.advanceTimersByTimeAsync(25);

    await result;
  });

  it("does not expose Hermes event-stream response bodies in request failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      "reflected bearer hermes-secret and private-session-scope",
      { status: 502 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const error = await collectEvents(
      client.streamRunEvents("hermes-secret-private-session-scope", { sessionKey: "private-session-scope" }),
    ).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("Hermes events request failed: 502 /v1/runs/{run_id}/events"));
    expect(String(error)).not.toContain("hermes-secret");
    expect(String(error)).not.toContain("private-session-scope");
  });

  it("never follows Hermes JSON or SSE redirects with private request data", async () => {
    let redirectedRequests = 0;
    const target = createServer((request, response) => {
      redirectedRequests += 1;
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"event":"run.completed","output":"redirected"}\n\n');
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"run_id":"run_redirected","status":"started"}');
      }
    });
    const targetUrl = await listenOnLoopback(target);
    const source = createServer((_request, response) => {
      response.writeHead(307, { location: `${targetUrl}/credential-capture` });
      response.end();
    });
    const sourceUrl = await listenOnLoopback(source);

    try {
      const client = hermesClient({ baseUrl: sourceUrl });
      await expect(client.startRun({
        input: "private redirected prompt",
        sessionId: "live_redirect",
        sessionKey: "private-session-scope",
      })).rejects.toThrow();
      await expect(
        collectEvents(client.streamRunEvents("run_private", { sessionKey: "private-session-scope" })),
      ).rejects.toThrow();
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([closeServer(source), closeServer(target)]);
    }
  });

  it("does not apply the request timeout to an established run event stream", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('data: {"event":"message.delta","delta":"late"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"event":"run.completed","output":"done"}\n\n'));
          controller.close();
        }, 50);
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient({ timeoutMs: 10 });
    const eventsPromise = collectEvents(client.streamRunEvents("run_123"));

    await vi.advanceTimersByTimeAsync(50);

    await expect(eventsPromise).resolves.toEqual([
      { event: "message.delta", delta: "late" },
      { event: "run.completed", output: "done" },
    ]);
  });

  it("times out and cancels an established run event stream after configured inactivity", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient({ streamIdleTimeoutMs: 25 });
    const result = expect(collectEvents(client.streamRunEvents("run_stalled"))).rejects.toThrow(
      "Hermes events stream was idle for 25ms: /v1/runs/{run_id}/events",
    );

    await vi.advanceTimersByTimeAsync(25);

    await result;
    expect(cancelled).toBe(true);
  });

  it("keeps the stream watchdog for legacy manual client configs that omit the new option", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>();
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HermesClient({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-secret",
      model: "hermes-agent",
      timeoutMs: 30_000,
    });
    const result = expect(collectEvents(client.streamRunEvents("run_legacy"))).rejects.toThrow(
      "Hermes events stream was idle for 120000ms: /v1/runs/{run_id}/events",
    );

    await vi.advanceTimersByTimeAsync(120_000);

    await result;
  });

  it("treats Hermes SSE keepalives as activity for the stream idle watchdog", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(new TextEncoder().encode(": keepalive\n\n")), 20);
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('data: {"event":"run.completed","output":"done"}\n\n'));
          controller.close();
        }, 40);
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient({ streamIdleTimeoutMs: 25 });
    const eventsPromise = collectEvents(client.streamRunEvents("run_heartbeat"));

    await vi.advanceTimersByTimeAsync(40);

    await expect(eventsPromise).resolves.toEqual([
      { event: "run.completed", output: "done" },
    ]);
  });
});

function hermesClient(overrides: Partial<ConstructorParameters<typeof HermesClient>[0]> = {}): HermesClient {
  return new HermesClient({
    baseUrl: "http://127.0.0.1:8642",
    apiKey: "hermes-secret",
    model: "hermes-agent",
    timeoutMs: 30_000,
    streamIdleTimeoutMs: 120_000,
    ...overrides,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function collectEvents(events: AsyncGenerator<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const collected = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
