export const HERMES_LIVE_PROTOCOL_VERSION = 3 as const;

export type HermesLiveProtocolVersion = typeof HERMES_LIVE_PROTOCOL_VERSION;

export const HERMES_LIVE_PROTOCOL_ERROR_CODE = "unsupported_protocol_version" as const;

export function isHermesLiveProtocolVersion(value: unknown): value is HermesLiveProtocolVersion {
  return value === HERMES_LIVE_PROTOCOL_VERSION;
}

export function incompatibleProtocolVersionMessage(value: unknown): string {
  const received = typeof value === "number" && Number.isInteger(value) ? `v${value}` : "an invalid version";
  return (
    `Hermes Live protocol ${received} is incompatible with protocol v${HERMES_LIVE_PROTOCOL_VERSION}. ` +
    "Upgrade hermes-live-voice and every connected client to the same release before reconnecting."
  );
}

export function assertHermesLiveProtocolVersion(value: unknown): asserts value is HermesLiveProtocolVersion {
  if (!isHermesLiveProtocolVersion(value)) {
    throw new UnsupportedHermesLiveProtocolVersionError(value);
  }
}

export class UnsupportedHermesLiveProtocolVersionError extends Error {
  readonly code = HERMES_LIVE_PROTOCOL_ERROR_CODE;
  readonly expected = HERMES_LIVE_PROTOCOL_VERSION;
  readonly received: unknown;

  constructor(received: unknown) {
    super(incompatibleProtocolVersionMessage(received));
    this.name = "UnsupportedHermesLiveProtocolVersionError";
    this.received = received;
  }
}
