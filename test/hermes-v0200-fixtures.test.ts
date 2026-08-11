import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hermesApprovalCompatibility } from "../src/application/live-gateway/hermes-approval-compatibility.js";
import type { HermesCapabilities } from "../src/application/live-gateway/ports/hermes-runs.port.js";
import { HERMES_COMPATIBILITY } from "../src/hermes-compatibility.js";

const fixtureRoot = new URL("./fixtures/hermes-agent-v0.20.0/", import.meta.url);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), "utf8")) as T;
}

describe("Hermes Agent v0.20.0 API fixtures", () => {
  it("records the official release and immutable image used for the contract", () => {
    const provenance = fixture<Record<string, unknown>>("provenance.json");
    expect(provenance).toMatchObject({
      source: "Live authenticated API capture from the official Hermes Agent Docker image",
      hermesVersion: "0.20.0",
      releaseTag: "v2026.8.3",
      releaseCommit: "3c27eb6234bf91b8ceee9e9071591b31e9b148cb",
      ociRevision: "3c27eb6234bf91b8ceee9e9071591b31e9b148cb",
      containerImage: "nousresearch/hermes-agent:v2026.8.3@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e",
    });
    expect(provenance.hermesVersion).toBe(HERMES_COMPATIBILITY.testedVersion);
    expect(provenance.releaseTag).toBe(HERMES_COMPATIBILITY.testedReleaseTag);
    expect(provenance.containerImage).toBe(HERMES_COMPATIBILITY.testedImage);
  });

  it("pins every Hermes capability required by live task supervision", () => {
    const capabilities = fixture<HermesCapabilities>("capabilities.json");
    expect(capabilities.features).toMatchObject({
      run_submission: true,
      run_status: true,
      run_events_sse: true,
      run_stop: true,
      run_approval_response: true,
      tool_progress_events: true,
      approval_events: true,
      session_resources: true,
      model_options: true,
      session_chat: true,
      session_chat_streaming: true,
      session_model_lock: true,
    });
    expect(capabilities.endpoints).toMatchObject({
      runs: { method: "POST", path: "/v1/runs" },
      run_events: { method: "GET", path: "/v1/runs/{run_id}/events" },
      run_stop: { method: "POST", path: "/v1/runs/{run_id}/stop" },
      session_chat: { method: "POST", path: "/api/sessions/{session_id}/chat" },
    });
  });

  it("keeps targeted approvals disabled until Hermes advertises identity support", () => {
    const capabilities = fixture<HermesCapabilities>("capabilities.json");
    expect(capabilities.features).not.toHaveProperty("run_approval_response_by_id");
    expect(hermesApprovalCompatibility(capabilities)).toMatchObject({
      uiSupported: false,
      interactive: false,
      fallback: "deny_all_then_stop",
      upstreamTargetedResponseAdvertised: false,
      negotiated: true,
    });
  });

  it("does not confuse the API bridge with Hermes native voice", () => {
    const capabilities = fixture<HermesCapabilities>("capabilities.json");
    expect(capabilities.features).toMatchObject({
      audio_api: false,
      realtime_voice: false,
    });
  });
});
