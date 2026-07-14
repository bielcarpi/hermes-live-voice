import { describe, expect, it, vi } from "vitest";
import { createLiveModelAdapter } from "../src/adapters/outbound/realtime/factory.js";
import { loadConfig } from "../src/config.js";
import { errorToMessage } from "../src/domain/error-message.js";
import { runLiveProviderSmoke } from "../src/live-provider-smoke.js";

vi.mock("../src/adapters/outbound/realtime/factory.js", () => ({
  createLiveModelAdapter: vi.fn(),
}));

describe("provider error formatting", () => {
  it("formats nested structured provider errors without falling back to object coercion", () => {
    expect(
      errorToMessage({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "model_not_found",
          message: "The requested realtime model is unavailable.",
        },
      }),
    ).toBe(
      "message=The requested realtime model is unavailable., code=model_not_found, type=invalid_request_error",
    );
  });

  it("returns a safe diagnostic for unknown objects", () => {
    expect(errorToMessage({ unexpected: { secret: "not rendered" } })).toBe(
      "Unknown structured error.",
    );
  });

  it("closes a provider session that resolves after the smoke deadline", async () => {
    const pendingConnect = deferred<any>();
    const lateSession = { close: vi.fn(async () => undefined) };
    vi.mocked(createLiveModelAdapter).mockReturnValue({
      connect: vi.fn(() => pendingConnect.promise),
    });
    const config = loadConfig({
      HERMES_LIVE_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
    });

    await expect(runLiveProviderSmoke(config, { timeoutMs: 10 })).rejects.toThrow(
      "did not connect within 10ms",
    );
    pendingConnect.resolve(lateSession);
    await vi.waitFor(() => expect(lateSession.close).toHaveBeenCalledTimes(1));
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
