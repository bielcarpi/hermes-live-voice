import type { HermesRunEvent } from "../../../domain/protocol/server-protocol.js";

export const MAX_SSE_EVENT_BYTES = 1_000_000;

export interface SseStreamOptions {
  idleTimeoutMs?: number;
  idleTimeoutMessage?: string;
  onIdle?: () => void;
}

export function parseSseEventBlock(block: string): HermesRunEvent | null {
  assertSseEventSize(block);
  const dataLines: string[] = [];
  let eventName: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  const payload = dataLines.join("\n");
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return eventName && typeof (parsed as HermesRunEvent).event !== "string"
        ? { event: eventName, ...(parsed as Record<string, unknown>) }
        : (parsed as HermesRunEvent);
    }
    return { event: eventName ?? "hermes.raw", data: parsed };
  } catch {
    return { event: eventName ?? "hermes.raw", data: payload };
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: SseStreamOptions = {},
): AsyncGenerator<HermesRunEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;

  try {
    while (true) {
      const { value, done } = await readSseChunk(reader, options);
      if (done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + delimiterLength(buffer, boundary));
        const event = parseSseEventBlock(block);
        if (event) {
          yield event;
        }
        boundary = findBoundary(buffer);
      }
      assertSseEventSize(buffer);
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      assertSseEventSize(buffer);
      const event = parseSseEventBlock(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: SseStreamOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutMs = options.idleTimeoutMs;
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return await reader.read();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readUntilActivity(reader),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          try {
            options.onIdle?.();
          } catch {
            // The timeout remains authoritative even if transport cleanup fails.
          }
          reject(new Error(options.idleTimeoutMessage ?? `SSE stream was idle for ${timeoutMs}ms.`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readUntilActivity(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  while (true) {
    const result = await reader.read();
    if (result.done || result.value.byteLength > 0) return result;
  }
}

function assertSseEventSize(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_SSE_EVENT_BYTES) {
    throw new Error(`Hermes SSE event exceeded the ${MAX_SSE_EVENT_BYTES}-byte safety limit.`);
  }
}

function findBoundary(value: string): number {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1) {
    return crlf;
  }
  if (crlf === -1) {
    return lf;
  }
  return Math.min(lf, crlf);
}

function delimiterLength(value: string, boundary: number): number {
  return value.startsWith("\r\n\r\n", boundary) ? 4 : 2;
}
