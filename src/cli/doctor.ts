import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { isLoopbackHostname, loadConfig, type AppConfig } from "../config.js";
import { runLiveProviderSmoke } from "../live-provider-smoke.js";
import { buildReadinessReport, type ReadinessReport } from "../readiness.js";
import { errorToMessage } from "../domain/error-message.js";
import { readManagedConfig } from "./managed-config.js";
import { pluginInstallStatus } from "./plugin-installer.js";
import { findExecutable, runCommand, type CommandRunner } from "./process.js";
import { serviceStatus, type ServiceStatus } from "./service-manager.js";
import {
  HUGGINGFACE_SPEECH_TO_SPEECH_VERSION,
  MIN_MANAGED_LOCAL_MEMORY_BYTES,
  probeLocalVoiceEndpoint,
} from "./local-voice.js";
import { gatewayOrigin, probeGatewayReadiness } from "./gateway-probe.js";
import { isDefaultLocalHermesApi, resolveHermesHome } from "./hermes-api-bootstrap.js";
import {
  classifyHermesVersion,
  HERMES_COMPATIBILITY,
  parseHermesVersion,
} from "../hermes-compatibility.js";

const packageRequire = createRequire(import.meta.url);
const PACKAGE_VERSION = (packageRequire("../../package.json") as { version: string }).version;
const MINIMUM_NODE_MAJOR = 20;
const RECOMMENDED_MANAGED_LOCAL_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
const HIGH_SWAP_MINIMUM_BYTES = 4 * 1024 * 1024 * 1024;

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
  compatibility: typeof HERMES_COMPATIBILITY;
  checks: DiagnosticCheck[];
  readiness?: ReadinessReport;
  service?: ServiceStatus;
  localService?: ServiceStatus;
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
  arch?: string;
  uid?: number;
  nodeVersion?: string;
  totalMemoryBytes?: number;
  runner?: CommandRunner;
  findCommand?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  probeLocalEndpoint?: (url: string) => Promise<boolean>;
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
  const home = dependencies.home ?? homedir();
  const hermesHome = resolveHermesHome(home, env);
  const managedConfigPath = options.configPath
    ?? (env.HERMES_HOME ? join(hermesHome, "hermes-live", "config.env") : undefined);
  const pluginsDir = options.pluginsDir
    ?? (env.HERMES_HOME ? join(hermesHome, "plugins") : undefined);
  const checks: DiagnosticCheck[] = [];
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push(Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR
    ? pass("node", "Node.js", `v${nodeVersion}`)
    : fail("node", "Node.js", `v${nodeVersion} is unsupported.`, `Install Node.js ${MINIMUM_NODE_MAJOR} or newer.`));

  let managedValues: NodeJS.ProcessEnv = {};
  try {
    const managed = await readManagedConfig({ path: managedConfigPath, home });
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
    ...(pluginsDir
      ? { dir: pluginsDir }
      : dependencies.home
        ? { dir: join(home, ".hermes", "plugins") }
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
  let localService: ServiceStatus | undefined;
  if (config?.realtime.provider === "local") {
    const endpoint = new URL(config.local.url);
    if (isLoopbackHostname(endpoint.hostname)) {
      const uv = await findCommand("uv", env);
      const managedProfileSupported = (dependencies.platform ?? process.platform) === "darwin"
        && (dependencies.arch ?? process.arch) === "arm64";
      checks.push(uv
        ? pass(
          "local-launcher",
          "Local voice launcher",
          `${shortHome(uv, dependencies.home)} (speech-to-speech ${HUGGINGFACE_SPEECH_TO_SPEECH_VERSION})`,
        )
        : managedProfileSupported
          ? fail("local-launcher", "Local voice launcher", "uv is not installed.", "Run `brew install uv`, then rerun `hermes-live setup`.")
          : pass("local-launcher", "Local voice launcher", "External speech-to-speech runtime expected on this platform."));
      if (managedProfileSupported) {
        const memory = await inspectManagedLocalMemory(
          dependencies.totalMemoryBytes ?? totalmem(),
          dependencies.runner,
        );
        checks.push(memory);
        localService = await serviceStatus({
          kind: "local-voice",
          home: dependencies.home,
          platform: dependencies.platform,
          uid: dependencies.uid,
          runner: dependencies.runner,
        });
        if (!localService.installed) {
          checks.push(fail("local-service", "Local voice service", localService.detail, "Run `hermes-live setup`."));
        } else if (!localService.running) {
          checks.push(fail("local-service", "Local voice service", localService.detail, "Run `hermes-live local restart`, then inspect `hermes-live local logs`."));
        } else {
          const listening = await (dependencies.probeLocalEndpoint ?? probeLocalVoiceEndpoint)(config.local.url)
            .catch(() => false);
          checks.push(listening
            ? pass("local-service", "Local voice service", `${localService.platform}: running; endpoint is listening`)
            : fail(
              "local-service",
              "Local voice service",
              `${localService.platform}: running, but the provider endpoint is not listening yet`,
              "Wait for the models to load. If it does not recover, run `hermes-live local logs`, then `hermes-live local restart`.",
            ));
        }
      }
    } else {
      checks.push(pass("local-launcher", "Local voice launcher", "Using an operator-managed remote speech-to-speech endpoint."));
    }
  }
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
  if (hermesCommand) {
    checks.push(await inspectHermesVersion(hermesCommand, dependencies.runner));
  }

  let readiness: ReadinessReport | undefined;
  if (config) {
    readiness = await buildReadinessReport(config);
    const hermesReadinessError = String(readiness.hermes.error ?? "Not ready.");
    checks.push(readiness.hermes.ok
      ? pass("hermes-api", "Hermes API", `${String(readiness.hermes.baseUrl)} supports task runs and saved chats`)
      : fail(
        "hermes-api",
        "Hermes API",
        hermesReadinessError,
        hermesReadinessError.startsWith("Hermes API Server is missing required ")
          ? "Update Hermes Agent, restart `hermes gateway`, then rerun `hermes-live doctor`."
          : hermesCommand && isDefaultLocalHermesApi(config.hermes.baseUrl)
          ? "Run `hermes-live setup`; it configures and starts Hermes' private API bridge."
          : "Enable the Hermes API Server, start `hermes gateway`, then rerun `hermes-live doctor`.",
      ));
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
      checks.push(warn("provider-session", "Provider session", "Mock mode has no external voice session.", "Choose local, Gemini, or OpenAI in `hermes-live setup` for speech."));
    } else {
      try {
        await runLiveProviderSmoke(config, { timeoutMs: config.server.providerReadyTimeoutMs });
        checks.push(pass("provider-session", "Provider session", `Connected to ${config.realtime.provider} realtime`));
      } catch (error) {
        const fix = config.realtime.provider === "local"
          ? "Run `hermes-live local restart`, inspect `hermes-live local logs`, then rerun with --provider-smoke."
          : "Check the provider key, model access, and network, then rerun with --provider-smoke.";
        checks.push(fail("provider-session", "Provider session", errorToMessage(error), fix));
      }
    }
  }

  const service = await serviceStatus({
    home: dependencies.home,
    platform: dependencies.platform,
    runner: dependencies.runner,
    configPath: managedConfigPath,
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
    const gateway = await probeGatewayReadiness(publicGatewayOrigin(config), {
      ...(config.server.authToken ? { authToken: config.server.authToken } : {}),
      fetch: dependencies.fetch ?? globalThis.fetch,
      timeoutMs: 3_000,
    });
    const gatewayFix = gateway.ok
      ? undefined
      : gateway.error.includes("belongs to another service")
        ? "Run `hermes-live setup` so it can select and share a free local port."
        : "Run `hermes-live service restart` and inspect `hermes-live service logs`.";
    checks.push(gateway.ok
      ? pass("gateway", "Live gateway", `${publicGatewayOrigin(config)} is ready`)
      : fail("gateway", "Live gateway", gateway.error, gatewayFix));
  } else {
    checks.push(fail("gateway", "Live gateway", "Skipped because runtime settings are invalid.", "Fix runtime settings first."));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    version: PACKAGE_VERSION,
    compatibility: HERMES_COMPATIBILITY,
    checks,
    ...(readiness ? { readiness } : {}),
    service,
    ...(localService ? { localService } : {}),
  };
}

async function inspectHermesVersion(
  hermesCommand: string,
  runner: CommandRunner | undefined,
): Promise<DiagnosticCheck> {
  const result = await (runner ?? runCommand)(hermesCommand, ["--version"], {
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
  }).catch((error) => ({
    code: 1,
    stdout: "",
    stderr: errorToMessage(error),
    timedOut: false,
  }));
  if (result.code !== 0) {
    return warn(
      "hermes-version",
      "Hermes version",
      result.timedOut ? "The version check timed out." : "The CLI did not report its version.",
      `Hermes Agent ${HERMES_COMPATIBILITY.minimumVersion} or newer is required.`,
    );
  }

  const version = parseHermesVersion(`${result.stdout}\n${result.stderr}`);
  const status = classifyHermesVersion(version);
  if (status === "unsupported") {
    return fail(
      "hermes-version",
      "Hermes version",
      `v${version} is unsupported.`,
      `Update Hermes Agent to v${HERMES_COMPATIBILITY.minimumVersion} or newer. v${HERMES_COMPATIBILITY.testedVersion} is the latest tested version.`,
    );
  }
  if (status === "tested") {
    return pass(
      "hermes-version",
      "Hermes version",
      `v${version} (${HERMES_COMPATIBILITY.testedReleaseTag}) is tested`,
    );
  }
  if (status === "supported") {
    return pass(
      "hermes-version",
      "Hermes version",
      `v${version} is supported; v${HERMES_COMPATIBILITY.testedVersion} is the latest tested version`,
    );
  }
  if (status === "newer") {
    return warn(
      "hermes-version",
      "Hermes version",
      `v${version} is newer than the latest tested version, v${HERMES_COMPATIBILITY.testedVersion}.`,
      "Keep the capability checks enabled and report any compatibility issue.",
    );
  }
  return warn(
    "hermes-version",
    "Hermes version",
    "The CLI output did not contain a semantic version.",
    `Hermes Agent ${HERMES_COMPATIBILITY.minimumVersion} or newer is required.`,
  );
}

export function diagnoseManagedLocalMemory(
  totalMemoryBytes: number,
  memoryPressureOutput = "",
  swapUsageOutput = "",
): DiagnosticCheck {
  const totalGiB = totalMemoryBytes / 1024 ** 3;
  const freePercent = /memory\s+free\s+percentage:\s*(\d{1,3})%/iu.exec(memoryPressureOutput)?.[1];
  const parsedFreePercent = freePercent === undefined ? undefined : Number(freePercent);
  const swapUsedBytes = parseMacSwapUsedBytes(swapUsageOutput);
  const facts = [
    `${formatGiB(totalGiB)} GB physical`,
    ...(parsedFreePercent !== undefined && parsedFreePercent <= 100
      ? [`${parsedFreePercent}% pressure-free`]
      : []),
    ...(swapUsedBytes !== undefined ? [`${formatGiB(swapUsedBytes / 1024 ** 3)} GB swap used`] : []),
  ].join("; ");

  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes < MIN_MANAGED_LOCAL_MEMORY_BYTES) {
    return fail(
      "local-memory",
      "Local voice memory",
      `${facts}. Managed local voice needs at least 12 GB.`,
      "Choose OpenAI or Gemini in `hermes-live setup`, or use a larger Apple Silicon host.",
    );
  }
  if (totalMemoryBytes < RECOMMENDED_MANAGED_LOCAL_MEMORY_BYTES) {
    return warn(
      "local-memory",
      "Local voice memory",
      `${facts}. 16 GB or more is recommended for consistent latency.`,
      "Close memory-heavy apps before using local voice, or choose a hosted voice provider.",
    );
  }

  const highSwapThreshold = Math.max(HIGH_SWAP_MINIMUM_BYTES, totalMemoryBytes * 0.25);
  if (
    (parsedFreePercent !== undefined && parsedFreePercent < 10)
    || (swapUsedBytes !== undefined && swapUsedBytes >= highSwapThreshold)
  ) {
    return warn(
      "local-memory",
      "Local voice memory",
      `${facts}. Host memory pressure may make speech turns much slower.`,
      "Close memory-heavy apps, then run `hermes-live local restart` before judging local voice latency.",
    );
  }
  return pass("local-memory", "Local voice memory", facts);
}

async function inspectManagedLocalMemory(
  totalMemoryBytes: number,
  runner: CommandRunner | undefined,
): Promise<DiagnosticCheck> {
  const run = runner ?? runCommand;
  const [pressure, swap] = await Promise.all([
    run("/usr/bin/memory_pressure", ["-Q"]).catch(() => undefined),
    run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]).catch(() => undefined),
  ]);
  return diagnoseManagedLocalMemory(
    totalMemoryBytes,
    pressure?.code === 0 ? pressure.stdout : "",
    swap?.code === 0 ? swap.stdout : "",
  );
}

function parseMacSwapUsedBytes(value: string): number | undefined {
  const match = /\bused\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT])\b/iu.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const exponent = { K: 1, M: 2, G: 3, T: 4 }[match[2]!.toUpperCase() as "K" | "M" | "G" | "T"];
  const bytes = amount * 1024 ** exponent;
  return Number.isFinite(bytes) ? bytes : undefined;
}

function formatGiB(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
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

function publicGatewayOrigin(config: AppConfig): string {
  return gatewayOrigin(config.server.host, config.server.port);
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
