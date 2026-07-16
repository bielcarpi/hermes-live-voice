import {
  assertGatewayExposureConfig,
  assertHermesApiConfig,
  assertRealtimeProviderConfig,
  publicBaseUrl,
  type AppConfig,
} from "./config.js";
import type { HermesRunsPort } from "./application/live-gateway/ports/hermes-runs.port.js";
import {
  hermesApprovalCompatibility,
  unnegotiatedHermesApprovalCompatibility,
} from "./application/live-gateway/hermes-approval-compatibility.js";
import { HermesClient } from "./adapters/outbound/hermes/hermes-runs.client.js";
import { errorToMessage } from "./domain/error-message.js";

export interface ReadinessSection extends Record<string, unknown> {
  ok: boolean;
}

export interface ReadinessReport {
  ok: boolean;
  gateway: ReadinessSection;
  hermes: ReadinessSection;
  realtime: ReadinessSection;
  tasks: ReadinessSection;
}

export interface TaskRuntimeHealthPort {
  health(): Promise<void>;
}

export interface BuildReadinessReportOptions {
  hermes?: HermesRunsPort;
  tasks?: TaskRuntimeHealthPort;
  requireHermesApiKey?: boolean;
  requireRealtimeProviderConfig?: boolean;
}

export async function buildReadinessReport(config: AppConfig, options: BuildReadinessReportOptions = {}): Promise<ReadinessReport> {
  const gateway = checkGatewayConfig(config);
  const realtime = checkRealtimeConfig(config, options);
  const [hermes, tasks] = await Promise.all([
    checkHermesConfig(config, options),
    checkTaskRuntime(options.tasks),
  ]);
  return {
    ok: gateway.ok && hermes.ok && realtime.ok && tasks.ok,
    gateway,
    hermes,
    realtime,
    tasks,
  };
}

async function checkTaskRuntime(tasks: TaskRuntimeHealthPort | undefined): Promise<ReadinessSection> {
  if (!tasks) return { ok: true, checked: false, durable: true };
  try {
    await tasks.health();
    return { ok: true, checked: true, durable: true };
  } catch {
    return {
      ok: false,
      checked: true,
      durable: true,
      error: "Task state is unavailable. Check the gateway logs.",
    };
  }
}

function checkGatewayConfig(config: AppConfig): ReadinessSection {
  const base = {
    host: config.server.host,
    port: config.server.port,
    authRequired: Boolean(config.server.authToken),
    demoEnabled: config.server.demoEnabled,
    serverManagedIdentity: !config.server.trustClientIdentity,
    maxSessions: config.server.maxSessions,
    tasks: {
      durable: true,
      maxConcurrent: config.tasks.maxConcurrent,
      declaredReadOnlyTrusted: config.tasks.trustDeclaredReadOnly === true,
      maxQueued: config.tasks.maxQueued,
      maxRetained: config.tasks.historyLimit,
      retentionMs: config.tasks.retentionMs,
      pollIntervalMs: config.tasks.pollIntervalMs,
    },
  };
  try {
    assertGatewayExposureConfig(config);
    return { ok: true, ...base };
  } catch (error) {
    return { ok: false, ...base, error: errorToMessage(error) };
  }
}

async function checkHermesConfig(config: AppConfig, options: BuildReadinessReportOptions): Promise<ReadinessSection> {
  const hermes = options.hermes ?? new HermesClient(config.hermes);
  const base = {
    baseUrl: publicBaseUrl(hermes.baseUrl ?? config.hermes.baseUrl),
    approvals: unnegotiatedHermesApprovalCompatibility(),
  };
  if (options.requireHermesApiKey ?? true) {
    try {
      assertHermesApiConfig(config);
    } catch (error) {
      return { ok: false, ...base, error: errorToMessage(error) };
    }
  }

  try {
    const capabilities = await hermes.assertRunsSupported();
    return {
      ok: true,
      ...base,
      ...(capabilities.model ? { model: capabilities.model } : {}),
      ...(capabilities.features ? { features: capabilities.features } : {}),
      approvals: hermesApprovalCompatibility(capabilities),
    };
  } catch (error) {
    return { ok: false, ...base, error: errorToMessage(error) };
  }
}

function checkRealtimeConfig(config: AppConfig, options: BuildReadinessReportOptions): ReadinessSection {
  const base = realtimeCheckSummary(config);
  if (options.requireRealtimeProviderConfig === false) {
    return { ok: true, configured: true, injected: true, ...base };
  }
  try {
    assertRealtimeProviderConfig(config);
    return { ok: true, configured: true, ...base };
  } catch (error) {
    return { ok: false, configured: false, ...base, error: errorToMessage(error) };
  }
}

function realtimeCheckSummary(config: AppConfig): Record<string, unknown> {
  const base = {
    provider: config.realtime.provider,
    model: config.realtime.model,
    sessionChecked: false,
  };
  if (config.realtime.provider === "gemini") {
    return {
      ...base,
      enterprise: config.gemini.enterprise,
      location: config.gemini.location,
      projectConfigured: Boolean(config.gemini.project),
      ...(config.gemini.apiVersion ? { apiVersion: config.gemini.apiVersion } : {}),
    };
  }
  if (config.realtime.provider === "openai") {
    return {
      ...base,
      baseUrl: publicBaseUrl(config.openai.baseUrl),
      voice: config.openai.voice,
      reasoningEffort: config.openai.reasoningEffort,
      turnDetection: config.openai.turnDetection,
      inputAudioFormat: config.openai.inputAudioFormat,
      outputAudioFormat: config.openai.outputAudioFormat,
    };
  }
  return base;
}
