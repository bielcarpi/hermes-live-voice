import type { HermesRunEvent } from "../protocol.js";

export function parseSseEventBlock(block: string): HermesRunEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
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
    return JSON.parse(payload) as HermesRunEvent;
  } catch {
    return { event: "hermes.raw", data: payload };
  }
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<HermesRunEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
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
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseEventBlock(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
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
