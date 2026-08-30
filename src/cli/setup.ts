import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isLoopbackHostname, loadConfig, type RealtimeProvider } from "../config.js";
import {
  LOCAL_FUNCTIONAL_PROVIDER_SMOKE_TIMEOUT_MS,
  runLiveProviderSmoke,
} from "../live-provider-smoke.js";
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
import {
  localVoiceStartupProgress,
  probeLocalVoiceEndpoint,
  resolveLocalVoiceCommand,
  type LocalVoiceCommand,
} from "./local-voice.js";
import {
  gatewayOrigin,
  probeGatewayEndpoint,
  probeGatewayReadiness,
  type GatewayEndpointState,
} from "./gateway-probe.js";
import {
  ensureHermesApiEnvironment,
  generateHermesApiKey,
  isDefaultLocalHermesApi,
  resolveHermesHome,
} from "./hermes-api-bootstrap.js";

const MAX_LEGACY_ENV_BYTES = 64 * 1024;
const DEFAULT_GATEWAY_READY_TIMEOUT_MS = 15_000;
const DEFAULT_LOCAL_PROVIDER_READY_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_HERMES_API_READY_TIMEOUT_MS = 45_000;
const DEFAULT_GATEWAY_PORT = 8788;
const MAX_GATEWAY_PORT_CANDIDATES = 20;
const MAX_LOCAL_VOICE_PORT_CANDIDATES = 20;

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
  hermesGateway: {
    managed: boolean;
    configured: boolean;
    ready: boolean;
    action: "already-running" | "installed" | "skipped" | "failed";
    error?: string;
  };
  readiness: ReadinessReport;
  providerSession: { checked: boolean; ok: boolean; error?: string };
  localService: ServiceStatus | { skipped: true; reason: string; error?: string };
  service: ServiceStatus | { skipped: true; reason: string };
  gateway: { checked: boolean; ready: boolean; url: string; error?: string };
  nextSteps: string[];
}

export interface SetupDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemoryBytes?: number;
  uid?: number;
  nodePath?: string;
  cliPath?: string;
  runner?: CommandRunner;
  findCommand?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  prompt?: (message: string) => Promise<string>;
  promptSecret?: (message: string) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  gatewayReadyTimeoutMs?: number;
  hermesApiReadyTimeoutMs?: number;
  localProviderReadyTimeoutMs?: number;
  progress?: (message: string) => void;
  providerSessionCheck?: (config: ReturnType<typeof loadConfig>) => Promise<SetupReport["providerSession"]>;
  localProviderProgress?: () => Promise<string | undefined>;
  localEndpointProbe?: (url: string) => Promise<boolean>;
  gatewayEndpointProbe?: (host: string, port: number) => Promise<GatewayEndpointState>;
  readinessCheck?: (config: ReturnType<typeof loadConfig>) => Promise<ReadinessReport>;
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
  const hermesHome = resolveHermesHome(home, env);
  const runner = dependencies.runner ?? runCommand;
  const findCommand = dependencies.findCommand ?? findExecutable;
  const managedConfigPath = options.configPath
    ?? (env.HERMES_HOME ? join(hermesHome, "hermes-live", "config.env") : undefined);
  const pluginsDir = options.pluginsDir ?? join(hermesHome, "plugins");
  const existing = await readManagedConfig({ path: managedConfigPath, home });
  const legacy = await readLegacyHermesEnvironment(hermesHome);
  const inherited = firstDefinedEnvironment(env, existing.values, legacy);
  const provider = await selectProvider(options, inherited, dependencies);
  const hermesCommand = options.hermesCommand
    ? await findCommand(options.hermesCommand, env)
    : await findCommand("hermes", env);
  const hermesUrl = options.hermesUrl ?? inherited.HERMES_BASE_URL ?? "http://127.0.0.1:8642";
  const canManageHermesGateway = options.service
    && isDefaultLocalHermesApi(hermesUrl)
    && Boolean(hermesCommand);
  const existingHermesApiKey = env.HERMES_AGENT_API_SERVER_KEY
    ?? env.HERMES_API_KEY
    ?? env.API_SERVER_KEY
    ?? legacy.API_SERVER_KEY
    ?? existing.values.HERMES_AGENT_API_SERVER_KEY
    ?? existing.values.HERMES_API_KEY;
  const hermesApiKey = existingHermesApiKey
    ?? (canManageHermesGateway
      ? generateHermesApiKey()
      : await requireSecret("Hermes API_SERVER_KEY: ", undefined, options, dependencies));
  const values: ManagedConfigValues = {
    ...managedValuesFromEnvironment(inherited),
    HERMES_BASE_URL: hermesUrl,
    HERMES_AGENT_API_SERVER_KEY: hermesApiKey,
    HERMES_LIVE_PROVIDER: provider,
    HERMES_LIVE_HOST: inherited.HERMES_LIVE_HOST ?? "127.0.0.1",
    HERMES_LIVE_PORT: env.PORT ?? inherited.HERMES_LIVE_PORT ?? String(DEFAULT_GATEWAY_PORT),
  };
  delete values.HERMES_API_KEY;

  const initialConfig = loadConfig({ ...values, ...env });
  const gatewayPort = await resolveSetupGatewayPort({
    host: initialConfig.server.host,
    port: initialConfig.server.port,
    explicit: env.PORT !== undefined
      || env.HERMES_LIVE_PORT !== undefined
      || legacy.HERMES_LIVE_PORT !== undefined,
    probe: dependencies.gatewayEndpointProbe
      ?? ((host, port) => probeGatewayEndpoint(host, port)),
    progress: dependencies.progress,
  });
  values.HERMES_LIVE_PORT = String(gatewayPort);

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

  let preparedLocalVoiceCommand: LocalVoiceCommand | undefined;
  // This is an implementation detail of the pinned managed runtime, not a
  // portable local-provider preference. Never carry it from an earlier
  // managed install into an external or operator-managed realtime endpoint.
  delete values.HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING;
  if (provider === "local" && options.service && supportsManagedLocalService(dependencies)) {
    values.HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING = "true";
    const configuredLocal = loadConfig({ ...values, ...env });
    const existingLocalService = await runServiceAction("status", {
      kind: "local-voice",
      home,
      platform: dependencies.platform,
      uid: dependencies.uid,
      runner,
    }) as ServiceStatus;
    values.HERMES_LIVE_LOCAL_URL = await resolveSetupLocalVoiceUrl({
      url: configuredLocal.local.url,
      explicit: env.HERMES_LIVE_LOCAL_URL !== undefined
        || legacy.HERMES_LIVE_LOCAL_URL !== undefined,
      ownedServiceUrl: existingLocalService.running
        ? existing.values.HERMES_LIVE_LOCAL_URL
        : undefined,
      probe: dependencies.localEndpointProbe ?? probeLocalVoiceEndpoint,
      progress: dependencies.progress,
    });
    preparedLocalVoiceCommand = await resolveLocalVoiceCommand(
      loadConfig({ ...values, ...env }),
      dependencies,
    );
  }

  // Validate provider input and local runtime prerequisites before changing
  // Hermes' own environment. A missing key or executable must not leave a
  // partially applied setup.
  let hermesEnvironmentChanged = false;
  if (canManageHermesGateway) {
    const result = await ensureHermesApiEnvironment(hermesHome, hermesApiKey);
    hermesEnvironmentChanged = result.changed;
    if (result.changed) {
      dependencies.progress?.(result.created
        ? "Configured Hermes' private API bridge."
        : "Updated Hermes' private API bridge configuration.");
    }
  }

  const configPath = await writeManagedConfig(values, { path: managedConfigPath, home });
  const plugin = await installHermesPlugin({
    ...(pluginsDir ? { dir: pluginsDir } : {}),
    mode: "copy",
    force: true,
  });
  const hermesCli = await enableHermesPlugin(options, env, runner, findCommand, hermesCommand);
  const config = loadConfig({ ...values, ...env });
  const hermesGateway = canManageHermesGateway && hermesCommand
    ? await ensureHermesGatewayReady(config, {
      command: hermesCommand,
      environmentChanged: hermesEnvironmentChanged,
      env,
      runner,
      timeoutMs: dependencies.hermesApiReadyTimeoutMs ?? DEFAULT_HERMES_API_READY_TIMEOUT_MS,
      progress: dependencies.progress,
      readinessCheck: dependencies.readinessCheck ?? buildReadinessReport,
    })
    : {
      managed: false,
      configured: Boolean(existingHermesApiKey),
      ready: false,
      action: "skipped" as const,
      ...(!hermesCommand && isDefaultLocalHermesApi(hermesUrl)
        ? { error: "Hermes CLI was not found, so its API bridge could not be managed." }
        : {}),
    };
  const readiness = await (dependencies.readinessCheck ?? buildReadinessReport)(config);
  const managedLocalProfile = isManagedLocalProfile(config, dependencies);
  let localService: SetupReport["localService"] = {
    skipped: true,
    reason: provider === "local"
      ? "This local endpoint is managed outside Hermes Live Voice."
      : "The selected provider does not use a local voice service.",
  };
  if (provider === "local" && options.service && managedLocalProfile) {
    dependencies.progress?.("Preparing fully local voice. The first setup downloads Python packages and model weights.");
    try {
      const command = preparedLocalVoiceCommand
        ?? await resolveLocalVoiceCommand(config, dependencies);
      const localServiceOptions = {
        kind: "local-voice" as const,
        command,
        home,
        platform: dependencies.platform,
        uid: dependencies.uid,
        runner,
      };
      const installed = await runServiceAction("install", localServiceOptions) as ServiceStatus;
      localService = installed.running
        ? installed
        : await runServiceAction("start", localServiceOptions) as ServiceStatus;
    } catch (error) {
      localService = {
        skipped: true,
        reason: "The managed local voice service could not be started.",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else if (options.service && supportsManagedLocalService(dependencies)) {
    const existingLocalService = await runServiceAction("status", {
      kind: "local-voice",
      home,
      platform: dependencies.platform,
      uid: dependencies.uid,
      runner,
    }) as ServiceStatus;
    if (existingLocalService.installed) {
      localService = await runServiceAction("uninstall", {
        kind: "local-voice",
        home,
        platform: dependencies.platform,
        uid: dependencies.uid,
        runner,
      }) as ServiceStatus;
    }
  }
  const providerSession = provider === "local" && managedLocalProfile && "skipped" in localService && localService.error
    ? { checked: false, ok: false, error: localService.error }
    : provider === "local" && managedLocalProfile && !("skipped" in localService) && localService.running
      ? await waitForProviderSession(config, dependencies)
      : await (dependencies.providerSessionCheck ?? checkProviderSession)(config);
  let service: SetupReport["service"] = { skipped: true, reason: "Service installation was disabled." };
  let gateway: SetupReport["gateway"] = {
    checked: false,
    ready: false,
    url: `http://${config.server.host}:${config.server.port}/ready`,
  };

  const activationPreflightOk = readiness.ok
    && providerSession.ok
    && (hermesCli.enabled || hermesCli.skipped);
  if (options.service && activationPreflightOk) {
    const serviceOptions = {
      home,
      platform: dependencies.platform,
      nodePath: dependencies.nodePath,
      cliPath: dependencies.cliPath,
      configPath,
      runner,
    };
    const installedService = await runServiceAction("install", serviceOptions) as ServiceStatus;
    service = installedService.running
      ? installedService
      : await runServiceAction("start", serviceOptions) as ServiceStatus;
    gateway = await waitForGateway(config, dependencies);
  } else if (options.service) {
    service = { skipped: true, reason: "Service was not installed because the readiness preflight failed." };
  }

  const nextSteps = setupNextSteps({
    options,
    provider,
    managedLocalProfile,
    readiness,
    providerSession,
    hermesCli,
    hermesGateway,
    localService,
    service,
    gateway,
  });
  const localServiceOk = !managedLocalProfile
    || !options.service
    || (!("skipped" in localService) && localService.running);
  const ok = readiness.ok
    && providerSession.ok
    && localServiceOk
    && (hermesCli.enabled || hermesCli.skipped)
    && (!options.service || (!("skipped" in service) && service.running && gateway.ready));
  return {
    ok,
    config: { path: configPath, written: true },
    provider,
    plugin,
    hermesCli,
    hermesGateway,
    readiness,
    providerSession,
    localService,
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
    report = await runSetup(options, {
      ...(options.json ? {} : { progress: (message) => console.log(message) }),
    });
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
  --provider <local|gemini|openai|mock>  Realtime voice provider
  --hermes-url <url>               Hermes API Server URL
  --config <path>                  Managed config path
  --plugins-dir <path>             Hermes plugins directory
  --hermes-command <path>          Hermes executable to enable the plugin
  --no-enable                      Install but do not enable the Hermes plugin
  --no-service                     Configure only; run hermes-live serve manually
  --non-interactive                Never prompt; fail when required values are missing
  --json                           Print a machine-readable report

Provider and remote-Hermes keys are read from the environment, an existing
managed config, or Hermes' .env. Local Hermes bridge credentials are generated
automatically. Secret CLI flags are not accepted.
`);
}

function printSetupReport(report: SetupReport): void {
  console.log(report.ok ? "Hermes Live Voice is ready." : "Hermes Live Voice needs attention.");
  console.log(`  Config: ${shortHome(report.config.path)}`);
  console.log(`  Provider: ${report.provider}`);
  console.log(`  Plugin: ${report.plugin.manifestFound ? "installed" : "missing"}`);
  console.log(`  Hermes plugin: ${report.hermesCli.enabled ? "enabled" : report.hermesCli.skipped ? "skipped" : "not enabled"}`);
  console.log(`  Hermes gateway: ${report.hermesGateway.ready ? report.hermesGateway.action : report.hermesGateway.managed ? "not ready" : "external"}`);
  console.log(`  Hermes API: ${report.readiness.hermes.ok ? "ready" : "not ready"}`);
  console.log(`  Voice provider: ${report.providerSession.ok ? report.providerSession.checked ? "verified" : "configured" : "not ready"}`);
  if (report.provider === "local") {
    console.log(`  Local voice: ${"skipped" in report.localService ? "external or unavailable" : report.localService.running ? "running" : "not running"}`);
  }
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
  if (configured === "local" || configured === "gemini" || configured === "openai" || configured === "mock") return configured;
  if ((dependencies.platform ?? process.platform) === "darwin" && (dependencies.arch ?? process.arch) === "arm64") return "local";
  if (inherited.OPENAI_API_KEY && !inherited.GEMINI_API_KEY && !inherited.GOOGLE_API_KEY) return "openai";
  if (inherited.GEMINI_API_KEY || inherited.GOOGLE_API_KEY) return "gemini";
  if (options.nonInteractive) {
    throw new Error("No voice provider was selected. Pass --provider local, gemini, openai, or mock.");
  }
  const answer = (await (dependencies.prompt ?? promptText)("Voice provider [gemini/openai/local/mock]: ")).trim();
  if (!answer) throw new Error("Choose a voice provider, or rerun setup with --provider.");
  return parseProvider(answer);
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
  resolvedCommand?: string,
): Promise<SetupReport["hermesCli"]> {
  if (!options.enablePlugin) return { enabled: false, skipped: true };
  const command = resolvedCommand ?? (options.hermesCommand
    ? await findCommand(options.hermesCommand, env)
    : await findCommand("hermes", env));
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

async function ensureHermesGatewayReady(
  config: ReturnType<typeof loadConfig>,
  input: {
    command: string;
    environmentChanged: boolean;
    env: NodeJS.ProcessEnv;
    runner: CommandRunner;
    timeoutMs: number;
    progress?: (message: string) => void;
    readinessCheck: (config: ReturnType<typeof loadConfig>) => Promise<ReadinessReport>;
  },
): Promise<SetupReport["hermesGateway"]> {
  const initial = await input.readinessCheck(config);
  if (initial.hermes.ok) {
    return {
      managed: true,
      configured: true,
      ready: true,
      action: "already-running",
    };
  }

  input.progress?.(input.environmentChanged
    ? "Refreshing Hermes' gateway so the private API bridge becomes available."
    : "Starting Hermes' private API bridge.");
  const action: SetupReport["hermesGateway"]["action"] = "installed";
  const commandResult = await input.runner(
    input.command,
    ["gateway", "install", "--force"],
    { env: input.env, timeoutMs: 120_000 },
  );
  if (commandResult.code !== 0) {
    return {
      managed: true,
      configured: true,
      ready: false,
      action: "failed",
      error: conciseCommandError(commandResult),
    };
  }

  const deadline = Date.now() + input.timeoutMs;
  let lastError = String(initial.hermes.error ?? "Hermes API did not become ready.");
  while (Date.now() < deadline) {
    const readiness = await input.readinessCheck(config);
    if (readiness.hermes.ok) {
      return { managed: true, configured: true, ready: true, action };
    }
    lastError = String(readiness.hermes.error ?? lastError);
    if (isHermesApiCompatibilityError(lastError)) {
      return {
        managed: true,
        configured: true,
        ready: false,
        action: "failed",
        error: lastError,
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(500, Math.max(1, deadline - Date.now()))));
  }
  return {
    managed: true,
    configured: true,
    ready: false,
    action: "failed",
    error: lastError,
  };
}

function conciseCommandError(result: Awaited<ReturnType<CommandRunner>>): string {
  if (result.timedOut) return "Hermes gateway installation timed out.";
  const detail = result.stderr.trim() || result.stdout.trim();
  if (!detail) return `Hermes gateway command exited with code ${result.code}.`;
  return detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
}

async function waitForGateway(
  config: ReturnType<typeof loadConfig>,
  dependencies: SetupDependencies,
): Promise<SetupReport["gateway"]> {
  const origin = gatewayOrigin(config.server.host, config.server.port);
  const url = `${origin}/ready`;
  const timeoutMs = dependencies.gatewayReadyTimeoutMs ?? DEFAULT_GATEWAY_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError = "Gateway did not become ready.";
  while (Date.now() < deadline) {
    try {
      const result = await probeGatewayReadiness(origin, {
        ...(config.server.authToken ? { authToken: config.server.authToken } : {}),
        fetch: dependencies.fetch ?? globalThis.fetch,
        timeoutMs: Math.min(2_000, Math.max(1, deadline - Date.now())),
      });
      if (result.ok) return { checked: true, ready: true, url };
      lastError = result.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return { checked: true, ready: false, url, error: lastError };
}

export async function resolveSetupGatewayPort(input: {
  host: string;
  port: number;
  explicit: boolean;
  probe: (host: string, port: number) => Promise<GatewayEndpointState>;
  progress?: (message: string) => void;
}): Promise<number> {
  if (!isLoopbackHostname(input.host) && input.host !== "0.0.0.0" && input.host !== "::") {
    return input.port;
  }
  const state = await input.probe(input.host, input.port);
  if (state !== "occupied") return input.port;
  if (input.explicit) {
    throw new Error(
      `Gateway port ${input.port} is already used by another service. Choose a free HERMES_LIVE_PORT and rerun setup.`,
    );
  }
  for (let offset = 1; offset <= MAX_GATEWAY_PORT_CANDIDATES; offset += 1) {
    const candidate = DEFAULT_GATEWAY_PORT + offset;
    if (candidate === input.port) continue;
    if (await input.probe(input.host, candidate) === "available") {
      input.progress?.(`Port ${input.port} is already in use. Hermes Live Voice will use ${candidate}.`);
      return candidate;
    }
  }
  throw new Error(
    `Gateway port ${input.port} is already used by another service and no free port was found between ${DEFAULT_GATEWAY_PORT + 1} and ${DEFAULT_GATEWAY_PORT + MAX_GATEWAY_PORT_CANDIDATES}.`,
  );
}

export async function resolveSetupLocalVoiceUrl(input: {
  url: string;
  explicit: boolean;
  ownedServiceUrl?: string;
  probe: (url: string) => Promise<boolean>;
  progress?: (message: string) => void;
}): Promise<string> {
  const endpoint = new URL(input.url);
  if (endpoint.protocol !== "ws:" || !isLoopbackHostname(endpoint.hostname)) return input.url;
  const occupied = await input.probe(input.url);
  const ownedByRunningService = input.ownedServiceUrl !== undefined
    && sameEndpoint(input.url, input.ownedServiceUrl);
  if (!occupied || ownedByRunningService) return input.url;
  const port = endpoint.port ? Number(endpoint.port) : 80;
  if (input.explicit) {
    throw new Error(
      `Local voice port ${port} is already used by another process. Choose a free HERMES_LIVE_LOCAL_URL and rerun setup.`,
    );
  }
  for (let offset = 1; offset <= MAX_LOCAL_VOICE_PORT_CANDIDATES; offset += 1) {
    const candidatePort = port + offset;
    if (candidatePort > 65_535) break;
    const candidate = new URL(endpoint);
    candidate.port = String(candidatePort);
    if (!(await input.probe(candidate.toString()))) {
      const url = candidate.toString();
      input.progress?.(`Local voice port ${port} is already in use. Hermes Live Voice will use ${candidatePort}.`);
      return url;
    }
  }
  throw new Error(
    `Local voice port ${port} is already used by another process and no free port was found in the next ${MAX_LOCAL_VOICE_PORT_CANDIDATES} ports.`,
  );
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return false;
  }
}

async function readLegacyHermesEnvironment(hermesHome: string): Promise<Record<string, string | undefined>> {
  const path = join(hermesHome, ".env");
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
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`Hermes environment must not be readable or writable by other users: ${path}`);
  }
  if (stat.size > MAX_LEGACY_ENV_BYTES) throw new Error(`Hermes environment exceeds ${MAX_LEGACY_ENV_BYTES} bytes.`);
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`Hermes environment must be a regular file: ${path}`);
    if (currentUid !== undefined && openedStat.uid !== currentUid) {
      throw new Error(`Hermes environment must be owned by the current user: ${path}`);
    }
    if (process.platform !== "win32" && (openedStat.mode & 0o077) !== 0) {
      throw new Error(`Hermes environment must not be readable or writable by other users: ${path}`);
    }
    const source = await readBoundedFile(handle, MAX_LEGACY_ENV_BYTES, path);
    return parseLegacyEnvironment(source);
  } finally {
    await handle.close();
  }
}

function parseLegacyEnvironment(source: string): Record<string, string | undefined> {
  const accepted = new Set([
    "API_SERVER_ENABLED",
    "API_SERVER_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "HERMES_AGENT_API_SERVER_KEY",
    "HERMES_API_KEY",
    "HERMES_BASE_URL",
    "HERMES_LIVE_HOST",
    "HERMES_LIVE_LOCAL_ALLOW_REMOTE",
    "HERMES_LIVE_LOCAL_URL",
    "HERMES_LIVE_LOCAL_VOICE",
    "HERMES_LIVE_PORT",
    "HERMES_LIVE_PROVIDER",
    "OPENAI_API_KEY",
  ]);
  const result: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    if (!accepted.has(key)) continue;
    if (seen.has(key)) throw new Error(`Hermes environment contains duplicate ${key}.`);
    result[key] = unquoteLegacyValue(normalized.slice(separator + 1).trim());
    seen.add(key);
  }
  return result;
}

async function readBoundedFile(handle: Awaited<ReturnType<typeof open>>, maximumBytes: number, path: string): Promise<string> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error(`Hermes environment exceeds ${maximumBytes} bytes: ${path}`);
  return buffer.subarray(0, offset).toString("utf8");
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
  provider: RealtimeProvider;
  managedLocalProfile: boolean;
  readiness: ReadinessReport;
  providerSession: SetupReport["providerSession"];
  hermesCli: SetupReport["hermesCli"];
  hermesGateway: SetupReport["hermesGateway"];
  localService: SetupReport["localService"];
  service: SetupReport["service"];
  gateway: SetupReport["gateway"];
}): string[] {
  const steps: string[] = [];
  if (!input.hermesCli.enabled && !input.hermesCli.skipped) {
    steps.push(input.hermesCli.error ?? "Run `hermes plugins enable hermes-live`.");
  }
  if (!input.readiness.hermes.ok) {
    const readinessError = String(input.readiness.hermes.error ?? "Hermes API unavailable");
    if (isHermesApiCompatibilityError(readinessError)) {
      steps.push(`Update Hermes Agent, restart \`hermes gateway\`, then rerun \`hermes-live setup\`: ${readinessError}`);
    } else if (input.hermesGateway.managed) {
      steps.push(`Run \`hermes gateway status\`, then rerun \`hermes-live setup\`: ${input.hermesGateway.error ?? String(input.readiness.hermes.error ?? "Hermes API unavailable")}`);
    } else {
      steps.push(`Enable Hermes' API Server and start \`hermes gateway\`: ${String(input.readiness.hermes.error ?? "unavailable")}`);
    }
  }
  if (!input.readiness.realtime.ok) {
    steps.push(`Run \`hermes-live setup\` again with a working voice provider: ${String(input.readiness.realtime.error ?? "provider unavailable")}`);
  }
  if (!input.providerSession.ok) {
    if (input.provider === "local") {
      if (input.managedLocalProfile) {
        const serviceError = "skipped" in input.localService ? input.localService.error : undefined;
        steps.push(serviceError ?? "Run `hermes-live local logs`, then `hermes-live local restart`.");
      } else {
        steps.push("Start the configured OpenAI Realtime-compatible local endpoint, then rerun `hermes-live setup`.");
      }
    } else {
      steps.push(`Fix the realtime provider connection, then rerun \`hermes-live setup\`: ${input.providerSession.error ?? "connection failed"}`);
    }
  }
  if (!input.options.service) {
    steps.push("Start the gateway with `hermes-live serve`.");
  } else if (!("skipped" in input.service) && !input.gateway.ready) {
    steps.push("Run `hermes-live service logs`, then `hermes-live doctor`.");
  }
  if (input.readiness.ok && input.providerSession.ok && (input.hermesCli.enabled || input.hermesCli.skipped) && (input.gateway.ready || !input.options.service)) {
    steps.push("Open `hermes dashboard` and choose Live Voice.");
  }
  return steps;
}

function isHermesApiCompatibilityError(message: string): boolean {
  return message.startsWith("Hermes API Server is missing required ");
}

function parseProvider(value: string): RealtimeProvider {
  if (value === "local" || value === "gemini" || value === "openai" || value === "mock") return value;
  throw new Error(`Unsupported provider: ${value}. Choose local, gemini, openai, or mock.`);
}

async function checkProviderSession(
  config: ReturnType<typeof loadConfig>,
  options: { verifyToolCall?: boolean; timeoutMs?: number } = {},
): Promise<SetupReport["providerSession"]> {
  if (config.realtime.provider === "mock") return { checked: false, ok: true };
  try {
    await runLiveProviderSmoke(config, {
      timeoutMs: options.timeoutMs ?? config.server.providerReadyTimeoutMs,
      ...(options.verifyToolCall ? { verifyToolCall: true } : {}),
    });
    return { checked: true, ok: true };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      error: error instanceof Error ? error.message : "Realtime provider connection failed.",
    };
  }
}

async function waitForProviderSession(
  config: ReturnType<typeof loadConfig>,
  dependencies: SetupDependencies,
): Promise<SetupReport["providerSession"]> {
  const timeoutMs = dependencies.localProviderReadyTimeoutMs ?? DEFAULT_LOCAL_PROVIDER_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const check = dependencies.providerSessionCheck
    ?? ((candidate) => checkProviderSession(candidate, {
      verifyToolCall: true,
      timeoutMs: Math.max(
        candidate.server.providerReadyTimeoutMs,
        LOCAL_FUNCTIONAL_PROVIDER_SMOKE_TIMEOUT_MS,
      ),
    }));
  let functionalProgressShown = false;
  const runCheck = async () => {
    if (!dependencies.providerSessionCheck && !functionalProgressShown) {
      const listening = await Promise.resolve()
        .then(() => (dependencies.localEndpointProbe ?? probeLocalVoiceEndpoint)(config.local.url))
        .catch(() => false);
      if (listening) {
        functionalProgressShown = true;
        dependencies.progress?.("Local models are loaded. Verifying task delegation and speech output.");
      }
    }
    return await check(config);
  };
  let last = await runCheck();
  let nextProgressAt = Date.now() + 15_000;
  let lastProgressMessage = "";
  let lastProgressEmittedAt = 0;
  while (!last.ok && Date.now() < deadline) {
    if (Date.now() >= nextProgressAt) {
      const message = await localProviderProgress(dependencies)
        ?? "Local voice is still downloading or loading models. Setup will continue when it is ready.";
      if (message !== lastProgressMessage || Date.now() - lastProgressEmittedAt >= 60_000) {
        dependencies.progress?.(message);
        lastProgressMessage = message;
        lastProgressEmittedAt = Date.now();
      }
      nextProgressAt = Date.now() + 15_000;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(1_000, Math.max(1, deadline - Date.now()))));
    last = await runCheck();
  }
  return last;
}

async function localProviderProgress(dependencies: SetupDependencies): Promise<string | undefined> {
  if (dependencies.localProviderProgress) return await dependencies.localProviderProgress();
  try {
    const result = await runServiceAction("logs", {
      kind: "local-voice",
      home: dependencies.home,
      platform: dependencies.platform,
      uid: dependencies.uid,
      runner: dependencies.runner,
    });
    if (!("stdout" in result)) return undefined;
    return localVoiceStartupProgress(`${result.stdout}\n${result.stderr}`);
  } catch {
    return undefined;
  }
}

function isManagedLocalProfile(
  config: ReturnType<typeof loadConfig>,
  dependencies: Pick<SetupDependencies, "platform" | "arch">,
): boolean {
  if (config.realtime.provider !== "local") return false;
  if ((dependencies.platform ?? process.platform) !== "darwin" || (dependencies.arch ?? process.arch) !== "arm64") {
    return false;
  }
  const endpoint = new URL(config.local.url);
  return endpoint.protocol === "ws:" && isLoopbackHostname(endpoint.hostname);
}

function supportsManagedLocalService(
  dependencies: Pick<SetupDependencies, "platform" | "arch">,
): boolean {
  return (dependencies.platform ?? process.platform) === "darwin"
    && (dependencies.arch ?? process.arch) === "arm64";
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
