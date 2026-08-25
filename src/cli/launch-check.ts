import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig, type AppConfig } from "../config.js";
import { HermesClient } from "../adapters/outbound/hermes/hermes-runs.client.js";
import type { HermesRunsPort } from "../application/live-gateway/ports/hermes-runs.port.js";
import { runLiveProviderSmoke, type LiveProviderSmokeReport } from "../live-provider-smoke.js";
import { buildReadinessReport, type ReadinessReport } from "../readiness.js";
import { errorToMessage } from "../domain/error-message.js";
import { gatewayOrigin, probeGatewayReadiness } from "./gateway-probe.js";
import {
  pluginInstallStatus,
  type PluginInstallStatus,
} from "./plugin-installer.js";
import { serviceStatus, type ServiceStatus } from "./service-manager.js";

const packageRequire = createRequire(import.meta.url);
const PACKAGE_VERSION = (packageRequire("../../package.json") as { version: string }).version;
const DEFAULT_LAUNCH_CHECK_TIMEOUT_MS = 120_000;
const WORKER_TOKEN = "HERMES_LIVE_WORKER_OK";

export interface LaunchCheckOptions {
  json: boolean;
  timeoutMs?: number;
}

export interface LaunchCheckReport {
  ok: true;
  version: string;
  provider: Exclude<AppConfig["realtime"]["provider"], "mock">;
  readiness: ReadinessReport;
  plugin: {
    installed: true;
    version: string;
    path: string;
  };
  service: ServiceStatus;
  gateway: {
    ok: true;
    url: string;
  };
  providerSession: LiveProviderSmokeReport;
  worker: {
    runId: string;
    status: "completed";
    outputVerified: true;
  };
}

export interface LaunchCheckDependencies {
  config?: AppConfig;
  readinessCheck?: (config: AppConfig) => Promise<ReadinessReport>;
  pluginStatus?: () => Promise<PluginInstallStatus>;
  pluginVersion?: (target: string) => Promise<string | undefined>;
  serviceStatus?: () => Promise<ServiceStatus>;
  gatewayReadiness?: (origin: string, config: AppConfig) => Promise<{ ok: true } | { ok: false; error: string }>;
  providerSmoke?: (config: AppConfig, options: { timeoutMs: number; verifyToolCall?: boolean }) => Promise<LiveProviderSmokeReport>;
  hermes?: HermesLaunchCheckPort;
  now?: () => number;
}

type HermesLaunchCheckPort = Pick<
  HermesRunsPort,
  "assertRunsSupported" | "startRun" | "streamRunEvents" | "getRun"
>;

export function parseLaunchCheckOptions(args: readonly string[]): LaunchCheckOptions {
  const options: LaunchCheckOptions = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const nextValue = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--json") options.json = true;
    else if (argument === "--timeout-ms") options.timeoutMs = positiveTimeout(nextValue(), argument);
    else if (argument?.startsWith("--timeout-ms=")) {
      options.timeoutMs = positiveTimeout(argument.slice("--timeout-ms=".length), "--timeout-ms");
    } else if (argument === "--help" || argument === "-h") throw new LaunchCheckHelpRequested();
    else if (argument) throw new Error(`Unknown launch-check option: ${argument}`);
  }
  return options;
}

export async function runLaunchCheck(
  options: LaunchCheckOptions,
  dependencies: LaunchCheckDependencies = {},
): Promise<LaunchCheckReport> {
  const config = dependencies.config ?? loadConfig();
  if (config.realtime.provider === "mock") {
    throw new Error("HERMES_LIVE_PROVIDER=mock is for development and cannot pass launch-check.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_CHECK_TIMEOUT_MS;
  const readiness = await (dependencies.readinessCheck ?? buildReadinessReport)(config);
  if (!readiness.ok) {
    throw new Error("Runtime readiness failed. Run `hermes-live doctor` for the exact fix.");
  }

  const plugin = await checkedPlugin(dependencies);
  const service = await (dependencies.serviceStatus ?? serviceStatus)();
  if (service.installed && !service.running) {
    throw new Error("The Hermes Live gateway service is installed but stopped. Run `hermes-live service restart`.");
  }

  const gatewayUrl = gatewayOrigin(config.server.host, config.server.port);
  const gateway = await (dependencies.gatewayReadiness ?? defaultGatewayReadiness)(gatewayUrl, config);
  if (!gateway.ok) {
    throw new Error(`The Live Voice gateway is not ready: ${gateway.error}`);
  }

  const providerSession = await (dependencies.providerSmoke ?? runLiveProviderSmoke)(config, {
    timeoutMs,
    ...(config.realtime.provider === "local" ? { verifyToolCall: true } : {}),
  });
  const worker = await checkHermesWorker(
    dependencies.hermes ?? new HermesClient(config.hermes),
    config,
    timeoutMs,
    dependencies.now ?? Date.now,
  );

  return {
    ok: true,
    version: PACKAGE_VERSION,
    provider: config.realtime.provider,
    readiness,
    plugin,
    service,
    gateway: { ok: true, url: gatewayUrl },
    providerSession,
    worker,
  };
}

export async function runLaunchCheckCommand(args: readonly string[]): Promise<void> {
  let options: LaunchCheckOptions;
  try {
    options = parseLaunchCheckOptions(args);
  } catch (error) {
    if (error instanceof LaunchCheckHelpRequested) {
      console.log(launchCheckHelp());
      return;
    }
    throw error;
  }

  try {
    const report = await runLaunchCheck(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printLaunchCheckReport(report);
  } catch (error) {
    const message = errorToMessage(error);
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else {
      console.error(`Hermes Live Voice launch-check failed: ${message}`);
      console.error("Run `hermes-live doctor --provider-smoke` for detailed fixes.");
    }
    process.exitCode = 1;
  }
}

export function launchCheckHelp(): string {
  return `hermes-live launch-check [--json] [--timeout-ms <ms>]

Run the v1 launch proof. This opens a real voice-provider session, checks the
Dashboard plugin and gateway, then starts one bounded Hermes worker.

Mock mode is rejected. Use this before a public release or user demo.`;
}

async function checkedPlugin(
  dependencies: Pick<LaunchCheckDependencies, "pluginStatus" | "pluginVersion">,
): Promise<LaunchCheckReport["plugin"]> {
  const status = await (dependencies.pluginStatus ?? pluginInstallStatus)();
  if (!status.installed || !status.manifestFound) {
    throw new Error("The Hermes Dashboard Live Voice plugin is not installed. Run `hermes-live setup`.");
  }
  const version = await (dependencies.pluginVersion ?? readInstalledPluginVersion)(status.target);
  if (version !== PACKAGE_VERSION) {
    throw new Error(
      `The installed Hermes plugin is ${version ? `v${version}` : "missing a version"}; package is v${PACKAGE_VERSION}. Run \`hermes-live upgrade\`.`,
    );
  }
  return { installed: true, version, path: status.target };
}

async function checkHermesWorker(
  hermes: HermesLaunchCheckPort,
  config: AppConfig,
  timeoutMs: number,
  now: () => number,
): Promise<LaunchCheckReport["worker"]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Hermes worker launch verification timed out.")),
    timeoutMs,
  );
  timeout.unref?.();
  const sessionKey = [
    config.server.sessionPrefix,
    `profile:${config.server.defaultProfileId}`,
    `user:${config.server.defaultUserLabel}`,
    "launch-check",
  ].join(":");
  const sessionId = `hermes_live_launch_check_${now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  try {
    await hermes.assertRunsSupported(controller.signal);
    const started = await hermes.startRun({
      sessionId,
      sessionKey,
      input: `Launch verification only. Do not use tools or modify files. Reply with exactly ${WORKER_TOKEN}.`,
    }, controller.signal);

    for await (const event of hermes.streamRunEvents(started.runId, {
      signal: controller.signal,
      sessionKey,
    })) {
      if (["run.completed", "run.failed", "run.cancelled"].includes(event.event ?? "")) break;
    }

    const snapshot = await hermes.getRun(started.runId, {
      signal: controller.signal,
      sessionKey,
    });
    if (snapshot.status !== "completed") {
      throw new Error(`Hermes worker ended in ${snapshot.status}.`);
    }
    if (snapshot.output.trim() !== WORKER_TOKEN) {
      throw new Error("Hermes worker completed but did not return the exact launch-check token.");
    }
    return { runId: started.runId, status: "completed", outputVerified: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function defaultGatewayReadiness(
  origin: string,
  config: AppConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return await probeGatewayReadiness(origin, {
    ...(config.server.authToken ? { authToken: config.server.authToken } : {}),
    timeoutMs: 3_000,
  });
}

async function readInstalledPluginVersion(target: string): Promise<string | undefined> {
  const manifest = await readFile(`${target}/plugin.yaml`, "utf8").catch(() => "");
  return /^version:\s*["']?([^\s"']+)["']?\s*$/mu.exec(manifest)?.[1];
}

function printLaunchCheckReport(report: LaunchCheckReport): void {
  console.log("Hermes Live Voice passed v1 launch verification.");
  console.log(`  Voice provider: ${report.provider} ${report.providerSession.model}`);
  console.log(`  Hermes worker: completed ${report.worker.runId}`);
  console.log(`  Gateway: ${report.gateway.url}`);
  console.log(`  Dashboard plugin: v${report.plugin.version}`);
}

function positiveTimeout(value: string, argument: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${argument} requires a positive integer.`);
  return parsed;
}

class LaunchCheckHelpRequested extends Error {}
