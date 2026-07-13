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
    expect(source).toContain("audio.clearPlayback()");
  });

  it("keeps queued approvals read-only and permanent approval pattern-bound", () => {
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    expect(source).toContain("const isActionable = index === 0");
    expect(source).toContain("Hermes resolves approval requests in FIFO order.");
    expect(source).toContain("approval.allowPermanent === true && patternKeys.length > 0");
    expect(source).toContain("Permanent approval requires an inspectable permission pattern.");
  });

  it("replaces stale connected notices when the gateway socket closes", () => {
    const source = readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");

    expect(source).toContain("Live Voice connection was lost. Check the gateway and reconnect.");
    expect(source).toContain("Live Voice disconnected.");
  });
});
