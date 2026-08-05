import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const MAX_ENV_BYTES = 64 * 1024;
const ENV_FILE_MODE = 0o600;

export interface HermesApiEnvironmentResult {
  path: string;
  changed: boolean;
  created: boolean;
}

export function resolveHermesHome(home: string, env: NodeJS.ProcessEnv): string {
  return resolve(env.HERMES_HOME || join(home, ".hermes"));
}

export function generateHermesApiKey(): string {
  return randomBytes(32).toString("hex");
}

export function isDefaultLocalHermesApi(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
      && (url.port || "80") === "8642"
      && (url.pathname === "/" || url.pathname === "")
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

/**
 * Persist the private loopback bridge that Hermes Live Voice needs.
 *
 * This intentionally edits only the two API-server variables in Hermes' own
 * environment file. Unknown settings and comments are preserved, and the
 * replacement is atomic so an interrupted setup cannot truncate Hermes config.
 */
export async function ensureHermesApiEnvironment(
  hermesHome: string,
  apiKey: string,
): Promise<HermesApiEnvironmentResult> {
  assertSafeApiKey(apiKey);
  const path = join(resolve(hermesHome), ".env");
  const existing = await readSafeEnvironment(path);
  let source = existing.source;
  source = setEnvironmentValue(source, "API_SERVER_ENABLED", "true");
  source = setEnvironmentValue(source, "API_SERVER_KEY", apiKey);
  if (source === existing.source) {
    return { path, changed: false, created: false };
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.env.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    ENV_FILE_MODE,
  );
  try {
    await handle.writeFile(source, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, path);
    await chmod(path, ENV_FILE_MODE);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { path, changed: true, created: !existing.exists };
}

interface EnvironmentSource {
  exists: boolean;
  source: string;
}

async function readSafeEnvironment(path: string): Promise<EnvironmentSource> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return { exists: false, source: "" };
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
  if (stat.size > MAX_ENV_BYTES) throw new Error(`Hermes environment exceeds ${MAX_ENV_BYTES} bytes.`);

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
    const buffer = Buffer.alloc(MAX_ENV_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_ENV_BYTES) throw new Error(`Hermes environment exceeds ${MAX_ENV_BYTES} bytes.`);
    return { exists: true, source: buffer.subarray(0, offset).toString("utf8") };
  } finally {
    await handle.close();
  }
}

function setEnvironmentValue(source: string, key: string, value: string): string {
  const encoded = encodeEnvironmentValue(value);
  const lines = source.split(/\r?\n/u);
  const matches: number[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimStart();
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    if (normalized.startsWith(`${key}=`) || new RegExp(`^${key}\\s*=`).test(normalized)) {
      matches.push(index);
    }
  }
  if (matches.length > 1) throw new Error(`Hermes environment contains duplicate ${key}.`);
  if (matches.length === 1) {
    const index = matches[0] as number;
    const prefix = lines[index]?.match(/^\s*/u)?.[0] ?? "";
    lines[index] = `${prefix}${key}=${encoded}`;
  } else {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    lines.push(`${key}=${encoded}`, "");
  }
  return lines.join("\n");
}

function encodeEnvironmentValue(value: string): string {
  return JSON.stringify(value);
}

function assertSafeApiKey(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 16 || bytes > 4096 || /[\r\n\0]/u.test(value)) {
    throw new Error("Hermes API_SERVER_KEY must be a single-line secret between 16 and 4096 bytes.");
  }
}
