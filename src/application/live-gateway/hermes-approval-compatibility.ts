import type { HermesCapabilities, HermesRunsPort } from "./ports/hermes-runs.port.js";

export const HERMES_TARGETED_APPROVAL_FEATURE = "run_approval_response_by_id" as const;

export interface HermesApprovalCompatibility {
  uiSupported: true;
  interactive: boolean;
  fallback: "deny_all_then_stop";
  requiredFeature: typeof HERMES_TARGETED_APPROVAL_FEATURE;
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

function approvalCompatibility(interactive: boolean, negotiated: boolean): HermesApprovalCompatibility {
  return {
    uiSupported: true,
    interactive,
    fallback: "deny_all_then_stop",
    requiredFeature: HERMES_TARGETED_APPROVAL_FEATURE,
    negotiated,
  };
}
