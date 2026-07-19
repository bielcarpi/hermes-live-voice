#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input } from "node:process";
import WebSocket from "ws";
import { assertRuntimeConfig, loadConfig, publicBaseUrl } from "./config.js";
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { HERMES_LIVE_PROTOCOL_VERSION } from "./protocol.js";
import { buildReadinessReport } from "./readiness.js";
import { startServer } from "./adapters/inbound/http/server.js";
import { runLiveProviderSmoke } from "./live-provider-smoke.js";
import { errorToMessage } from "./domain/error-message.js";
import { normalizeGatewayWebSocketUrl, runInteractiveTerminal, sanitizeTerminalText } from "./cli/terminal-session.js";
import { runOfflineTaskCommand } from "./cli/task-operator.js";
import {
  installHermesPlugin,
  pluginInstallStatus,
  pluginSourceDir,
  type PluginInstallOptions,
} from "./cli/plugin-installer.js";
import { applyManagedConfigToProcess } from "./cli/managed-config.js";
import { runServiceAction, type ServiceAction } from "./cli/service-manager.js";
import { runSetupCommand } from "./cli/setup.js";
import { runDoctorCommand } from "./cli/doctor.js";
import type { PublicTaskSnapshot, ServerMessage } from "./domain/protocol/server-protocol.js";
import type { ConversationSelection } from "./domain/protocol/client-protocol.js";
import { parseServerMessage as parseProtocolServerMessage } from "./domain/protocol/server-protocol.js";

const logger = createLogger((process.env.HERMES_LIVE_LOG_LEVEL as any) ?? "info");
const packageRequire = createRequire(import.meta.url);
const PACKAGE_VERSION = (packageRequire("../package.json") as { version: string }).version;
const DEFAULT_TEXT_CLIENT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_TEXT_CLIENT_RESULT_TIMEOUT_MS = 60 * 60 * 1_000;
const DIRECT_RESPONSE_SETTLE_MS = 100;
const MIN_TEXT_CLIENT_SERVER_MESSAGE_BYTES = 2_000_000;
const MAX_TEXT_CLIENT_OUTPUT_CHARS = 200_000;
const MAX_TEXT_CLIENT_ID_CHARS = 256;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  if (usesManagedRuntimeConfig(command)) {
    await applyManagedConfigToProcess();
  }

  if (command === "plugin") {
    await runPluginCommand(process.argv.slice(3));
    return;
  }

  if (command === "setup") {
    await runSetupCommand(process.argv.slice(3));
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand(process.argv.slice(3));
    return;
  }

  if (command === "service") {
    await runServiceCommand(process.argv.slice(3));
    return;
  }

  if (command === "tasks") {
    await runOfflineTaskCommand(process.argv.slice(3), loadConfig());
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
    const startupAbort = new AbortController();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (!server) {
        startupAbort.abort(new Error(`Hermes Live startup interrupted by ${signal}.`));
        return;
      }
      void server.close().then(
        () => process.exit(0),
        (error) => {
          logger.error("hermes-live shutdown failed", { signal, error: errorToMessage(error) });
          process.exit(1);
        },
      );
    };
    const onSigint = () => shutdown("SIGINT");
    const onSigterm = () => shutdown("SIGTERM");
    // Keep both handlers installed through cleanup. Repeated signals are
    // ignored by the guard instead of falling back to Node's immediate default
    // exit while the task-store lock is still being released.
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    try {
      server = await startServer({ config, logger, signal: startupAbort.signal });
    } catch (error) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (
        shuttingDown
        && startupAbort.signal.aborted
        && error === startupAbort.signal.reason
      ) {
        process.exitCode = 0;
        return;
      }
      throw error;
    }
    if (shuttingDown) {
      await server.close();
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.exitCode = 0;
    }
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
    const conversation = parseTerminalConversation(process.argv.slice(3));
    await runInteractiveTerminal({
      url: process.env.HERMES_LIVE_URL ?? defaultGatewayWebSocketUrl(config),
      ...(config.server.authToken ? { authToken: config.server.authToken } : {}),
      userLabel: process.env.USER ?? "terminal",
      conversation,
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
          hermes: {
            ...config.hermes,
            baseUrl: publicBaseUrl(config.hermes.baseUrl),
            apiKey: redact(config.hermes.apiKey),
          },
          gemini: { ...config.gemini, apiKey: redact(config.gemini.apiKey) },
          openai: {
            ...config.openai,
            baseUrl: publicBaseUrl(config.openai.baseUrl),
            apiKey: redact(config.openai.apiKey),
          },
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

function usesManagedRuntimeConfig(command: string): boolean {
  return [
    "serve",
    "dev",
    "client",
    "terminal",
    "chat",
    "check",
    "provider-smoke",
    "check-live-provider",
    "tasks",
    "print-config",
  ].includes(command);
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
  hermes-live setup         Configure, install, verify, and start Live Voice
  hermes-live doctor        Check the installation and print exact fixes
  hermes-live serve         Start the realtime gateway and web demo
  hermes-live dev           Alias for serve
  hermes-live client "..."  Send one prompt; wait for its exact task result
  hermes-live terminal      Open a new persisted chat and the task inbox
  hermes-live terminal --resume <sessionId> Continue an existing Hermes chat
  hermes-live terminal --unbound Open voice without attaching a saved chat
  hermes-live chat          Alias for terminal
  hermes-live check         Check Hermes capabilities and realtime provider config
  hermes-live provider-smoke Open and close a real Gemini/OpenAI provider session
  hermes-live tasks unresolved Inspect unresolved outcomes with the gateway stopped
  hermes-live tasks contain <taskId> --confirm-contained Unblock one unknown outcome after containment
  hermes-live tasks unlock --confirm-no-gateway Clear a crash-left state lock after verifying shutdown
  hermes-live print-config  Print resolved config with secrets redacted
  hermes-live plugin install Install the Hermes plugin into ~/.hermes/plugins
  hermes-live plugin status  Show Hermes plugin install status
  hermes-live plugin path    Print this package's Hermes plugin directory
  hermes-live service install Install and load the user gateway service
  hermes-live service status  Show whether the gateway service is running
  hermes-live service logs    Show the most recent gateway service logs

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
  HERMES_LIVE_TRUST_CLIENT_IDENTITY Allow profileId/userLabel from clients; default false
  HERMES_LIVE_TRUST_DECLARED_READ_ONLY Trust model-declared read-only task scopes; default false
  HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS  Hermes run SSE idle timeout, default 120000
  HERMES_LIVE_PROVIDER      gemini, openai, or mock; default gemini
  HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS  Provider session ready timeout, default 15000
  HERMES_LIVE_PROVIDER_SMOKE_TIMEOUT_MS  Optional timeout for provider-smoke
  HERMES_LIVE_CLIENT_READY_TIMEOUT_MS  One-shot client handshake timeout, default 10000
  HERMES_LIVE_CLIENT_RESULT_TIMEOUT_MS One-shot response/task timeout, default 3600000
  OPENAI_REALTIME_MODEL     OpenAI Realtime model, default gpt-realtime-2.1
  OPENAI_REALTIME_TURN_DETECTION disabled, semantic_vad, or server_vad

Terminal client:
  The terminal console controls a remote Hermes Live session without native
  audio dependencies. Use /tasks, /status <taskId>, /result <taskId>,
  /followup <taskId> <text>, and /stop <taskId>. Quitting only detaches;
  server-owned tasks keep running.
  For local microphone use, run Hermes and press Ctrl+B for official Hermes
  Voice Mode. Use the Dashboard/browser UI for gateway audio.

Plugin options:
  --dir <path>              Hermes plugins directory, default ~/.hermes/plugins
  --copy                    Copy plugin files, default
  --symlink                 Symlink plugin directory instead of copying
  --force                   Replace an existing hermes-live plugin install
`);
}

function parseTerminalConversation(args: string[]): ConversationSelection {
  if (args.length === 0 || (args.length === 1 && args[0] === "--new")) {
    return { mode: "new", title: "Terminal" };
  }
  if (args.length === 1 && args[0] === "--unbound") return { mode: "unbound" };
  if (args.length === 2 && args[0] === "--resume") {
    const sessionId = args[1]!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(sessionId)) {
      throw new Error("--resume requires a safe Hermes session ID.");
    }
    return { mode: "resume", sessionId };
  }
  throw new Error("Usage: hermes-live terminal [--new | --resume <sessionId> | --unbound]");
}

async function runServiceCommand(args: string[]): Promise<void> {
  const action = (args[0] ?? "status") as ServiceAction;
  if (!["install", "uninstall", "start", "stop", "restart", "status", "logs"].includes(action)) {
    throw new Error(`Unknown service action: ${action}`);
  }
  if (args.length > 1) {
    throw new Error(`Unknown service option: ${args[1]}`);
  }
  const result = await runServiceAction(action);
  if (action === "logs" && "stdout" in result) {
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    if (result.code !== 0) process.exitCode = result.code;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
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

function parsePluginOptions(args: string[]): PluginInstallOptions {
  const options: PluginInstallOptions = { mode: "copy", force: false };
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

async function runTextClient(config: AppConfig, text: string): Promise<void> {
  const url = normalizeGatewayWebSocketUrl(process.env.HERMES_LIVE_URL ?? defaultGatewayWebSocketUrl(config));
  const headers = config.server.authToken ? { authorization: `Bearer ${config.server.authToken}` } : undefined;
  const readyTimeoutMs = positiveInt(
    process.env.HERMES_LIVE_CLIENT_READY_TIMEOUT_MS,
    DEFAULT_TEXT_CLIENT_READY_TIMEOUT_MS,
  );
  const resultTimeoutMs = positiveInt(
    process.env.HERMES_LIVE_CLIENT_RESULT_TIMEOUT_MS,
    DEFAULT_TEXT_CLIENT_RESULT_TIMEOUT_MS,
  );
  const ws = new WebSocket(url, {
    ...(headers ? { headers } : {}),
    handshakeTimeout: readyTimeoutMs,
    followRedirects: false,
    maxPayload: textClientServerMessageBytes(config),
    perMessageDeflate: false,
  });
  const state: TextClientState = {
    directTranscript: [],
    directTranscriptChars: 0,
    knownTaskIds: new Set(),
    sessionReady: false,
    finished: false,
  };

  await new Promise<void>((resolve, reject) => {
    let inboundQueue = Promise.resolve();
    let readyTimeout: NodeJS.Timeout | undefined;
    let resultTimeout: NodeJS.Timeout | undefined;
    const clearTimers = (): void => {
      if (readyTimeout) clearTimeout(readyTimeout);
      if (resultTimeout) clearTimeout(resultTimeout);
      if (state.directCompletionTimer) clearTimeout(state.directCompletionTimer);
      readyTimeout = undefined;
      resultTimeout = undefined;
      state.directCompletionTimer = undefined;
    };
    const finish = (error?: Error, terminate = false): void => {
      if (state.finished) return;
      state.finished = true;
      clearTimers();
      if (terminate && ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      } else if (ws.readyState === WebSocket.OPEN) {
        try {
          sendTextClientMessage(ws, { type: "session.close", id: "client_close", detach: true });
        } finally {
          ws.close(1000, "client detached");
        }
      }
      error ? reject(error) : resolve();
    };
    const markSessionReady = (): void => {
      if (readyTimeout) clearTimeout(readyTimeout);
      readyTimeout = undefined;
      resultTimeout = setTimeout(() => {
        const message = state.boundTaskId
          ? `Timed out waiting for Hermes task ${state.boundTaskId}; the one-shot client detached and the server-owned task may still be running.`
          : "Timed out waiting for the realtime response; the one-shot client detached.";
        finish(new Error(message));
      }, resultTimeoutMs);
      resultTimeout.unref?.();
    };
    const scheduleDirectCompletion = (): void => {
      if (state.directCompletionTimer || state.boundTaskId) return;
      state.directCompletionTimer = setTimeout(() => {
        state.directCompletionTimer = undefined;
        if (!state.boundTaskId) finishDirectResponse(state, finish);
      }, DIRECT_RESPONSE_SETTLE_MS);
      state.directCompletionTimer.unref?.();
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
        .then(() => handleClientServerMessage(ws, raw, text, state, markSessionReady, scheduleDirectCompletion, finish))
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error)), true));
    });
  });
}

async function handleClientServerMessage(
  ws: WebSocket,
  raw: WebSocket.RawData,
  text: string,
  state: TextClientState,
  markSessionReady: () => void,
  scheduleDirectCompletion: () => void,
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
      sendTextClientMessage(ws, { type: "text.input", id: "client_input", text });
      break;
    }
    case "task.accepted": {
      const taskId = message.taskId;
      if (!state.boundTaskId && state.knownTaskIds.has(taskId)) break;
      if (!state.boundTaskId) {
        state.boundTaskId = taskId;
        state.knownTaskIds.add(taskId);
        if (state.directCompletionTimer) clearTimeout(state.directCompletionTimer);
        state.directCompletionTimer = undefined;
        console.error(`Hermes task accepted: ${sanitizeTerminalText(taskId, MAX_TEXT_CLIENT_ID_CHARS)}`);
      } else if (state.boundTaskId !== taskId) {
        console.error(
          `Additional Hermes task accepted: ${sanitizeTerminalText(taskId, MAX_TEXT_CLIENT_ID_CHARS)}; waiting for ${sanitizeTerminalText(state.boundTaskId, MAX_TEXT_CLIENT_ID_CHARS)}.`,
        );
      }
      break;
    }
    case "transcript.delta": {
      if (!state.boundTaskId && message.speaker === "assistant") {
        const delta = message.text;
        state.directTranscriptChars += delta.length;
        if (state.directTranscriptChars > MAX_TEXT_CLIENT_OUTPUT_CHARS) {
          throw new Error("Gateway direct transcript exceeded the one-shot client output limit.");
        }
        state.directTranscript.push(delta);
      }
      break;
    }
    case "response.completed":
      if (!state.boundTaskId) scheduleDirectCompletion();
      break;
    case "response.failed":
      if (!state.boundTaskId) finish(new Error(message.error));
      break;
    case "response.cancelled":
      if (!state.boundTaskId) finish(new Error("Realtime provider response was cancelled."));
      break;
    case "task.started":
      if (message.taskId === state.boundTaskId) {
        console.error(`Hermes task started: ${sanitizeTerminalText(message.taskId, MAX_TEXT_CLIENT_ID_CHARS)}`);
      }
      break;
    case "task.completed": {
      if (message.taskId !== state.boundTaskId) break;
      const output = message.result.output;
      if (output !== undefined) {
        printOneShotOutput(output);
        finish();
      } else {
        state.resultRequestId = "client_task_result";
        sendTextClientMessage(ws, {
          type: "task.get",
          id: state.resultRequestId,
          taskId: state.boundTaskId,
        });
      }
      break;
    }
    case "task.snapshot": {
      if (message.reason === "initial" || message.reason === "reconnect") {
        for (const task of message.tasks) state.knownTaskIds.add(task.taskId);
        break;
      }
      if (!state.resultRequestId || message.requestId !== state.resultRequestId) break;
      if (message.reason !== "get") throw new Error("Gateway task snapshot did not answer the one-shot task.get request.");
      if (message.tasks.length !== 1 || message.tasks[0]?.taskId !== state.boundTaskId) {
        throw new Error("Gateway task.get snapshot did not match the accepted Hermes task.");
      }
      finishFromTaskSnapshot(message.tasks[0], finish);
      break;
    }
    case "task.failed":
      if (message.taskId === state.boundTaskId) finish(new Error(`Hermes task failed: ${message.error.message}`));
      break;
    case "task.cancelled":
      if (message.taskId === state.boundTaskId) {
        finish(new Error(`Hermes task was cancelled${message.reason ? `: ${message.reason}` : "."}`));
      }
      break;
    case "task.unknown":
      if (message.taskId === state.boundTaskId) finish(new Error(`Hermes task outcome is unknown: ${message.error.message}`));
      break;
    case "session.error":
      finish(new Error(message.message));
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
  knownTaskIds: Set<string>;
  sessionReady: boolean;
  finished: boolean;
  boundTaskId?: string;
  resultRequestId?: string;
  directCompletionTimer?: NodeJS.Timeout;
}

function parseTextClientServerMessage(raw: WebSocket.RawData): ServerMessage {
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
  if (message.type === "session.ready" && message.protocolVersion !== HERMES_LIVE_PROTOCOL_VERSION) {
    throw new Error(
      `Gateway protocol mismatch: expected v${HERMES_LIVE_PROTOCOL_VERSION}, received ${String(message.protocolVersion)}.`,
    );
  }
  try {
    return parseProtocolServerMessage(value);
  } catch {
    throw new Error(`Gateway ${message.type} did not match the bounded protocol-v${HERMES_LIVE_PROTOCOL_VERSION} schema.`);
  }
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

function sendTextClientMessage(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("Gateway WebSocket is not open.");
  ws.send(JSON.stringify(message));
}

function textClientServerMessageBytes(config: AppConfig): number {
  const base64AudioBytes = Math.ceil((config.server.maxAudioBytes * 4) / 3) + 4_096;
  return Math.max(MIN_TEXT_CLIENT_SERVER_MESSAGE_BYTES, base64AudioBytes);
}

function printOneShotOutput(output: string): void {
  console.log(sanitizeTerminalText(output, MAX_TEXT_CLIENT_OUTPUT_CHARS));
}

function finishFromTaskSnapshot(task: PublicTaskSnapshot, finish: (error?: Error) => void): void {
  if (task.state === "completed") {
    printOneShotOutput(task.result?.output ?? task.result?.summary ?? "");
    finish();
    return;
  }
  if (task.state === "failed" || task.state === "unknown") {
    finish(new Error(`Hermes task ${task.state}: ${task.error?.message ?? "No result is available."}`));
    return;
  }
  if (task.state === "cancelled") {
    finish(new Error("Hermes task was cancelled."));
    return;
  }
  finish(new Error(`Hermes task.get returned ${task.state} instead of a completed result.`));
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
