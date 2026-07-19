import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HermesClient,
  HermesRequestError,
  MAX_HERMES_JSON_RESPONSE_BYTES,
  MAX_HERMES_RETRY_AFTER_CHARS,
  MAX_HERMES_RUN_OUTPUT_CHARS,
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
      .mockResolvedValueOnce(runResponse({ run_id: "run_123", status: "running" }))
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
    ["queued", { status: "queued" }, { status: "queued" }],
    ["running", { status: "running" }, { status: "running" }],
    [
      "waiting for approval",
      { status: "waiting_for_approval", last_event: "approval.request" },
      { status: "waiting_for_approval", last_event: "approval.request" },
    ],
    ["stopping", { status: "stopping" }, { status: "stopping" }],
    [
      "completed",
      {
        status: "completed",
        output: "All checks passed.",
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, ignored_tokens: 99 },
      },
      {
        status: "completed",
        output: "All checks passed.",
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    ],
    ["failed", { status: "failed", error: "Provider request failed." }, { status: "failed", error: "Hermes run failed." }],
    ["cancelled", { status: "cancelled" }, { status: "cancelled" }],
  ])("validates and normalizes a %s run snapshot", async (_label, statusFields, expectedStatusFields) => {
    const body = {
      object: "hermes.run",
      run_id: "run_123",
      runId: "run_123",
      session_id: "task_123",
      model: "hermes-agent",
      created_at: 10,
      updated_at: 20.5,
      private_internal: "must not cross the adapter boundary",
      ...statusFields,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.getRun("run_123")).resolves.toEqual({
      object: "hermes.run",
      run_id: "run_123",
      session_id: "task_123",
      model: "hermes-agent",
      created_at: 10,
      updated_at: 20.5,
      ...expectedStatusFields,
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing object discriminator", { run_id: "run_123", status: "running" }],
    ["a conflicting object discriminator", { object: "other.run", run_id: "run_123", status: "running" }],
    ["a missing run id", { object: "hermes.run", status: "running" }],
    ["another run id", { object: "hermes.run", run_id: "run_other", status: "running" }],
    ["an unsafe run id", { object: "hermes.run", run_id: "run\nother", status: "running" }],
    ["a bidirectional run id", { object: "hermes.run", run_id: "run\u202eother", status: "running" }],
    [
      "conflicting run-id aliases",
      { object: "hermes.run", run_id: "run_123", runId: "run_other", status: "running" },
    ],
    ["a missing status", { object: "hermes.run", run_id: "run_123" }],
    ["an unsupported status", { object: "hermes.run", run_id: "run_123", status: "started" }],
    [
      "an unsafe session id",
      { object: "hermes.run", run_id: "run_123", status: "running", session_id: "task\nother" },
    ],
    [
      "unbounded model metadata",
      { object: "hermes.run", run_id: "run_123", status: "running", model: "x".repeat(513) },
    ],
    [
      "an invalid timestamp",
      { object: "hermes.run", run_id: "run_123", status: "running", updated_at: -1 },
    ],
    [
      "unsafe event metadata",
      { object: "hermes.run", run_id: "run_123", status: "running", last_event: "tool\nstarted" },
    ],
    [
      "bidirectional event metadata",
      { object: "hermes.run", run_id: "run_123", status: "running", last_event: "tool\u202estarted" },
    ],
  ])("rejects a run snapshot containing %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.getRun("run_123")).rejects.toThrow("Hermes returned an invalid run snapshot");
  });

  it.each([
    [
      "completed output is missing",
      { object: "hermes.run", run_id: "run_123", status: "completed", usage: validUsage() },
    ],
    [
      "completed usage is missing",
      { object: "hermes.run", run_id: "run_123", status: "completed", output: "done" },
    ],
    [
      "completed usage has a negative token count",
      {
        object: "hermes.run",
        run_id: "run_123",
        status: "completed",
        output: "done",
        usage: { ...validUsage(), output_tokens: -1 },
      },
    ],
    [
      "completed usage has a fractional token count",
      {
        object: "hermes.run",
        run_id: "run_123",
        status: "completed",
        output: "done",
        usage: { ...validUsage(), total_tokens: 1.5 },
      },
    ],
    [
      "completed usage has an unsafe token count",
      {
        object: "hermes.run",
        run_id: "run_123",
        status: "completed",
        output: "done",
        usage: { ...validUsage(), input_tokens: Number.MAX_SAFE_INTEGER + 1 },
      },
    ],
  ])("rejects a terminal snapshot when %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.getRun("run_123")).rejects.toThrow("Hermes returned an invalid run snapshot");
  });

  it("retains a bounded completion prefix and marks oversized upstream output", async () => {
    fetchMock.mockResolvedValueOnce(runResponse({
      run_id: "run_123",
      status: "completed",
      output: "x".repeat(MAX_HERMES_RUN_OUTPUT_CHARS + 7),
      usage: validUsage(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(hermesClient().getRun("run_123")).resolves.toMatchObject({
      status: "completed",
      output: "x".repeat(MAX_HERMES_RUN_OUTPUT_CHARS),
      outputTruncated: true,
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["sensitive", "Bearer upstream-secret at /Users/private/provider.ts"],
    ["oversized", "x".repeat(100_000)],
  ])("normalizes %s upstream failure text at the adapter boundary", async (_label, error) => {
    fetchMock.mockResolvedValueOnce(runResponse({ run_id: "run_123", status: "failed", ...(error === undefined ? {} : { error }) }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await hermesClient().getRun("run_123");
    expect(snapshot).toMatchObject({ status: "failed", error: "Hermes run failed." });
    expect(JSON.stringify(snapshot)).not.toContain("upstream-secret");
    expect(JSON.stringify(snapshot)).not.toContain("/Users/private");
  });

  it("rejects unsafe requested run ids before they enter a request URL", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.getRun("run\nsecret")).rejects.toThrow("Hermes run id must be a bounded identifier.");
    expect(fetchMock).not.toHaveBeenCalled();
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
    fetchMock.mockResolvedValueOnce(runResponse({ run_id: "run_123", status: "running" }));
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

    await expect(client.assertRunsSupported()).rejects.toThrow(
      /run_status, run_events_sse, run_stop, run_approval_response/,
    );
  });

  it("validates the stable Hermes session surface before enabling continuity", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      features: {
        session_resources: true,
        session_chat: true,
        session_chat_streaming: true,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(hermesClient().assertSessionsSupported()).resolves.toMatchObject({
      features: { session_resources: true, session_chat: true, session_chat_streaming: true },
    });
  });

  it("lists bounded Hermes sessions without exposing private metadata", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      object: "list",
      data: [{
        id: "session_123",
        source: "cli",
        title: "Authentication refactor",
        preview: "Check the middleware",
        started_at: 10,
        last_active: 20.25,
        message_count: 4,
        system_prompt: "must not cross the adapter",
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(hermesClient().listSessions({ limit: 20 })).resolves.toEqual([{
      id: "session_123",
      source: "cli",
      title: "Authentication refactor",
      preview: "Check the middleware",
      startedAt: 10_000,
      lastActive: 20_250,
      messageCount: 4,
    }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8642/api/sessions?limit=20&offset=0");
  });

  it("creates and reads a session through the release-pinned resource contract", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        object: "hermes.session",
        session: { id: "api_123", source: "api_server", title: "Voice session" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        object: "list",
        session_id: "api_123_tip",
        data: [
          { role: "user", content: "Earlier question", private: "ignored" },
          { role: "assistant", content: "Earlier answer" },
        ],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    await expect(client.createSession({ title: "Voice session" })).resolves.toEqual({
      id: "api_123",
      source: "api_server",
      title: "Voice session",
    });
    await expect(client.getSessionHistory("api_123")).resolves.toEqual({
      sessionId: "api_123_tip",
      messages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
    });
  });

  it("continues a persisted Hermes session using the session chat endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      object: "hermes.session.chat.completion",
      session_id: "session_tip",
      message: { role: "assistant", content: "The tests pass." },
      usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const sessionKey = "agent:main:hermes-live:profile:default:user:alice";

    await expect(hermesClient().chatSession("session_123", "Do the tests pass?", { sessionKey })).resolves.toEqual({
      sessionId: "session_tip",
      content: "The tests pass.",
      usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/api/sessions/session_123/chat",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ "X-Hermes-Session-Key": sessionKey }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ message: "Do the tests pass?" });
  });

  it("does not expose Hermes response bodies in request failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      "Authorization: Bearer hermes-secret; X-Hermes-Session-Key: private-scope",
      { status: 401 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesRequestError);
    expect(error).toMatchObject({
      status: 401,
      publicPath: "/v1/capabilities",
      retryAfter: undefined,
      message: "Hermes request failed: 401 /v1/capabilities",
    });
    expect(String(error)).not.toContain("hermes-secret");
    expect(String(error)).not.toContain("private-scope");
  });

  it("returns structured, public-safe HTTP failures for task reconciliation and admission", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("private missing-run detail", {
        status: 404,
        headers: { "retry-after": "7" },
      }))
      .mockResolvedValueOnce(new Response("Bearer secret-from-429-body", {
        status: 429,
        headers: { "retry-after": "3" },
      }))
      .mockResolvedValueOnce(new Response("private draining detail", {
        status: 503,
        headers: { "retry-after": "Bearer reflected-secret" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const missing = await client.getRun("run_private_404").catch((caught: unknown) => caught);
    const limited = await client.startRun({
      input: "private task body",
      sessionId: "task_private",
      sessionKey: "private-session-key",
    }).catch((caught: unknown) => caught);
    const draining = await client.capabilities().catch((caught: unknown) => caught);

    expect(missing).toBeInstanceOf(HermesRequestError);
    expect(missing).toMatchObject({ status: 404, publicPath: "/v1/runs/{run_id}", retryAfter: "7" });
    expect(limited).toBeInstanceOf(HermesRequestError);
    expect(limited).toMatchObject({ status: 429, publicPath: "/v1/runs", retryAfter: "3" });
    expect(draining).toBeInstanceOf(HermesRequestError);
    expect(draining).toMatchObject({ status: 503, publicPath: "/v1/capabilities", retryAfter: undefined });

    const rendered = [missing, limited, draining].map(String).join("\n");
    expect(rendered).not.toContain("private missing-run detail");
    expect(rendered).not.toContain("secret-from-429-body");
    expect(rendered).not.toContain("private draining detail");
    expect(rendered).not.toContain("reflected-secret");
    expect(rendered).not.toContain("private-session-key");
    expect(rendered).not.toContain("private task body");
  });

  it("extracts only bounded structured Hermes error codes without exposing response text", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "rate_limit_exceeded", message: "Bearer private-upstream-secret" },
      }), { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "gateway_draining", message: "/Users/private/runtime" },
      }), { status: 503, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "Bearer reflected secret", message: "private" },
      }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const limited = await client.startRun({ input: "one", sessionId: "task_1", sessionKey: "scope" }).catch((error) => error);
    const draining = await client.startRun({ input: "two", sessionId: "task_2", sessionKey: "scope" }).catch((error) => error);
    const unsafe = await client.startRun({ input: "three", sessionId: "task_3", sessionKey: "scope" }).catch((error) => error);

    expect(limited).toMatchObject({ status: 429, errorCode: "rate_limit_exceeded", retryAfter: "1" });
    expect(draining).toMatchObject({ status: 503, errorCode: "gateway_draining", retryAfter: "1" });
    expect(unsafe).toMatchObject({ status: 429, errorCode: undefined });
    expect([limited, draining, unsafe].map(String).join("\n")).not.toContain("private-upstream-secret");
    expect([limited, draining, unsafe].map(String).join("\n")).not.toContain("/Users/private");
    expect([limited, draining, unsafe].map(String).join("\n")).not.toContain("reflected secret");
  });

  it.each([
    ["an overlong value", "9".repeat(MAX_HERMES_RETRY_AFTER_CHARS + 1)],
    ["an excessive delay", "86401"],
    ["unstructured text", "retry later with secret-token"],
  ])("drops %s from Retry-After", async (_label, retryAfter) => {
    fetchMock.mockResolvedValueOnce(new Response("private", {
      status: 503,
      headers: { "retry-after": retryAfter },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesRequestError);
    expect(error).toMatchObject({ status: 503, retryAfter: undefined });
    expect(String(error)).not.toContain(retryAfter);
  });

  it("preserves a bounded HTTP-date Retry-After value", async () => {
    const retryAfter = "Thu, 16 Jul 2026 12:00:00 GMT";
    fetchMock.mockResolvedValueOnce(new Response("private", {
      status: 503,
      headers: { "retry-after": retryAfter },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesRequestError);
    expect(error).toMatchObject({ status: 503, retryAfter });
    expect(String(error)).not.toContain(retryAfter);
  });

  it("retains the structured HTTP failure when its private body exceeds the safety limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_HERMES_JSON_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, {
      status: 429,
      headers: { "retry-after": "5" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = hermesClient();

    const error = await client.capabilities().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HermesRequestError);
    expect(error).toMatchObject({
      status: 429,
      publicPath: "/v1/capabilities",
      retryAfter: "5",
    });
    expect(cancelled).toBe(true);
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
    expect(error).toBeInstanceOf(HermesRequestError);
    expect(error).toMatchObject({
      status: 502,
      publicPath: "/v1/runs/{run_id}/events",
      message: "Hermes events request failed: 502 /v1/runs/{run_id}/events",
    });
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

function runResponse(body: Record<string, unknown>): Response {
  return jsonResponse({ object: "hermes.run", ...body });
}

function validUsage(): { input_tokens: number; output_tokens: number; total_tokens: number } {
  return { input_tokens: 1, output_tokens: 2, total_tokens: 3 };
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
