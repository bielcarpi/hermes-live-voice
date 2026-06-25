import type WebSocket from "ws";
import type { ClientConnectionPort, ClientInboundFrame } from "../../../application/live-gateway/ports/client-connection.port.js";

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
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(payload);
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
