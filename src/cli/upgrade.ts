import { runSetupCommand } from "./setup.js";

export function upgradeSetupArgs(args: readonly string[]): string[] {
  return args.includes("--non-interactive")
    ? [...args]
    : ["--non-interactive", ...args];
}

export async function runUpgradeCommand(args: string[]): Promise<void> {
  await runSetupCommand(upgradeSetupArgs(args));
}

export function upgradeHelp(): string {
  return `hermes-live upgrade [setup options]

Reinstall the bundled plugin and service definitions from this npm package.
Existing provider settings and credentials stay in place.

This command does not download a newer npm package. Update the package first:
  npm install --global hermes-live-voice@latest
  hermes-live upgrade`;
}
