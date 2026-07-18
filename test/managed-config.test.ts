import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseManagedConfig,
  readManagedConfig,
  resolvedManagedEnvironment,
  serializeManagedConfig,
  writeManagedConfig,
} from "../src/cli/managed-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed config", () => {
  it("round-trips supported values without shell evaluation", async () => {
    const home = await temporaryHome();
    const values = {
      HERMES_BASE_URL: "http://127.0.0.1:8642",
      HERMES_AGENT_API_SERVER_KEY: "secret with spaces; $(touch /tmp/nope)",
      HERMES_LIVE_PROVIDER: "mock",
    } as const;

    const path = await writeManagedConfig(values, { home });
    expect(await readManagedConfig({ home })).toMatchObject({ exists: true, path, values });
    expect(await readFile(path, "utf8")).toContain(JSON.stringify(values.HERMES_AGENT_API_SERVER_KEY));
  });

  it("lets the process environment override managed values", async () => {
    const home = await temporaryHome();
    await writeManagedConfig({ HERMES_LIVE_PORT: "8788", HERMES_LIVE_PROVIDER: "gemini" }, { home });

    const resolved = await resolvedManagedEnvironment({ HERMES_LIVE_PORT: "9999" }, { home });

    expect(resolved.HERMES_LIVE_PORT).toBe("9999");
    expect(resolved.HERMES_LIVE_PROVIDER).toBe("gemini");
  });

  it("treats an empty config-path environment override as unset", async () => {
    const home = await temporaryHome();
    const previous = process.env.HERMES_LIVE_CONFIG_FILE;
    process.env.HERMES_LIVE_CONFIG_FILE = "";
    try {
      const path = await writeManagedConfig({ HERMES_LIVE_PROVIDER: "mock" }, { home });
      expect(path).toBe(join(home, ".hermes", "hermes-live", "config.env"));
    } finally {
      if (previous === undefined) delete process.env.HERMES_LIVE_CONFIG_FILE;
      else process.env.HERMES_LIVE_CONFIG_FILE = previous;
    }
  });

  it("rejects unapproved keys, duplicates, and non-string values", () => {
    expect(() => parseManagedConfig('NODE_OPTIONS="--import=evil"')).toThrow(/not a supported/u);
    expect(() => parseManagedConfig('HERMES_LIVE_PORT="8788"\nHERMES_LIVE_PORT="9999"')).toThrow(/duplicate/u);
    expect(() => parseManagedConfig("HERMES_LIVE_PORT=8788")).toThrow(/must be a string/u);
  });

  it("serializes keys in a stable allowlist order", () => {
    const serialized = serializeManagedConfig({
      OPENAI_API_KEY: "openai-secret",
      HERMES_BASE_URL: "http://127.0.0.1:8642",
    });

    expect(serialized.indexOf("HERMES_BASE_URL")).toBeLessThan(serialized.indexOf("OPENAI_API_KEY"));
    expect(parseManagedConfig(serialized)).toEqual({
      HERMES_BASE_URL: "http://127.0.0.1:8642",
      OPENAI_API_KEY: "openai-secret",
    });
  });

  it.runIf(process.platform !== "win32")("creates private directories and files", async () => {
    const home = await temporaryHome();
    const path = await writeManagedConfig({ HERMES_LIVE_PROVIDER: "mock" }, { home });
    const { stat } = await import("node:fs/promises");

    expect((await stat(join(home, ".hermes", "hermes-live"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("refuses permissive files and directories", async () => {
    const home = await temporaryHome();
    const path = await writeManagedConfig({ HERMES_LIVE_PROVIDER: "mock" }, { home });
    await chmod(path, 0o644);
    await expect(readManagedConfig({ home })).rejects.toThrow(/0600/u);

    await chmod(path, 0o600);
    await chmod(join(home, ".hermes", "hermes-live"), 0o755);
    await expect(readManagedConfig({ home })).rejects.toThrow(/0700/u);
  });

  it.runIf(process.platform !== "win32")("refuses incomplete owner permissions", async () => {
    const home = await temporaryHome();
    const path = await writeManagedConfig({ HERMES_LIVE_PROVIDER: "mock" }, { home });
    await chmod(path, 0o400);
    await expect(readManagedConfig({ home })).rejects.toThrow(/0600/u);
  });

  it("refuses a symlinked config file", async () => {
    const home = await temporaryHome();
    const directory = join(home, ".hermes", "hermes-live");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(home, "target.env");
    await writeFile(target, 'HERMES_LIVE_PROVIDER="mock"\n', { mode: 0o600 });
    await symlink(target, join(directory, "config.env"));

    await expect(readManagedConfig({ home })).rejects.toThrow(/not a symlink/u);
  });
});

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hermes-live-managed-config-"));
  temporaryDirectories.push(path);
  return path;
}
