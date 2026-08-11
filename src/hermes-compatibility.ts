export const HERMES_COMPATIBILITY = {
  minimumVersion: "0.18.2",
  testedVersion: "0.20.0",
  testedReleaseTag: "v2026.8.3",
  testedImage: "nousresearch/hermes-agent:v2026.8.3@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e",
} as const;

export type HermesVersionStatus = "unsupported" | "supported" | "tested" | "newer" | "unknown";

export function parseHermesVersion(output: string): string | undefined {
  return /\bHermes(?:\s+Agent)?\s+v?(\d+\.\d+\.\d+)\b/iu.exec(output)?.[1];
}

export function classifyHermesVersion(version: string | undefined): HermesVersionStatus {
  const current = version ? parseSemanticVersion(version) : undefined;
  const minimum = parseSemanticVersion(HERMES_COMPATIBILITY.minimumVersion);
  const tested = parseSemanticVersion(HERMES_COMPATIBILITY.testedVersion);
  if (!current || !minimum || !tested) return "unknown";

  if (compareSemanticVersions(current, minimum) < 0) return "unsupported";
  const comparedWithTested = compareSemanticVersions(current, tested);
  if (comparedWithTested === 0) return "tested";
  if (comparedWithTested > 0) return "newer";
  return "supported";
}

type SemanticVersion = readonly [number, number, number];

function parseSemanticVersion(version: string): SemanticVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? [parts[0]!, parts[1]!, parts[2]!]
    : undefined;
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}
