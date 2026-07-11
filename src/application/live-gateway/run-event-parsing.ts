import { z } from "zod";
import type { HermesRunEvent } from "../../domain/protocol/server-protocol.js";

export type NarratableEvent =
  | { kind: "reasoning"; text: string }
  | { kind: "tool_started"; tool: string; preview?: string }
  | { kind: "tool_completed"; tool: string; error: boolean; duration?: number }
  | { kind: "approval_request" }
  | { kind: "terminal"; status: "completed" | "failed" | "cancelled" };

// Per-kind zod schemas — all use safeParse so nothing ever throws
const ReasoningSchema = z.object({
  event: z.literal("reasoning.available"),
  text: z.string(),
});

const ToolStartedSchema = z.object({
  event: z.literal("tool.started"),
  tool: z.string(),
  preview: z.string().optional(),
});

const ToolCompletedSchema = z.object({
  event: z.literal("tool.completed"),
  tool: z.string(),
  error: z.unknown().optional(),
  duration: z.number().optional(),
});

const ApprovalRequestSchema = z.object({
  event: z.literal("approval.request"),
});

const TerminalSchema = z.object({
  event: z.union([z.literal("run.completed"), z.literal("run.failed"), z.literal("run.cancelled")]),
});

export function parseNarratableEvent(event: HermesRunEvent): NarratableEvent | undefined {
  const untrusted = event as unknown;
  if (untrusted === null || untrusted === undefined || typeof untrusted !== "object" || Array.isArray(untrusted)) {
    return undefined;
  }
  const safeEvent = untrusted as HermesRunEvent;
  const kind = safeEvent.event;
  if (typeof kind !== "string") return undefined;

  switch (kind) {
    case "reasoning.available": {
      const r = ReasoningSchema.safeParse(safeEvent);
      if (!r.success) return undefined;
      return { kind: "reasoning", text: r.data.text };
    }
    case "tool.started": {
      const r = ToolStartedSchema.safeParse(safeEvent);
      if (!r.success) return undefined;
      return { kind: "tool_started", tool: r.data.tool, ...(r.data.preview !== undefined ? { preview: r.data.preview } : {}) };
    }
    case "tool.completed": {
      const r = ToolCompletedSchema.safeParse(safeEvent);
      if (!r.success) return undefined;
      const isError = r.data.error !== undefined && r.data.error !== null && r.data.error !== false;
      return {
        kind: "tool_completed",
        tool: r.data.tool,
        error: isError,
        ...(r.data.duration !== undefined ? { duration: r.data.duration } : {}),
      };
    }
    case "approval.request": {
      const r = ApprovalRequestSchema.safeParse(safeEvent);
      if (!r.success) return undefined;
      return { kind: "approval_request" };
    }
    case "run.completed":
    case "run.failed":
    case "run.cancelled": {
      const r = TerminalSchema.safeParse(safeEvent);
      if (!r.success) return undefined;
      const statusMap = {
        "run.completed": "completed",
        "run.failed": "failed",
        "run.cancelled": "cancelled",
      } as const;
      return { kind: "terminal", status: statusMap[r.data.event] };
    }
    default:
      return undefined;
  }
}

// Regex patterns:
// - Path-like: sequences with ≥2 forward slashes mixed with word chars, dots, dashes
const PATH_RE = /[\w./-]*\/[\w./-]*\/[\w./-]+/g;
// - Token/key-shaped: contiguous base64/hex-looking runs of 24+ chars
const TOKEN_RE = /\b[A-Za-z0-9+/_-]{24,}\b/g;
// - Collapse whitespace
const WHITESPACE_RE = /\s+/g;

const MAX_LENGTH = 300;

export function redactForNarration(text: string): string {
  // Strip paths first (before truncation so we don't cut mid-path)
  let result = text.replace(PATH_RE, "[path]");
  // Strip token/key-shaped strings
  result = result.replace(TOKEN_RE, "[redacted]");
  // Collapse whitespace
  result = result.replace(WHITESPACE_RE, " ").trim();
  // Cap at 300 chars
  if (result.length > MAX_LENGTH) {
    result = result.slice(0, MAX_LENGTH) + "...";
  }
  return result;
}
