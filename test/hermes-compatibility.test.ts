import { describe, expect, it } from "vitest";
import {
  classifyHermesVersion,
  HERMES_COMPATIBILITY,
  parseHermesVersion,
} from "../src/hermes-compatibility.js";

describe("Hermes version compatibility", () => {
  it("parses current and legacy Hermes version output", () => {
    expect(parseHermesVersion("Hermes Agent v0.20.0 (2026.8.3)"))
      .toBe(HERMES_COMPATIBILITY.testedVersion);
    expect(parseHermesVersion("Hermes v0.18.2"))
      .toBe(HERMES_COMPATIBILITY.minimumVersion);
    expect(parseHermesVersion("Hermes development build")).toBeUndefined();
  });

  it("classifies the supported version range", () => {
    expect(classifyHermesVersion("0.18.1")).toBe("unsupported");
    expect(classifyHermesVersion("0.18.2")).toBe("supported");
    expect(classifyHermesVersion("0.19.1")).toBe("supported");
    expect(classifyHermesVersion("0.20.0")).toBe("tested");
    expect(classifyHermesVersion("0.21.0")).toBe("newer");
    expect(classifyHermesVersion("main")).toBe("unknown");
  });
});
