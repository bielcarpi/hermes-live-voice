export const HERMES_LIVE_PROTOCOL_VERSION = 4 as const;
export const HERMES_LIVE_SUPPORTED_PROTOCOL_VERSIONS = [3, 4] as const;

export type HermesLiveProtocolVersion = (typeof HERMES_LIVE_SUPPORTED_PROTOCOL_VERSIONS)[number];

export const HERMES_LIVE_PROTOCOL_ERROR_CODE = "unsupported_protocol_version" as const;

export function isHermesLiveProtocolVersion(value: unknown): value is HermesLiveProtocolVersion {
  return value === 3 || value === 4;
}

export function incompatibleProtocolVersionMessage(value: unknown): string {
  const received = typeof value === "number" && Number.isInteger(value) ? `v${value}` : "an invalid version";
  return (
    `Hermes Live protocol ${received} is incompatible with supported protocols ` +
    `${HERMES_LIVE_SUPPORTED_PROTOCOL_VERSIONS.map((version) => `v${version}`).join(", ")}. ` +
    "Upgrade hermes-live-voice before reconnecting."
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
  readonly supported = HERMES_LIVE_SUPPORTED_PROTOCOL_VERSIONS;
  readonly received: unknown;

  constructor(received: unknown) {
    super(incompatibleProtocolVersionMessage(received));
    this.name = "UnsupportedHermesLiveProtocolVersionError";
    this.received = received;
  }
}
