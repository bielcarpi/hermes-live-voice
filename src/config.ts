import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const MAX_COMPATIBLE_AUDIO_FRAME_BYTES = 5_900_000;
export const MAX_COMPATIBLE_TEXT_CHARS = 1_000_000;
export const DEFAULT_HERMES_STREAM_IDLE_TIMEOUT_MS = 120_000;
const MAX_OUTBOUND_BASE_URL_CHARS = 2_048;
const MAX_STATE_FILE_PATH_CHARS = 4_096;

const HermesBaseUrlSchema = z.string().url().refine(isSafeHermesBaseUrl, {
  message: "HERMES_BASE_URL must be a credential-free HTTP(S) root origin.",
});
const OpenAIRealtimeBaseUrlSchema = z.string().url().refine(isSafeOpenAIRealtimeBaseUrl, {
  message: "OPENAI_REALTIME_BASE_URL must be a credential-free WS(S) URL without a fragment.",
});
const GoogleCloudProjectSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(6).max(30).refine(isSafeGoogleCloudProject, {
    message: "GOOGLE_CLOUD_PROJECT must be a canonical Google Cloud project id.",
  }).optional(),
);
const GoogleCloudLocationSchema = z.string().min(1).max(63).refine(isSafeGoogleCloudLocation, {
  message: "GOOGLE_CLOUD_LOCATION must be a canonical Google Cloud location.",
});
const GoogleGenAiApiVersionSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(2).max(32).refine(isSafeGoogleGenAiApiVersion, {
    message: "GOOGLE_GENAI_API_VERSION must be a bounded v1/v1beta/v1alpha-style token.",
  }).optional(),
);
const TaskStateFileSchema = z.string().min(1).max(MAX_STATE_FILE_PATH_CHARS).refine(
  (value) => isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  { message: "HERMES_LIVE_TASK_STATE_FILE must be a bounded absolute path." },
);

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  HERMES_LIVE_HOST: z.string().default("127.0.0.1"),
  HERMES_LIVE_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HERMES_LIVE_AUTH_TOKEN: z.string().optional(),
  HERMES_LIVE_ALLOW_UNAUTHENTICATED: z.string().optional(),
  HERMES_LIVE_ALLOW_ORIGIN: z.string().optional(),
  HERMES_LIVE_SESSION_PREFIX: z.string().default("agent:main:hermes-live"),
  HERMES_LIVE_PROFILE_ID: z.string().default("default"),
  HERMES_LIVE_USER_LABEL: z.string().default("voice"),
  HERMES_LIVE_TRUST_CLIENT_IDENTITY: z.string().optional(),
  HERMES_LIVE_MAX_SESSIONS: z.coerce.number().int().positive().default(8),
  HERMES_LIVE_MAX_AUDIO_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_COMPATIBLE_AUDIO_FRAME_BYTES)
    .default(2_000_000),
  HERMES_LIVE_MAX_TEXT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_COMPATIBLE_TEXT_CHARS)
    .default(20_000),
  HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HERMES_LIVE_DEMO_ENABLED: z.string().optional(),
  HERMES_LIVE_TASK_STATE_FILE: TaskStateFileSchema.default(
    join(homedir(), ".hermes", "hermes-live", "tasks-v1.json"),
  ),
  HERMES_LIVE_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(16).default(3),
  HERMES_LIVE_MAX_QUEUED_TASKS: z.coerce.number().int().min(0).max(512).default(32),
  HERMES_LIVE_TASK_HISTORY_LIMIT: z.coerce.number().int().min(10).max(1_000).default(200),
  HERMES_LIVE_TASK_RETENTION_HOURS: z.coerce.number().int().min(1).max(8_760).default(168),
  HERMES_LIVE_TASK_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),

  HERMES_BASE_URL: HermesBaseUrlSchema.default("http://127.0.0.1:8642"),
  HERMES_AGENT_API_SERVER_KEY: z.string().optional(),
  HERMES_API_KEY: z.string().optional(),
  HERMES_MODEL: z.string().default("hermes-agent"),
  HERMES_LIVE_RUN_INSTRUCTIONS: z.string().optional(),
  HERMES_LIVE_HERMES_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(DEFAULT_HERMES_STREAM_IDLE_TIMEOUT_MS),

  HERMES_LIVE_PROVIDER: z.enum(["gemini", "openai", "mock"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-live-preview"),
  GOOGLE_GENAI_USE_ENTERPRISE: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: GoogleCloudProjectSchema,
  GOOGLE_CLOUD_LOCATION: GoogleCloudLocationSchema.default("us-central1"),
  GOOGLE_GENAI_API_VERSION: GoogleGenAiApiVersionSchema,

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_BASE_URL: OpenAIRealtimeBaseUrlSchema.default("wss://api.openai.com/v1/realtime"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2.1"),
  OPENAI_REALTIME_VOICE: z.string().default("marin"),
  OPENAI_REALTIME_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("low"),
  OPENAI_REALTIME_TURN_DETECTION: z.enum(["disabled", "semantic_vad", "server_vad"]).default("disabled"),
  OPENAI_REALTIME_INPUT_AUDIO_FORMAT: z.enum(["pcm16", "g711_ulaw", "g711_alaw"]).default("pcm16"),
  OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT: z.enum(["pcm16", "g711_ulaw", "g711_alaw"]).default("pcm16"),
});

export type RealtimeProvider = "gemini" | "openai" | "mock";

export interface AppConfig {
  server: {
    host: string;
    port: number;
    authToken?: string;
    allowUnauthenticated: boolean;
    allowOrigin?: string;
    sessionPrefix: string;
    defaultProfileId: string;
    defaultUserLabel: string;
    trustClientIdentity: boolean;
    maxSessions: number;
    maxAudioBytes: number;
    maxTextChars: number;
    providerReadyTimeoutMs: number;
    demoEnabled: boolean;
  };
  hermes: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    instructions?: string;
    timeoutMs: number;
    streamIdleTimeoutMs?: number;
  };
  tasks: {
    stateFile: string;
    maxConcurrent: number;
    maxQueued: number;
    historyLimit: number;
    retentionMs: number;
    pollIntervalMs: number;
  };
  realtime: {
    provider: RealtimeProvider;
    model: string;
  };
  gemini: {
    apiKey?: string;
    model: string;
    enterprise: boolean;
    project?: string;
    location: string;
    apiVersion?: string;
  };
  openai: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    voice: string;
    reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
    turnDetection: "disabled" | "semantic_vad" | "server_vad";
    inputAudioFormat: "pcm16" | "g711_ulaw" | "g711_alaw";
    outputAudioFormat: "pcm16" | "g711_ulaw" | "g711_alaw";
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const geminiApiKey = parsed.GEMINI_API_KEY || parsed.GOOGLE_API_KEY;
  const hermesApiKey = parsed.HERMES_AGENT_API_SERVER_KEY || parsed.HERMES_API_KEY;
  const enterprise = parseBool(parsed.GOOGLE_GENAI_USE_ENTERPRISE);
  const realtimeModel = selectedRealtimeModel(parsed.HERMES_LIVE_PROVIDER, parsed.GEMINI_MODEL, parsed.OPENAI_REALTIME_MODEL);

  return {
    server: {
      host: parsed.HERMES_LIVE_HOST,
      port: parsed.PORT ?? parsed.HERMES_LIVE_PORT,
      ...(parsed.HERMES_LIVE_AUTH_TOKEN ? { authToken: parsed.HERMES_LIVE_AUTH_TOKEN } : {}),
      allowUnauthenticated: parseBool(parsed.HERMES_LIVE_ALLOW_UNAUTHENTICATED),
      ...(parsed.HERMES_LIVE_ALLOW_ORIGIN ? { allowOrigin: parsed.HERMES_LIVE_ALLOW_ORIGIN } : {}),
      sessionPrefix: parsed.HERMES_LIVE_SESSION_PREFIX,
      defaultProfileId: parsed.HERMES_LIVE_PROFILE_ID,
      defaultUserLabel: parsed.HERMES_LIVE_USER_LABEL,
      trustClientIdentity: parseBool(parsed.HERMES_LIVE_TRUST_CLIENT_IDENTITY),
      maxSessions: parsed.HERMES_LIVE_MAX_SESSIONS,
      maxAudioBytes: parsed.HERMES_LIVE_MAX_AUDIO_BYTES,
      maxTextChars: parsed.HERMES_LIVE_MAX_TEXT_CHARS,
      providerReadyTimeoutMs: parsed.HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS,
      demoEnabled:
        parsed.HERMES_LIVE_DEMO_ENABLED === undefined
          ? parsed.NODE_ENV !== "production"
          : parseBool(parsed.HERMES_LIVE_DEMO_ENABLED),
    },
    hermes: {
      baseUrl: withoutTrailingSlash(parsed.HERMES_BASE_URL),
      ...(hermesApiKey ? { apiKey: hermesApiKey } : {}),
      model: parsed.HERMES_MODEL,
      ...(parsed.HERMES_LIVE_RUN_INSTRUCTIONS ? { instructions: parsed.HERMES_LIVE_RUN_INSTRUCTIONS } : {}),
      timeoutMs: parsed.HERMES_LIVE_HERMES_TIMEOUT_MS,
      streamIdleTimeoutMs: parsed.HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS,
    },
    tasks: {
      stateFile: parsed.HERMES_LIVE_TASK_STATE_FILE,
      maxConcurrent: parsed.HERMES_LIVE_MAX_CONCURRENT_TASKS,
      maxQueued: parsed.HERMES_LIVE_MAX_QUEUED_TASKS,
      historyLimit: parsed.HERMES_LIVE_TASK_HISTORY_LIMIT,
      retentionMs: parsed.HERMES_LIVE_TASK_RETENTION_HOURS * 60 * 60 * 1_000,
      pollIntervalMs: parsed.HERMES_LIVE_TASK_POLL_INTERVAL_MS,
    },
    realtime: {
      provider: parsed.HERMES_LIVE_PROVIDER,
      model: realtimeModel,
    },
    gemini: {
      ...(geminiApiKey ? { apiKey: geminiApiKey } : {}),
      model: parsed.GEMINI_MODEL,
      enterprise,
      ...(parsed.GOOGLE_CLOUD_PROJECT ? { project: parsed.GOOGLE_CLOUD_PROJECT } : {}),
      location: parsed.GOOGLE_CLOUD_LOCATION,
      ...(parsed.GOOGLE_GENAI_API_VERSION ? { apiVersion: parsed.GOOGLE_GENAI_API_VERSION } : {}),
    },
    openai: {
      ...(parsed.OPENAI_API_KEY ? { apiKey: parsed.OPENAI_API_KEY } : {}),
      baseUrl: parsed.OPENAI_REALTIME_BASE_URL,
      model: parsed.OPENAI_REALTIME_MODEL,
      voice: parsed.OPENAI_REALTIME_VOICE,
      reasoningEffort: parsed.OPENAI_REALTIME_REASONING_EFFORT,
      turnDetection: parsed.OPENAI_REALTIME_TURN_DETECTION,
      inputAudioFormat: parsed.OPENAI_REALTIME_INPUT_AUDIO_FORMAT,
      outputAudioFormat: parsed.OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT,
    },
  };
}

export function assertRuntimeConfig(config: AppConfig): void {
  assertHermesApiConfig(config);
  assertGatewayExposureConfig(config);
  assertRealtimeProviderConfig(config);
}

export function assertHermesApiConfig(config: Pick<AppConfig, "hermes">): void {
  if (!config.hermes.apiKey) {
    throw new Error("Set HERMES_AGENT_API_SERVER_KEY to Hermes Agent's API_SERVER_KEY.");
  }
}

export function assertGatewayExposureConfig(config: Pick<AppConfig, "server">): void {
  if (!config.server.authToken && isNetworkAccessibleHost(config.server.host) && !config.server.allowUnauthenticated) {
    throw new Error(
      "HERMES_LIVE_AUTH_TOKEN is required when HERMES_LIVE_HOST is network-accessible. " +
        "Set HERMES_LIVE_ALLOW_UNAUTHENTICATED=true only for an isolated trusted network.",
    );
  }
  if (config.server.authToken && isNetworkAccessibleHost(config.server.host) && config.server.authToken.length < 16) {
    throw new Error("HERMES_LIVE_AUTH_TOKEN must be at least 16 characters when HERMES_LIVE_HOST is network-accessible.");
  }
}

export function assertRealtimeProviderConfig(config: Pick<AppConfig, "realtime" | "gemini" | "openai">): void {
  if (config.realtime.provider === "gemini" && config.gemini.enterprise && !config.gemini.project) {
    throw new Error("GOOGLE_CLOUD_PROJECT is required when GOOGLE_GENAI_USE_ENTERPRISE=true.");
  }
  if (realtimeProviderConfigured(config)) {
    return;
  }
  if (config.realtime.provider === "openai") {
    throw new Error("Set OPENAI_API_KEY or use HERMES_LIVE_PROVIDER=mock for local text-only development.");
  }
  if (config.realtime.provider === "gemini" && !config.gemini.enterprise && !config.gemini.apiKey) {
    throw new Error(
      "Set GEMINI_API_KEY or GOOGLE_API_KEY, enable GOOGLE_GENAI_USE_ENTERPRISE=true, or use HERMES_LIVE_PROVIDER=mock for local text-only development.",
    );
  }
}

export function realtimeProviderConfigured(config: Pick<AppConfig, "realtime" | "gemini" | "openai">): boolean {
  if (config.realtime.provider === "mock") {
    return true;
  }
  if (config.realtime.provider === "openai") {
    return Boolean(config.openai.apiKey);
  }
  if (config.gemini.enterprise) {
    return Boolean(config.gemini.project);
  }
  return Boolean(config.gemini.apiKey);
}

export function sanitizeSessionComponent(value: string): string {
  const sanitized: string[] = [];
  let replacingUnsafeRun = false;

  for (const character of value.trim().toLowerCase()) {
    if (isSafeSessionCharacter(character)) {
      sanitized.push(character);
      replacingUnsafeRun = false;
    } else if (!replacingUnsafeRun) {
      sanitized.push("-");
      replacingUnsafeRun = true;
    }
  }

  let start = 0;
  let end = sanitized.length;
  while (start < end && sanitized[start] === "-") {
    start += 1;
  }
  while (end > start && sanitized[end - 1] === "-") {
    end -= 1;
  }

  return sanitized.slice(start, Math.min(end, start + 80)).join("");
}

function isSafeSessionCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    character === "." ||
    character === "_" ||
    character === ":" ||
    character === "-"
  );
}

export function makeSessionKey(prefix: string, profileId: string, userLabel: string): string {
  const safeProfile = sanitizeSessionComponent(profileId || "default") || "default";
  const safeUser = sanitizeSessionComponent(userLabel || "anonymous") || "anonymous";
  return `${prefix}:profile:${safeProfile}:user:${safeUser}`.slice(0, 256);
}

function parseBool(value: string | undefined): boolean {
  return value ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : false;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isSafeHermesBaseUrl(value: string): boolean {
  const parsed = parseSafeConfiguredUrl(value);
  return Boolean(
    parsed &&
    ["http:", "https:"].includes(parsed.protocol) &&
    parsed.pathname === "/" &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

function isSafeOpenAIRealtimeBaseUrl(value: string): boolean {
  const parsed = parseSafeConfiguredUrl(value);
  return Boolean(
    parsed &&
    ["ws:", "wss:"].includes(parsed.protocol) &&
    !value.includes("#")
  );
}

export function isSafeGoogleCloudProject(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value);
}

export function isSafeGoogleCloudLocation(value: string): boolean {
  return value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

export function isSafeGoogleGenAiApiVersion(value: string): boolean {
  return value.length <= 32 && /^v[1-9][0-9]*(?:(?:alpha|beta)[0-9]*)?$/u.test(value);
}

function parseSafeConfiguredUrl(value: string): URL | undefined {
  if (
    !value ||
    value.length > MAX_OUTBOUND_BASE_URL_CHARS ||
    value !== value.trim() ||
    /[\\\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password || !parsed.hostname ? undefined : parsed;
  } catch {
    return undefined;
  }
}

export function publicBaseUrl(value: string): string {
  if (
    !value ||
    value.length > MAX_OUTBOUND_BASE_URL_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return "[invalid-url]";
  }
  try {
    const parsed = new URL(value);
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!parsed.hostname || origin.length > 512) return "[invalid-url]";
    const path = parsed.pathname === "/" ? "" : "/[redacted-path]";
    const query = value.includes("?") ? "?[redacted]" : "";
    return `${origin}${path}${query}`;
  } catch {
    return "[invalid-url]";
  }
}

function selectedRealtimeModel(provider: RealtimeProvider, geminiModel: string, openaiModel: string): string {
  if (provider === "openai") {
    return openaiModel;
  }
  if (provider === "mock") {
    return "mock-live";
  }
  return geminiModel;
}

function isNetworkAccessibleHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(normalized);
}
