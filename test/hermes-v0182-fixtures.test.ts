import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hermesApprovalCompatibility } from "../src/application/live-gateway/hermes-approval-compatibility.js";
import type { HermesCapabilities } from "../src/application/live-gateway/ports/hermes-runs.port.js";

const fixtureRoot = new URL("./fixtures/hermes-agent-v0.18.2/", import.meta.url);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), "utf8")) as T;
}

describe("Hermes Agent v0.18.2 API fixtures", () => {
  it("records the exact official image provenance used for the compatibility contract", () => {
    expect(fixture<Record<string, unknown>>("provenance.json")).toMatchObject({
      source: "Live authenticated API capture from the official Hermes Agent Docker image",
      hermesVersion: "0.18.2",
      releaseTag: "v2026.7.7.2",
      reportedUpstreamCommit: "226e8de8",
      containerDigest: "sha256:465e3be53ac04f87c983697d8446d3dbdde47b489b51bb910c319731c3c78397",
    });
  });

  it("does not mistake generic FIFO approval support for targeted interactive approval", () => {
    const capabilities = fixture<HermesCapabilities>("capabilities.json");

    expect(capabilities.features).toMatchObject({
      run_submission: true,
      run_events_sse: true,
      run_stop: true,
      run_approval_response: true,
      approval_events: true,
    });
    expect(capabilities.features).not.toHaveProperty("run_approval_response_by_id");
    expect(hermesApprovalCompatibility(capabilities)).toEqual({
      uiSupported: true,
      interactive: false,
      fallback: "deny_all_then_stop",
      requiredFeature: "run_approval_response_by_id",
      negotiated: true,
    });
  });

  it("pins the missing approval identity in request and confirmation payloads", () => {
    const request = fixture<Record<string, unknown>>("approval-request.json");
    const response = fixture<Record<string, unknown>>("approval-response.json");
    const responded = fixture<Record<string, unknown>>("approval-responded-event.json");

    expect(request).toMatchObject({
      event: "approval.request",
      run_id: "run_fixture_v0182_approval",
      choices: ["once", "session", "always", "deny"],
    });
    expect(request).not.toHaveProperty("approval_id");
    expect(response).toEqual({
      object: "hermes.run.approval_response",
      run_id: "run_fixture_v0182_approval",
      choice: "deny",
      resolved: 1,
    });
    expect(response).not.toHaveProperty("approval_id");
    expect(responded).not.toHaveProperty("approval_id");
  });

  it("pins the strict stop confirmation returned by v0.18.2", () => {
    expect(fixture<Record<string, unknown>>("stop-response.json")).toEqual({
      run_id: "run_fixture_v0182_stop",
      status: "stopping",
    });
  });
});
