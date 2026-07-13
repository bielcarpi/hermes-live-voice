import { describe, expect, it } from "vitest";
import { MAX_SSE_EVENT_BYTES, parseSseEventBlock, parseSseStream } from "../src/adapters/outbound/hermes/sse.js";

describe("SSE parsing", () => {
  it("parses JSON data blocks", () => {
    expect(parseSseEventBlock('event: message\ndata: {"event":"message.delta","delta":"hi"}')).toEqual({
      event: "message.delta",
      delta: "hi",
    });
  });

  it("uses the SSE event name when JSON data omits event", () => {
    expect(parseSseEventBlock('event: run.completed\ndata: {"output":"done"}')).toEqual({
      event: "run.completed",
      output: "done",
    });
  });

  it("joins multi-line data blocks", () => {
    expect(parseSseEventBlock('data: {"event":"x",\ndata: "delta":"hi"}')).toEqual({ event: "x", delta: "hi" });
  });

  it("returns raw payloads for non-JSON data", () => {
    expect(parseSseEventBlock("data: hello")).toEqual({ event: "hermes.raw", data: "hello" });
  });

  it("uses the SSE event name for non-JSON data", () => {
    expect(parseSseEventBlock("event: debug\ndata: hello")).toEqual({ event: "debug", data: "hello" });
  });

  it("streams events across chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"event":"a"}\n\n:data ignored\ndata: {"event":"b"}'));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }

    expect(events).toEqual([{ event: "a" }, { event: "b" }]);
  });

  it("rejects an oversized unterminated event before buffering more data", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(MAX_SSE_EVENT_BYTES + 1)}`));
      },
      cancel() {
        cancelled = true;
      },
    });

    const consume = async () => {
      for await (const _event of parseSseStream(stream)) {
        // No complete event should be emitted.
      }
    };
    await expect(consume()).rejects.toThrow(`${MAX_SSE_EVENT_BYTES}-byte safety limit`);
    expect(cancelled).toBe(true);
  });

  it("cancels the source when a consumer returns before natural EOF", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"event":"run.completed"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const _event of parseSseStream(stream)) {
      break;
    }

    expect(cancelled).toBe(true);
  });
});
