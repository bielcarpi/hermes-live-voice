import { constants as fsConstants } from "node:fs";
import { access, cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginInstallOptions {
  dir?: string;
  mode?: "copy" | "symlink";
  force?: boolean;
}

export interface PluginInstallStatus {
  source: string;
  target: string;
  installed: boolean;
  manifestFound: boolean;
  symlink: boolean;
  symlinkTarget?: string;
  mode?: "copy" | "symlink";
  enabledHint: string;
}

export async function installHermesPlugin(options: PluginInstallOptions = {}): Promise<PluginInstallStatus> {
  const normalized = normalizePluginOptions(options);
  const source = pluginSourceDir();
  const target = pluginTargetDir(normalized);
  await assertPluginSource(source);
  await mkdir(dirname(target), { recursive: true });
  const existing = await pluginInstallStatus(normalized);
  if (existing.installed) {
    if (!normalized.force) {
      return { ...existing, mode: existing.symlink ? "symlink" : "copy" };
    }
    await rm(target, { recursive: true, force: true });
  }

  if (normalized.mode === "symlink") {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } else {
    await cp(source, target, {
      recursive: true,
      filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc"),
    });
  }
  return { ...(await pluginInstallStatus(normalized)), mode: normalized.mode };
}

export async function pluginInstallStatus(options: PluginInstallOptions = {}): Promise<PluginInstallStatus> {
  const normalized = normalizePluginOptions(options);
  const source = pluginSourceDir();
  const target = pluginTargetDir(normalized);
  const stat = await lstat(target).catch(() => undefined);
  const symlinkTarget = stat?.isSymbolicLink() ? await readlink(target).catch(() => undefined) : undefined;
  return {
    source,
    target,
    installed: Boolean(stat),
    manifestFound: await fileExists(join(target, "plugin.yaml")),
    symlink: Boolean(stat?.isSymbolicLink()),
    ...(symlinkTarget ? { symlinkTarget } : {}),
    enabledHint: "Run `hermes plugins enable hermes-live` after installation.",
  };
}

export function pluginSourceDir(): string {
  return join(packageRoot(), "plugins", "hermes-live");
}

export function pluginTargetDir(options: PluginInstallOptions = {}): string {
  return join(hermesPluginsDir(options), "hermes-live");
}

export function hermesPluginsDir(options: PluginInstallOptions = {}): string {
  return resolve(options.dir ?? process.env.HERMES_LIVE_HERMES_PLUGINS_DIR ?? join(homedir(), ".hermes", "plugins"));
}

export function packageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function normalizePluginOptions(options: PluginInstallOptions): Required<Pick<PluginInstallOptions, "mode" | "force">> & Pick<PluginInstallOptions, "dir"> {
  return {
    mode: options.mode ?? "copy",
    force: options.force ?? false,
    ...(options.dir ? { dir: options.dir } : {}),
  };
}

async function assertPluginSource(source: string): Promise<void> {
  if (!(await fileExists(join(source, "plugin.yaml"))) || !(await fileExists(join(source, "__init__.py")))) {
    throw new Error(`Hermes plugin source is incomplete: ${source}`);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
