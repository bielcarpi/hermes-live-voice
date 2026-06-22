import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesClient } from "../src/hermes/client.js";

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

  it("streams run events through SSE", async () => {
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

    const events = [];
    for await (const event of client.streamRunEvents("run_123")) {
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
        headers: expect.objectContaining({ accept: "text/event-stream", authorization: "Bearer hermes-secret" }),
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
