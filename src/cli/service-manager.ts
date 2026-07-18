import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { managedConfigPath } from "./managed-config.js";
import { packageRoot } from "./plugin-installer.js";
import { runCommand, type CommandResult, type CommandRunner } from "./process.js";

export const SERVICE_LABEL = "dev.hermes-live-voice.gateway";

export type ServicePlatform = "launchd" | "systemd" | "unsupported";
export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "restart" | "status" | "logs";

export interface ServiceManagerOptions {
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
  home: string;
  platform: ServicePlatform;
  nodePath: string;
  cliPath: string;
  configPath: string;
  definitionPath?: string;
  uid?: number;
  runner: CommandRunner;
}

export async function runServiceAction(
  action: ServiceAction,
  options: ServiceManagerOptions = {},
): Promise<ServiceStatus | CommandResult> {
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
      detail: "Service definition is not installed.",
    };
  }
  const result = resolved.platform === "launchd"
    ? await resolved.runner("launchctl", ["print", launchdDomain(resolved)])
    : await resolved.runner("systemctl", ["--user", "is-active", SERVICE_LABEL]);
  const running = result.code === 0 && (resolved.platform === "launchd" || result.stdout.trim() === "active");
  return {
    platform: resolved.platform,
    definitionPath,
    installed,
    running,
    detail: running ? "Gateway service is running." : commandDetail(result, "Gateway service is installed but not running."),
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(resolved.nodePath)}</string>
    <string>${xmlEscape(resolved.cliPath)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERMES_LIVE_CONFIG_FILE</key>
    <string>${xmlEscape(resolved.configPath)}</string>
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
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logsDirectory, "gateway.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logsDirectory, "gateway.error.log"))}</string>
</dict>
</plist>
`;
}

export function systemdServiceDefinition(options: ServiceManagerOptions = {}): string {
  const resolved = resolveServiceOptions({ ...options, platform: "linux" });
  return renderSystemdServiceDefinition(resolved);
}

function renderSystemdServiceDefinition(resolved: ResolvedServiceOptions): string {
  return `[Unit]
Description=Hermes Live Voice gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdEscape(resolved.nodePath)} ${systemdEscape(resolved.cliPath)} serve
Environment=${systemdEscape(`HERMES_LIVE_CONFIG_FILE=${resolved.configPath}`)}
WorkingDirectory=${systemdEscape(resolved.home)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function resolveServiceOptions(options: ServiceManagerOptions = {}): ResolvedServiceOptions {
  const home = resolve(options.home ?? homedir());
  const platform = resolveServicePlatform(options.platform);
  const definitionPath = platform === "launchd"
    ? join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
    : platform === "systemd"
      ? join(home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`)
      : undefined;
  const resolvedOptions: ResolvedServiceOptions = {
    home,
    platform,
    nodePath: resolve(options.nodePath ?? process.execPath),
    cliPath: resolve(options.cliPath ?? join(packageRoot(), "dist", "cli.js")),
    configPath: managedConfigPath({ path: options.configPath, home }),
    ...(definitionPath ? { definitionPath } : {}),
    ...(options.uid ?? process.getuid?.()) !== undefined ? { uid: options.uid ?? process.getuid?.() } : {},
    runner: options.runner ?? runCommand,
  };
  assertSafeServicePath("home", resolvedOptions.home);
  assertSafeServicePath("Node executable", resolvedOptions.nodePath);
  assertSafeServicePath("CLI", resolvedOptions.cliPath);
  assertSafeServicePath("managed config", resolvedOptions.configPath);
  return resolvedOptions;
}

async function installService(options: ResolvedServiceOptions): Promise<void> {
  const definitionPath = options.definitionPath!;
  await mkdir(dirname(definitionPath), { recursive: true, mode: 0o700 });
  if (options.platform === "launchd") {
    await mkdir(join(options.home, ".hermes", "hermes-live", "logs"), { recursive: true, mode: 0o700 });
  }
  const definition = options.platform === "launchd"
    ? renderLaunchdServiceDefinition(options)
    : renderSystemdServiceDefinition(options);
  await writeFile(definitionPath, definition, { encoding: "utf8", mode: 0o600 });
  await chmod(definitionPath, 0o600);

  if (options.platform === "launchd") {
    await options.runner("launchctl", ["bootout", `gui/${options.uid}`, definitionPath]).catch(() => undefined);
    await expectSuccess(await options.runner("launchctl", ["bootstrap", `gui/${options.uid}`, definitionPath]));
  } else {
    await expectSuccess(await options.runner("systemctl", ["--user", "daemon-reload"]));
    await expectSuccess(await options.runner("systemctl", ["--user", "enable", SERVICE_LABEL]));
  }
}

async function uninstallService(options: ResolvedServiceOptions): Promise<void> {
  const definitionPath = options.definitionPath!;
  if (options.platform === "launchd") {
    await options.runner("launchctl", ["bootout", `gui/${options.uid}`, definitionPath]);
  } else {
    await options.runner("systemctl", ["--user", "disable", "--now", SERVICE_LABEL]);
  }
  await rm(definitionPath, { force: true });
  if (options.platform === "systemd") {
    await options.runner("systemctl", ["--user", "daemon-reload"]);
  }
}

async function startService(options: ResolvedServiceOptions): Promise<void> {
  assertDefinitionInstalled(options);
  const result = options.platform === "launchd"
    ? await options.runner("launchctl", ["kickstart", "-k", launchdDomain(options)])
    : await options.runner("systemctl", ["--user", "start", SERVICE_LABEL]);
  await expectSuccess(result);
}

async function stopService(options: ResolvedServiceOptions): Promise<void> {
  assertDefinitionInstalled(options);
  const result = options.platform === "launchd"
    ? await options.runner("launchctl", ["kill", "SIGTERM", launchdDomain(options)])
    : await options.runner("systemctl", ["--user", "stop", SERVICE_LABEL]);
  await expectSuccess(result);
}

async function restartService(options: ResolvedServiceOptions): Promise<void> {
  assertDefinitionInstalled(options);
  const result = options.platform === "launchd"
    ? await options.runner("launchctl", ["kickstart", "-k", launchdDomain(options)])
    : await options.runner("systemctl", ["--user", "restart", SERVICE_LABEL]);
  await expectSuccess(result);
}

async function serviceLogs(options: ServiceManagerOptions): Promise<CommandResult> {
  const resolved = resolveServiceOptions(options);
  assertSupported(resolved);
  if (resolved.platform === "launchd") {
    const stdout = await readFile(join(resolved.home, ".hermes", "hermes-live", "logs", "gateway.log"), "utf8")
      .catch(() => "");
    const stderr = await readFile(join(resolved.home, ".hermes", "hermes-live", "logs", "gateway.error.log"), "utf8")
      .catch(() => "");
    return {
      command: "launchd log files",
      args: [],
      code: 0,
      stdout: tailLines(stdout, 200),
      stderr: tailLines(stderr, 200),
      timedOut: false,
    };
  }
  return await resolved.runner("journalctl", ["--user-unit", SERVICE_LABEL, "--no-pager", "-n", "200"]);
}

function assertSupported(options: ResolvedServiceOptions): void {
  if (options.platform === "unsupported") {
    throw new Error("Managed services require macOS launchd or a Linux systemd user session. Run `hermes-live serve` manually on this platform.");
  }
}

function assertDefinitionInstalled(options: ResolvedServiceOptions): void {
  if (!options.definitionPath) {
    throw new Error("Service definition path is unavailable.");
  }
}

async function expectSuccess(result: CommandResult): Promise<void> {
  if (result.code !== 0) {
    throw new Error(commandDetail(result, `Command failed with exit code ${result.code}.`));
  }
}

function launchdDomain(options: ResolvedServiceOptions): string {
  return `gui/${options.uid}/${SERVICE_LABEL}`;
}

function commandDetail(result: CommandResult, fallback: string): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `${fallback} ${detail}` : fallback;
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
  if (/[ -]/u.test(value)) {
    throw new Error(`${label} path contains a control character.`);
  }
}

function tailLines(value: string, count: number): string {
  return value.split(/\r?\n/u).slice(-count).join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
