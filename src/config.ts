import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  HERMES_LIVE_HOST: z.string().default("127.0.0.1"),
  HERMES_LIVE_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HERMES_LIVE_AUTH_TOKEN: z.string().optional(),
  HERMES_LIVE_ALLOW_UNAUTHENTICATED: z.string().optional(),
  HERMES_LIVE_ALLOW_ORIGIN: z.string().optional(),
  HERMES_LIVE_SESSION_PREFIX: z.string().default("agent:main:hermes-live"),
  HERMES_LIVE_MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(2_000_000),
  HERMES_LIVE_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(20_000),
  HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HERMES_LIVE_DEMO_ENABLED: z.string().optional(),
  HERMES_LIVE_NARRATION_ENABLED: z.string().optional(),
  HERMES_LIVE_NARRATION_GRACE_MS: z.coerce.number().int().nonnegative().default(6_000),
  HERMES_LIVE_NARRATION_MIN_GAP_MS: z.coerce.number().int().nonnegative().default(12_000),
  HERMES_LIVE_NARRATION_HEARTBEAT_IDLE_MS: z.coerce.number().int().nonnegative().default(25_000),
  HERMES_LIVE_NARRATION_HEARTBEAT_MAX: z.coerce.number().int().min(0).default(2),
  HERMES_LIVE_NARRATION_REASONING_MODE: z.enum(["paraphrase", "off"]).default("paraphrase"),
  HERMES_LIVE_NARRATION_AUDIO_GAP_MS: z.coerce.number().int().nonnegative().default(800),

  HERMES_BASE_URL: z.string().url().default("http://127.0.0.1:8642"),
  HERMES_AGENT_API_SERVER_KEY: z.string().optional(),
  HERMES_API_KEY: z.string().optional(),
  HERMES_MODEL: z.string().default("hermes-agent"),
  HERMES_LIVE_RUN_INSTRUCTIONS: z.string().optional(),
  HERMES_LIVE_HERMES_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

  HERMES_LIVE_PROVIDER: z.enum(["gemini", "openai", "local", "mock"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-live-preview"),
  GOOGLE_GENAI_USE_ENTERPRISE: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default("us-central1"),
  GOOGLE_GENAI_API_VERSION: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_BASE_URL: z.string().url().default("wss://api.openai.com/v1/realtime"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_REALTIME_VOICE: z.string().default("echo"),
  OPENAI_REALTIME_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("low"),
  OPENAI_REALTIME_TURN_DETECTION: z.enum(["disabled", "semantic_vad", "server_vad"]).default("disabled"),
  OPENAI_REALTIME_INPUT_AUDIO_FORMAT: z.enum(["pcm16", "g711_ulaw", "g711_alaw"]).default("pcm16"),
  OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT: z.enum(["pcm16", "g711_ulaw", "g711_alaw"]).default("pcm16"),

  HERMES_LOCAL_REALTIME_BASE_URL: z
    .string()
    .url()
    .default("ws://127.0.0.1:8765/v1/realtime")
    .refine((v) => v.startsWith("ws://") || v.startsWith("wss://"), "must be a ws:// or wss:// URL"),
  HERMES_LOCAL_REALTIME_VOICE: z.string().default("Aiden"),
});

export type RealtimeProvider = "gemini" | "openai" | "local" | "mock";

export interface AppConfig {
  server: {
    host: string;
    port: number;
    authToken?: string;
    allowUnauthenticated: boolean;
    allowOrigin?: string;
    sessionPrefix: string;
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
  local: {
    baseUrl: string;
    voice: string;
  };
  narration: {
    enabled: boolean;
    graceMs: number;
    minGapMs: number;
    heartbeatIdleMs: number;
    heartbeatMax: number;
    reasoningMode: "paraphrase" | "off";
    audioGapMs: number;
  };
}

export const defaultNarrationConfig: AppConfig["narration"] = {
  enabled: true,
  graceMs: 6_000,
  minGapMs: 12_000,
  heartbeatIdleMs: 25_000,
  heartbeatMax: 2,
  reasoningMode: "paraphrase",
  audioGapMs: 800,
};

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
      baseUrl: withoutTrailingSlash(parsed.OPENAI_REALTIME_BASE_URL),
      model: parsed.OPENAI_REALTIME_MODEL,
      voice: parsed.OPENAI_REALTIME_VOICE,
      reasoningEffort: parsed.OPENAI_REALTIME_REASONING_EFFORT,
      turnDetection: parsed.OPENAI_REALTIME_TURN_DETECTION,
      inputAudioFormat: parsed.OPENAI_REALTIME_INPUT_AUDIO_FORMAT,
      outputAudioFormat: parsed.OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT,
    },
    local: {
      baseUrl: withoutTrailingSlash(parsed.HERMES_LOCAL_REALTIME_BASE_URL),
      voice: parsed.HERMES_LOCAL_REALTIME_VOICE,
    },
    narration: {
      enabled:
        parsed.HERMES_LIVE_NARRATION_ENABLED === undefined
          ? true
          : parseBool(parsed.HERMES_LIVE_NARRATION_ENABLED),
      graceMs: parsed.HERMES_LIVE_NARRATION_GRACE_MS,
      minGapMs: parsed.HERMES_LIVE_NARRATION_MIN_GAP_MS,
      heartbeatIdleMs: parsed.HERMES_LIVE_NARRATION_HEARTBEAT_IDLE_MS,
      heartbeatMax: parsed.HERMES_LIVE_NARRATION_HEARTBEAT_MAX,
      reasoningMode: parsed.HERMES_LIVE_NARRATION_REASONING_MODE,
      audioGapMs: parsed.HERMES_LIVE_NARRATION_AUDIO_GAP_MS,
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

export function assertRealtimeProviderConfig(config: Pick<AppConfig, "realtime" | "gemini" | "openai" | "local" | "server">): void {
  if (config.realtime.provider === "gemini" && config.gemini.enterprise && !config.gemini.project) {
    throw new Error("GOOGLE_CLOUD_PROJECT is required when GOOGLE_GENAI_USE_ENTERPRISE=true.");
  }
  if (config.realtime.provider === "local") {
    const url = config.local.baseUrl;
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      throw new Error("HERMES_LOCAL_REALTIME_BASE_URL must be a ws:// or wss:// URL.");
    }
    if (isNetworkAccessibleHost(config.server.host)) {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
          console.warn(
            "Warning: HERMES_LIVE_HOST is network-accessible but HERMES_LOCAL_REALTIME_BASE_URL points to a non-loopback host. " +
              "Ensure the local realtime backend is properly secured.",
          );
        }
      } catch {
        // URL already validated by Zod; ignore parse errors here
      }
    }
    return;
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

export function realtimeProviderConfigured(config: Pick<AppConfig, "realtime" | "gemini" | "openai" | "local">): boolean {
  if (config.realtime.provider === "mock") {
    return true;
  }
  if (config.realtime.provider === "local") {
    return Boolean(config.local.baseUrl);
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
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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

export function selectedRealtimeModel(provider: RealtimeProvider, geminiModel: string, openaiModel: string): string {
  if (provider === "local") {
    return "hf-realtime-voice";
  }
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
