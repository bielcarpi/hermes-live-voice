import { describe, expect, it, vi } from "vitest";
import type { LiveModelEvent } from "../src/application/live-gateway/ports/realtime-model.port.js";
import { extractWavPcmBase64, VoxtralLiveAdapter } from "../src/adapters/outbound/realtime/voxtral.adapter.js";
import type { LiveModelCallbacks } from "../src/application/live-gateway/ports/realtime-model.port.js";

const CONFIG = {
  apiKey: "test-key",
  baseUrl: "https://api.mistral.ai",
  sttModel: "voxtral-mini-transcribe-realtime-2602",
  ttsModel: "voxtral-mini-tts-latest",
  voice: "fr_marie_happy",
};

function collectingCallbacks(): { callbacks: LiveModelCallbacks; events: LiveModelEvent[] } {
  const events: LiveModelEvent[] = [];
  return {
    events,
    callbacks: {
      onEvent: (event) => events.push(event),
      onOpen: vi.fn(),
      onError: vi.fn(),
    },
  };
}

describe("extractWavPcmBase64", () => {
  it("extracts the data chunk of a canonical RIFF/WAVE buffer", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      new Uint8Array(new Uint32Array([36 + payload.length]).buffer),
      Buffer.from("WAVE", "ascii"),
      Buffer.from("fmt ", "ascii"),
      new Uint8Array(new Uint32Array([16]).buffer),
      new Uint8Array(new Uint16Array([1, 1]).buffer),
      new Uint8Array(new Uint32Array([24000, 48000]).buffer),
      new Uint8Array(new Uint16Array([2, 16]).buffer),
      Buffer.from("data", "ascii"),
      new Uint8Array(new Uint32Array([payload.length]).buffer),
      payload,
    ]);
    expect(extractWavPcmBase64(wav.toString("base64"))).toBe(payload.toString("base64"));
  });

  it("rejects non-WAVE input", () => {
    expect(extractWavPcmBase64(Buffer.from("not a wav at all").toString("base64"))).toBeNull();
    expect(extractWavPcmBase64("")).toBeNull();
  });
});

describe("VoxtralLiveAdapter", () => {
  it("requires an API key", () => {
    expect(() => new VoxtralLiveAdapter({ ...CONFIG, apiKey: undefined }, 1000)).toThrow(/API key/u);
  });

  it("routes every committed text turn through continue_hermes_conversation", async () => {
    const adapter = new VoxtralLiveAdapter(CONFIG, 1000);
    const { callbacks, events } = collectingCallbacks();
    const session = await adapter.connect({ sessionId: "s1", systemInstruction: "", callbacks });
    await session.sendText("Bonjour, que sais-tu faire ?");
    const response = expect.objectContaining({ status: "started" }) as unknown as Record<string, unknown>;
    expect(events).toEqual([
      { type: "response", status: "started" },
      {
        type: "tool_call",
        call: {
          id: expect.stringMatching(/^voxtral_/u) as unknown,
          name: "continue_hermes_conversation",
          args: { message: "Bonjour, que sais-tu faire ?" },
        },
      },
    ]);
    expect(response).toBeTruthy();
  });

  it("speaks the Hermes reply and completes the response lifecycle", async () => {
    const adapter = new VoxtralLiveAdapter(CONFIG, 1000);
    const { callbacks, events } = collectingCallbacks();
    const session = await adapter.connect({ sessionId: "s1", systemInstruction: "", callbacks });
    const speak = vi.spyOn(session as unknown as { speak: (text: string) => Promise<void> }, "speak");
    speak.mockResolvedValue(undefined);
    await session.sendToolResponse(
      { id: "call_1", name: "continue_hermes_conversation", args: { message: "hi" } },
      { ok: true, message: "Voici ce que je sais faire." },
    );
    expect(speak).toHaveBeenCalledWith("Voici ce que je sais faire.");
    expect(events.at(-1)).toEqual({ type: "response", status: "completed" });
  });

  it("commits no turn without audio", async () => {
    const adapter = new VoxtralLiveAdapter(CONFIG, 1000);
    const { callbacks, events } = collectingCallbacks();
    const session = await adapter.connect({ sessionId: "s1", systemInstruction: "", callbacks });
    await expect(session.sendAudioStreamEnd()).resolves.toBe(false);
    expect(events).toEqual([]);
  });
});
