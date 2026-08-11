import { describe, expect, it } from "vitest";
import { upgradeHelp, upgradeSetupArgs } from "../src/cli/upgrade.js";

describe("upgrade command", () => {
  it("reconciles the installed package without prompting", () => {
    expect(upgradeSetupArgs([])).toEqual(["--non-interactive"]);
    expect(upgradeSetupArgs(["--provider", "openai"]))
      .toEqual(["--non-interactive", "--provider", "openai"]);
    expect(upgradeSetupArgs(["--non-interactive", "--json"]))
      .toEqual(["--non-interactive", "--json"]);
  });

  it("does not claim to download the npm package", () => {
    expect(upgradeHelp()).toContain("does not download");
    expect(upgradeHelp()).toContain("npm install --global hermes-live-voice@latest");
  });
});
