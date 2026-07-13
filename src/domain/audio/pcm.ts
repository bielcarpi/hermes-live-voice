export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;
export const CLIENT_CAPTURE_SAMPLE_RATE = 24_000;
export const MIN_PCM_SAMPLE_RATE = 8_000;
export const MAX_PCM_SAMPLE_RATE = 192_000;

// Resampling can amplify an inbound frame by up to 24x across the supported
// rate range. Keep the resulting allocation bounded even if an upstream frame
// limit is raised or this helper is called outside the gateway.
export const MAX_RESAMPLED_PCM16_BYTES = 16 * 1024 * 1024;

export interface PcmAudioFrame {
  data: string;
  mimeType: string;
}

export function normalizePcm16Audio<T extends PcmAudioFrame>(audio: T, targetRate: number): T {
  if (!isPcmMimeType(audio.mimeType)) {
    throw new Error(`Unsupported audio mime type for PCM normalization: ${audio.mimeType}`);
  }
  const sourceRate = requirePcmSampleRate(audio.mimeType);
  validatePcmSampleRate(targetRate, "Target PCM sample rate");
  const mimeType = pcmMimeType(targetRate);
  if (sourceRate === targetRate) {
    return { ...audio, mimeType };
  }
  return { ...audio, data: resamplePcm16Base64(audio.data, sourceRate, targetRate), mimeType };
}

export function parsePcmSampleRate(mimeType: string): number | undefined {
  const [, ...params] = mimeType.split(";").map((part) => part.trim().toLowerCase());
  if (!isPcmMimeType(mimeType)) {
    return undefined;
  }

  const rates: number[] = [];
  for (const param of params) {
    const separator = param.indexOf("=");
    const key = (separator === -1 ? param : param.slice(0, separator)).trim();
    if (key !== "rate") {
      continue;
    }

    const value = separator === -1 ? "" : param.slice(separator + 1).trim();
    const rate = Number(value);
    if (!value || !isValidPcmSampleRate(rate)) {
      return undefined;
    }
    rates.push(rate);
  }

  return rates.length === 1 ? rates[0] : undefined;
}

export function requirePcmSampleRate(mimeType: string): number {
  const sampleRate = parsePcmSampleRate(mimeType);
  if (sampleRate === undefined) {
    throw new Error(
      `PCM audio mime type must include exactly one integer rate between ${MIN_PCM_SAMPLE_RATE} and ${MAX_PCM_SAMPLE_RATE} Hz.`,
    );
  }
  return sampleRate;
}

export function isValidPcmSampleRate(sampleRate: unknown): sampleRate is number {
  return (
    typeof sampleRate === "number" &&
    Number.isInteger(sampleRate) &&
    sampleRate >= MIN_PCM_SAMPLE_RATE &&
    sampleRate <= MAX_PCM_SAMPLE_RATE
  );
}

export function validatePcmSampleRate(sampleRate: unknown, label = "PCM sample rate"): asserts sampleRate is number {
  if (!isValidPcmSampleRate(sampleRate)) {
    throw new Error(`${label} must be an integer between ${MIN_PCM_SAMPLE_RATE} and ${MAX_PCM_SAMPLE_RATE} Hz.`);
  }
}

export function isPcmMimeType(mimeType: string): boolean {
  return mimeType.split(";")[0]?.trim().toLowerCase() === "audio/pcm";
}

export function pcmMimeType(sampleRate: number): string {
  validatePcmSampleRate(sampleRate);
  return `audio/pcm;rate=${sampleRate}`;
}

export function resamplePcm16Base64(data: string, sourceRate: number, targetRate: number): string {
  validatePcmSampleRate(sourceRate, "Source PCM sample rate");
  validatePcmSampleRate(targetRate, "Target PCM sample rate");
  const source = decodePcm16Base64(data);
  if (source.length === 0 || sourceRate === targetRate) {
    return data;
  }

  const outputLength = Math.max(1, Math.round((source.length * targetRate) / sourceRate));
  const outputBytes = outputLength * Int16Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(outputBytes) || outputBytes > MAX_RESAMPLED_PCM16_BYTES) {
    throw new Error(`Resampled PCM16 audio exceeds the ${MAX_RESAMPLED_PCM16_BYTES}-byte allocation limit.`);
  }
  const output = Buffer.alloc(outputBytes);
  const scale = sourceRate / targetRate;

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = i * scale;
    const leftIndex = Math.min(source.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const mix = sourcePosition - leftIndex;
    const left = source[leftIndex] ?? 0;
    const right = source[rightIndex] ?? left;
    output.writeInt16LE(clampPcm16(Math.round(left * (1 - mix) + right * mix)), i * 2);
  }

  return output.toString("base64");
}

function decodePcm16Base64(data: string): Int16Array {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length % 2 !== 0) {
    throw new Error("PCM16 audio must contain an even number of bytes.");
  }
  const samples = new Int16Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = bytes.readInt16LE(i * 2);
  }
  return samples;
}

function clampPcm16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, value));
}
