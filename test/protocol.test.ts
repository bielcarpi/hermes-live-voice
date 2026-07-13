import { describe, expect, it } from "vitest";
import { HERMES_LIVE_TOOL_DECLARATIONS, OPENAI_HERMES_LIVE_TOOLS, parseClientMessage, serverMessage } from "../src/protocol.js";

describe("protocol", () => {
  it("validates known client messages", () => {
    expect(parseClientMessage({ type: "session.start", protocolVersion: 1, profileId: "default" })).toMatchObject({
      type: "session.start",
      protocolVersion: 1,
    });
    expect(parseClientMessage({ type: "text.input", text: "hello" }).type).toBe("text.input");
    expect(parseClientMessage({ type: "response.cancel", reason: "user interrupted" }).type).toBe("response.cancel");
    expect(
      parseClientMessage({
        type: "response.cancel",
        reason: "barge-in",
        truncate: { itemId: "item_1", audioEndMs: 1200 },
      }),
    ).toMatchObject({
      type: "response.cancel",
      truncate: { itemId: "item_1", contentIndex: 0, audioEndMs: 1200 },
    });
    expect(
      parseClientMessage({
        type: "response.cancel",
        reason: "queued audio interruption",
        truncate: { itemId: "item_1", audioEndMs: 0 },
      }),
    ).toMatchObject({
      type: "response.cancel",
      truncate: { itemId: "item_1", contentIndex: 0, audioEndMs: 0 },
    });
    expect(parseClientMessage({ type: "approval.respond", runId: "run_1", choice: "once" }).type).toBe("approval.respond");
  });

  it("rejects invalid client messages", () => {
    expect(() => parseClientMessage({ type: "session.start", protocolVersion: 0 })).toThrow();
    expect(() => parseClientMessage({ type: "text.input", text: "" })).toThrow();
    expect(() => parseClientMessage({ type: "approval.respond", runId: "run_1", choice: "forever" })).toThrow();
  });

  it("bounds client-controlled metadata fields", () => {
    const tooLongMetadata = "x".repeat(257);
    const tooLongReason = "x".repeat(1_001);

    expect(() => parseClientMessage({ type: "session.start", profileId: tooLongMetadata })).toThrow();
    expect(() => parseClientMessage({ type: "audio.input", data: "AA==", mimeType: "x".repeat(129) })).toThrow();
    expect(() => parseClientMessage({ type: "approval.respond", runId: tooLongMetadata, choice: "once" })).toThrow();
    expect(() => parseClientMessage({ type: "run.stop", reason: tooLongReason })).toThrow();
    expect(() =>
      parseClientMessage({ type: "response.cancel", truncate: { itemId: "item_1", audioEndMs: Number.POSITIVE_INFINITY } }),
    ).toThrow();
    expect(() =>
      parseClientMessage({ type: "response.cancel", truncate: { itemId: "item_1", audioEndMs: 60 * 60 * 1_000 + 1 } }),
    ).toThrow();
  });

  it("serializes server messages as JSON", () => {
    expect(JSON.parse(serverMessage({ type: "run.stopped", runId: "run_1", status: "stopping" }))).toEqual({
      type: "run.stopped",
      runId: "run_1",
      status: "stopping",
    });
  });

  it("exposes only gateway tools to OpenAI Realtime", () => {
    expect(OPENAI_HERMES_LIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "start_hermes_run",
      "get_hermes_run_status",
      "stop_hermes_run",
      "submit_hermes_approval",
    ]);
    expect(OPENAI_HERMES_LIVE_TOOLS.every((tool) => tool.type === "function")).toBe(true);
    expect(OPENAI_HERMES_LIVE_TOOLS[0]).toHaveProperty("parameters");
    expect(OPENAI_HERMES_LIVE_TOOLS[0]).not.toHaveProperty("parametersJsonSchema");
  });

  it("uses Gemini SDK function declaration schema shape", () => {
    expect(HERMES_LIVE_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      "start_hermes_run",
      "get_hermes_run_status",
      "stop_hermes_run",
      "submit_hermes_approval",
    ]);
    expect(HERMES_LIVE_TOOL_DECLARATIONS[0]).toHaveProperty("parametersJsonSchema");
    expect(HERMES_LIVE_TOOL_DECLARATIONS[0]).not.toHaveProperty("parameters");
  });
});
