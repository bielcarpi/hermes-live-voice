import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDiagnosticBundle,
  parseDiagnosticsOptions,
  sanitizeDiagnosticValue,
  writeDiagnosticBundle,
} from "../src/cli/diagnostics.js";
import { HERMES_COMPATIBILITY } from "../src/hermes-compatibility.js";
import type { DoctorReport } from "../src/cli/doctor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("diagnostics", () => {
  it("parses the short and explicit export forms", () => {
    expect(parseDiagnosticsOptions([])).toEqual({ providerSmoke: false });
    expect(parseDiagnosticsOptions(["export", "--output", "report.json", "--provider-smoke"]))
      .toEqual({ output: "report.json", providerSmoke: true });
    expect(() => parseDiagnosticsOptions(["--token", "secret"]))
      .toThrow(/Unknown diagnostics option/u);
  });

  it("redacts secrets, credentials, URL queries, and the home path", () => {
    const secret = "super-secret-value";
    const sanitized = sanitizeDiagnosticValue({
      apiKey: secret,
      accessToken: "another-sensitive-value",
      nested: {
        path: `/Users/example/.hermes/config.env`,
        error: `Bearer ${secret} at https://alice:password@example.com/status?token=${secret}`,
        provider: `token=${secret}`,
      },
    }, { home: "/Users/example", secrets: [secret] });

    const encoded = JSON.stringify(sanitized);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("another-sensitive-value");
    expect(encoded).not.toContain("alice");
    expect(encoded).not.toContain("password");
    expect(encoded).not.toContain("/Users/example");
    expect(encoded).toContain("[redacted]");
    expect(encoded).toContain("~/.hermes/config.env");
  });

  it("writes a private bundle and refuses to replace an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hermes-live-diagnostics-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "report.json");
    const doctor: DoctorReport = {
      ok: true,
      version: "0.9.3",
      compatibility: HERMES_COMPATIBILITY,
      checks: [],
    };
    const bundle = createDiagnosticBundle(doctor, {
      generatedAt: "2026-08-11T12:00:00.000Z",
      home: directory,
    });

    await writeDiagnosticBundle(path, bundle);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-08-11T12:00:00.000Z",
      package: { name: "hermes-live-voice" },
    });
    await expect(writeDiagnosticBundle(path, bundle)).rejects.toThrow();
    await chmod(path, 0o600);
  });
});
