import { describe, expect, it } from "vitest";
import { findExecutable, runCommand } from "../src/cli/process.js";

describe("CLI process runner", () => {
  it("runs commands without a shell and captures bounded output", async () => {
    const marker = "literal;$(not-a-command)";
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", marker], {
      maxOutputBytes: 8,
    });

    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: marker.slice(0, 8) });
  });

  it("terminates commands that exceed their deadline", async () => {
    const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20 });

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("finds executables from PATH and rejects missing commands", async () => {
    const executable = await findExecutable(process.platform === "win32" ? "node.exe" : "node");

    expect(executable).toBeTruthy();
    await expect(findExecutable("definitely-not-a-real-hermes-live-command")).resolves.toBeUndefined();
  });
});
