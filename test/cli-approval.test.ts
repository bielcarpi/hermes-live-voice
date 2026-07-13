import { describe, expect, it, vi } from "vitest";
import {
  promptForOneShotApproval,
  sanitizeOneShotApproval,
  type ApprovalQuestioner,
} from "../src/cli/one-shot-approval.js";

describe("one-shot CLI approvals", () => {
  it("renders exact safe request details and offers only supplied valid choices", async () => {
    const questions = questioner("session");
    const lines: string[] = [];

    const choice = await promptForOneShotApproval(
      questions,
      {
        command: "git push origin main",
        description: "Push the release to origin",
        patternKey: "git_push",
        patternKeys: ["git_push", "git_tag"],
        choices: ["once", "session", "session", "always", "deny"],
        allowPermanent: true,
      },
      { interactive: true, writeLine: (line) => lines.push(line) },
    );

    expect(choice).toBe("session");
    expect(questions.question).toHaveBeenCalledOnce();
    expect(questions.question).toHaveBeenCalledWith("Choose once/session/always/deny [deny]: ");
    expect(lines).toContain("[approval] Description: Push the release to origin");
    expect(lines).toContain("[approval] Command: git push origin main");
    expect(lines).toContain("[approval] Permission pattern: git_push, git_tag");
    expect(lines).toContain("[approval] Available choices: once, session, always, deny. Deny is the safe default.");
    expect(lines.every((line) => !/[\u0000-\u001f\u007f-\u009f]/.test(line))).toBe(true);
  });

  it("reduces transformed or partially invalid request details to deny-only", async () => {
    const questions = questioner("once");
    const lines: string[] = [];

    const choice = await promptForOneShotApproval(
      questions,
      {
        command: "git\u001b[2J push",
        description: "Push\nproduction",
        patternKey: "git_push\u001b[31m",
        choices: ["once", "session", "always", "deny"],
        allowPermanent: true,
      },
      { interactive: true, writeLine: (line) => lines.push(line) },
    );

    expect(choice).toBe("deny");
    expect(questions.question).not.toHaveBeenCalled();
    expect(lines).toContain("[approval] The request details were incomplete or unsafe; denial is the only available choice.");
  });

  it.each([
    { label: "allowPermanent is false", approval: { allowPermanent: false, patternKey: "git_push" } },
    { label: "the pattern is missing", approval: { allowPermanent: true } },
    { label: "the pattern sanitizes to empty", approval: { allowPermanent: true, patternKey: "\u001b[31m\u0000" } },
  ])("removes always when $label", async ({ approval }) => {
    const questions = questioner("always");

    const choice = await promptForOneShotApproval(
      questions,
      { command: "git push", ...approval, choices: ["once", "always", "deny"] },
      { interactive: true },
    );

    expect(choice).toBe("deny");
    expect(questions.question).toHaveBeenCalledOnce();
    expect(questions.question).toHaveBeenCalledWith("Choose once/deny [deny]: ");
  });

  it("requires an explicit second confirmation for permanent approval", async () => {
    const cancelled = questioner("always", "no");
    const confirmed = questioner("always", "ALWAYS");
    const approval = {
      command: "git push",
      choices: ["once", "always", "deny"],
      allowPermanent: true,
      patternKey: "git_push",
    };

    await expect(
      promptForOneShotApproval(cancelled, approval, { interactive: true }),
    ).resolves.toBe("deny");
    await expect(
      promptForOneShotApproval(confirmed, approval, { interactive: true }),
    ).resolves.toBe("always");

    expect(cancelled.question).toHaveBeenCalledTimes(2);
    expect(cancelled.question).toHaveBeenLastCalledWith(
      "Permanent approval changes future policy for git_push. Type always again to confirm [deny]: ",
    );
    expect(confirmed.question).toHaveBeenCalledTimes(2);
  });

  it("denies without reading input when stdin is non-interactive", async () => {
    const questions = questioner("always", "always");
    const lines: string[] = [];

    const choice = await promptForOneShotApproval(
      questions,
      {
        command: "git push",
        choices: ["always"],
        allowPermanent: true,
        patternKey: "git_push",
      },
      { interactive: false, writeLine: (line) => lines.push(line) },
    );

    expect(choice).toBe("deny");
    expect(questions.question).not.toHaveBeenCalled();
    expect(lines).toContain("[approval] Standard input is not interactive; denying by default.");
  });

  it("fails closed when the gateway supplies no valid choices", async () => {
    const questions = questioner("once");

    const choice = await promptForOneShotApproval(
      questions,
      { choices: ["forever", 1], allowPermanent: true, patternKey: "anything" },
      { interactive: true },
    );

    expect(choice).toBe("deny");
    expect(questions.question).not.toHaveBeenCalled();
  });

  it("deduplicates and bounds inspectable patterns before enabling always", () => {
    const approval = sanitizeOneShotApproval({
      command: "release package",
      choices: ["always", "deny"],
      allowPermanent: true,
      patternKey: "same",
      patternKeys: ["same", ...Array.from({ length: 30 }, (_, index) => `pattern_${index}`)],
    });

    expect(approval.patternKeys).toHaveLength(31);
    expect(approval.patternKeys.slice(0, 3)).toEqual(["same", "pattern_0", "pattern_1"]);
    expect(approval.choices).toEqual(["always", "deny"]);
    expect(approval.allowPermanent).toBe(true);
  });
});

function questioner(...answers: string[]): ApprovalQuestioner & { question: ReturnType<typeof vi.fn> } {
  return {
    question: vi.fn(async () => answers.shift() ?? ""),
  };
}
