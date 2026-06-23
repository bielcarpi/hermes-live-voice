#!/usr/bin/env node
import { stdin as input, stderr as approvalOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";
import {
  assertGatewayExposureConfig,
  assertHermesApiConfig,
  assertRealtimeProviderConfig,
  assertRuntimeConfig,
  loadConfig,
} from "./config.js";
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
    const report = await buildCheckReport(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
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

interface CheckSection extends Record<string, unknown> {
  ok: boolean;
}

interface CheckReport {
  ok: boolean;
  gateway: CheckSection;
  hermes: CheckSection;
  realtime: CheckSection;
}

async function buildCheckReport(config: AppConfig): Promise<CheckReport> {
  const gateway = checkGatewayConfig(config);
  const hermes = await checkHermesConfig(config);
  const realtime = checkRealtimeConfig(config);
  return {
    ok: gateway.ok && hermes.ok && realtime.ok,
    gateway,
    hermes,
    realtime,
  };
}

function checkGatewayConfig(config: AppConfig): CheckSection {
  const base = {
    host: config.server.host,
    port: config.server.port,
    authRequired: Boolean(config.server.authToken),
    demoEnabled: config.server.demoEnabled,
  };
  try {
    assertGatewayExposureConfig(config);
    return { ok: true, ...base };
  } catch (error) {
    return { ok: false, ...base, error: errorToMessage(error) };
  }
}

async function checkHermesConfig(config: AppConfig): Promise<CheckSection> {
  const base = { baseUrl: config.hermes.baseUrl };
  try {
    assertHermesApiConfig(config);
  } catch (error) {
    return { ok: false, ...base, error: errorToMessage(error) };
  }

  const hermes = new HermesClient(config.hermes);
  try {
    const capabilities = await hermes.assertRunsSupported();
    return {
      ok: true,
      ...base,
      ...(capabilities.model ? { model: capabilities.model } : {}),
      ...(capabilities.features ? { features: capabilities.features } : {}),
    };
  } catch (error) {
    return { ok: false, ...base, error: errorToMessage(error) };
  }
}

function checkRealtimeConfig(config: AppConfig): CheckSection {
  const base = realtimeCheckSummary(config);
  try {
    assertRealtimeProviderConfig(config);
    return { ok: true, configured: true, ...base };
  } catch (error) {
    return { ok: false, configured: false, ...base, error: errorToMessage(error) };
  }
}

function realtimeCheckSummary(config: AppConfig): Record<string, unknown> {
  const base = {
    provider: config.realtime.provider,
    model: config.realtime.model,
  };
  if (config.realtime.provider === "gemini") {
    return {
      ...base,
      enterprise: config.gemini.enterprise,
      location: config.gemini.location,
      projectConfigured: Boolean(config.gemini.project),
      ...(config.gemini.apiVersion ? { apiVersion: config.gemini.apiVersion } : {}),
    };
  }
  if (config.realtime.provider === "openai") {
    return {
      ...base,
      baseUrl: config.openai.baseUrl,
      voice: config.openai.voice,
      reasoningEffort: config.openai.reasoningEffort,
      turnDetection: config.openai.turnDetection,
      inputAudioFormat: config.openai.inputAudioFormat,
      outputAudioFormat: config.openai.outputAudioFormat,
    };
  }
  return base;
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
  HERMES_API_KEY            Hermes API_SERVER_KEY bearer token
  GEMINI_API_KEY            Gemini Developer API key, unless using Enterprise auth
  OPENAI_API_KEY            OpenAI API key when HERMES_LIVE_PROVIDER=openai

Optional:
  HERMES_LIVE_PORT          Gateway port, default 8788
  HERMES_LIVE_AUTH_TOKEN    Require auth for /v1/live, /ready, and /v1/capabilities
  HERMES_LIVE_ALLOW_UNAUTHENTICATED  Unsafe opt-out for network-accessible binds
  HERMES_LIVE_MAX_TEXT_CHARS Text/tool-call character limit, default 20000
  HERMES_LIVE_PROVIDER      gemini, openai, or mock; default gemini
  HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS  Provider session ready timeout, default 15000
  OPENAI_REALTIME_MODEL     OpenAI Realtime model, default gpt-realtime-2; use gpt-realtime-1.5 for 1.x
  OPENAI_REALTIME_TURN_DETECTION disabled, semantic_vad, or server_vad
`);
}

async function runTextClient(config: AppConfig, text: string): Promise<void> {
  const url = process.env.HERMES_LIVE_URL ?? defaultGatewayWebSocketUrl(config);
  const headers = config.server.authToken ? { authorization: `Bearer ${config.server.authToken}` } : undefined;
  const ws = new WebSocket(url, { headers });
  const approvalReader = createInterface({ input, output: approvalOutput });
  const state: TextClientState = { directTranscript: [], hermesRunStarted: false };

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
        if (!finished) {
          finish(new Error(`Gateway WebSocket closed before completing the request: ${code} ${reason.toString("utf8")}`));
        }
      });
      ws.on("message", (raw) => {
        void handleClientServerMessage(ws, raw, text, approvalReader, state, finish).catch((error) =>
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
  state: TextClientState,
  finish: (error?: Error) => void,
): Promise<void> {
  const message = JSON.parse(raw.toString("utf8")) as any;
  switch (message.type) {
    case "session.ready":
      ws.send(JSON.stringify({ type: "text.input", text }));
      break;
    case "run.started":
      state.hermesRunStarted = true;
      console.error(`Hermes run started: ${message.runId}`);
      break;
    case "transcript.delta":
      if (!state.hermesRunStarted && typeof message.text === "string") {
        state.directTranscript.push(message.text);
      }
      break;
    case "realtime.message":
      if (!state.hermesRunStarted && isRealtimeResponseComplete(message.message)) {
        const output = state.directTranscript.join("").trim();
        if (output) {
          console.log(output);
          finish();
        } else {
          finish(new Error("Realtime provider completed without text output. Use the web demo or a voice client for audio-only responses."));
        }
      }
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

interface TextClientState {
  directTranscript: string[];
  hermesRunStarted: boolean;
}

function isRealtimeResponseComplete(message: unknown): boolean {
  const root = unwrapRealtimeMessage(message);
  return (
    root?.type === "response.done" ||
    root?.serverContent?.turnComplete === true ||
    root?.server_content?.turn_complete === true ||
    root?.data?.serverContent?.turnComplete === true ||
    root?.data?.server_content?.turn_complete === true
  );
}

function unwrapRealtimeMessage(message: unknown): any {
  if (message && typeof message === "object" && "data" in message) {
    return (message as { data: unknown }).data;
  }
  return message;
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
