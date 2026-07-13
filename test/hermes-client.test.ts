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
      .mockResolvedValueOnce(jsonResponse({ run_id: "run_123", choice: "once", resolved: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();
    const sessionKey = "agent:main:hermes-live:profile:default:user:alice";

    await client.getRun("run_123", { sessionKey });
    await client.stopRun("run_123", { sessionKey });
    await client.submitApproval("run_123", "once", { sessionKey });

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

  it("includes Hermes response details in request failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.capabilities()).rejects.toThrow("Hermes request failed: 401 nope");
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
        headers: expect.objectContaining({
          accept: "text/event-stream",
          authorization: "Bearer hermes-secret",
          "X-Hermes-Session-Key": sessionKey,
        }),
      }),
    );
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
});

function hermesClient(overrides: Partial<ConstructorParameters<typeof HermesClient>[0]> = {}): HermesClient {
  return new HermesClient({
    baseUrl: "http://127.0.0.1:8642",
    apiKey: "hermes-secret",
    model: "hermes-agent",
    timeoutMs: 30_000,
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
