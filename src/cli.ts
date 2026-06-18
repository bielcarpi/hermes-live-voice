#!/usr/bin/env node
import { stdin as input, stderr as approvalOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";
import { assertRuntimeConfig, loadConfig, realtimeProviderConfigured } from "./config.js";
import type { AppConfig } from "./config.js";
import { HermesClient } from "./hermes/client.js";
import { createLogger } from "./logger.js";
import { ApprovalChoiceSchema } from "./protocol.js";
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

  if (command === "client") {
    const text = process.argv.slice(3).join(" ").trim();
    if (!text) {
      console.error("Provide text to send, for example: hermes-live client \"summarize my project\".");
      process.exitCode = 1;
      return;
    }
    await runTextClient(config, text);
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
  hermes-live client "..."  Send one text prompt through a running gateway
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

async function runTextClient(config: AppConfig, text: string): Promise<void> {
  const url = process.env.HERMES_LIVE_URL ?? defaultGatewayWebSocketUrl(config);
  const headers = config.server.authToken ? { authorization: `Bearer ${config.server.authToken}` } : undefined;
  const ws = new WebSocket(url, { headers });
  const approvalReader = createInterface({ input, output: approvalOutput });

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "client complete");
        }
        error ? reject(error) : resolve();
      };

      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "session.start", profileId: "terminal", userLabel: process.env.USER ?? "terminal" }));
      });
      ws.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      ws.once("close", (code, reason) => {
        if (!finished && code !== 1000) {
          finish(new Error(`Gateway WebSocket closed: ${code} ${reason.toString("utf8")}`));
        }
      });
      ws.on("message", (raw) => {
        void handleClientServerMessage(ws, raw, text, approvalReader, finish).catch((error) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
      });
    });
  } finally {
    approvalReader.close();
  }
}

async function handleClientServerMessage(
  ws: WebSocket,
  raw: WebSocket.RawData,
  text: string,
  approvalReader: ReturnType<typeof createInterface>,
  finish: (error?: Error) => void,
): Promise<void> {
  const message = JSON.parse(raw.toString("utf8")) as any;
  switch (message.type) {
    case "session.ready":
      ws.send(JSON.stringify({ type: "text.input", text }));
      break;
    case "run.started":
      console.error(`Hermes run started: ${message.runId}`);
      break;
    case "approval.request":
      await respondToApproval(ws, approvalReader, String(message.runId), message.event);
      break;
    case "run.completed":
      console.log(String(message.output ?? ""));
      finish();
      break;
    case "run.failed":
    case "session.error":
      finish(new Error(message.message ?? message.error ?? "Gateway request failed."));
      break;
  }
}

async function respondToApproval(
  ws: WebSocket,
  approvalReader: ReturnType<typeof createInterface>,
  runId: string,
  event: unknown,
): Promise<void> {
  console.error(`Approval requested for ${runId}:`);
  console.error(JSON.stringify(event, null, 2));
  const answer = await approvalReader.question("Approve once/session/always, or deny? [deny] ");
  const parsed = ApprovalChoiceSchema.safeParse(answer.trim() || "deny");
  const choice = parsed.success ? parsed.data : "deny";
  ws.send(JSON.stringify({ type: "approval.respond", runId, choice }));
}

function defaultGatewayWebSocketUrl(config: AppConfig): string {
  const host = config.server.host === "0.0.0.0" || config.server.host === "::" ? "127.0.0.1" : config.server.host;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ws://${formattedHost}:${config.server.port}/v1/live`;
}

main().catch((error) => {
  logger.error("fatal", { error: errorToMessage(error) });
  process.exitCode = 1;
});
