import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const dashboardUrl = new URL("../plugins/hermes-live/dashboard/", import.meta.url);

describe("Hermes Dashboard plugin", () => {
  it("registers the Live Voice tab synchronously as a dependency-free IIFE", () => {
    const register = vi.fn();
    const window = {
      __HERMES_PLUGINS__: { register },
      location: { href: "http://127.0.0.1:9119/live-voice" },
    };
    const document = {
      baseURI: "http://127.0.0.1:9119/",
      currentScript: {
        src: "http://127.0.0.1:9119/api/dashboard-plugins/hermes-live/dist/index.js",
      },
      querySelector: vi.fn(),
    };
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    vm.runInNewContext(source, { document, URL, window }, {
      filename: "plugins/hermes-live/dashboard/dist/index.js",
    });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("hermes-live", expect.any(Function));
  });

  it("declares an official Dashboard tab, assets, and backend with package-version parity", () => {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", dashboardUrl), "utf8"));
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(manifest).toMatchObject({
      name: "hermes-live",
      label: "Live Voice",
      icon: "Zap",
      version: packageJson.version,
      tab: { path: "/live-voice", position: "after:chat" },
      entry: "dist/index.js",
      css: "dist/style.css",
      api: "plugin_api.py",
    });
  });

  it("uses only host-authenticated dashboard APIs and contains no static secret hooks", () => {
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    expect(source).toContain("SDK.buildWsUrl(LIVE_ENDPOINT)");
    expect(source).toContain("SDK.fetchJSON(STATUS_ENDPOINT)");
    expect(source).not.toContain("__HERMES_SESSION_TOKEN__");
    expect(source).not.toContain("HERMES_LIVE_AUTH_TOKEN");
    expect(source).not.toContain("OPENAI_API_KEY");
    expect(source).not.toContain("GEMINI_API_KEY");
  });

  it("keeps interrupting speech distinct from stopping a Hermes task", () => {
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    expect(source).toContain('audio.interrupt("interrupted from Hermes Dashboard")');
    expect(source).toContain('client.stopRun("stopped from Hermes Dashboard")');
    expect(source).toContain("Interrupt speech");
    expect(source).toContain("Stop Hermes task");
    expect(source).toContain('audio.interrupt("provider detected user speech")');
    expect(source).toContain('audio.interrupt("new Dashboard text input")');
    expect(source).toContain("audio.clearPlayback()");
    expect(source).toContain("audio.primePlayback()");
    expect(source).toContain("primePlaybackFromGesture();");
  });

  it("keeps queued approvals read-only and permanent approval pattern-bound", () => {
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    expect(source).toContain("run_approval_response_by_id === true");
    expect(source).toContain("Approval controls are unavailable with this Hermes version.");
    expect(source).toContain("const pendingApprovals = approvalResponsesSupported &&");
    expect(source).toContain("const isActionable = index === 0");
    expect(source).toContain("Hermes resolves approval requests in FIFO order.");
    expect(source).toContain("approval.allowPermanent === true && patternKeys.length > 0");
    expect(source).toContain("Permanent approval requires an inspectable permission pattern.");
  });

  it("announces approval arrivals and moves focus to the actionable decision", () => {
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    expect(source).toContain('"aria-live": "assertive"');
    expect(source).toContain('"aria-labelledby": titleId');
    expect(source).toContain("autoFocus: isActionable && choiceIndex === 0");
    expect(source).toContain("autoFocus: true");
  });

  it("attempts protocol disconnect even when microphone cleanup fails", async () => {
    const utilities = loadDashboardUtilities();
    const audio = { stopMicrophone: vi.fn(async () => { throw new Error("capture cleanup failed"); }) };
    const client = { disconnect: vi.fn(async () => undefined) };
    const onAudioError = vi.fn();

    await expect(utilities.disconnectSession(audio, client, onAudioError)).resolves.toBeUndefined();
    expect(audio.stopMicrophone).toHaveBeenCalledWith({ endTurn: false });
    expect(client.disconnect).toHaveBeenCalledWith("user disconnected from dashboard");
    await vi.waitFor(() => expect(onAudioError).toHaveBeenCalledWith(expect.objectContaining({
      message: "capture cleanup failed",
    })));
  });

  it("does not wait for stalled microphone cleanup after protocol disconnect", async () => {
    const utilities = loadDashboardUtilities();
    const audio = { stopMicrophone: vi.fn(async () => await new Promise(() => undefined)) };
    const client = { disconnect: vi.fn(async () => undefined) };

    await expect(utilities.disconnectSession(audio, client)).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves a fatal session error when the socket subsequently closes", () => {
    const utilities = loadDashboardUtilities();
    const fatal = { tone: "danger", text: "Verify the active Hermes task in the Dashboard." };

    expect(utilities.connectionClosedNotice({ clean: true }, fatal)).toMatchObject(fatal);
    expect(utilities.connectionClosedNotice({ clean: false }, null)).toMatchObject({
      tone: "warning",
      text: "Live Voice connection was lost. Check the gateway and reconnect.",
    });
  });

  it("gates approval controls on targeted-response support and explains fail-closed mode", () => {
    const utilities = loadDashboardUtilities();
    const unsupported = { hermes: { capabilities: {} } };
    const supported = { hermes: { capabilities: { run_approval_response_by_id: true } } };

    expect(utilities.supportsTargetedApprovalResponses(unsupported)).toBe(false);
    expect(utilities.approvalSupportPresentation(unsupported)).toMatchObject({ value: "Fail closed" });
    expect(utilities.supportsTargetedApprovalResponses(supported)).toBe(true);
    expect(utilities.approvalSupportPresentation(supported)).toMatchObject({ value: "Available" });
  });

  it("gives explicit push-to-talk guidance when provider turn detection is disabled", () => {
    const utilities = loadDashboardUtilities();

    expect(utilities.microphoneActiveGuidance("disabled")).toContain("stop the microphone to submit");
    expect(utilities.microphoneActiveGuidance("semantic_vad")).toContain("Speak naturally");
  });

  it("replaces stale connected notices when the gateway socket closes", () => {
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    expect(source).toContain("Live Voice connection was lost. Check the gateway and reconnect.");
    expect(source).toContain("Live Voice disconnected.");
  });
});

function loadDashboardUtilities(): Record<string, (...args: any[]) => any> {
  const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8").replace(
    "  function LiveVoicePage() {",
    `  window.__HERMES_LIVE_TEST_UTILITIES__ = {
      approvalSupportPresentation,
      connectionClosedNotice,
      disconnectSession,
      microphoneActiveGuidance,
      supportsTargetedApprovalResponses,
    };

  function LiveVoicePage() {`,
  );
  const window: Record<string, any> = {
    location: { href: "http://127.0.0.1:9119/live-voice" },
  };
  const document = {
    baseURI: "http://127.0.0.1:9119/",
    currentScript: {
      src: "http://127.0.0.1:9119/api/dashboard-plugins/hermes-live/dist/index.js",
    },
    querySelector: vi.fn(),
  };

  vm.runInNewContext(source, { document, Error, Promise, URL, window }, {
    filename: "plugins/hermes-live/dashboard/dist/index.js",
  });

  return window.__HERMES_LIVE_TEST_UTILITIES__;
}
