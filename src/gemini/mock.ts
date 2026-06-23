import { randomUUID } from "node:crypto";
import type { LiveModelAudio, LiveToolCall } from "../protocol.js";
import type { LiveModelAdapter, LiveModelCallbacks, LiveModelConnectParams, LiveModelSession } from "../realtime/live.js";

export class MockLiveAdapter implements LiveModelAdapter {
  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => {
      params.callbacks.onOpen?.();
      params.callbacks.onEvent({
        type: "text",
        text: "Mock live mode is connected. Type a message to route it through Hermes.",
      });
    });
    return new MockLiveSession(params.callbacks);
  }
}

class MockLiveSession implements LiveModelSession {
  constructor(private readonly callbacks: LiveModelCallbacks) {}

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {
    this.callbacks.onEvent({
      type: "text",
      text: "Mock live mode does not transcribe audio. Use the text box to test the Hermes bridge.",
    });
  }

  async sendText(text: string): Promise<void> {
    this.callbacks.onEvent({
      type: "tool_call",
      call: {
        id: `mock_${randomUUID()}`,
        name: "start_hermes_run",
        args: { message: text },
      },
    });
  }

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(): Promise<boolean> {
    return false;
  }

  async sendToolResponse(_call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    const output = typeof response.output === "string" ? response.output : JSON.stringify(response);
    this.callbacks.onEvent({ type: "text", text: output });
  }

  async close(): Promise<void> {}
}
