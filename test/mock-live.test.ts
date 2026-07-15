import { describe, expect, it, vi } from "vitest";
import { MockLiveAdapter } from "../src/adapters/outbound/realtime/mock-live.adapter.js";

describe("Mock Live task delegation and notifications", () => {
  it("delegates text through the protocol-v3 background-task tool", async () => {
    const onEvent = vi.fn();
    const session = await new MockLiveAdapter().connect({
      sessionId: "live_mock_task",
      systemInstruction: "test",
      callbacks: { onEvent },
    });
    await Promise.resolve();
    onEvent.mockClear();

    await session.sendText(" inspect this repository ");

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "response", status: "started" },
      {
        type: "tool_call",
        call: expect.objectContaining({
          id: expect.stringMatching(/^mock_/u),
          name: "start_background_task",
          args: {
            message: " inspect this repository ",
            title: "inspect this repository",
            execution_mode: "exclusive",
            resource_keys: ["workspace:default"],
          },
        }),
      },
    ]);
  });

  it("announces the bounded safe sentence deterministically without exposing context or raw output", async () => {
    const onEvent = vi.fn();
    const session = await new MockLiveAdapter().connect({
      sessionId: "live_mock_notification",
      systemInstruction: "test",
      callbacks: { onEvent },
    });
    await Promise.resolve();
    onEvent.mockClear();

    await session.sendTaskNotification?.({
      context: "[HERMES_LIVE_TASK_EVENT_V1:0123456789abcdef0123456789abcdef] Task finished.",
      announcement: "Task finished.",
      rawOutput: "private Hermes output",
    } as any);

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "response", status: "started" },
      { type: "text", text: "Task finished.", speaker: "assistant", final: true },
      { type: "response", status: "completed" },
    ]);
    const rendered = JSON.stringify(onEvent.mock.calls);
    expect(rendered).not.toContain("HERMES_LIVE_TASK_EVENT_V1");
    expect(rendered).not.toContain("private Hermes output");
  });

  it("renders a human task receipt instead of raw tool-response JSON", async () => {
    const onEvent = vi.fn();
    const session = await new MockLiveAdapter().connect({
      sessionId: "live_mock_receipt",
      systemInstruction: "test",
      callbacks: { onEvent },
    });
    await Promise.resolve();
    onEvent.mockClear();

    await session.sendToolResponse?.(
      { id: "mock_receipt", name: "start_background_task", args: {} },
      {
        ok: true,
        task_id: "task_0123456789abcdef0123456789abcdef",
        status: "queued",
        message: "Background task accepted. You can keep talking or disconnect.",
      },
    );

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "text", text: "Background task accepted. You can keep talking or disconnect." },
      { type: "response", status: "completed" },
    ]);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("task_0123456789abcdef0123456789abcdef");
  });

  it("rejects malformed notifications without emitting a partial lifecycle", async () => {
    const onEvent = vi.fn();
    const session = await new MockLiveAdapter().connect({
      sessionId: "live_mock_invalid_notification",
      systemInstruction: "test",
      callbacks: { onEvent },
    });
    await Promise.resolve();
    onEvent.mockClear();

    await expect(session.sendTaskNotification?.({
      context: "marker\nforged",
      announcement: "Task finished.",
    })).rejects.toThrow(/Task notification context/);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
