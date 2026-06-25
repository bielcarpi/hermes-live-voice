export type ClientInboundFrame = string | Uint8Array;

export interface ClientConnectionPort {
  onMessage(handler: (data: ClientInboundFrame) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
  sendText(payload: string): void;
  close(code: number, reason: string): void;
}
