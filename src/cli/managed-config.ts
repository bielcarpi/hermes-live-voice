import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 32 * 1024;
const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

export const MANAGED_CONFIG_KEYS = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_GENAI_API_VERSION",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "HERMES_AGENT_API_SERVER_KEY",
  "HERMES_API_KEY",
  "HERMES_BASE_URL",
  "HERMES_LIVE_ALLOW_ORIGIN",
  "HERMES_LIVE_ALLOW_UNAUTHENTICATED",
  "HERMES_LIVE_AUTH_TOKEN",
  "HERMES_LIVE_DEMO_ENABLED",
  "HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS",
  "HERMES_LIVE_HERMES_TIMEOUT_MS",
  "HERMES_LIVE_HOST",
  "HERMES_LIVE_MAX_AUDIO_BYTES",
  "HERMES_LIVE_MAX_CONCURRENT_TASKS",
  "HERMES_LIVE_MAX_QUEUED_TASKS",
  "HERMES_LIVE_MAX_SESSIONS",
  "HERMES_LIVE_MAX_TEXT_CHARS",
  "HERMES_LIVE_PORT",
  "HERMES_LIVE_PROFILE_ID",
  "HERMES_LIVE_PROVIDER",
  "HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS",
  "HERMES_LIVE_RUN_INSTRUCTIONS",
  "HERMES_LIVE_SESSION_PREFIX",
  "HERMES_LIVE_TASK_HISTORY_LIMIT",
  "HERMES_LIVE_TASK_POLL_INTERVAL_MS",
  "HERMES_LIVE_TASK_RETENTION_HOURS",
  "HERMES_LIVE_TASK_STATE_FILE",
  "HERMES_LIVE_TRUST_CLIENT_IDENTITY",
  "HERMES_LIVE_TRUST_DECLARED_READ_ONLY",
  "HERMES_LIVE_USER_LABEL",
  "HERMES_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_BASE_URL",
  "OPENAI_REALTIME_INPUT_AUDIO_FORMAT",
  "OPENAI_REALTIME_MODEL",
  "OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT",
  "OPENAI_REALTIME_REASONING_EFFORT",
  "OPENAI_REALTIME_TURN_DETECTION",
  "OPENAI_REALTIME_VOICE",
] as const;

export type ManagedConfigKey = (typeof MANAGED_CONFIG_KEYS)[number];
export type ManagedConfigValues = Partial<Record<ManagedConfigKey, string>>;

export interface ManagedConfigReadResult {
  path: string;
  exists: boolean;
  values: ManagedConfigValues;
}

export interface ManagedConfigOptions {
  path?: string;
  home?: string;
}

const managedKeySet = new Set<string>(MANAGED_CONFIG_KEYS);

export function managedConfigPath(options: ManagedConfigOptions = {}): string {
  return resolve(
    options.path
      || process.env.HERMES_LIVE_CONFIG_FILE
      || join(options.home ?? homedir(), ".hermes", "hermes-live", "config.env"),
  );
}

export async function applyManagedConfigToProcess(options: ManagedConfigOptions = {}): Promise<ManagedConfigReadResult> {
  const result = await readManagedConfig(options);
  for (const [key, value] of Object.entries(result.values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return result;
}

export async function resolvedManagedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: ManagedConfigOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const result = await readManagedConfig(options);
  return { ...result.values, ...env };
}

export async function readManagedConfig(options: ManagedConfigOptions = {}): Promise<ManagedConfigReadResult> {
  const path = managedConfigPath(options);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) {
    return { path, exists: false, values: {} };
  }
  assertSafeFileStat(path, stat);
  await assertSafeConfigDirectory(dirname(path));

  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const openedStat = await handle.stat();
    assertSafeFileStat(path, openedStat);
    if (openedStat.size > MAX_CONFIG_BYTES) {
      throw new Error(`Managed config exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`);
    }
    return {
      path,
      exists: true,
      values: parseManagedConfig(await handle.readFile({ encoding: "utf8" }), path),
    };
  } finally {
    await handle.close();
  }
}

export async function writeManagedConfig(
  values: ManagedConfigValues,
  options: ManagedConfigOptions = {},
): Promise<string> {
  const path = managedConfigPath(options);
  const directory = dirname(path);
  await prepareConfigDirectory(directory);
  const body = serializeManagedConfig(values);
  if (Buffer.byteLength(body) > MAX_CONFIG_BYTES) {
    throw new Error(`Managed config exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }

  const temporaryPath = join(directory, `.config.env.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, CONFIG_FILE_MODE);
  try {
    await handle.writeFile(body, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, path);
    await chmod(path, CONFIG_FILE_MODE);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

export function parseManagedConfig(source: string, sourceLabel = "managed config"): ManagedConfigValues {
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) {
    throw new Error(`${sourceLabel} exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }
  const values: ManagedConfigValues = {};
  const seen = new Set<string>();
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`${sourceLabel}:${index + 1}: expected KEY=\"value\".`);
    }
    const key = line.slice(0, separator).trim();
    if (!managedKeySet.has(key)) {
      throw new Error(`${sourceLabel}:${index + 1}: ${key || "empty key"} is not a supported Hermes Live setting.`);
    }
    if (seen.has(key)) {
      throw new Error(`${sourceLabel}:${index + 1}: duplicate setting ${key}.`);
    }
    const encoded = line.slice(separator + 1).trim();
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      throw new Error(`${sourceLabel}:${index + 1}: values must be JSON strings.`);
    }
    if (typeof value !== "string") {
      throw new Error(`${sourceLabel}:${index + 1}: ${key} must be a string.`);
    }
    assertSafeValue(key, value);
    values[key as ManagedConfigKey] = value;
    seen.add(key);
  }
  return values;
}

export function serializeManagedConfig(values: ManagedConfigValues): string {
  const lines = [
    "# Hermes Live Voice managed configuration.",
    "# Edit with `hermes-live setup`; process environment variables take precedence.",
  ];
  for (const key of MANAGED_CONFIG_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    assertSafeValue(key, value);
    lines.push(`${key}=${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function prepareConfigDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Managed config directory must be a real directory, not a symlink: ${directory}`);
  }
  if (isPosix()) {
    assertOwnedByCurrentUser(directory, stat.uid);
    await chmod(directory, CONFIG_DIRECTORY_MODE);
  }
}

async function assertSafeConfigDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Managed config directory must be a real directory, not a symlink: ${directory}`);
  }
  if (isPosix()) {
    assertOwnedByCurrentUser(directory, stat.uid);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Managed config directory permissions must be 0700: ${directory}`);
    }
  }
}

function assertSafeFileStat(path: string, stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Managed config must be a regular file, not a symlink: ${path}`);
  }
  if (isPosix()) {
    assertOwnedByCurrentUser(path, stat.uid);
    if ((stat.mode & 0o177) !== 0) {
      throw new Error(`Managed config permissions must be 0600: ${path}`);
    }
  }
}

function assertOwnedByCurrentUser(path: string, uid: number): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error(`Managed config must be owned by the current user: ${path}`);
  }
}

function assertSafeValue(key: string, value: string): void {
  if (value.length > MAX_VALUE_CHARS) {
    throw new Error(`${key} exceeds ${MAX_VALUE_CHARS} characters.`);
  }
  if (value.includes("\u0000")) {
    throw new Error(`${key} contains a NUL character.`);
  }
}

function isPosix(): boolean {
  return process.platform !== "win32";
}
