import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function checkZodConsumers({ tarball, workDir, cacheDir }) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const compiler = resolve("node_modules/typescript/bin/tsc");
  const env = { ...process.env, npm_config_cache: cacheDir, NPM_CONFIG_CACHE: cacheDir };
  for (const [version, importPath] of [["3.25.76", "zod"], ["4.6.6", "zod/v3"]]) {
    const consumer = join(workDir, `zod-consumer-${version}`);
    mkdirSync(consumer, { recursive: true });
    checked(npm, [
      "install", "--prefix", consumer, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
      tarball, `zod@${version}`,
    ], { env });

    const fixture = join(consumer, "consumer.mts");
    writeFileSync(fixture, `
import { z } from ${JSON.stringify(importPath)};
import { ClientMessageSchema, ServerMessageSchema, type ClientMessage } from "hermes-live-voice";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// Existing consumers can compose our exported schemas with their own Zod,
// infer message types, and recognize validation errors without a second copy.
const clientSchema: z.ZodTypeAny = ClientMessageSchema;
const serverSchema: z.ZodTypeAny = ServerMessageSchema;
assert(clientSchema instanceof z.ZodType, "Client schema uses a different Zod instance");
assert(serverSchema instanceof z.ZodType, "Server schema uses a different Zod instance");
const message: ClientMessage = { type: "text.input", text: "hello" };
const envelope = z.object({ message: ClientMessageSchema }).parse({ message });
assert(envelope.message.type === "text.input", "Composed client schema failed");
const invalid = ClientMessageSchema.safeParse({ type: "text.input", text: "" });
assert(!invalid.success, "Empty text must fail validation");
const error: z.ZodError = invalid.error;
assert(error instanceof z.ZodError, "Error does not match the consumer's ZodError");
assert(error.errors.length > 0 && error.flatten().fieldErrors.text?.length, "Zod 3 error API changed");
const log = ServerMessageSchema.parse({
  type: "log", level: "info", message: "ready", data: { status: "ok", nested: { value: null } },
});
assert(log.type === "log" && log.data?.status === "ok", "Public metadata validation failed");
`);
    checked(process.execPath, [
      compiler, "--ignoreConfig", "--strict", "--skipLibCheck", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--target", "ES2022", "--outDir", join(consumer, "compiled"), fixture,
    ], { env });
    checked(process.execPath, [join(consumer, "compiled", "consumer.mjs")], { env });
  }
  console.log("Packed schema consumer smoke ok: Zod 3 and Zod 4 package installs preserve v1 types, composition, and error identity.");
}

function checked(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Zod consumer check failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  }
}
