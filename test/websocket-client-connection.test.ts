import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
  MAX_CLIENT_BUFFERED_BYTES,
  WebSocketClientConnection,
} from "../src/adapters/inbound/http/websocket-client-connection.js";

describe("WebSocketClientConnection", () => {
  it("sends while the payload fits within the outbound buffer cap", () => {
    const socket = fakeSocket({ bufferedAmount: MAX_CLIENT_BUFFERED_BYTES - 5 });
    const connection = new WebSocketClientConnection(socket as unknown as WebSocket);

    connection.sendText("hello");

    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledWith("hello");
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("terminates a slow client before queuing data beyond the outbound buffer cap", () => {
    const socket = fakeSocket({ bufferedAmount: MAX_CLIENT_BUFFERED_BYTES - 4 });
    const connection = new WebSocketClientConnection(socket as unknown as WebSocket);

    connection.sendText("hello");

    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("measures UTF-8 bytes rather than JavaScript string length", () => {
    const socket = fakeSocket({ bufferedAmount: MAX_CLIENT_BUFFERED_BYTES - 3 });
    const connection = new WebSocketClientConnection(socket as unknown as WebSocket);

    connection.sendText("🙂");

    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the socket if send races with a close", () => {
    const socket = fakeSocket();
    socket.send.mockImplementationOnce(() => {
      throw new Error("WebSocket is not open");
    });
    const connection = new WebSocketClientConnection(socket as unknown as WebSocket);

    expect(() => connection.sendText("hello")).not.toThrow();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("does not send or terminate a socket that is already closing", () => {
    const socket = fakeSocket({ readyState: 2 });
    const connection = new WebSocketClientConnection(socket as unknown as WebSocket);

    connection.sendText("hello");

    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
  });
});

function fakeSocket({
  bufferedAmount = 0,
  readyState = 1,
}: {
  bufferedAmount?: number;
  readyState?: number;
} = {}) {
  return {
    OPEN: 1,
    CONNECTING: 0,
    bufferedAmount,
    readyState,
    send: vi.fn(),
    terminate: vi.fn(),
  };
}
