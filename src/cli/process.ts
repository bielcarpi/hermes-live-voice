import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export interface CommandResult {
  command: string;
  args: string[];
  code: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;

    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer | string): Buffer<ArrayBufferLike> => {
      if (current.byteLength >= maxOutputBytes) return current;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      return Buffer.concat([current, next.subarray(0, maxOutputBytes - current.byteLength)]);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    timer.unref?.();

    const finish = (code: number, signal?: NodeJS.Signals): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args: [...args],
        code,
        ...(signal ? { signal } : {}),
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
      });
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      stderr = append(stderr, error.message);
      finish(error.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0), signal ?? undefined));
  });
};

export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (name.includes("/") || (process.platform === "win32" && name.includes("\\"))) {
    return await isExecutable(name) ? name : undefined;
  }
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
