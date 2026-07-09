import {
  assertGatewayExposureConfig,
  assertHermesApiConfig,
  assertRealtimeProviderConfig,
  type AppConfig,
} from "./config.js";
import type { HermesRunsPort } from "./application/live-gateway/ports/hermes-runs.port.js";
import { HermesClient } from "./adapters/outbound/hermes/hermes-runs.client.js";

export interface ReadinessSection extends Record<string, unknown> {
  ok: boolean;
}

export interface ReadinessReport {
  ok: boolean;
  gateway: ReadinessSection;
  hermes: ReadinessSection;
  realtime: ReadinessSection;
}

export interface BuildReadinessReportOptions {
  hermes?: HermesRunsPort;
  requireHermesApiKey?: boolean;
  requireRealtimeProviderConfig?: boolean;
}

export async function buildReadinessReport(config: AppConfig, options: BuildReadinessReportOptions = {}): Promise<ReadinessReport> {
  const gateway = checkGatewayConfig(config);
  const hermes = await checkHermesConfig(config, options);
  const realtime = checkRealtimeConfig(config, options);
  return {
    ok: gateway.ok && hermes.ok && realtime.ok,
    gateway,
    hermes,
    realtime,
  };
}

function checkGatewayConfig(config: AppConfig): ReadinessSection {
  const base = {
    host: config.server.host,
    port: config.server.port,
    authRequired: Boolean(config.server.authToken),
    demoEnabled: config.server.demoEnabled,
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
  const base = { baseUrl: hermes.baseUrl ?? config.hermes.baseUrl };
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
      baseUrl: config.openai.baseUrl,
      voice: config.openai.voice,
      reasoningEffort: config.openai.reasoningEffort,
      turnDetection: config.openai.turnDetection,
      inputAudioFormat: config.openai.inputAudioFormat,
      outputAudioFormat: config.openai.outputAudioFormat,
    };
  }
  if (config.realtime.provider === "local") {
    return {
      ...base,
      baseUrl: config.local.baseUrl,
      voice: config.local.voice,
    };
  }
  return base;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
