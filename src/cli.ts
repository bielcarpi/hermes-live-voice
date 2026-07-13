#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin as input, stderr as approvalOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { HERMES_LIVE_PROTOCOL_VERSION } from "./protocol.js";
import { buildReadinessReport } from "./readiness.js";
import { startServer } from "./adapters/inbound/http/server.js";
import { runLiveProviderSmoke } from "./live-provider-smoke.js";
import { errorToMessage } from "./domain/error-message.js";
import { promptForOneShotApproval } from "./cli/one-shot-approval.js";
import { normalizeGatewayWebSocketUrl, runInteractiveTerminal, sanitizeTerminalText } from "./cli/terminal-session.js";

const logger = createLogger((process.env.HERMES_LIVE_LOG_LEVEL as any) ?? "info");
const packageRequire = createRequire(import.meta.url);
const PACKAGE_VERSION = (packageRequire("../package.json") as { version: string }).version;
const DEFAULT_TEXT_CLIENT_READY_TIMEOUT_MS = 10_000;
const MIN_TEXT_CLIENT_SERVER_MESSAGE_BYTES = 2_000_000;
const MAX_TEXT_CLIENT_OUTPUT_CHARS = 200_000;
const MAX_TEXT_CLIENT_ID_CHARS = 256;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  if (command === "plugin") {
    await runPluginCommand(process.argv.slice(3));
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-V") {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (command === "serve" || command === "dev") {
    const config = loadConfig();
    assertRuntimeConfig(config);
    const server = await startServer({ config, logger });
    process.on("SIGINT", () => void server.close().finally(() => process.exit(0)));
    process.on("SIGTERM", () => void server.close().finally(() => process.exit(0)));
    return;
  }

  if (command === "client") {
    const config = loadConfig();
    const text = process.argv.slice(3).join(" ").trim();
    if (!text) {
      console.error("Provide text to send, for example: hermes-live client \"summarize my project\".");
      process.exitCode = 1;
      return;
    }
    await runTextClient(config, text);
    return;
  }

  if (command === "terminal" || command === "chat") {
    const config = loadConfig();
    await runInteractiveTerminal({
      url: process.env.HERMES_LIVE_URL ?? defaultGatewayWebSocketUrl(config),
      ...(config.server.authToken ? { authToken: config.server.authToken } : {}),
      userLabel: process.env.USER ?? "terminal",
    });
    // A piped stdin remains referenced after readline closes; release it so
    // non-interactive terminal sessions exit just as cleanly as TTY sessions.
    input.destroy();
    return;
  }

  if (command === "check") {
    const config = loadConfig();
    const report = await buildReadinessReport(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "provider-smoke" || command === "check-live-provider") {
    const config = loadConfig();
    try {
      const report = await runLiveProviderSmoke(config, {
        timeoutMs: positiveInt(process.env.HERMES_LIVE_PROVIDER_SMOKE_TIMEOUT_MS, config.server.providerReadyTimeoutMs),
      });
      console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      console.error(errorToMessage(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "print-config") {
    const config = loadConfig();
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

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function redact(value: string | undefined): string | undefined {
  return value ? "***" : undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp(): void {
  console.log(`hermes-live

Usage:
  hermes-live --version     Print the installed package version
  hermes-live serve         Start the realtime gateway and web demo
  hermes-live dev           Alias for serve
  hermes-live client "..."  Send one text prompt through a running gateway
  hermes-live terminal      Open the interactive text-control gateway console
  hermes-live chat          Alias for terminal
  hermes-live check         Check Hermes capabilities and realtime provider config
  hermes-live provider-smoke Open and close a real Gemini/OpenAI provider session
  hermes-live print-config  Print resolved config with secrets redacted
  hermes-live plugin install Install the Hermes plugin into ~/.hermes/plugins
  hermes-live plugin status  Show Hermes plugin install status
  hermes-live plugin path    Print this package's Hermes plugin directory

Required environment:
  HERMES_BASE_URL           Hermes API Server URL, default http://127.0.0.1:8642
  HERMES_AGENT_API_SERVER_KEY Hermes Agent API_SERVER_KEY bearer token
  GEMINI_API_KEY            Gemini Developer API key, unless using Enterprise auth
  OPENAI_API_KEY            OpenAI API key when HERMES_LIVE_PROVIDER=openai

Optional:
  HERMES_LIVE_URL           Remote gateway HTTP/WS URL for client and terminal
  HERMES_LIVE_PORT          Gateway port, default 8788
  HERMES_LIVE_AUTH_TOKEN    Require auth for /v1/live, /ready, and /v1/capabilities
  HERMES_LIVE_ALLOW_UNAUTHENTICATED  Unsafe opt-out for network-accessible binds
  HERMES_LIVE_MAX_TEXT_CHARS Text/tool-call character limit, default 20000
  HERMES_LIVE_MAX_SESSIONS Concurrent WebSocket session limit, default 8
  HERMES_LIVE_RUN_EVENT_DETAIL summary, raw, or none; default summary
  HERMES_LIVE_TRUST_CLIENT_IDENTITY Allow profileId/userLabel from clients; default false
  HERMES_LIVE_PROVIDER      gemini, openai, or mock; default gemini
  HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS  Provider session ready timeout, default 15000
  HERMES_LIVE_PROVIDER_SMOKE_TIMEOUT_MS  Optional timeout for provider-smoke
  HERMES_LIVE_CLIENT_READY_TIMEOUT_MS  One-shot client handshake timeout, default 10000
  OPENAI_REALTIME_MODEL     OpenAI Realtime model, default gpt-realtime-2.1
  OPENAI_REALTIME_TURN_DETECTION disabled, semantic_vad, or server_vad

Terminal voice:
  The terminal console controls a remote Hermes Live session without native
  audio dependencies. For local microphone use, run Hermes and press Ctrl+B
  for official Hermes Voice Mode. Use the Dashboard/browser UI for gateway audio.

Plugin options:
  --dir <path>              Hermes plugins directory, default ~/.hermes/plugins
  --copy                    Copy plugin files, default
  --symlink                 Symlink plugin directory instead of copying
  --force                   Replace an existing hermes-live plugin install
`);
}

async function runPluginCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "status";
  const options = parsePluginOptions(args.slice(1));
  if (subcommand === "path") {
    console.log(pluginSourceDir());
    return;
  }
  if (subcommand === "status") {
    console.log(JSON.stringify(await pluginInstallStatus(options), null, 2));
    return;
  }
  if (subcommand === "install") {
    const status = await installHermesPlugin(options);
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.error(`Unknown plugin command: ${subcommand}`);
  printHelp();
  process.exitCode = 1;
}

interface PluginOptions {
  dir?: string;
  mode: "copy" | "symlink";
  force: boolean;
}

interface PluginInstallStatus {
  source: string;
  target: string;
  installed: boolean;
  manifestFound: boolean;
  symlink: boolean;
  symlinkTarget?: string;
  mode?: "copy" | "symlink";
  enabledHint: string;
}

function parsePluginOptions(args: string[]): PluginOptions {
  const options: PluginOptions = { mode: "copy", force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--copy") {
      options.mode = "copy";
    } else if (arg === "--symlink") {
      options.mode = "symlink";
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--dir requires a path.");
      }
      options.dir = value;
      index += 1;
    } else if (arg?.startsWith("--dir=")) {
      options.dir = arg.slice("--dir=".length);
    } else if (arg) {
      throw new Error(`Unknown plugin option: ${arg}`);
    }
  }
  return options;
}

async function installHermesPlugin(options: PluginOptions): Promise<PluginInstallStatus> {
  const source = pluginSourceDir();
  const target = pluginTargetDir(options);
  await assertPluginSource(source);
  await mkdir(dirname(target), { recursive: true });
  const existing = await pluginInstallStatus(options);
  if (existing.installed) {
    if (!options.force) {
      return { ...existing, mode: existing.symlink ? "symlink" : "copy" };
    }
    await rm(target, { recursive: true, force: true });
  }

  if (options.mode === "symlink") {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } else {
    await cp(source, target, {
      recursive: true,
      filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc"),
    });
  }
  return { ...(await pluginInstallStatus(options)), mode: options.mode };
}

async function pluginInstallStatus(options: PluginOptions): Promise<PluginInstallStatus> {
  const source = pluginSourceDir();
  const target = pluginTargetDir(options);
  const stat = await lstat(target).catch(() => undefined);
  const symlinkTarget = stat?.isSymbolicLink() ? await readlink(target).catch(() => undefined) : undefined;
  return {
    source,
    target,
    installed: Boolean(stat),
    manifestFound: await fileExists(join(target, "plugin.yaml")),
    symlink: Boolean(stat?.isSymbolicLink()),
    ...(symlinkTarget ? { symlinkTarget } : {}),
    enabledHint: "Run `hermes plugins enable hermes-live` after installation.",
  };
}

async function assertPluginSource(source: string): Promise<void> {
  if (!(await fileExists(join(source, "plugin.yaml"))) || !(await fileExists(join(source, "__init__.py")))) {
    throw new Error(`Hermes plugin source is incomplete: ${source}`);
  }
}

function pluginTargetDir(options: PluginOptions): string {
  return join(hermesPluginsDir(options), "hermes-live");
}

function hermesPluginsDir(options: PluginOptions): string {
  return resolve(options.dir ?? process.env.HERMES_LIVE_HERMES_PLUGINS_DIR ?? join(homedir(), ".hermes", "plugins"));
}

function pluginSourceDir(): string {
  return join(packageRoot(), "plugins", "hermes-live");
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runTextClient(config: AppConfig, text: string): Promise<void> {
  const url = normalizeGatewayWebSocketUrl(process.env.HERMES_LIVE_URL ?? defaultGatewayWebSocketUrl(config));
  const headers = config.server.authToken ? { authorization: `Bearer ${config.server.authToken}` } : undefined;
  const readyTimeoutMs = positiveInt(
    process.env.HERMES_LIVE_CLIENT_READY_TIMEOUT_MS,
    DEFAULT_TEXT_CLIENT_READY_TIMEOUT_MS,
  );
  const ws = new WebSocket(url, {
    ...(headers ? { headers } : {}),
    handshakeTimeout: readyTimeoutMs,
    followRedirects: false,
    maxPayload: textClientServerMessageBytes(config),
    perMessageDeflate: false,
  });
  const approvalReader = createInterface({ input, output: approvalOutput });
  const state: TextClientState = {
    directTranscript: [],
    directTranscriptChars: 0,
    hermesRunStarted: false,
    sessionReady: false,
    finished: false,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let inboundQueue = Promise.resolve();
      let readyTimeout: NodeJS.Timeout | undefined;
      const clearReadyTimeout = (): void => {
        if (!readyTimeout) return;
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      };
      const finish = (error?: Error, terminate = false) => {
        if (state.finished) {
          return;
        }
        state.finished = true;
        clearReadyTimeout();
        if (terminate && ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "client complete");
        }
        error ? reject(error) : resolve();
      };
      const markSessionReady = (): void => {
        clearReadyTimeout();
      };

      readyTimeout = setTimeout(() => {
        finish(
          new Error(`Gateway did not complete the WebSocket/session.ready handshake within ${readyTimeoutMs}ms.`),
          true,
        );
      }, readyTimeoutMs);
      readyTimeout.unref?.();

      ws.once("open", () => {
        if (state.finished) return;
        try {
          sendTextClientMessage(ws, {
            type: "session.start",
            protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
            profileId: "terminal",
            userLabel: process.env.USER ?? "terminal",
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)), true);
        }
      });
      ws.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error)), true));
      ws.once("close", (code, reason) => {
        if (!state.finished) {
          finish(new Error(`Gateway WebSocket closed before completing the request: ${code} ${reason.toString("utf8")}`));
        }
      });
      ws.on("message", (raw) => {
        if (state.finished) return;
        inboundQueue = inboundQueue
          .then(() => handleClientServerMessage(ws, raw, text, approvalReader, state, markSessionReady, finish))
          .catch((error) => finish(error instanceof Error ? error : new Error(String(error)), true));
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
  markSessionReady: () => void,
  finish: (error?: Error) => void,
): Promise<void> {
  if (state.finished) return;
  const message = parseTextClientServerMessage(raw);
  if (!state.sessionReady && message.type !== "session.ready" && message.type !== "session.error") {
    throw new Error(`Gateway sent ${message.type} before session.ready.`);
  }
  switch (message.type) {
    case "session.ready": {
      if (state.sessionReady) throw new Error("Gateway sent duplicate session.ready messages.");
      const protocolVersion = requiredInteger(message, "protocolVersion", "session.ready");
      if (protocolVersion !== HERMES_LIVE_PROTOCOL_VERSION) {
        throw new Error(
          `Gateway protocol mismatch: expected v${HERMES_LIVE_PROTOCOL_VERSION}, received ${String(protocolVersion)}.`,
        );
      }
      requiredString(message, "sessionId", "session.ready", MAX_TEXT_CLIENT_ID_CHARS);
      state.sessionReady = true;
      markSessionReady();
      sendTextClientMessage(ws, { type: "text.input", text });
      break;
    }
    case "run.started": {
      const runId = requiredString(message, "runId", "run.started", MAX_TEXT_CLIENT_ID_CHARS);
      if (state.hermesRunStarted) throw new Error("Gateway sent duplicate run.started messages.");
      state.hermesRunStarted = true;
      state.activeRunId = runId;
      console.error(`Hermes run started: ${sanitizeTerminalText(runId, MAX_TEXT_CLIENT_ID_CHARS)}`);
      break;
    }
    case "transcript.delta": {
      const speaker = requiredString(message, "speaker", "transcript.delta", 16);
      if (!(["user", "assistant", "system"] as string[]).includes(speaker)) {
        throw new Error("Gateway transcript.delta speaker is invalid.");
      }
      const delta = requiredString(message, "text", "transcript.delta", MAX_TEXT_CLIENT_OUTPUT_CHARS, true);
      if (!state.hermesRunStarted && speaker === "assistant") {
        state.directTranscriptChars += delta.length;
        if (state.directTranscriptChars > MAX_TEXT_CLIENT_OUTPUT_CHARS) {
          throw new Error("Gateway direct transcript exceeded the one-shot client output limit.");
        }
        state.directTranscript.push(delta);
      }
      break;
    }
    case "response.completed":
      if (!state.hermesRunStarted) finishDirectResponse(state, finish);
      break;
    case "response.failed":
      if (!state.hermesRunStarted) {
        finish(new Error(requiredString(message, "error", "response.failed", 2_000)));
      }
      break;
    case "response.cancelled":
      if (!state.hermesRunStarted) finish(new Error("Realtime provider response was cancelled."));
      break;
    case "approval.request": {
      const runId = requiredString(message, "runId", "approval.request", MAX_TEXT_CLIENT_ID_CHARS);
      if (state.activeRunId && runId !== state.activeRunId) {
        throw new Error("Gateway approval.request did not match the active Hermes run.");
      }
      const approval = recordValue(message.approval) ?? recordValue(message.event);
      if (!approval) throw new Error("Gateway approval.request did not include approval details.");
      await respondToApproval(ws, approvalReader, runId, approval);
      break;
    }
    case "run.completed": {
      assertActiveRunMessage(message, state, "run.completed");
      const output = requiredString(message, "output", "run.completed", MAX_TEXT_CLIENT_OUTPUT_CHARS, true);
      console.log(sanitizeTerminalText(output, MAX_TEXT_CLIENT_OUTPUT_CHARS));
      finish();
      break;
    }
    case "run.failed":
      assertActiveRunMessage(message, state, "run.failed");
      finish(new Error(requiredString(message, "error", "run.failed", 2_000)));
      break;
    case "run.stopped":
      assertActiveRunMessage(message, state, "run.stopped");
      finish(new Error(`Hermes run stopped: ${requiredString(message, "status", "run.stopped", 256)}`));
      break;
    case "session.error":
      finish(new Error(requiredString(message, "message", "session.error", 2_000)));
      break;
  }
}

function finishDirectResponse(state: TextClientState, finish: (error?: Error) => void): void {
  const output = sanitizeTerminalText(state.directTranscript.join(""), MAX_TEXT_CLIENT_OUTPUT_CHARS).trim();
  if (output) {
    console.log(output);
    finish();
  } else {
    finish(new Error("Realtime provider completed without text output. Use the web client for audio-only responses."));
  }
}

interface TextClientState {
  directTranscript: string[];
  directTranscriptChars: number;
  hermesRunStarted: boolean;
  sessionReady: boolean;
  finished: boolean;
  activeRunId?: string;
}

function parseTextClientServerMessage(raw: WebSocket.RawData): Record<string, unknown> & { type: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new Error("Gateway sent invalid JSON.");
  }
  const message = recordValue(value);
  if (!message || typeof message.type !== "string" || !message.type || message.type.length > 128) {
    throw new Error("Gateway sent an invalid protocol message.");
  }
  return message as Record<string, unknown> & { type: string };
}

function requiredString(
  message: Record<string, unknown>,
  field: string,
  type: string,
  maxChars: number,
  allowEmpty = false,
): string {
  const value = message[field];
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maxChars) {
    throw new Error(`Gateway ${type} ${field} must be ${allowEmpty ? "a" : "a non-empty"} bounded string.`);
  }
  return value;
}

function requiredInteger(message: Record<string, unknown>, field: string, type: string): number {
  const value = message[field];
  if (!Number.isSafeInteger(value)) throw new Error(`Gateway ${type} ${field} must be an integer.`);
  return value as number;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertActiveRunMessage(message: Record<string, unknown>, state: TextClientState, type: string): void {
  const runId = requiredString(message, "runId", type, MAX_TEXT_CLIENT_ID_CHARS);
  if (!state.activeRunId || runId !== state.activeRunId) {
    throw new Error(`Gateway ${type} did not match the active Hermes run.`);
  }
}

function sendTextClientMessage(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("Gateway WebSocket is not open.");
  ws.send(JSON.stringify(message));
}

function textClientServerMessageBytes(config: AppConfig): number {
  const base64AudioBytes = Math.ceil((config.server.maxAudioBytes * 4) / 3) + 4_096;
  return Math.max(MIN_TEXT_CLIENT_SERVER_MESSAGE_BYTES, base64AudioBytes);
}

async function respondToApproval(
  ws: WebSocket,
  approvalReader: ReturnType<typeof createInterface>,
  runId: string,
  event: unknown,
): Promise<void> {
  const approvalId = typeof (event as { approvalId?: unknown })?.approvalId === "string"
    ? (event as { approvalId: string }).approvalId
    : "";
  if (!approvalId || approvalId.length > 256) {
    throw new Error("Gateway approval request did not include a valid approval id.");
  }
  console.error(`Approval requested for ${sanitizeTerminalText(runId, MAX_TEXT_CLIENT_ID_CHARS)}:`);
  const choice = await promptForOneShotApproval(approvalReader, event, {
    interactive: input.isTTY === true,
    writeLine: (line) => console.error(line),
  });
  sendTextClientMessage(ws, {
    type: "approval.respond",
    id: `client_approval_${randomUUID().replaceAll("-", "")}`,
    runId,
    approvalId,
    choice,
  });
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
