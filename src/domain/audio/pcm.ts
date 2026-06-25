export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;
export const CLIENT_CAPTURE_SAMPLE_RATE = 24_000;

export interface PcmAudioFrame {
  data: string;
  mimeType: string;
}

export function normalizePcm16Audio<T extends PcmAudioFrame>(audio: T, targetRate: number): T {
  if (!isPcmMimeType(audio.mimeType)) {
    throw new Error(`Unsupported audio mime type for PCM normalization: ${audio.mimeType}`);
  }
  const sourceRate = parsePcmSampleRate(audio.mimeType) ?? targetRate;
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
  for (const param of params) {
    const [key, value] = param.split("=").map((part) => part.trim());
    if (key === "rate" && value) {
      const rate = Number(value);
      return Number.isFinite(rate) && rate > 0 ? rate : undefined;
    }
  }
  return undefined;
}

export function isPcmMimeType(mimeType: string): boolean {
  return mimeType.split(";")[0]?.trim().toLowerCase() === "audio/pcm";
}

export function pcmMimeType(sampleRate: number): string {
  return `audio/pcm;rate=${sampleRate}`;
}

export function resamplePcm16Base64(data: string, sourceRate: number, targetRate: number): string {
  if (sourceRate <= 0 || targetRate <= 0) {
    throw new Error("PCM sample rates must be positive.");
  }
  const source = decodePcm16Base64(data);
  if (source.length === 0 || sourceRate === targetRate) {
    return data;
  }

  const outputLength = Math.max(1, Math.round((source.length * targetRate) / sourceRate));
  const output = Buffer.alloc(outputLength * 2);
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
