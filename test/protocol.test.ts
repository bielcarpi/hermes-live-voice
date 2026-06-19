import { describe, expect, it } from "vitest";
import { OPENAI_HERMES_LIVE_TOOLS, parseClientMessage, serverMessage } from "../src/protocol.js";

describe("protocol", () => {
  it("validates known client messages", () => {
    expect(parseClientMessage({ type: "session.start", profileId: "default" }).type).toBe("session.start");
    expect(parseClientMessage({ type: "text.input", text: "hello" }).type).toBe("text.input");
    expect(parseClientMessage({ type: "response.cancel", reason: "user interrupted" }).type).toBe("response.cancel");
    expect(parseClientMessage({ type: "approval.respond", runId: "run_1", choice: "once" }).type).toBe("approval.respond");
  });

  it("rejects invalid client messages", () => {
    expect(() => parseClientMessage({ type: "text.input", text: "" })).toThrow();
    expect(() => parseClientMessage({ type: "approval.respond", runId: "run_1", choice: "forever" })).toThrow();
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
  });
});
