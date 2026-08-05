import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { totalmem } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { isLoopbackHostname } from "../config.js";
import { findExecutable, type CommandRunner } from "./process.js";
import {
  runServiceAction,
  type ServiceAction,
  type ServiceCommand,
  type ServiceStatus,
} from "./service-manager.js";

export const HUGGINGFACE_SPEECH_TO_SPEECH_VERSION = "0.2.11";
export const MIN_MANAGED_LOCAL_MEMORY_BYTES = 12 * 1024 * 1024 * 1024;
export const MANAGED_LOCAL_MIN_SILENCE_MS = 700;
export const MANAGED_LOCAL_MAX_NEW_TOKENS = 96;
export const MANAGED_LOCAL_ENTRYPOINT = fileURLToPath(
  new URL("../../assets/huggingface-realtime-entry.py", import.meta.url),
);

export interface LocalVoiceCommand extends ServiceCommand {}

interface LocalVoiceDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemoryBytes?: number;
  uid?: number;
  runner?: CommandRunner;
  findCommand?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  runForeground?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  probeEndpoint?: (url: string) => Promise<boolean>;
}

export interface LocalVoiceServiceStatus extends ServiceStatus {
  endpoint: {
    url: string;
    listening: boolean;
  };
}

export async function runLocalVoiceCommand(
  args: string[],
  config: Pick<AppConfig, "local">,
  dependencies: LocalVoiceDependencies = {},
): Promise<void> {
  const action = args[0] ?? "status";
  if (action === "help" || action === "--help" || action === "-h") {
    printLocalVoiceHelp();
    return;
  }
  if (!["run", "command", "start", "stop", "restart", "uninstall", "status", "logs"].includes(action)) {
    throw new Error(`Unknown local voice action: ${action}. Choose start, stop, restart, uninstall, status, logs, run, or command.`);
  }
  if (args.length > 1) throw new Error(`Unknown local voice option: ${args[1]}`);

  if (action === "logs") {
    const result = await runServiceAction(action as ServiceAction, {
      kind: "local-voice",
      home: dependencies.home,
      platform: dependencies.platform,
      uid: dependencies.uid,
      runner: dependencies.runner,
    });
    printServiceResult(action, result);
    return;
  }

  if (["stop", "uninstall", "status"].includes(action)) {
    const result = await runServiceAction(action as ServiceAction, {
      kind: "local-voice",
      home: dependencies.home,
      platform: dependencies.platform,
      uid: dependencies.uid,
      runner: dependencies.runner,
    }) as ServiceStatus;
    console.log(JSON.stringify(await localVoiceServiceStatus(config, result, dependencies.probeEndpoint), null, 2));
    return;
  }

  const env = dependencies.env ?? process.env;
  const command = await resolveLocalVoiceCommand(config, dependencies);
  if (action === "command") {
    console.log(renderCommand(command));
    return;
  }

  if (action === "start" || action === "restart") {
    const serviceOptions = {
      kind: "local-voice" as const,
      command,
      home: dependencies.home,
      platform: dependencies.platform,
      uid: dependencies.uid,
      runner: dependencies.runner,
    };
    const installed = await runServiceAction("install", serviceOptions) as ServiceStatus;
    const result = installed.running
      ? installed
      : await runServiceAction("start", serviceOptions) as ServiceStatus;
    console.log(JSON.stringify(await localVoiceServiceStatus(config, result, dependencies.probeEndpoint), null, 2));
    return;
  }

  console.log(
    `Starting Hugging Face speech-to-speech ${HUGGINGFACE_SPEECH_TO_SPEECH_VERSION} on ${publicLocalEndpoint(config.local.url)}.`,
  );
  console.log("The first run downloads Python packages and model weights. Keep this terminal open; Ctrl+C stops local voice.");
  const code = await (dependencies.runForeground ?? runForeground)(
    command.command,
    command.args,
    { ...env, ...command.environment },
  );
  if (code !== 0) throw new Error(`Hugging Face speech-to-speech exited with code ${code}.`);
}

export async function probeLocalVoiceEndpoint(url: string, timeoutMs = 350): Promise<boolean> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    return false;
  }
  if (endpoint.protocol !== "ws:" || !isLoopbackHostname(endpoint.hostname)) return false;
  const port = endpoint.port ? Number(endpoint.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  const host = endpoint.hostname === "localhost"
    ? "127.0.0.1"
    : endpoint.hostname.replace(/^\[(.*)\]$/u, "$1");
  return await new Promise<boolean>((resolveProbe) => {
    const socket = new Socket();
    let settled = false;
    const settle = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect({ host, port });
  });
}

export function localVoiceStartupProgress(logs: string): string | undefined {
  if (/Uvicorn running on|realtime server.*(?:ready|running)|application startup complete/iu.test(logs)) {
    return "Local voice models are ready. Verifying the private voice session.";
  }
  if (/Qwen3-TTS.*(?:warmed up|model loaded)|warming up Qwen3TTSHandler/iu.test(logs)) {
    return "Warming up local speech output. This is the last model stage.";
  }
  if (/Loading Qwen3-TTS|mlx-audio.*Qwen3/iu.test(logs)) {
    return "Loading the local speech model.";
  }
  if (/LLM Language Model Handler setup|LLM Backend:|mlx[-_ ]lm|Loading.*Qwen3(?:\.5)?/iu.test(logs)) {
    return "Loading the local language model.";
  }
  if (/Parakeet|speech.to.text|STT/iu.test(logs)) {
    return "Loading the local transcription model.";
  }
  if (/Downloading|Resolved \d+ packages|Installed \d+ packages|Building/iu.test(logs)) {
    return "Installing the pinned local voice runtime.";
  }
  return undefined;
}

async function localVoiceServiceStatus(
  config: Pick<AppConfig, "local">,
  status: ServiceStatus,
  probe: (url: string) => Promise<boolean> = probeLocalVoiceEndpoint,
): Promise<LocalVoiceServiceStatus> {
  const url = publicLocalEndpoint(config.local.url);
  const listening = await probe(config.local.url).catch(() => false);
  let detail = status.detail;
  if (status.running && listening) {
    detail = "Local voice service is running and its configured endpoint is listening.";
  } else if (status.running) {
    detail = "Local voice service is running; models are still loading or the provider has not opened its endpoint.";
  } else if (listening) {
    detail = `${status.detail} Another process is listening at the configured endpoint.`;
  }
  return { ...status, detail, endpoint: { url, listening } };
}

export async function resolveLocalVoiceCommand(
  config: Pick<AppConfig, "local">,
  dependencies: Pick<
    LocalVoiceDependencies,
    "env" | "platform" | "arch" | "totalMemoryBytes" | "findCommand"
  > = {},
): Promise<LocalVoiceCommand> {
  const env = dependencies.env ?? process.env;
  const uv = await (dependencies.findCommand ?? findExecutable)("uv", env);
  if (!uv) {
    throw new Error(
      "uv is required for fully local voice. Install it with `brew install uv`, then rerun `hermes-live setup`.",
    );
  }
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const totalMemoryBytes = dependencies.totalMemoryBytes
    ?? (platform === process.platform && arch === process.arch ? totalmem() : undefined);
  if (
    platform === "darwin"
    && arch === "arm64"
    && totalMemoryBytes !== undefined
    && totalMemoryBytes < MIN_MANAGED_LOCAL_MEMORY_BYTES
  ) {
    throw new Error(
      "Managed local voice needs at least 12 GB of physical memory; a 16 GB Apple Silicon Mac is recommended. Choose OpenAI or Gemini in `hermes-live setup`, or use an external local voice endpoint.",
    );
  }
  return buildLocalVoiceCommand({
    uv,
    endpoint: config.local.url,
    platform,
    arch,
    caBundle: findMacCaBundle(env, platform),
  });
}

export function buildLocalVoiceCommand(input: {
  uv: string;
  endpoint: string;
  platform: NodeJS.Platform;
  arch: string;
  caBundle?: string;
  runtimeEntrypoint?: string;
}): LocalVoiceCommand {
  if (input.platform !== "darwin" || input.arch !== "arm64") {
    throw new Error(
      "The managed fully-local profile currently supports Apple Silicon. On other systems, run Hugging Face speech-to-speech in realtime mode and point HERMES_LIVE_LOCAL_URL at it.",
    );
  }
  const endpoint = new URL(input.endpoint);
  if (!isLoopbackHostname(endpoint.hostname) || endpoint.protocol !== "ws:") {
    throw new Error("`hermes-live local` can only launch a loopback ws:// endpoint.");
  }
  if (endpoint.pathname !== "/v1/realtime" || endpoint.search || endpoint.hash) {
    throw new Error("`hermes-live local` requires HERMES_LIVE_LOCAL_URL to end at /v1/realtime without query parameters.");
  }
  const port = endpoint.port ? Number(endpoint.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HERMES_LIVE_LOCAL_URL contains an invalid port.");
  }
  const host = endpoint.hostname === "localhost" ? "127.0.0.1" : endpoint.hostname.replace(/^\[(.*)\]$/u, "$1");
  const runtimeEntrypoint = input.runtimeEntrypoint ?? MANAGED_LOCAL_ENTRYPOINT;
  return {
    command: input.uv,
    environment: {
      HF_HUB_DISABLE_TELEMETRY: "1",
      ...(input.caBundle ? { SSL_CERT_FILE: input.caBundle } : {}),
    },
    args: [
      "run",
      // launchd/systemd use the user's home as their working directory. Do
      // not let an unrelated pyproject, .venv, .env, or uv configuration
      // change the managed voice environment. The global package/model cache
      // remains available, so this isolation does not make restarts cold.
      "--isolated",
      "--no-env-file",
      "--no-config",
      "--directory",
      dirname(runtimeEntrypoint),
      "--python",
      "3.12",
      "--with",
      `speech-to-speech==${HUGGINGFACE_SPEECH_TO_SPEECH_VERSION}`,
      "python",
      runtimeEntrypoint,
      // Do not use --local_mac_optimal_settings here. Upstream deliberately
      // forces that preset back to direct `local` microphone mode after
      // parsing, even when --mode realtime is also present. These are its
      // equivalent Apple Silicon model settings with the realtime transport
      // kept explicit for Hermes Live.
      "--device",
      "mps",
      "--stt",
      "parakeet-tdt",
      "--llm_backend",
      "mlx-lm",
      "--model_name",
      "mlx-community/Qwen3.5-2B-4bit",
      // Voice turns must stay short. Upstream holds one shared MLX lock for
      // the whole LLM generation, so its 1,024-token default can block TTS
      // and interruption for far longer than a live conversation can tolerate.
      "--llm_gen_max_new_tokens",
      String(MANAGED_LOCAL_MAX_NEW_TOKENS),
      "--tts",
      "qwen3",
      "--mode",
      "realtime",
      "--ws_host",
      host,
      "--ws_port",
      String(port),
      "--language",
      "auto",
      // The upstream 64ms default starts speculative LLM work during normal
      // sentence pauses. On a shared Apple GPU that generation can delay VAD
      // revision and interruption for tens of seconds. Wait through ordinary
      // pauses; the adapter supplies a bounded silence tail for manual stops.
      "--min_silence_ms",
      String(MANAGED_LOCAL_MIN_SILENCE_MS),
      "--num_pipelines",
      "1",
    ],
  };
}

export function printLocalVoiceHelp(): void {
  console.log(`hermes-live local

Manage the tested fully-local Hugging Face speech-to-speech profile on Apple Silicon.

Usage:
  hermes-live local          Show managed local voice status
  hermes-live local start    Install and start the background service
  hermes-live local stop     Stop the background service
  hermes-live local restart  Reinstall and restart the background service
  hermes-live local uninstall  Remove the background service
  hermes-live local logs     Show recent local voice logs
  hermes-live local run      Run in the foreground for debugging
  hermes-live local command  Print the exact pinned command without running it

The voice server listens at HERMES_LIVE_LOCAL_URL (default ws://127.0.0.1:8765/v1/realtime).
Normal installation is automatic through \`hermes-live setup\`. Other platforms can run any
speech-to-speech realtime server separately.
`);
}

function printServiceResult(action: string, result: Awaited<ReturnType<typeof runServiceAction>>): void {
  if (action === "logs" && "stdout" in result) {
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    if (result.code !== 0) process.exitCode = result.code;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function runForeground(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function publicLocalEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function renderCommand(value: LocalVoiceCommand): string {
  const environment = Object.entries(value.environment ?? {})
    .map(([key, setting]) => `${key}=${shellQuote(setting)}`);
  return [...environment, value.command, ...value.args].map((part, index) => {
    return index < environment.length ? part : shellQuote(part);
  }).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function findMacCaBundle(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== "darwin") return undefined;
  for (const candidate of [env.SSL_CERT_FILE, env.REQUESTS_CA_BUNDLE, env.CURL_CA_BUNDLE, "/etc/ssl/cert.pem"]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}
