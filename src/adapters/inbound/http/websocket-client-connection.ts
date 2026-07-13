import type WebSocket from "ws";
import type { ClientConnectionPort, ClientInboundFrame } from "../../../application/live-gateway/ports/client-connection.port.js";

// Keep enough headroom for multiple default-sized audio frames, but never let a
// stalled client turn provider output into an unbounded process-level buffer.
export const MAX_CLIENT_BUFFERED_BYTES = 8 * 1024 * 1024;

export class WebSocketClientConnection implements ClientConnectionPort {
  constructor(private readonly socket: WebSocket) {}

  onMessage(handler: (data: ClientInboundFrame) => void): void {
    this.socket.on("message", (data) => handler(normalizeWebSocketFrame(data)));
  }

  onClose(handler: () => void): void {
    this.socket.on("close", handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.socket.on("error", handler);
  }

  sendText(payload: string): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }

    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (this.socket.bufferedAmount + payloadBytes > MAX_CLIENT_BUFFERED_BYTES) {
      this.socket.terminate();
      return;
    }

    try {
      this.socket.send(payload);
    } catch {
      // The socket can leave OPEN between the readyState check and send(). A
      // hard close is safe here and ensures the session observes termination.
      this.socket.terminate();
    }
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.close(code, reason);
    } else if (this.socket.readyState === this.socket.CONNECTING) {
      this.socket.once("open", () => this.socket.close(code, reason));
    }
  }
}

function normalizeWebSocketFrame(data: WebSocket.RawData): ClientInboundFrame {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return Buffer.concat(data);
}
