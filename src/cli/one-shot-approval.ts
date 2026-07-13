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
  const command = boundedSingleLine(approval?.command, MAX_COMMAND_CHARS);
  const description = boundedSingleLine(approval?.description, MAX_DESCRIPTION_CHARS);
  const patternKeys = uniqueStrings([
    boundedSingleLine(approval?.patternKey, MAX_PATTERN_CHARS),
    ...(Array.isArray(approval?.patternKeys)
      ? approval.patternKeys.map((pattern) => boundedSingleLine(pattern, MAX_PATTERN_CHARS))
      : []),
  ]).slice(0, MAX_PATTERN_KEYS);
  const allowPermanent = approval?.allowPermanent === true && patternKeys.length > 0;
  const choices = uniqueChoices(approval?.choices).filter(
    (choice) => choice !== "always" || allowPermanent,
  );

  return {
    ...(command ? { command } : {}),
    ...(description ? { description } : {}),
    patternKeys,
    choices,
    allowPermanent: allowPermanent && choices.includes("always"),
  };
}

function uniqueChoices(value: unknown): ApprovalChoice[] {
  if (!Array.isArray(value)) return [];
  const choices = value.flatMap((choice) => {
    const parsed = ApprovalChoiceSchema.safeParse(choice);
    return parsed.success ? [parsed.data] : [];
  });
  return [...new Set(choices)];
}

function normalizeChoice(value: string): ApprovalChoice | undefined {
  const parsed = ApprovalChoiceSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function boundedSingleLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutTerminalSequences = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
  const sanitized: string[] = [];
  for (const character of withoutTerminalSequences) {
    if (sanitized.length >= maxChars) break;
    const code = character.charCodeAt(0);
    if (character === "\n" || character === "\r" || character === "\t") {
      sanitized.push(" ");
    } else if (
      code >= 32 &&
      code !== 127 &&
      !(code >= 128 && code <= 159) &&
      code !== 0x061c &&
      code !== 0x200e &&
      code !== 0x200f &&
      !(code >= 0x202a && code <= 0x202e) &&
      !(code >= 0x2066 && code <= 0x2069)
    ) {
      sanitized.push(character);
    }
  }
  const normalized = sanitized.join("").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
