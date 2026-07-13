import { describe, expect, it } from "vitest";
import {
  MAX_RESAMPLED_PCM16_BYTES,
  normalizePcm16Audio,
  parsePcmSampleRate,
  pcmMimeType,
  requirePcmSampleRate,
  resamplePcm16Base64,
  validatePcmSampleRate,
} from "../src/domain/audio/pcm.js";

describe("PCM audio helpers", () => {
  it("parses PCM sample rates", () => {
    expect(parsePcmSampleRate("audio/pcm;rate=24000")).toBe(24000);
    expect(parsePcmSampleRate("audio/wav;rate=24000")).toBeUndefined();
  });

  it.each([0, 24_000.5, 7_999, 192_001])("rejects invalid PCM sample rate %s", (sampleRate) => {
    expect(parsePcmSampleRate(`audio/pcm;rate=${sampleRate}`)).toBeUndefined();
    expect(() => validatePcmSampleRate(sampleRate)).toThrow(/integer between 8000 and 192000/);
  });

  it("requires explicit valid source rate metadata", () => {
    expect(parsePcmSampleRate("audio/pcm")).toBeUndefined();
    expect(() => requirePcmSampleRate("audio/pcm")).toThrow(/must include exactly one integer rate/);
    expect(() => requirePcmSampleRate("audio/pcm;rate=not-a-number")).toThrow(/must include exactly one integer rate/);
    expect(() => requirePcmSampleRate("audio/pcm;rate=24000;rate=16000")).toThrow(
      /must include exactly one integer rate/,
    );
  });

  it("builds PCM mime types", () => {
    expect(pcmMimeType(16000)).toBe("audio/pcm;rate=16000");
    expect(() => pcmMimeType(16_000.5)).toThrow(/integer between 8000 and 192000/);
  });

  it("keeps audio unchanged when rate already matches", () => {
    const data = Buffer.from([0, 0, 1, 0]).toString("base64");
    expect(normalizePcm16Audio({ data, mimeType: "audio/pcm;rate=24000" }, 24000)).toEqual({
      data,
      mimeType: "audio/pcm;rate=24000",
    });
  });

  it("does not infer missing or malformed source rates during normalization", () => {
    const data = Buffer.from([0, 0]).toString("base64");

    expect(() => normalizePcm16Audio({ data, mimeType: "audio/pcm" }, 24_000)).toThrow(/must include exactly one/);
    expect(() => normalizePcm16Audio({ data, mimeType: "audio/pcm;rate=0" }, 24_000)).toThrow(
      /must include exactly one/,
    );
  });

  it("validates normalization target rates", () => {
    const data = Buffer.from([0, 0]).toString("base64");

    expect(() => normalizePcm16Audio({ data, mimeType: "audio/pcm;rate=24000" }, 0)).toThrow(
      /Target PCM sample rate must be an integer/,
    );
  });

  it("resamples PCM16 base64", () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(-1000, 0);
    input.writeInt16LE(1000, 2);

    const output = Buffer.from(resamplePcm16Base64(input.toString("base64"), 8_000, 16_000), "base64");

    expect(output.length).toBe(8);
  });

  it("validates direct resampling rates", () => {
    const input = Buffer.from([0, 0]).toString("base64");

    expect(() => resamplePcm16Base64(input, 0, 24_000)).toThrow(/Source PCM sample rate must be an integer/);
    expect(() => resamplePcm16Base64(input, 24_000, 192_000.5)).toThrow(/Target PCM sample rate must be an integer/);
  });

  it("caps resampled output allocation before amplification", () => {
    const maximumInputBytes = Math.floor(MAX_RESAMPLED_PCM16_BYTES / (192_000 / 8_000));
    const oversizedInputBytes = maximumInputBytes + (maximumInputBytes % 2 === 0 ? 2 : 1);
    const input = Buffer.alloc(oversizedInputBytes).toString("base64");

    expect(() => resamplePcm16Base64(input, 8_000, 192_000)).toThrow(/allocation limit/);
  });

  it("rejects odd PCM byte counts", () => {
    expect(() => resamplePcm16Base64(Buffer.from([1]).toString("base64"), 16000, 24000)).toThrow(/even number/);
  });
});
