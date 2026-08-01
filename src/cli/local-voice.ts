import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { isLoopbackHostname } from "../config.js";
import { findExecutable } from "./process.js";

export const HUGGINGFACE_SPEECH_TO_SPEECH_VERSION = "0.2.11";

export interface LocalVoiceCommand {
  command: string;
  args: string[];
  environment?: Record<string, string>;
}

interface LocalVoiceDependencies {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  findCommand?: typeof findExecutable;
  runForeground?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

export async function runLocalVoiceCommand(
  args: string[],
  config: Pick<AppConfig, "local">,
  dependencies: LocalVoiceDependencies = {},
): Promise<void> {
  const action = args[0] ?? "start";
  if (action === "help" || action === "--help" || action === "-h") {
    printLocalVoiceHelp();
    return;
  }
  if (!["start", "command"].includes(action)) {
    throw new Error(`Unknown local voice action: ${action}. Choose start or command.`);
  }
  if (args.length > 1) throw new Error(`Unknown local voice option: ${args[1]}`);

  const env = dependencies.env ?? process.env;
  const uv = await (dependencies.findCommand ?? findExecutable)("uv", env);
  if (!uv) {
    throw new Error(
      "uv is required for the managed local voice launcher. Install uv from https://docs.astral.sh/uv/ and rerun `hermes-live local`.",
    );
  }
  const platform = dependencies.platform ?? process.platform;
  const command = buildLocalVoiceCommand({
    uv,
    endpoint: config.local.url,
    platform,
    arch: dependencies.arch ?? process.arch,
    caBundle: findMacCaBundle(env, platform),
  });
  if (action === "command") {
    console.log(renderCommand(command));
    return;
  }

  console.log(
    `Starting Hugging Face speech-to-speech ${HUGGINGFACE_SPEECH_TO_SPEECH_VERSION} on ${publicLocalEndpoint(config.local.url)}.`,
  );
  console.log("The first start downloads Python packages and model weights. Keep this terminal open; Ctrl+C stops local voice.");
  const code = await (dependencies.runForeground ?? runForeground)(
    command.command,
    command.args,
    { ...env, ...command.environment },
  );
  if (code !== 0) throw new Error(`Hugging Face speech-to-speech exited with code ${code}.`);
}

export function buildLocalVoiceCommand(input: {
  uv: string;
  endpoint: string;
  platform: NodeJS.Platform;
  arch: string;
  caBundle?: string;
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
  return {
    command: input.uv,
    ...(input.caBundle ? { environment: { SSL_CERT_FILE: input.caBundle } } : {}),
    args: [
      "tool",
      "run",
      "--python",
      "3.12",
      "--from",
      `speech-to-speech==${HUGGINGFACE_SPEECH_TO_SPEECH_VERSION}`,
      "speech-to-speech",
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
      "mlx-community/Qwen3-4B-Instruct-2507-4bit",
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
      "--num_pipelines",
      "1",
    ],
  };
}

export function printLocalVoiceHelp(): void {
  console.log(`hermes-live local

Run the tested fully-local Hugging Face speech-to-speech profile on Apple Silicon.

Usage:
  hermes-live local          Install/cache dependencies as needed and run in the foreground
  hermes-live local start    Same as above
  hermes-live local command  Print the exact pinned command without running it

The voice server listens at HERMES_LIVE_LOCAL_URL (default ws://127.0.0.1:8765/v1/realtime).
Use Ctrl+C to stop it. Other platforms can run any speech-to-speech realtime server separately.
`);
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
