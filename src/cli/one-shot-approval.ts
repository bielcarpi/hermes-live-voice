import type { ApprovalChoice } from "../domain/protocol/client-protocol.js";
import { ApprovalChoiceSchema } from "../domain/protocol/client-protocol.js";

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_COMMAND_CHARS = 4_000;
const MAX_PATTERN_CHARS = 256;
const MAX_PATTERN_KEYS = 32;

export interface ApprovalQuestioner {
  question(prompt: string): Promise<string>;
}

export interface OneShotApprovalPromptOptions {
  interactive: boolean;
  writeLine?: (line: string) => void;
}

export interface SanitizedOneShotApproval {
  command?: string;
  description?: string;
  patternKeys: string[];
  choices: ApprovalChoice[];
  allowPermanent: boolean;
}

/**
 * Resolves a single approval request without widening the choices supplied by
 * the gateway. Denial remains the fail-closed result for missing input,
 * malformed metadata, unavailable choices, or non-interactive execution.
 */
export async function promptForOneShotApproval(
  questioner: ApprovalQuestioner,
  rawApproval: unknown,
  options: OneShotApprovalPromptOptions,
): Promise<ApprovalChoice> {
  const approval = sanitizeOneShotApproval(rawApproval);
  const writeLine = options.writeLine ?? (() => undefined);

  writeLine(`[approval] Description: ${approval.description ?? "not supplied"}`);
  writeLine(`[approval] Command: ${approval.command ?? "not supplied"}`);
  if (approval.patternKeys.length > 0) {
    writeLine(`[approval] Permission pattern: ${approval.patternKeys.join(", ")}`);
  } else {
    writeLine("[approval] Permission pattern: not supplied; permanent approval is unavailable.");
  }

  if (approval.choices.length === 0) {
    writeLine("[approval] The gateway supplied no valid approval choices; denying by default.");
    return "deny";
  }
  writeLine(`[approval] Available choices: ${approval.choices.join(", ")}. Deny is the safe default.`);
  if (approval.choices.length === 1 && approval.choices[0] === "deny") {
    writeLine("[approval] The request details were incomplete or unsafe; denial is the only available choice.");
    return "deny";
  }

  if (!options.interactive) {
    writeLine("[approval] Standard input is not interactive; denying by default.");
    return "deny";
  }

  const answer = normalizeChoice(
    await questioner.question(`Choose ${approval.choices.join("/")} [deny]: `),
  );
  if (!answer || !approval.choices.includes(answer)) {
    writeLine("[approval] No valid available choice was selected; denying by default.");
    return "deny";
  }

  if (answer !== "always") return answer;

  // `always` can only survive sanitization when both the explicit permission
  // bit and at least one inspectable, terminal-safe pattern are present.
  if (!approval.allowPermanent || approval.patternKeys.length === 0) {
    writeLine("[approval] Permanent approval is unavailable; denying by default.");
    return "deny";
  }

  const confirmation = normalizeChoice(
    await questioner.question(
      `Permanent approval changes future policy for ${approval.patternKeys.join(", ")}. Type always again to confirm [deny]: `,
    ),
  );
  if (confirmation !== "always") {
    writeLine("[approval] Permanent approval was not confirmed; denying by default.");
    return "deny";
  }
  return "always";
}

export function sanitizeOneShotApproval(value: unknown): SanitizedOneShotApproval {
  const approval = recordValue(value);
  const commandProjection = exactDisplayText(approval?.command, MAX_COMMAND_CHARS);
  const descriptionProjection = exactDisplayText(approval?.description, MAX_DESCRIPTION_CHARS);
  const command = commandProjection.value;
  const description = descriptionProjection.value;
  const displayComplete = commandProjection.exact && descriptionProjection.exact && Boolean(command || description);
  const patterns = exactPatterns(approval);
  const patternKeys = displayComplete && patterns.exact ? patterns.values : [];
  const hasInspectablePermanentPattern = displayComplete && patterns.exact && patternKeys.length > 0;
  const suppliedChoices = exactChoices(approval?.choices);
  const choices = suppliedChoices
    .filter(
      (choice) =>
        (displayComplete || choice === "deny") &&
        ((choice !== "session" && choice !== "always") || hasInspectablePermanentPattern) &&
        (choice !== "always" || (hasInspectablePermanentPattern && approval?.allowPermanent === true)),
    )
    .filter((choice, index, all) => all.indexOf(choice) === index);
  if (!choices.includes("deny")) choices.push("deny");
  const allowPermanent = hasInspectablePermanentPattern &&
    approval?.allowPermanent === true &&
    choices.includes("always");

  return {
    ...(command ? { command } : {}),
    ...(description ? { description } : {}),
    patternKeys,
    choices,
    allowPermanent,
  };
}

function exactChoices(value: unknown): ApprovalChoice[] {
  if (!Array.isArray(value) || value.length === 0) return ["deny"];
  const choices: ApprovalChoice[] = [];
  for (const choice of value) {
    const parsed = ApprovalChoiceSchema.safeParse(choice);
    if (!parsed.success) return ["deny"];
    choices.push(parsed.data);
  }
  return choices;
}

function normalizeChoice(value: string): ApprovalChoice | undefined {
  const parsed = ApprovalChoiceSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

function exactDisplayText(value: unknown, maxChars: number): { value?: string; exact: boolean } {
  if (value === undefined || value === null || value === "") return { exact: true };
  if (typeof value !== "string" || /[\r\n\t]/u.test(value)) return { exact: false };
  const projected = boundedSingleLine(value, maxChars);
  return projected && projected === value && /[\p{L}\p{N}\p{P}\p{S}]/u.test(projected)
    ? { value: projected, exact: true }
    : { exact: false };
}

function exactPatterns(approval: Record<string, unknown> | undefined): { values: string[]; exact: boolean } {
  const rawValues: unknown[] = [];
  if (approval?.patternKey !== undefined && approval.patternKey !== null && approval.patternKey !== "") {
    rawValues.push(approval.patternKey);
  }
  if (approval?.patternKeys !== undefined && approval.patternKeys !== null) {
    if (!Array.isArray(approval.patternKeys) || approval.patternKeys.length > MAX_PATTERN_KEYS) {
      return { values: [], exact: false };
    }
    rawValues.push(...approval.patternKeys);
  }
  if (rawValues.length > MAX_PATTERN_KEYS) return { values: [], exact: false };

  const values: string[] = [];
  for (const raw of rawValues) {
    const projected = boundedSingleLine(raw, MAX_PATTERN_CHARS);
    if (
      typeof raw !== "string" ||
      !projected ||
      projected !== raw ||
      !/[\p{L}\p{N}\p{P}\p{S}]/u.test(projected)
    ) {
      return { values: [], exact: false };
    }
    if (!values.includes(projected)) values.push(projected);
  }
  return { values, exact: true };
}

function boundedSingleLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const boundedInput = value.slice(0, maxChars * 4 + 4_096);
  const withoutTerminalSequences = boundedInput
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
  const normalized = Array.from(withoutTerminalSequences.normalize("NFC"))
    .filter((character) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(character))
    .slice(0, maxChars)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
