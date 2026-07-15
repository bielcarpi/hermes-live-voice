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

  it.each(["openai", "gemini"] as const)(
    "suppresses reflected %s startup connection errors",
    async (provider) => {
      const { config, secrets } = providerConfig(provider);
      vi.mocked(createLiveModelAdapter).mockReturnValue({
        connect: vi.fn(async () => {
          throw new Error(`reflected ${secrets.join(" ")}`);
        }),
      });

      const error = await runLiveProviderSmoke(config, { timeoutMs: 100 }).catch((caught: unknown) => caught);

      expect(String(error)).toContain(`${provider} realtime provider smoke failed. Provider details were suppressed.`);
      for (const secret of secrets) expect(String(error)).not.toContain(secret);
    },
  );

  it.each(["openai", "gemini"] as const)(
    "suppresses reflected %s callback errors",
    async (provider) => {
      const { config, secrets } = providerConfig(provider);
      const session = { close: vi.fn(async () => undefined) };
      vi.mocked(createLiveModelAdapter).mockReturnValue({
        connect: vi.fn(async (params) => {
          params.callbacks.onOpen?.();
          params.callbacks.onError?.(new Error(`reflected ${secrets.join(" ")}`));
          return session as any;
        }),
      });

      const error = await runLiveProviderSmoke(config, { timeoutMs: 100 }).catch((caught: unknown) => caught);

      expect(String(error)).toContain(`${provider} provider emitted an error during startup.`);
      for (const secret of secrets) expect(String(error)).not.toContain(secret);
      expect(session.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["openai", "gemini"] as const)(
    "keeps only a bounded numeric close code in successful %s smoke output",
    async (provider) => {
      const { config, secrets } = providerConfig(provider);
      vi.mocked(createLiveModelAdapter).mockReturnValue({
        connect: vi.fn(async (params) => {
          params.callbacks.onOpen?.();
          params.callbacks.onEvent({
            type: "audio",
            audio: { data: "", mimeType: `audio/${secrets.join("-")}` },
          });
          return {
            close: vi.fn(async () => {
              params.callbacks.onClose?.({ code: 1000, reason: `reflected ${secrets.join(" ")}` });
            }),
          } as any;
        }),
      });

      const report = await runLiveProviderSmoke(config, { timeoutMs: 100 });
      const serialized = JSON.stringify(report);

      expect(report.closeEvent).toEqual({ code: 1000 });
      expect(report.sampleEvents).toContainEqual({ type: "audio" });
      for (const secret of secrets) expect(serialized).not.toContain(secret);
    },
  );
});

function providerConfig(provider: "openai" | "gemini") {
  if (provider === "openai") {
    return {
      config: loadConfig({
        HERMES_LIVE_PROVIDER: "openai",
        OPENAI_API_KEY: "openai-provider-secret",
        OPENAI_REALTIME_BASE_URL:
          "wss://compatible.example/tenant/openai-path-secret?api-key=openai-query-secret",
      }),
      secrets: ["openai-provider-secret", "openai-path-secret", "openai-query-secret"],
    };
  }
  return {
    config: loadConfig({
      HERMES_LIVE_PROVIDER: "gemini",
      GEMINI_API_KEY: "gemini-provider-secret",
    }),
    secrets: ["gemini-provider-secret"],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
