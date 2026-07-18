import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const [bin, workDir, expectedVersion] = process.argv.slice(2);
if (!bin || !workDir || !expectedVersion) {
  throw new Error("Usage: packed-activation-smoke.mjs <bin> <work-dir> <version>");
}

const home = join(workDir, "activation-home");
const pluginsDir = join(home, ".hermes", "plugins");
const hermesCommand = join(home, "bin", "hermes");
const privateKey = "packed-activation-private-key";
await mkdir(join(home, ".hermes"), { recursive: true, mode: 0o700 });
await mkdir(dirname(hermesCommand), { recursive: true, mode: 0o700 });
await writeFile(join(home, ".hermes", ".env"), `API_SERVER_KEY=${privateKey}\n`, { mode: 0o600 });
await writeFile(hermesCommand, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
await chmod(hermesCommand, 0o700);

const hermes = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/capabilities") {
    response.end(JSON.stringify({
      model: "hermes-agent",
      features: {
        run_submission: true,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
      },
    }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
await new Promise((resolveListen) => hermes.listen(0, "127.0.0.1", resolveListen));
const address = hermes.address();
if (!address || typeof address === "string") throw new Error("Packed activation Hermes server did not bind TCP.");
const gatewayPort = await availablePort();

const env = {
  HOME: home,
  PATH: `${dirname(process.execPath)}:${dirname(hermesCommand)}:${process.env.PATH ?? ""}`,
  HERMES_LIVE_PORT: String(gatewayPort),
};
let gateway;
let gatewayStdout = "";
let gatewayStderr = "";
try {
  const setup = await run(bin, [
    "setup",
    "--provider", "mock",
    "--hermes-url", `http://127.0.0.1:${address.port}`,
    "--plugins-dir", pluginsDir,
    "--hermes-command", hermesCommand,
    "--no-service",
    "--non-interactive",
    "--json",
  ], env);
  if (setup.code !== 0) throw new Error(`Packed setup failed.\n${setup.stdout}\n${setup.stderr}`);
  const report = JSON.parse(setup.stdout);
  if (!report.ok || !report.plugin?.manifestFound || !report.hermesCli?.enabled || !report.readiness?.ok) {
    throw new Error(`Packed setup returned an invalid report.\n${setup.stdout}`);
  }
  if (setup.stdout.includes(privateKey) || setup.stderr.includes(privateKey)) {
    throw new Error("Packed setup exposed the imported Hermes key.");
  }

  const configPath = join(home, ".hermes", "hermes-live", "config.env");
  const config = await readFile(configPath, "utf8");
  if (!config.includes("HERMES_AGENT_API_SERVER_KEY") || !config.includes("HERMES_LIVE_PROVIDER=\"mock\"")) {
    throw new Error("Packed setup did not write the expected managed settings.");
  }
  if (process.platform !== "win32") {
    if (((await stat(configPath)).mode & 0o777) !== 0o600) throw new Error("Packed setup config is not 0600.");
    if (((await stat(dirname(configPath))).mode & 0o777) !== 0o700) throw new Error("Packed setup directory is not 0700.");
  }
  const pluginManifest = await readFile(join(pluginsDir, "hermes-live", "plugin.yaml"), "utf8");
  if (!pluginManifest.includes(`version: ${expectedVersion}`)) {
    throw new Error("Packed setup installed a plugin with the wrong version.");
  }

  gateway = spawn(bin, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", (chunk) => { gatewayStdout += chunk; });
  gateway.stderr.on("data", (chunk) => { gatewayStderr += chunk; });
  const readyUrl = `http://127.0.0.1:${gatewayPort}/ready`;
  try {
    await waitForReady(readyUrl, 15_000);
  } catch (error) {
    throw new Error(`${error.message}\nGateway stdout:\n${gatewayStdout}\nGateway stderr:\n${gatewayStderr}`);
  }
  const doctor = await run(bin, [
    "doctor",
    "--json",
    "--plugins-dir", pluginsDir,
    "--hermes-command", hermesCommand,
  ], env);
  if (doctor.code !== 0) throw new Error(`Packed doctor failed.\n${doctor.stdout}\n${doctor.stderr}`);
  const doctorReport = JSON.parse(doctor.stdout);
  if (!doctorReport.ok || doctorReport.checks?.find((check) => check.id === "gateway")?.status !== "pass") {
    throw new Error(`Packed doctor did not verify the running gateway.\n${doctor.stdout}`);
  }
  if (doctor.stdout.includes(privateKey) || doctor.stderr.includes(privateKey)) {
    throw new Error("Packed doctor exposed the imported Hermes key.");
  }
} finally {
  gateway?.kill("SIGTERM");
  if (gateway) await new Promise((resolveClose) => gateway.once("close", resolveClose));
  await new Promise((resolveClose, reject) => hermes.close((error) => error ? reject(error) : resolveClose()));
}

console.log("Packed activation smoke ok: setup, managed config, plugin, gateway, and doctor verified.");

async function run(command, args, commandEnv) {
  return await new Promise((resolveRun) => {
    const child = spawn(command, args, { env: commandEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "No response.";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      lastDetail = `HTTP ${response.status}: ${body.slice(0, 2_000)}`;
      const parsed = JSON.parse(body);
      if (response.ok && (parsed.ok === true || parsed.status === "ready")) return;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Packed gateway did not become ready. Last probe: ${lastDetail}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a gateway smoke port.");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}
