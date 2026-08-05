import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { managedConfigPath } from "./managed-config.js";
import { packageRoot } from "./plugin-installer.js";
import { runCommand, type CommandResult, type CommandRunner } from "./process.js";

export const SERVICE_LABEL = "dev.hermes-live-voice.gateway";
export const LOCAL_VOICE_SERVICE_LABEL = "dev.hermes-live-voice.local";
const MAX_SERVICE_LOG_BYTES = 256 * 1024;
const MAX_SERVICE_LOG_FILE_BYTES = 8 * 1024 * 1024;

export type ServicePlatform = "launchd" | "systemd" | "unsupported";
export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "restart" | "status" | "logs";
export type ServiceKind = "gateway" | "local-voice";

export interface ServiceCommand {
  command: string;
  args: string[];
  environment?: Record<string, string>;
}

export interface ServiceManagerOptions {
  kind?: ServiceKind;
  command?: ServiceCommand;
  home?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  cliPath?: string;
  configPath?: string;
  uid?: number;
  runner?: CommandRunner;
}

export interface ServiceStatus {
  platform: ServicePlatform;
  definitionPath?: string;
  installed: boolean;
  running: boolean;
  detail: string;
}

interface ResolvedServiceOptions {
  kind: ServiceKind;
  label: string;
  displayName: string;
  logStem: string;
  restartDelaySeconds: number;
  home: string;
  platform: ServicePlatform;
  program: ServiceCommand;
  definitionPath?: string;
  uid?: number;
  runner: CommandRunner;
}

export async function runServiceAction(
  action: ServiceAction,
  options: ServiceManagerOptions = {},
): Promise<ServiceStatus | CommandResult> {
  if (action === "install" && options.kind === "local-voice" && !options.command) {
    throw new Error("Local voice service installation requires a resolved launch command.");
  }
  const resolved = resolveServiceOptions(options);
  assertSupported(resolved);
  switch (action) {
    case "install":
      await installService(resolved);
      return await serviceStatus(options);
    case "uninstall":
      await uninstallService(resolved);
      return await serviceStatus(options);
    case "start":
      await startService(resolved);
      return await serviceStatus(options);
    case "stop":
      await stopService(resolved);
      return await serviceStatus(options);
    case "restart":
      await restartService(resolved);
      return await serviceStatus(options);
    case "status":
      return await serviceStatus(options);
    case "logs":
      return await serviceLogs(options);
  }
}

export async function serviceStatus(options: ServiceManagerOptions = {}): Promise<ServiceStatus> {
  const resolved = resolveServiceOptions(options);
  if (resolved.platform === "unsupported") {
    return {
      platform: "unsupported",
      installed: false,
      running: false,
      detail: "Managed services are available on macOS (launchd) and Linux (systemd user services).",
    };
  }
  const definitionPath = resolved.definitionPath!;
  const installed = await fileExists(definitionPath);
  if (!installed) {
    return {
      platform: resolved.platform,
      definitionPath,
      installed: false,
      running: false,
      detail: `${resolved.displayName} service is not installed.`,
    };
  }
  const result = resolved.platform === "launchd"
    ? await resolved.runner("launchctl", ["print", launchdDomain(resolved)])
    : await resolved.runner("systemctl", ["--user", "is-active", resolved.label]);
  const running = result.code === 0 && (resolved.platform === "launchd"
    ? /(?:^|\n)\s*state = running\s*(?:\n|$)/u.test(result.stdout)
      || /(?:^|\n)\s*pid = [1-9][0-9]*\s*(?:\n|$)/u.test(result.stdout)
    : result.stdout.trim() === "active");
  return {
    platform: resolved.platform,
    definitionPath,
    installed,
    running,
    detail: running
      ? `${resolved.displayName} service is running.`
      : stoppedServiceDetail(resolved, result),
  };
}

export function resolveServicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "unsupported";
}

export function launchdServiceDefinition(options: ServiceManagerOptions = {}): string {
  const resolved = resolveServiceOptions({ ...options, platform: "darwin" });
  return renderLaunchdServiceDefinition(resolved);
}

function renderLaunchdServiceDefinition(resolved: ResolvedServiceOptions): string {
  const logsDirectory = join(resolved.home, ".hermes", "hermes-live", "logs");
  const environment = Object.entries(resolved.program.environment ?? {}).map(([key, value]) => `
    <key>${xmlEscape(key)}</key>
    <string>${xmlEscape(value)}</string>`).join("");
  const argumentsXml = [resolved.program.command, ...resolved.program.args]
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(resolved.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>${environment}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(resolved.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${resolved.restartDelaySeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logsDirectory, `${resolved.logStem}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logsDirectory, `${resolved.logStem}.error.log`))}</string>
</dict>
</plist>
`;
}

export function systemdServiceDefinition(options: ServiceManagerOptions = {}): string {
  const resolved = resolveServiceOptions({ ...options, platform: "linux" });
  return renderSystemdServiceDefinition(resolved);
}

function renderSystemdServiceDefinition(resolved: ResolvedServiceOptions): string {
  const environment = Object.entries(resolved.program.environment ?? {})
    .map(([key, value]) => `Environment=${systemdEscape(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Hermes Live Voice ${resolved.displayName.toLowerCase()}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[resolved.program.command, ...resolved.program.args].map(systemdEscape).join(" ")}
${environment}
WorkingDirectory=${systemdEscape(resolved.home)}
Restart=on-failure
RestartSec=${resolved.restartDelaySeconds}

[Install]
WantedBy=default.target
`;
}

function resolveServiceOptions(options: ServiceManagerOptions = {}): ResolvedServiceOptions {
  const home = resolve(options.home ?? homedir());
  const platform = resolveServicePlatform(options.platform);
  const kind = options.kind ?? "gateway";
  const label = kind === "gateway" ? SERVICE_LABEL : LOCAL_VOICE_SERVICE_LABEL;
  const configPath = managedConfigPath({ path: options.configPath, home });
  const program = kind === "gateway"
    ? {
        command: resolve(options.nodePath ?? process.execPath),
        args: [resolve(options.cliPath ?? join(packageRoot(), "dist", "cli.js")), "serve"],
        environment: { HERMES_LIVE_CONFIG_FILE: configPath },
      }
    : options.command ?? { command: "/usr/bin/false", args: [] };
  const definitionPath = platform === "launchd"
    ? join(home, "Library", "LaunchAgents", `${label}.plist`)
    : platform === "systemd"
      ? join(home, ".config", "systemd", "user", `${label}.service`)
      : undefined;
  const uid = options.uid ?? process.getuid?.();
  const resolvedOptions: ResolvedServiceOptions = {
    kind,
    label,
    displayName: kind === "gateway" ? "Gateway" : "Local voice",
    logStem: kind === "gateway" ? "gateway" : "local-voice",
    restartDelaySeconds: kind === "gateway" ? 5 : 30,
    home,
    platform,
    program,
    ...(definitionPath ? { definitionPath } : {}),
    ...(uid !== undefined ? { uid } : {}),
    runner: options.runner ?? runCommand,
  };
  assertSafeServicePath("home", resolvedOptions.home);
  assertSafeServicePath("service executable", resolvedOptions.program.command);
  for (const argument of resolvedOptions.program.args) assertSafeServicePath("service argument", argument);
  for (const [key, value] of Object.entries(resolvedOptions.program.environment ?? {})) {
    assertSafeEnvironmentName(key);
    assertSafeServicePath("service environment value", value);
  }
  return resolvedOptions;
}

async function installService(options: ResolvedServiceOptions): Promise<void> {
  const definitionPath = options.definitionPath!;
  await mkdir(dirname(definitionPath), { recursive: true, mode: 0o700 });
  if (options.platform === "launchd") {
    const logsDirectory = join(options.home, ".hermes", "hermes-live", "logs");
    await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
    await chmod(logsDirectory, 0o700);
  }
  const definition = options.platform === "launchd"
    ? renderLaunchdServiceDefinition(options)
    : renderSystemdServiceDefinition(options);
  await writeFile(definitionPath, definition, { encoding: "utf8", mode: 0o600 });
  await chmod(definitionPath, 0o600);

  if (options.platform === "launchd") {
    await unloadLaunchdService(options);
    await prepareLaunchdLogs(options);
    await expectSuccess(await options.runner("launchctl", ["bootstrap", launchdUserDomain(options), definitionPath]));
  } else {
    await expectSuccess(await options.runner("systemctl", ["--user", "daemon-reload"]));
    await expectSuccess(await options.runner("systemctl", ["--user", "enable", options.label]));
  }
}

async function prepareLaunchdLogs(options: ResolvedServiceOptions): Promise<void> {
  const logsDirectory = join(options.home, ".hermes", "hermes-live", "logs");
  for (const suffix of [".log", ".error.log"]) {
    const path = join(logsDirectory, `${options.logStem}${suffix}`);
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    let handle;
    try {
      handle = await open(path, fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow, 0o600);
    } catch (error) {
      throw new Error(`Service log must be a regular file, not a symlink: ${path}`, { cause: error });
    }
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        throw new Error(`Service log must be a regular file, not a symlink: ${path}`);
      }
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && fileStat.uid !== currentUid) {
        throw new Error(`Service log must be owned by the current user: ${path}`);
      }
      if (fileStat.size > MAX_SERVICE_LOG_FILE_BYTES) await handle.truncate(0);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  }
}

async function uninstallService(options: ResolvedServiceOptions): Promise<void> {
  const definitionPath = options.definitionPath!;
  if (options.platform === "launchd") {
    await unloadLaunchdService(options);
  } else {
    await options.runner("systemctl", ["--user", "disable", "--now", options.label]);
  }
  await rm(definitionPath, { force: true });
  if (options.platform === "systemd") {
    await options.runner("systemctl", ["--user", "daemon-reload"]);
  }
}

async function startService(options: ResolvedServiceOptions): Promise<void> {
  await assertDefinitionInstalled(options);
  if (options.platform === "launchd") {
    const bootstrap = await options.runner("launchctl", ["bootstrap", launchdUserDomain(options), options.definitionPath!]);
    if (bootstrap.code === 0) return;
    const loaded = await options.runner("launchctl", ["print", launchdDomain(options)]);
    if (loaded.code !== 0) await expectSuccess(bootstrap);
    await expectSuccess(await options.runner("launchctl", ["kickstart", "-k", launchdDomain(options)]));
    return;
  }
  await expectSuccess(await options.runner("systemctl", ["--user", "start", options.label]));
}

async function stopService(options: ResolvedServiceOptions): Promise<void> {
  await assertDefinitionInstalled(options);
  if (options.platform === "launchd") {
    await unloadLaunchdService(options);
    return;
  }
  await expectSuccess(await options.runner("systemctl", ["--user", "stop", options.label]));
}

async function restartService(options: ResolvedServiceOptions): Promise<void> {
  await assertDefinitionInstalled(options);
  if (options.platform === "launchd") {
    await unloadLaunchdService(options);
    await expectSuccess(await options.runner("launchctl", ["bootstrap", launchdUserDomain(options), options.definitionPath!]));
    return;
  }
  await expectSuccess(await options.runner("systemctl", ["--user", "restart", options.label]));
}

async function unloadLaunchdService(options: ResolvedServiceOptions): Promise<void> {
  const result = await options.runner("launchctl", ["bootout", launchdUserDomain(options), options.definitionPath!]);
  if (result.code === 0) return;
  const loaded = await options.runner("launchctl", ["print", launchdDomain(options)]);
  if (loaded.code === 0) await expectSuccess(result);
}

async function serviceLogs(options: ServiceManagerOptions): Promise<CommandResult> {
  const resolved = resolveServiceOptions(options);
  assertSupported(resolved);
  if (resolved.platform === "launchd") {
    const stdout = await readBoundedLogTail(join(resolved.home, ".hermes", "hermes-live", "logs", `${resolved.logStem}.log`));
    const stderr = await readBoundedLogTail(join(resolved.home, ".hermes", "hermes-live", "logs", `${resolved.logStem}.error.log`));
    return {
      command: "launchd log files",
      args: [],
      code: 0,
      stdout: tailLines(stdout, 200),
      stderr: tailLines(stderr, 200),
      timedOut: false,
    };
  }
  return await resolved.runner("journalctl", ["--user-unit", resolved.label, "--no-pager", "-n", "200"]);
}

function assertSupported(options: ResolvedServiceOptions): void {
  if (options.platform === "unsupported") {
    const fallback = options.kind === "gateway"
      ? "Run `hermes-live serve` manually on this platform."
      : "Run the local realtime provider manually on this platform.";
    throw new Error(`Managed services require macOS launchd or a Linux systemd user session. ${fallback}`);
  }
}

async function assertDefinitionInstalled(options: ResolvedServiceOptions): Promise<void> {
  if (!options.definitionPath || !(await fileExists(options.definitionPath))) {
    throw new Error(`${options.displayName} service is not installed. Run \`hermes-live setup\`.`);
  }
}

async function expectSuccess(result: CommandResult): Promise<void> {
  if (result.code !== 0) {
    throw new Error(commandDetail(result, `Command failed with exit code ${result.code}.`));
  }
}

function launchdDomain(options: ResolvedServiceOptions): string {
  return `${launchdUserDomain(options)}/${options.label}`;
}

function launchdUserDomain(options: ResolvedServiceOptions): string {
  if (options.uid === undefined) throw new Error("Could not determine the current user id for launchd.");
  return `gui/${options.uid}`;
}

function commandDetail(result: CommandResult, fallback: string): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `${fallback} ${detail}` : fallback;
}

function stoppedServiceDetail(options: ResolvedServiceOptions, result: CommandResult): string {
  const fallback = `${options.displayName} service is installed but not running.`;
  const managerDetail = `${result.stdout}\n${result.stderr}`;
  if (options.platform === "launchd" && /(?:could not find service|service cannot be found|bad request)/iu.test(managerDetail)) {
    return fallback;
  }
  if (options.platform === "systemd" && /^(?:inactive|failed|unknown)\s*$/iu.test(result.stdout)) {
    return fallback;
  }
  return commandDetail(result, fallback);
}

function systemdEscape(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertSafeServicePath(label: string, value: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} path contains a control character.`);
  }
}

function assertSafeEnvironmentName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Service environment name is invalid: ${value}`);
  }
}

function tailLines(value: string, count: number): string {
  return value.split(/\r?\n/u).slice(-count).join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readBoundedLogTail(path: string): Promise<string> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`Service log must be a private regular file, not a symlink: ${path}`, { cause: error });
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Service log must be a private regular file, not a symlink: ${path}`);
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && fileStat.uid !== currentUid) {
      throw new Error(`Service log must be owned by the current user: ${path}`);
    }
    if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
      throw new Error(`Service log must not be readable or writable by other users: ${path}`);
    }
    const length = Math.min(fileStat.size, MAX_SERVICE_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, fileStat.size - length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
