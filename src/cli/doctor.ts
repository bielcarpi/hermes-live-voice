import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../config.js";
import { runLiveProviderSmoke } from "../live-provider-smoke.js";
import { buildReadinessReport, type ReadinessReport } from "../readiness.js";
import { errorToMessage } from "../domain/error-message.js";
import { readManagedConfig } from "./managed-config.js";
import { pluginInstallStatus } from "./plugin-installer.js";
import { findExecutable, type CommandRunner } from "./process.js";
import { serviceStatus, type ServiceStatus } from "./service-manager.js";

const packageRequire = createRequire(import.meta.url);
const PACKAGE_VERSION = (packageRequire("../../package.json") as { version: string }).version;
const MINIMUM_NODE_MAJOR = 20;

export type DiagnosticStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  checks: DiagnosticCheck[];
  readiness?: ReadinessReport;
  service?: ServiceStatus;
}

export interface DoctorOptions {
  json: boolean;
  providerSmoke: boolean;
  configPath?: string;
  pluginsDir?: string;
  hermesCommand?: string;
}

export interface DoctorDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  runner?: CommandRunner;
  findCommand?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
}

export function parseDoctorOptions(args: string[]): DoctorOptions {
  const options: DoctorOptions = { json: false, providerSmoke: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const nextValue = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--json") options.json = true;
    else if (argument === "--provider-smoke") options.providerSmoke = true;
    else if (argument === "--config") options.configPath = nextValue();
    else if (argument?.startsWith("--config=")) options.configPath = argument.slice(9);
    else if (argument === "--plugins-dir") options.pluginsDir = nextValue();
    else if (argument?.startsWith("--plugins-dir=")) options.pluginsDir = argument.slice(14);
    else if (argument === "--hermes-command") options.hermesCommand = nextValue();
    else if (argument?.startsWith("--hermes-command=")) options.hermesCommand = argument.slice(17);
    else if (argument === "--help" || argument === "-h") throw new DoctorHelpRequested();
    else if (argument) throw new Error(`Unknown doctor option: ${argument}`);
  }
  return options;
}

export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const env = dependencies.env ?? process.env;
  const checks: DiagnosticCheck[] = [];
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push(Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR
    ? pass("node", "Node.js", `v${nodeVersion}`)
    : fail("node", "Node.js", `v${nodeVersion} is unsupported.`, `Install Node.js ${MINIMUM_NODE_MAJOR} or newer.`));

  let managedValues: NodeJS.ProcessEnv = {};
  try {
    const managed = await readManagedConfig({ path: options.configPath, home: dependencies.home });
    managedValues = managed.values;
    checks.push(managed.exists
      ? pass("config", "Managed config", shortHome(managed.path, dependencies.home))
      : warn("config", "Managed config", "No managed config is installed.", "Run `hermes-live setup`."));
  } catch (error) {
    checks.push(fail("config", "Managed config", errorToMessage(error), "Run `hermes-live setup` after fixing the file ownership and permissions."));
  }

  let config: AppConfig | undefined;
  try {
    config = loadConfig({ ...managedValues, ...env });
    checks.push(pass("settings", "Runtime settings", `${config.realtime.provider} on ${publicGatewayOrigin(config)}`));
  } catch (error) {
    checks.push(fail("settings", "Runtime settings", errorToMessage(error), "Run `hermes-live setup` and correct the reported value."));
  }

  const plugin = await pluginInstallStatus({
    ...(options.pluginsDir
      ? { dir: options.pluginsDir }
      : dependencies.home
        ? { dir: join(dependencies.home, ".hermes", "plugins") }
        : {}),
  });
  if (!plugin.installed || !plugin.manifestFound) {
    checks.push(fail("plugin", "Hermes plugin", "The bundled plugin is not installed.", "Run `hermes-live setup`."));
  } else {
    const installedVersion = await pluginVersion(plugin.target);
    checks.push(installedVersion === PACKAGE_VERSION
      ? pass("plugin", "Hermes plugin", `v${installedVersion} at ${shortHome(plugin.target, dependencies.home)}`)
      : fail(
        "plugin",
        "Hermes plugin",
        `Installed ${installedVersion ? `v${installedVersion}` : "version is unknown"}; package is v${PACKAGE_VERSION}.`,
        "Run `hermes-live setup` to install the matching plugin.",
      ));
  }

  const findCommand = dependencies.findCommand ?? findExecutable;
  const hermesCommand = options.hermesCommand
    ? await findCommand(options.hermesCommand, env)
    : await findCommand("hermes", env);
  checks.push(hermesCommand
    ? pass("hermes-cli", "Hermes CLI", shortHome(hermesCommand, dependencies.home))
    : warn(
      "hermes-cli",
      "Hermes CLI",
      "The `hermes` command is not on PATH.",
      "Install Hermes or pass --hermes-command, then enable the plugin.",
    ));

  let readiness: ReadinessReport | undefined;
  if (config) {
    readiness = await buildReadinessReport(config);
    checks.push(readiness.hermes.ok
      ? pass("hermes-api", "Hermes API", `${String(readiness.hermes.baseUrl)} supports durable runs`)
      : fail("hermes-api", "Hermes API", String(readiness.hermes.error ?? "Not ready."), "Start the Hermes API Server, then rerun `hermes-live doctor`."));
    checks.push(readiness.realtime.ok
      ? pass("provider-config", "Voice provider", `${config.realtime.provider} configuration is valid`)
      : fail("provider-config", "Voice provider", String(readiness.realtime.error ?? "Not configured."), "Run `hermes-live setup`."));
  } else {
    checks.push(fail("hermes-api", "Hermes API", "Skipped because runtime settings are invalid.", "Fix runtime settings first."));
    checks.push(fail("provider-config", "Voice provider", "Skipped because runtime settings are invalid.", "Fix runtime settings first."));
  }

  if (options.providerSmoke) {
    if (!config || !readiness?.realtime.ok) {
      checks.push(fail("provider-session", "Provider session", "Skipped because provider configuration is invalid.", "Fix provider configuration first."));
    } else if (config.realtime.provider === "mock") {
      checks.push(warn("provider-session", "Provider session", "Mock mode has no external voice session.", "Choose Gemini or OpenAI in `hermes-live setup` for speech."));
    } else {
      try {
        await runLiveProviderSmoke(config, { timeoutMs: config.server.providerReadyTimeoutMs });
        checks.push(pass("provider-session", "Provider session", `Connected to ${config.realtime.provider} realtime`));
      } catch (error) {
        checks.push(fail("provider-session", "Provider session", errorToMessage(error), "Check the provider key, model access, and network, then rerun with --provider-smoke."));
      }
    }
  }

  const service = await serviceStatus({
    home: dependencies.home,
    platform: dependencies.platform,
    runner: dependencies.runner,
    configPath: options.configPath,
  });
  if (service.platform === "unsupported") {
    checks.push(warn("service", "Gateway service", service.detail, "Run `hermes-live serve` manually."));
  } else if (!service.installed) {
    checks.push(warn("service", "Gateway service", service.detail, "Run `hermes-live setup` or `hermes-live service install`."));
  } else if (!service.running) {
    checks.push(fail("service", "Gateway service", service.detail, "Run `hermes-live service restart`, then inspect `hermes-live service logs`."));
  } else {
    checks.push(pass("service", "Gateway service", `${service.platform}: running`));
  }

  if (config) {
    const gateway = await probeGateway(config, dependencies.fetch ?? globalThis.fetch);
    checks.push(gateway.ok
      ? pass("gateway", "Live gateway", `${publicGatewayOrigin(config)} is ready`)
      : fail("gateway", "Live gateway", gateway.error, "Run `hermes-live service restart` and inspect `hermes-live service logs`."));
  } else {
    checks.push(fail("gateway", "Live gateway", "Skipped because runtime settings are invalid.", "Fix runtime settings first."));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    version: PACKAGE_VERSION,
    checks,
    ...(readiness ? { readiness } : {}),
    service,
  };
}

export async function runDoctorCommand(args: string[]): Promise<void> {
  let options: DoctorOptions;
  try {
    options = parseDoctorOptions(args);
  } catch (error) {
    if (error instanceof DoctorHelpRequested) {
      printDoctorHelp();
      return;
    }
    throw error;
  }
  const report = await runDoctor(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printDoctorReport(report);
  if (!report.ok) process.exitCode = 1;
}

export function printDoctorHelp(): void {
  console.log(`hermes-live doctor

Check the complete Hermes Live Voice installation and print exact fixes.

Options:
  --provider-smoke        Open and close a real provider session
  --config <path>         Managed config path
  --plugins-dir <path>    Hermes plugins directory
  --hermes-command <path> Hermes executable path
  --json                  Print a machine-readable report
`);
}

function printDoctorReport(report: DoctorReport): void {
  console.log(`Hermes Live Voice doctor v${report.version}`);
  for (const check of report.checks) {
    const marker = check.status === "pass" ? "ok" : check.status;
    console.log(`[${marker}] ${check.label}: ${check.detail}`);
    if (check.fix) console.log(`       Fix: ${check.fix}`);
  }
  console.log(report.ok ? "\nEverything required is ready." : "\nOne or more required checks failed.");
}

async function probeGateway(config: AppConfig, fetchImplementation: typeof globalThis.fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetchImplementation(`${publicGatewayOrigin(config)}/ready`, {
      redirect: "error",
      headers: config.server.authToken ? { authorization: `Bearer ${config.server.authToken}` } : {},
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { ok: false, error: `Readiness returned HTTP ${response.status}.` };
    const body = await response.json() as { ok?: boolean; status?: string };
    return body.ok === true || body.status === "ready"
      ? { ok: true }
      : { ok: false, error: "Gateway responded but reported that a dependency is not ready." };
  } catch (error) {
    return { ok: false, error: errorToMessage(error) };
  }
}

function publicGatewayOrigin(config: AppConfig): string {
  const rawHost = config.server.host === "0.0.0.0" || config.server.host === "::" ? "127.0.0.1" : config.server.host;
  const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  return `http://${host}:${config.server.port}`;
}

async function pluginVersion(target: string): Promise<string | undefined> {
  const manifest = await readFile(`${target}/plugin.yaml`, "utf8").catch(() => "");
  return /^version:\s*["']?([^\s"']+)["']?\s*$/mu.exec(manifest)?.[1];
}

function pass(id: string, label: string, detail: string): DiagnosticCheck {
  return { id, label, status: "pass", detail };
}

function warn(id: string, label: string, detail: string, fix?: string): DiagnosticCheck {
  return { id, label, status: "warn", detail, ...(fix ? { fix } : {}) };
}

function fail(id: string, label: string, detail: string, fix?: string): DiagnosticCheck {
  return { id, label, status: "fail", detail, ...(fix ? { fix } : {}) };
}

function shortHome(path: string, configuredHome?: string): string {
  const home = configuredHome ?? process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

class DoctorHelpRequested extends Error {}
