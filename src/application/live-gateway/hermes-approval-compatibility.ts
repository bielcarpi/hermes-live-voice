import type { HermesCapabilities, HermesRunsPort } from "./ports/hermes-runs.port.js";

export const HERMES_TARGETED_APPROVAL_FEATURE = "run_approval_response_by_id" as const;

export interface HermesApprovalCompatibility {
  uiSupported: false;
  interactive: false;
  fallback: "deny_all_then_stop";
  requiredFeature: typeof HERMES_TARGETED_APPROVAL_FEATURE;
  upstreamTargetedResponseAdvertised: boolean;
  negotiated: boolean;
}

export function hermesApprovalCompatibility(
  capabilities: Pick<HermesCapabilities, "features">,
): HermesApprovalCompatibility {
  return approvalCompatibility(capabilities.features?.[HERMES_TARGETED_APPROVAL_FEATURE] === true, true);
}

export function unnegotiatedHermesApprovalCompatibility(): HermesApprovalCompatibility {
  return approvalCompatibility(false, false);
}

export async function negotiateHermesApprovalCompatibility(
  hermes: Pick<HermesRunsPort, "capabilities">,
): Promise<HermesApprovalCompatibility> {
  try {
    return hermesApprovalCompatibility(await hermes.capabilities());
  } catch {
    return unnegotiatedHermesApprovalCompatibility();
  }
}

function approvalCompatibility(upstreamTargetingAdvertised: boolean, negotiated: boolean): HermesApprovalCompatibility {
  return {
    // Protocol v3 deliberately does not expose an approval UI until Hermes can
    // prove stable approval identity across both events and targeted mutation.
    // A capability bit alone is not sufficient proof at this boundary.
    uiSupported: false,
    interactive: false,
    fallback: "deny_all_then_stop",
    requiredFeature: HERMES_TARGETED_APPROVAL_FEATURE,
    upstreamTargetedResponseAdvertised: upstreamTargetingAdvertised,
    negotiated,
  };
}
