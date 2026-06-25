import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(root, "..", "src");

describe("architecture boundaries", () => {
  it("keeps domain free of application and adapter imports", () => {
    for (const file of sourceFiles("domain")) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*application\//);
      expect(source, file).not.toMatch(/from\s+["'][^"']*adapters\//);
    }
  });

  it("keeps application code behind ports instead of transport/provider adapters", () => {
    for (const file of sourceFiles("application")) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["']ws["']/);
      expect(source, file).not.toMatch(/from\s+["'][^"']*adapters\//);
    }
  });

  it("keeps live session on the client connection port", () => {
    const source = readFileSync(join(srcRoot, "application", "live-gateway", "live-gateway-session.ts"), "utf8");
    expect(source).toContain("ClientConnectionPort");
    expect(source).not.toContain("WebSocket");
  });
});

function sourceFiles(relativeDir: string): string[] {
  const dir = join(srcRoot, relativeDir);
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(join(relativeDir, entry)));
    } else if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}
