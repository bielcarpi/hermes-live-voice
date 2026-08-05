import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureHermesApiEnvironment,
  generateHermesApiKey,
  isDefaultLocalHermesApi,
  resolveHermesHome,
} from "../src/cli/hermes-api-bootstrap.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Hermes API bootstrap", () => {
  it("creates a private bridge configuration while preserving unrelated settings", async () => {
    const home = await temporaryDirectory();
    const hermesHome = join(home, ".hermes");
    await mkdir(hermesHome, { recursive: true });
    await writeFile(join(hermesHome, ".env"), "# user config\nOPENROUTER_API_KEY=existing\n", { mode: 0o600 });
    const apiKey = generateHermesApiKey();

    const result = await ensureHermesApiEnvironment(hermesHome, apiKey);

    expect(result).toMatchObject({ changed: true, created: false });
    const source = await readFile(result.path, "utf8");
    expect(source).toContain("# user config\nOPENROUTER_API_KEY=existing\n");
    expect(source).toContain('API_SERVER_ENABLED="true"');
    expect(source).toContain(`API_SERVER_KEY="${apiKey}"`);
    expect((await lstat(result.path)).mode & 0o777).toBe(0o600);
    expect(apiKey).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is idempotent and updates stale API bridge values without duplicates", async () => {
    const hermesHome = await temporaryDirectory();
    const apiKey = generateHermesApiKey();
    await writeFile(
      join(hermesHome, ".env"),
      "API_SERVER_ENABLED=false\nexport API_SERVER_KEY=old-key-that-was-long-enough\n",
      { mode: 0o600 },
    );

    await expect(ensureHermesApiEnvironment(hermesHome, apiKey)).resolves.toMatchObject({ changed: true });
    await expect(ensureHermesApiEnvironment(hermesHome, apiKey)).resolves.toMatchObject({ changed: false });
    const source = await readFile(join(hermesHome, ".env"), "utf8");
    expect(source.match(/API_SERVER_ENABLED=/gu)).toHaveLength(1);
    expect(source.match(/API_SERVER_KEY=/gu)).toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")("refuses unsafe Hermes environment files", async () => {
    const hermesHome = await temporaryDirectory();
    const shared = join(hermesHome, ".env");
    await writeFile(shared, "API_SERVER_KEY=old-key-that-was-long-enough\n", { mode: 0o644 });
    await chmod(shared, 0o644);
    await expect(ensureHermesApiEnvironment(hermesHome, generateHermesApiKey()))
      .rejects.toThrow(/must not be readable or writable by other users/u);

    const target = join(hermesHome, "target.env");
    await writeFile(target, "", { mode: 0o600 });
    await rm(shared);
    await symlink(target, shared);
    await expect(ensureHermesApiEnvironment(hermesHome, generateHermesApiKey()))
      .rejects.toThrow(/regular file, not a symlink/u);
  });

  it("rejects duplicate bridge keys and unsafe secrets", async () => {
    const hermesHome = await temporaryDirectory();
    await writeFile(
      join(hermesHome, ".env"),
      "API_SERVER_ENABLED=true\nAPI_SERVER_ENABLED=false\n",
      { mode: 0o600 },
    );
    await expect(ensureHermesApiEnvironment(hermesHome, generateHermesApiKey()))
      .rejects.toThrow(/duplicate API_SERVER_ENABLED/u);
    await expect(ensureHermesApiEnvironment(hermesHome, "short"))
      .rejects.toThrow(/between 16 and 4096 bytes/u);
  });

  it("uses an explicit Hermes profile home", () => {
    expect(resolveHermesHome("/users/example", { HERMES_HOME: "/profiles/work" }))
      .toBe("/profiles/work");
    expect(resolveHermesHome("/users/example", {})).toBe("/users/example/.hermes");
  });

  it("manages only the exact private default Hermes API endpoint", () => {
    expect(isDefaultLocalHermesApi("http://127.0.0.1:8642")).toBe(true);
    expect(isDefaultLocalHermesApi("http://localhost:8642/")).toBe(true);
    expect(isDefaultLocalHermesApi("http://[::1]:8642")).toBe(true);
    expect(isDefaultLocalHermesApi("https://localhost:8642")).toBe(false);
    expect(isDefaultLocalHermesApi("http://localhost:8643")).toBe(false);
    expect(isDefaultLocalHermesApi("http://user@localhost:8642")).toBe(false);
    expect(isDefaultLocalHermesApi("http://localhost:8642/?profile=work")).toBe(false);
    expect(isDefaultLocalHermesApi("not-a-url")).toBe(false);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hermes-live-hermes-api-"));
  temporaryDirectories.push(path);
  return path;
}
