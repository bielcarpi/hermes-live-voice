#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { access, cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stdin as input, stderr as approvalOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { ApprovalChoiceSchema } from "./protocol.js";
import { buildReadinessReport } from "./readiness.js";
import { startServer } from "./adapters/inbound/http/server.js";
import { runLiveProviderSmoke } from "./live-provider-smoke.js";
import { errorToMessage } from "./domain/error-message.js";

const logger = createLogger((process.env.HERMES_LIVE_LOG_LEVEL as any) ?? "info");

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
  hermes-live serve         Start the realtime gateway and web demo
  hermes-live dev           Alias for serve
  hermes-live client "..."  Send one text prompt through a running gateway
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
  OPENAI_REALTIME_MODEL     OpenAI Realtime model, default gpt-realtime-2.1
  OPENAI_REALTIME_TURN_DETECTION disabled, semantic_vad, or server_vad

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
