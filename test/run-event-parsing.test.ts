import { describe, expect, it } from "vitest";
import { parseNarratableEvent, redactForNarration } from "../src/application/live-gateway/run-event-parsing.js";

describe("parseNarratableEvent", () => {
  it("parses reasoning.available with text", () => {
    const event = { event: "reasoning.available", text: "Gateway is healthy — 23/23 connected..." };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "reasoning", text: "Gateway is healthy — 23/23 connected..." });
  });

  it("parses tool.started with tool name", () => {
    const event = { event: "tool.started", tool: "bash", run_id: "run_abc" };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "tool_started", tool: "bash" });
  });

  it("parses tool.started with optional preview", () => {
    const event = { event: "tool.started", tool: "read_file", preview: "Reading config.ts..." };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "tool_started", tool: "read_file", preview: "Reading config.ts..." });
  });

  it("parses tool.completed with no error", () => {
    const event = { event: "tool.completed", tool: "bash", duration: 1234 };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "tool_completed", tool: "bash", error: false, duration: 1234 });
  });

  it("parses tool.completed with error truthy", () => {
    const event = { event: "tool.completed", tool: "bash", error: "exit code 1" };
    const result = parseNarratableEvent(event);
    expect(result).toMatchObject({ kind: "tool_completed", tool: "bash", error: true });
  });

  it("parses tool.completed with error=false as no error", () => {
    const event: Record<string, unknown> = { event: "tool.completed", tool: "bash", error: false };
    const result = parseNarratableEvent(event);
    expect(result).toMatchObject({ kind: "tool_completed", tool: "bash", error: false });
  });

  it("parses tool.completed without duration", () => {
    const event = { event: "tool.completed", tool: "read_file" };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "tool_completed", tool: "read_file", error: false });
    expect(result).not.toHaveProperty("duration");
  });

  it("parses approval.request", () => {
    const event = { event: "approval.request", run_id: "run_xyz" };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "approval_request" });
  });

  it("parses run.completed as terminal", () => {
    const event = { event: "run.completed", output: "Done", usage: { tokens: 100 } };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "terminal", status: "completed" });
  });

  it("parses run.failed as terminal", () => {
    const event = { event: "run.failed", error: "timeout" };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "terminal", status: "failed" });
  });

  it("parses run.cancelled as terminal", () => {
    const event = { event: "run.cancelled" };
    const result = parseNarratableEvent(event);
    expect(result).toEqual({ kind: "terminal", status: "cancelled" });
  });

  it("returns undefined for unknown event name", () => {
    const event = { event: "message.delta", delta: "hello" };
    expect(parseNarratableEvent(event)).toBeUndefined();
  });

  it("returns undefined for event with no event field", () => {
    const event = { run_id: "run_1" };
    expect(parseNarratableEvent(event)).toBeUndefined();
  });

  it("returns undefined for reasoning.available missing text — never throws", () => {
    const event = { event: "reasoning.available" }; // no text field
    expect(() => parseNarratableEvent(event)).not.toThrow();
    expect(parseNarratableEvent(event)).toBeUndefined();
  });

  it("returns undefined for tool.started missing tool — never throws", () => {
    const event = { event: "tool.started" }; // no tool field
    expect(() => parseNarratableEvent(event)).not.toThrow();
    expect(parseNarratableEvent(event)).toBeUndefined();
  });

  it("returns undefined for tool.completed missing tool — never throws", () => {
    const event = { event: "tool.completed" }; // no tool field
    expect(() => parseNarratableEvent(event)).not.toThrow();
    expect(parseNarratableEvent(event)).toBeUndefined();
  });

  it("never throws on completely malformed input", () => {
    expect(() => parseNarratableEvent({})).not.toThrow();
    expect(() => parseNarratableEvent({ event: null as unknown as string })).not.toThrow();
    expect(() => parseNarratableEvent({ event: 42 as unknown as string })).not.toThrow();
  });

  it("returns undefined for null and undefined inputs", () => {
    expect(() => parseNarratableEvent(null as any)).not.toThrow();
    expect(parseNarratableEvent(null as any)).toBeUndefined();
    expect(() => parseNarratableEvent(undefined as any)).not.toThrow();
    expect(parseNarratableEvent(undefined as any)).toBeUndefined();
  });

  it("real production reasoning.available payload passes through benign text unchanged", () => {
    const event = {
      event: "reasoning.available",
      text: "Gateway is healthy — 23/23 connected. All systems nominal.",
      run_id: "run_prod_001",
      timestamp: 1720000000,
    };
    const result = parseNarratableEvent(event);
    expect(result?.kind).toBe("reasoning");
    if (result?.kind === "reasoning") {
      // benign text should pass through redaction mostly unchanged
      const redacted = redactForNarration(result.text);
      expect(redacted).toContain("Gateway is healthy");
      expect(redacted).toContain("23/23 connected");
    }
  });
});

describe("redactForNarration", () => {
  it("passes benign short text through unchanged", () => {
    const text = "Hello, the run completed successfully.";
    expect(redactForNarration(text)).toBe(text);
  });

  it("caps text at 300 chars with ellipsis", () => {
    const long = "hello ".repeat(60);
    const result = redactForNarration(long);
    expect(result.length).toBe(303);
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not add ellipsis when text is exactly 300 chars", () => {
    const safe300 = ("ab ".repeat(100)).slice(0, 300);
    const r = redactForNarration(safe300);
    expect(r.endsWith("...")).toBe(false);
    expect(r.length).toBeLessThanOrEqual(300);
  });

  it("strips absolute file paths like /Users/x/secret/file.py", () => {
    const text = "Error reading /Users/x/secret/file.py at line 42";
    const result = redactForNarration(text);
    expect(result).not.toContain("/Users/x/secret/file.py");
    expect(result).toContain("[path]");
  });

  it("strips deeply nested paths", () => {
    const text = "Loaded from /home/user/projects/myapp/src/config.ts";
    const result = redactForNarration(text);
    expect(result).not.toContain("/home/user/projects");
    expect(result).toContain("[path]");
  });

  it("strips a 40-char hex string (token-shaped)", () => {
    const hex40 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const text = `Token: ${hex40} was used`;
    const result = redactForNarration(text);
    expect(result).not.toContain(hex40);
    expect(result).toContain("[redacted]");
  });

  it("strips a 24-char base64-looking string", () => {
    const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXyz"; // 26 chars, base64-like
    const text = `Key: ${b64} end`;
    const result = redactForNarration(text);
    expect(result).not.toContain(b64);
    expect(result).toContain("[redacted]");
  });

  it("does NOT strip short benign words (< 24 chars)", () => {
    const text = "The quick brown fox jumps";
    expect(redactForNarration(text)).toBe(text);
  });

  it("collapses multiple spaces into one", () => {
    const text = "hello   world\n\nfoo\tbar";
    const result = redactForNarration(text);
    expect(result).toBe("hello world foo bar");
  });

  it("trims leading and trailing whitespace", () => {
    const text = "  hello world  ";
    expect(redactForNarration(text)).toBe("hello world");
  });

  it("strips path before truncating (path stripped text may be under 300 chars)", () => {
    // Build a text that is over 300 chars only because of a long path
    const path = "/a/b/" + "c".repeat(300);
    const text = `See ${path} for details`;
    const result = redactForNarration(text);
    // After path stripping, the text should be short enough to not need truncation
    expect(result).toContain("[path]");
    expect(result).toContain("See");
    expect(result).toContain("for details");
  });
});
