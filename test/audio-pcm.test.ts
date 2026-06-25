import { describe, expect, it } from "vitest";
import { normalizePcm16Audio, parsePcmSampleRate, pcmMimeType, resamplePcm16Base64 } from "../src/domain/audio/pcm.js";

describe("PCM audio helpers", () => {
  it("parses PCM sample rates", () => {
    expect(parsePcmSampleRate("audio/pcm;rate=24000")).toBe(24000);
    expect(parsePcmSampleRate("audio/wav;rate=24000")).toBeUndefined();
  });

  it("builds PCM mime types", () => {
    expect(pcmMimeType(16000)).toBe("audio/pcm;rate=16000");
  });

  it("keeps audio unchanged when rate already matches", () => {
    const data = Buffer.from([0, 0, 1, 0]).toString("base64");
    expect(normalizePcm16Audio({ data, mimeType: "audio/pcm;rate=24000" }, 24000)).toEqual({
      data,
      mimeType: "audio/pcm;rate=24000",
    });
  });

  it("resamples PCM16 base64", () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(-1000, 0);
    input.writeInt16LE(1000, 2);

    const output = Buffer.from(resamplePcm16Base64(input.toString("base64"), 2, 4), "base64");

    expect(output.length).toBe(8);
  });

  it("rejects odd PCM byte counts", () => {
    expect(() => resamplePcm16Base64(Buffer.from([1]).toString("base64"), 16000, 24000)).toThrow(/even number/);
  });
});
