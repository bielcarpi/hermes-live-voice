import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStaticPath } from "../src/adapters/inbound/http/static.js";

describe("static file path resolution", () => {
  it("resolves root to index.html", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-live-static-"));
    writeFileSync(join(root, "index.html"), "ok");

    expect(resolveStaticPath(root, "/")).toBe(join(root, "index.html"));
  });

  it("rejects encoded path traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-live-static-"));

    expect(resolveStaticPath(root, "/..%2Fsecret.txt")).toBeNull();
  });

  it("rejects malformed encoded paths", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-live-static-"));

    expect(resolveStaticPath(root, "/%")).toBeNull();
  });
});
