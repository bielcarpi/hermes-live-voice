#!/usr/bin/env node
import { assertRuntimeConfig, loadConfig, realtimeProviderConfigured } from "./config.js";
import { HermesClient } from "./hermes/client.js";
import { createLogger } from "./logger.js";
import { startServer } from "./server/http.js";

const logger = createLogger((process.env.HERMES_LIVE_LOG_LEVEL as any) ?? "info");

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const config = loadConfig();

  if (command === "serve" || command === "dev") {
    assertRuntimeConfig(config);
    const server = await startServer({ config, logger });
    process.on("SIGINT", () => void server.close().finally(() => process.exit(0)));
    process.on("SIGTERM", () => void server.close().finally(() => process.exit(0)));
    return;
  }

  if (command === "check") {
    const hermes = new HermesClient(config.hermes);
    const realtimeConfigured = realtimeProviderConfigured(config);
    let hermesCheck: Record<string, unknown>;
    try {
      const capabilities = await hermes.assertRunsSupported();
      hermesCheck = {
        ok: true,
        baseUrl: config.hermes.baseUrl,
        ...(capabilities.model ? { model: capabilities.model } : {}),
        ...(capabilities.features ? { features: capabilities.features } : {}),
      };
    } catch (error) {
      hermesCheck = { ok: false, baseUrl: config.hermes.baseUrl, error: errorToMessage(error) };
    }
    const ok = realtimeConfigured && hermesCheck.ok === true;
    console.log(
      JSON.stringify(
        {
          ok,
          hermes: hermesCheck,
          realtime: {
            configured: realtimeConfigured,
            provider: config.realtime.provider,
            model: config.realtime.model,
            ...(config.realtime.provider === "gemini" ? { enterprise: config.gemini.enterprise } : {}),
            ...(config.realtime.provider === "openai" ? { baseUrl: config.openai.baseUrl } : {}),
          },
        },
        null,
        2,
      ),
    );
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "print-config") {
    console.log(
      JSON.stringify(
        {
          ...config,
          hermes: { ...config.hermes, apiKey: redact(config.hermes.apiKey) },
          gemini: { ...config.gemini, apiKey: redact(config.gemini.apiKey) },
          openai: { ...config.openai, apiKey: redact(config.openai.apiKey) },
          server: { ...config.server, authToken: redact(config.server.authToken) },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function redact(value: string | undefined): string | undefined {
  return value ? "***" : undefined;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(`hermes-live

Usage:
  hermes-live serve         Start the realtime gateway and web demo
  hermes-live dev           Alias for serve
  hermes-live check         Check Hermes capabilities and realtime provider config
  hermes-live print-config  Print resolved config with secrets redacted

Required environment:
  HERMES_BASE_URL           Hermes API Server URL, default http://127.0.0.1:8642
  HERMES_API_KEY            Bearer token if Hermes API Server requires one
  GEMINI_API_KEY            Gemini Developer API key, unless using Enterprise auth
  OPENAI_API_KEY            OpenAI API key when HERMES_LIVE_PROVIDER=openai

Optional:
  HERMES_LIVE_PORT          Gateway port, default 8788
  HERMES_LIVE_AUTH_TOKEN    Require auth for /v1/live, /ready, and /v1/capabilities
  HERMES_LIVE_PROVIDER      gemini, openai, or mock; default gemini
  OPENAI_REALTIME_MODEL     OpenAI Realtime model, default gpt-realtime-2
  OPENAI_REALTIME_TURN_DETECTION disabled, semantic_vad, or server_vad
`);
}

main().catch((error) => {
  logger.error("fatal", { error: errorToMessage(error) });
  process.exitCode = 1;
});
