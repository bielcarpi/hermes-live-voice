import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildLocalConversationResponse } from "../src/adapters/outbound/realtime/huggingface-local-routing.js";

it("delivers real gateway answer payloads through the managed Python speech patch", () => {
  const responses = [
    { ok: true, message: "The weather is clear." },
    { ok: true, message: "**The check passed.**\n\n- The gateway is ready." },
    { ok: true, message: "长沙今天晴，气温二十八度。" },
    { ok: true, message: "长沙天气：\n**晴天**，28°C。\n[来源](https://example.com/weather)" },
    { ok: true, message: "a".repeat(500) },
    { ok: true, message: "a".repeat(501) },
    { ok: true, message: "Long result. ".repeat(500) },
    { ok: true, message: "Run `npm test` to verify the fix." },
    { ok: true, message: "" },
    { ok: false, error: "Hermes request timed out." },
  ].map(buildLocalConversationResponse);
  const result = spawnSync("python3", [
    fileURLToPath(new URL("../scripts/local-runtime-contract-smoke.py", import.meta.url)),
    "--conversation-responses",
  ], { input: JSON.stringify(responses), encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
