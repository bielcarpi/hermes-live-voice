import { describe, expect, it } from "vitest";
import { AGENT_PROGRESS_PREFIX } from "../src/application/live-gateway/run-narrator.js";
import { buildSystemInstruction } from "../src/application/live-gateway/system-instruction.js";

describe("buildSystemInstruction", () => {
  it("contains the AGENT_PROGRESS_PREFIX constant (no drift possible)", () => {
    const output = buildSystemInstruction();
    expect(output).toContain(AGENT_PROGRESS_PREFIX);
  });

  it("contains the language-of-user instruction", () => {
    const output = buildSystemInstruction();
    expect(output).toContain("language of the user's most recent message");
  });

  it("contains the do-not-repeat-status instruction", () => {
    const output = buildSystemInstruction();
    expect(output).toContain("Do NOT call get_agent_run_status repeatedly");
  });

  it("still contains the no-backend-names rule (regression guard — existing line not removed)", () => {
    const output = buildSystemInstruction();
    expect(output).toContain("Never mention the backend technology");
  });
});
