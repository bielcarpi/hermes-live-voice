import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, type RealtimeProvider } from "../config.js";
import { runLiveProviderSmoke } from "../live-provider-smoke.js";
import { buildReadinessReport, type ReadinessReport } from "../readiness.js";
import {
  readManagedConfig,
  MANAGED_CONFIG_KEYS,
  writeManagedConfig,
  type ManagedConfigValues,
} from "./managed-config.js";
import { installHermesPlugin, type PluginInstallStatus } from "./plugin-installer.js";
import { findExecutable, runCommand, type CommandRunner } from "./process.js";
import { runServiceAction, type ServiceStatus } from "./service-manager.js";

const MAX_LEGACY_ENV_BYTES = 64 * 1024;
const DEFAULT_GATEWAY_READY_TIMEOUT_MS = 15_000;

export interface SetupOptions {
  provider?: RealtimeProvider;
  hermesUrl?: string;
  configPath?: string;
  pluginsDir?: string;
  hermesCommand?: string;
  enablePlugin: boolean;
  service: boolean;
  nonInteractive: boolean;
  json: boolean;
}

export interface SetupReport {
  ok: boolean;
  config: { path: string; written: boolean };
  provider: RealtimeProvider;
  plugin: PluginInstallStatus;
  hermesCli: {
    command?: string;
    enabled: boolean;
    skipped: boolean;
    error?: string;
  };
  readiness: ReadinessReport;
  providerSession: { checked: boolean; ok: boolean; error?: string };
  service: ServiceStatus | { skipped: true; reason: string };
  gateway: { checked: boolean; ready: boolean; url: string; error?: string };
  nextSteps: string[];
}

export interface SetupDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  cliPath?: string;
  runner?: CommandRunner;
  findCommand?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  prompt?: (message: string) => Promise<string>;
  promptSecret?: (message: string) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  gatewayReadyTimeoutMs?: number;
}

export function parseSetupOptions(args: string[]): SetupOptions {
  const options: SetupOptions = {
    enablePlugin: true,
    service: true,
    nonInteractive: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const nextValue = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--provider") options.provider = parseProvider(nextValue());
    else if (argument?.startsWith("--provider=")) options.provider = parseProvider(argument.slice(11));
    else if (argument === "--hermes-url") options.hermesUrl = nextValue();
    else if (argument?.startsWith("--hermes-url=")) options.hermesUrl = argument.slice(13);
    else if (argument === "--config") options.configPath = nextValue();
    else if (argument?.startsWith("--config=")) options.configPath = argument.slice(9);
    else if (argument === "--plugins-dir") options.pluginsDir = nextValue();
    else if (argument?.startsWith("--plugins-dir=")) options.pluginsDir = argument.slice(14);
    else if (argument === "--hermes-command") options.hermesCommand = nextValue();
    else if (argument?.startsWith("--hermes-command=")) options.hermesCommand = argument.slice(17);
    else if (argument === "--no-enable") options.enablePlugin = false;
    else if (argument === "--no-service") options.service = false;
    else if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") throw new SetupHelpRequested();
    else if (argument) throw new Error(`Unknown setup option: ${argument}`);
  }
  return options;
}

export async function runSetup(
  options: SetupOptions,
  dependencies: SetupDependencies = {},
): Promise<SetupReport> {
  const env = dependencies.env ?? process.env;
  const home = resolve(dependencies.home ?? homedir());
  const runner = dependencies.runner ?? runCommand;
  const findCommand = dependencies.findCommand ?? findExecutable;
  const existing = await readManagedConfig({ path: options.configPath, home });
  const legacy = await readLegacyHermesEnvironment(home);
  const inherited = firstDefinedEnvironment(env, existing.values, legacy);
  const provider = await selectProvider(options, inherited, dependencies);
  const hermesApiKey = await requireSecret(
    "Hermes API_SERVER_KEY: ",
    inherited.HERMES_AGENT_API_SERVER_KEY ?? inherited.HERMES_API_KEY ?? legacy.API_SERVER_KEY,
    options,
    dependencies,
  );
  const values: ManagedConfigValues = {
    ...managedValuesFromEnvironment(inherited),
    HERMES_BASE_URL: options.hermesUrl ?? inherited.HERMES_BASE_URL ?? "http://127.0.0.1:8642",
    HERMES_AGENT_API_SERVER_KEY: hermesApiKey,
    HERMES_LIVE_PROVIDER: provider,
    HERMES_LIVE_HOST: inherited.HERMES_LIVE_HOST ?? "127.0.0.1",
    HERMES_LIVE_PORT: inherited.HERMES_LIVE_PORT ?? "8788",
    HERMES_LIVE_DEMO_ENABLED: inherited.HERMES_LIVE_DEMO_ENABLED ?? "true",
  };
  delete values.HERMES_API_KEY;

  if (provider === "gemini") {
    if (isEnabled(inherited.GOOGLE_GENAI_USE_ENTERPRISE)) {
      values.GOOGLE_GENAI_USE_ENTERPRISE = "true";
      values.GOOGLE_CLOUD_PROJECT = await requireTextValue(
        "Google Cloud project ID: ",
        inherited.GOOGLE_CLOUD_PROJECT,
        options,
        dependencies,
      );
    } else {
      values.GEMINI_API_KEY = await requireSecret(
        "Gemini API key: ",
        inherited.GEMINI_API_KEY ?? inherited.GOOGLE_API_KEY,
        options,
        dependencies,
      );
    }
  } else if (provider === "openai") {
    values.OPENAI_API_KEY = await requireSecret(
      "OpenAI API key: ",
      inherited.OPENAI_API_KEY,
      options,
      dependencies,
    );
  }

  const configPath = await writeManagedConfig(values, { path: options.configPath, home });
  const plugin = await installHermesPlugin({
    ...(options.pluginsDir ? { dir: options.pluginsDir } : {}),
    mode: "copy",
    force: true,
  });
  const hermesCli = await enableHermesPlugin(options, env, runner, findCommand);
  const config = loadConfig({ ...values, ...env });
  const readiness = await buildReadinessReport(config);
  const providerSession = await checkProviderSession(config);
  let service: SetupReport["service"] = { skipped: true, reason: "Service installation was disabled." };
  let gateway: SetupReport["gateway"] = {
    checked: false,
    ready: false,
    url: `http://${config.server.host}:${config.server.port}/ready`,
  };

  if (options.service && readiness.ok && providerSession.ok) {
    const serviceOptions = {
      home,
      platform: dependencies.platform,
      nodePath: dependencies.nodePath,
      cliPath: dependencies.cliPath,
      configPath,
      runner,
    };
    await runServiceAction("install", serviceOptions);
    service = await runServiceAction("start", serviceOptions) as ServiceStatus;
    gateway = await waitForGateway(config, dependencies);
  } else if (options.service) {
    service = { skipped: true, reason: "Service was not installed because the readiness preflight failed." };
  }

  const nextSteps = setupNextSteps({ options, readiness, providerSession, hermesCli, service, gateway });
  const ok = readiness.ok
    && providerSession.ok
    && (hermesCli.enabled || hermesCli.skipped)
    && (!options.service || (!("skipped" in service) && service.running && gateway.ready));
  return {
    ok,
    config: { path: configPath, written: true },
    provider,
    plugin,
    hermesCli,
    readiness,
    providerSession,
    service,
    gateway,
    nextSteps,
  };
}

export async function runSetupCommand(args: string[]): Promise<void> {
  let options: SetupOptions;
  try {
    options = parseSetupOptions(args);
  } catch (error) {
    if (error instanceof SetupHelpRequested) {
      printSetupHelp();
      return;
    }
    throw error;
  }
  let report: SetupReport;
  try {
    report = await runSetup(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup failed.";
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else {
      console.error(`Setup could not finish: ${message}`);
      console.error("No API key was printed. Fix the issue and run `hermes-live setup` again.");
    }
    process.exitCode = 1;
    return;
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printSetupReport(report);
  if (!report.ok) process.exitCode = 1;
}

export function printSetupHelp(): void {
  console.log(`hermes-live setup

Configure voice, install the Hermes plugin, verify both runtimes, and start the gateway.

Options:
  --provider <gemini|openai|mock>  Realtime voice provider
  --hermes-url <url>               Hermes API Server URL
  --config <path>                  Managed config path
  --plugins-dir <path>             Hermes plugins directory
  --hermes-command <path>          Hermes executable to enable the plugin
  --no-enable                      Install but do not enable the Hermes plugin
  --no-service                     Configure only; run hermes-live serve manually
  --non-interactive                Never prompt; fail when required values are missing
  --json                           Print a machine-readable report

API keys are read from the current environment, an existing managed config, or
~/.hermes/.env. Setup prompts securely for missing keys; secret CLI flags are not accepted.
`);
}

function printSetupReport(report: SetupReport): void {
  console.log(report.ok ? "Hermes Live Voice is ready." : "Hermes Live Voice needs attention.");
  console.log(`  Config: ${shortHome(report.config.path)}`);
  console.log(`  Provider: ${report.provider}`);
  console.log(`  Plugin: ${report.plugin.manifestFound ? "installed" : "missing"}`);
  console.log(`  Hermes plugin: ${report.hermesCli.enabled ? "enabled" : report.hermesCli.skipped ? "skipped" : "not enabled"}`);
  console.log(`  Hermes API: ${report.readiness.hermes.ok ? "ready" : "not ready"}`);
  console.log(`  Voice provider: ${report.providerSession.ok ? report.providerSession.checked ? "verified" : "configured" : "not ready"}`);
  console.log(`  Gateway: ${report.gateway.ready ? "ready" : report.gateway.checked ? "not ready" : "not started"}`);
  if (report.nextSteps.length > 0) {
    console.log("\nNext:");
    for (const step of report.nextSteps) console.log(`  - ${step}`);
  }
}

async function selectProvider(
  options: SetupOptions,
  inherited: Record<string, string | undefined>,
  dependencies: SetupDependencies,
): Promise<RealtimeProvider> {
  if (options.provider) return options.provider;
  const configured = inherited.HERMES_LIVE_PROVIDER;
  if (configured === "gemini" || configured === "openai" || configured === "mock") return configured;
  if (inherited.OPENAI_API_KEY && !inherited.GEMINI_API_KEY && !inherited.GOOGLE_API_KEY) return "openai";
  if (options.nonInteractive) return "gemini";
  const answer = (await (dependencies.prompt ?? promptText)("Voice provider [gemini/openai/mock] (gemini): ")).trim();
  return answer ? parseProvider(answer) : "gemini";
}

async function requireSecret(
  prompt: string,
  existing: string | undefined,
  options: SetupOptions,
  dependencies: SetupDependencies,
): Promise<string> {
  if (existing) return existing;
  if (options.nonInteractive) {
    throw new Error(`${prompt.replace(/:\s*$/u, "")} is required in non-interactive mode.`);
  }
  const value = (await (dependencies.promptSecret ?? promptHidden)(prompt)).trim();
  if (!value) throw new Error(`${prompt.replace(/:\s*$/u, "")} is required.`);
  return value;
}

async function requireTextValue(
  prompt: string,
  existing: string | undefined,
  options: SetupOptions,
  dependencies: SetupDependencies,
): Promise<string> {
  if (existing) return existing;
  if (options.nonInteractive) {
    throw new Error(`${prompt.replace(/:\s*$/u, "")} is required in non-interactive mode.`);
  }
  const value = (await (dependencies.prompt ?? promptText)(prompt)).trim();
  if (!value) throw new Error(`${prompt.replace(/:\s*$/u, "")} is required.`);
  return value;
}

async function enableHermesPlugin(
  options: SetupOptions,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
  findCommand: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>,
): Promise<SetupReport["hermesCli"]> {
  if (!options.enablePlugin) return { enabled: false, skipped: true };
  const command = options.hermesCommand
    ? await findCommand(options.hermesCommand, env)
    : await findCommand("hermes", env);
  if (!command) {
    return {
      enabled: false,
      skipped: false,
      error: "Hermes CLI was not found. Install Hermes or pass --hermes-command, then run `hermes plugins enable hermes-live`.",
    };
  }
  const result = await runner(command, ["plugins", "enable", "hermes-live"], { env });
  if (result.code !== 0) {
    return {
      command,
      enabled: false,
      skipped: false,
      error: result.stderr.trim() || result.stdout.trim() || `Hermes exited with code ${result.code}.`,
    };
  }
  return { command, enabled: true, skipped: false };
}

async function waitForGateway(
  config: ReturnType<typeof loadConfig>,
  dependencies: SetupDependencies,
): Promise<SetupReport["gateway"]> {
  const url = `http://${config.server.host}:${config.server.port}/ready`;
  const timeoutMs = dependencies.gatewayReadyTimeoutMs ?? DEFAULT_GATEWAY_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError = "Gateway did not become ready.";
  while (Date.now() < deadline) {
    try {
      const response = await (dependencies.fetch ?? globalThis.fetch)(url, {
        headers: config.server.authToken ? { authorization: `Bearer ${config.server.authToken}` } : {},
        signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok) {
        const body = await response.json() as { ok?: boolean };
        if (body.ok === true) return { checked: true, ready: true, url };
        lastError = "Gateway responded but its dependencies were not ready.";
      } else {
        lastError = `Gateway readiness returned HTTP ${response.status}.`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return { checked: true, ready: false, url, error: lastError };
}

async function readLegacyHermesEnvironment(home: string): Promise<Record<string, string | undefined>> {
  const path = join(home, ".hermes", ".env");
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return {};
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Hermes environment must be a regular file, not a symlink: ${path}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`Hermes environment must be owned by the current user: ${path}`);
  }
  if (stat.size > MAX_LEGACY_ENV_BYTES) throw new Error(`Hermes environment exceeds ${MAX_LEGACY_ENV_BYTES} bytes.`);
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const source = await handle.readFile("utf8");
    return parseLegacyEnvironment(source);
  } finally {
    await handle.close();
  }
}

function parseLegacyEnvironment(source: string): Record<string, string | undefined> {
  const accepted = new Set([
    "API_SERVER_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "HERMES_AGENT_API_SERVER_KEY",
    "HERMES_API_KEY",
    "HERMES_BASE_URL",
    "HERMES_LIVE_DEMO_ENABLED",
    "HERMES_LIVE_HOST",
    "HERMES_LIVE_PORT",
    "HERMES_LIVE_PROVIDER",
    "OPENAI_API_KEY",
  ]);
  const result: Record<string, string | undefined> = {};
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    if (!accepted.has(key)) continue;
    result[key] = unquoteLegacyValue(normalized.slice(separator + 1).trim());
  }
  return result;
}

function unquoteLegacyValue(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replaceAll("\\\"", '"').replaceAll("\\\\", "\\") : inner;
  }
  return value;
}

function firstDefinedEnvironment(
  env: NodeJS.ProcessEnv,
  managed: ManagedConfigValues,
  legacy: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const keys = new Set([...Object.keys(legacy), ...Object.keys(managed), ...Object.keys(env)]);
  return Object.fromEntries([...keys].map((key) => [key, env[key] || managed[key as keyof ManagedConfigValues] || legacy[key]]));
}

function setupNextSteps(input: {
  options: SetupOptions;
  readiness: ReadinessReport;
  providerSession: SetupReport["providerSession"];
  hermesCli: SetupReport["hermesCli"];
  service: SetupReport["service"];
  gateway: SetupReport["gateway"];
}): string[] {
  const steps: string[] = [];
  if (!input.hermesCli.enabled && !input.hermesCli.skipped) {
    steps.push(input.hermesCli.error ?? "Run `hermes plugins enable hermes-live`.");
  }
  if (!input.readiness.hermes.ok) {
    steps.push(`Start the Hermes API Server and fix its readiness error: ${String(input.readiness.hermes.error ?? "unavailable")}`);
  }
  if (!input.readiness.realtime.ok) {
    steps.push(`Run \`hermes-live setup\` again with a working provider key: ${String(input.readiness.realtime.error ?? "provider unavailable")}`);
  }
  if (!input.providerSession.ok) {
    steps.push(`Fix the realtime provider connection, then rerun \`hermes-live setup\`: ${input.providerSession.error ?? "connection failed"}`);
  }
  if (!input.options.service) {
    steps.push("Start the gateway with `hermes-live serve`.");
  } else if (!("skipped" in input.service) && !input.gateway.ready) {
    steps.push("Run `hermes-live service logs`, then `hermes-live doctor`.");
  }
  if (input.readiness.ok && (input.hermesCli.enabled || input.hermesCli.skipped) && (input.gateway.ready || !input.options.service)) {
    steps.push("Open `hermes dashboard` and choose Live Voice.");
  }
  return steps;
}

function parseProvider(value: string): RealtimeProvider {
  if (value === "gemini" || value === "openai" || value === "mock") return value;
  throw new Error(`Unsupported provider: ${value}. Choose gemini, openai, or mock.`);
}

async function checkProviderSession(config: ReturnType<typeof loadConfig>): Promise<SetupReport["providerSession"]> {
  if (config.realtime.provider === "mock") return { checked: false, ok: true };
  try {
    await runLiveProviderSmoke(config, { timeoutMs: config.server.providerReadyTimeoutMs });
    return { checked: true, ok: true };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      error: error instanceof Error ? error.message : "Realtime provider connection failed.",
    };
  }
}

function managedValuesFromEnvironment(values: Record<string, string | undefined>): ManagedConfigValues {
  const managed: ManagedConfigValues = {};
  for (const key of MANAGED_CONFIG_KEYS) {
    if (values[key]) managed[key] = values[key];
  }
  return managed;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

async function promptText(message: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(message);
  } finally {
    readline.close();
  }
}

async function promptHidden(message: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("A required API key is missing and cannot be prompted without a TTY. Set it in the environment and rerun setup.");
  }
  stdout.write(message);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolveValue, reject) => {
    let value = "";
    const restore = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          restore();
          reject(new Error("Setup cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          restore();
          resolveValue(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

function shortHome(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

class SetupHelpRequested extends Error {}
