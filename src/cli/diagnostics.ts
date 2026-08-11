import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { readManagedConfig } from "./managed-config.js";
import { runDoctor, type DoctorOptions, type DoctorReport } from "./doctor.js";

const packageRequire = createRequire(import.meta.url);
const PACKAGE = packageRequire("../../package.json") as { name: string; version: string };
const SENSITIVE_FIELD = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/iu;
const SENSITIVE_ENVIRONMENT_NAME = /(?:API[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|SECRET|TOKEN)/iu;

export interface DiagnosticsOptions extends Omit<DoctorOptions, "json"> {
  output?: string;
}

export interface DiagnosticBundle {
  schemaVersion: 1;
  generatedAt: string;
  package: { name: string; version: string };
  runtime: { platform: NodeJS.Platform; arch: string; node: string };
  doctor: DoctorReport;
}

export function parseDiagnosticsOptions(args: readonly string[]): DiagnosticsOptions {
  const remaining = args[0] === "export" ? args.slice(1) : args;
  const options: DiagnosticsOptions = { providerSmoke: false };
  for (let index = 0; index < remaining.length; index += 1) {
    const argument = remaining[index];
    const nextValue = (): string => {
      const value = remaining[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === "--output") options.output = nextValue();
    else if (argument?.startsWith("--output=")) options.output = argument.slice(9);
    else if (argument === "--provider-smoke") options.providerSmoke = true;
    else if (argument === "--config") options.configPath = nextValue();
    else if (argument?.startsWith("--config=")) options.configPath = argument.slice(9);
    else if (argument === "--plugins-dir") options.pluginsDir = nextValue();
    else if (argument?.startsWith("--plugins-dir=")) options.pluginsDir = argument.slice(14);
    else if (argument === "--hermes-command") options.hermesCommand = nextValue();
    else if (argument?.startsWith("--hermes-command=")) options.hermesCommand = argument.slice(17);
    else if (argument === "--help" || argument === "-h") throw new DiagnosticsHelpRequested();
    else if (argument) throw new Error(`Unknown diagnostics option: ${argument}`);
  }
  return options;
}

export async function runDiagnosticsCommand(args: string[]): Promise<void> {
  let options: DiagnosticsOptions;
  try {
    options = parseDiagnosticsOptions(args);
  } catch (error) {
    if (error instanceof DiagnosticsHelpRequested) {
      console.log(diagnosticsHelp());
      return;
    }
    throw error;
  }

  const home = homedir();
  const managed = await readManagedConfig({ path: options.configPath, home }).catch(() => undefined);
  const secrets = [
    ...Object.entries(process.env)
      .filter(([key, value]) => Boolean(value) && SENSITIVE_ENVIRONMENT_NAME.test(key))
      .map(([, value]) => value!),
    ...Object.entries(managed?.values ?? {})
      .filter(([key, value]) => Boolean(value) && SENSITIVE_ENVIRONMENT_NAME.test(key))
      .map(([, value]) => value!),
  ];
  const report = await runDoctor({
    json: true,
    providerSmoke: options.providerSmoke,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.pluginsDir ? { pluginsDir: options.pluginsDir } : {}),
    ...(options.hermesCommand ? { hermesCommand: options.hermesCommand } : {}),
  });
  const bundle = createDiagnosticBundle(report, {
    home,
    secrets,
  });
  const output = resolve(options.output ?? defaultDiagnosticFilename(bundle.generatedAt));
  await writeDiagnosticBundle(output, bundle);
  console.log(`Wrote redacted diagnostics to ${shortHome(output, home)}.`);
  if (!report.ok) console.log("The report contains one or more failed checks.");
}

export function createDiagnosticBundle(
  doctor: DoctorReport,
  options: { generatedAt?: string; home?: string; secrets?: readonly string[] } = {},
): DiagnosticBundle {
  const raw: DiagnosticBundle = {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    package: { name: PACKAGE.name, version: PACKAGE.version },
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    doctor,
  };
  return sanitizeDiagnosticValue(raw, options) as DiagnosticBundle;
}

export function sanitizeDiagnosticValue(
  value: unknown,
  options: { home?: string; secrets?: readonly string[] } = {},
): unknown {
  const secrets = [...new Set((options.secrets ?? []).filter((secret) => secret.length >= 8))]
    .sort((left, right) => right.length - left.length);

  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, nested]) => [
        key,
        SENSITIVE_FIELD.test(key) ? "[redacted]" : visit(nested),
      ]));
    }
    if (typeof current !== "string") return current;
    let sanitized = current;
    for (const secret of secrets) sanitized = sanitized.replaceAll(secret, "[redacted]");
    if (options.home) sanitized = sanitized.replaceAll(options.home, "~");
    sanitized = sanitized
      .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
      .replace(/\b(?:api[_-]?key|password|secret|token)\s*[=:]\s*[^\s,;]+/giu, (match) => {
        const separator = match.includes("=") ? "=" : ":";
        return `${match.slice(0, match.indexOf(separator) + 1)}[redacted]`;
      })
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu, "[redacted]")
      .replace(/https?:\/\/[^\s"'<>]+/gu, (candidate) => sanitizeUrl(candidate));
    return sanitized;
  };
  return visit(value);
}

export async function writeDiagnosticBundle(path: string, bundle: DiagnosticBundle): Promise<void> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export function diagnosticsHelp(): string {
  return `hermes-live diagnostics [export] [options]

Write a private, redacted support bundle. It excludes logs, prompts, task
results, audio, credentials, and other secret values.

Options:
  --output <path>         Output file; the command refuses to overwrite it
  --provider-smoke        Open and close a real provider session
  --config <path>         Managed config path
  --plugins-dir <path>    Hermes plugins directory
  --hermes-command <path> Hermes executable path`;
}

function sanitizeUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return candidate;
  }
}

function defaultDiagnosticFilename(generatedAt: string): string {
  return `hermes-live-diagnostics-${generatedAt.replace(/[-:.]/gu, "")}.json`;
}

function shortHome(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

class DiagnosticsHelpRequested extends Error {}
