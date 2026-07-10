#!/usr/bin/env node
/**
 * Manual diagnostic script only — not wired into package.json, CI, or npm run verify.
 * Requires a live Hermes deployment with real Powerdot MCP tools configured.
 *
 * E2E flow validation: "Hi" → "Powerdot performance from yesterday by network"
 *
 * Connects to the REAL running gateway + Hermes stack using env vars from .env.
 * Does NOT mock anything — every message goes through the actual pipeline.
 *
 * Prerequisites:
 *   - Gateway running:  npm run start  (or npm run dev)
 *   - Hermes running with access to Powerdot data
 *   - .env loaded in shell (e.g. set -a && source .env && set +a)
 *
 * Usage:
 *   node scripts/e2e-powerdot-flow.mjs
 *   HERMES_LIVE_PROVIDER=openai node scripts/e2e-powerdot-flow.mjs
 *
 * What it validates:
 *   1. WebSocket connects to /v1/live
 *   2. session.start → session.ready (gateway + Hermes capabilities OK)
 *   3. text.input "Hi" → LLM responds (transcript.delta or run.* events)
 *   4. text.input "What was the Powerdot performance from yesterday by network?" →
 *      LLM calls start_hermes_run → run.started → streaming run.event → run.completed
 *   5. Hermes back-and-forth (tool.started / tool.completed events) is visible
 *   6. Final output contains meaningful data (not an error)
 *
 * Exit codes:
 *   0  — all assertions passed
 *   1  — assertion failed or timeout
 *   2  — connection/config error
 */

import WebSocket from "ws";

// ── Config from env ──────────────────────────────────────────────────────────

const GATEWAY_URL   = process.env.HERMES_LIVE_URL        ?? "ws://127.0.0.1:8788/v1/live";
const AUTH_TOKEN    = process.env.HERMES_LIVE_AUTH_TOKEN;
const PROFILE_ID    = process.env.E2E_PROFILE_ID         ?? "default";
const USER_LABEL    = process.env.E2E_USER_LABEL         ?? "e2e-test";

// How long to wait for each phase (ms)
const TIMEOUT_SESSION_READY = 20_000;
const TIMEOUT_HI_RESPONSE   = 30_000;
const TIMEOUT_RUN_STARTED   = 30_000;
const TIMEOUT_RUN_COMPLETED = 300_000; // Hermes may do many real MCP tool calls

// ── Utilities ────────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

function log(label, msg, color = RESET) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`${DIM}${ts}${RESET} ${color}${BOLD}[${label}]${RESET}${color} ${msg}${RESET}`);
}

function logMsg(direction, msg) {
  const type = msg?.type ?? "unknown";
  const color = direction === "→" ? CYAN : YELLOW;
  const summary = summarize(msg);
  console.log(
    `  ${color}${direction}${RESET} ${BOLD}${type}${RESET}${summary ? `  ${DIM}${summary}${RESET}` : ""}`,
  );
}

function summarize(msg) {
  if (!msg || typeof msg !== "object") return "";
  switch (msg.type) {
    case "session.start":    return `profile=${msg.profileId} user=${msg.userLabel}`;
    case "session.ready":    return `model=${msg.model} hermesModel=${msg.hermes?.model ?? "?"}`;
    case "text.input":       return `"${String(msg.text).slice(0, 80)}"`;
    case "transcript.delta": return `[${msg.speaker}] "${String(msg.text ?? "").slice(0, 60)}"`;
    case "run.started":      return `runId=${msg.runId}`;
    case "run.completed":    return `runId=${msg.runId} outputLen=${String(msg.output ?? "").length}`;
    case "run.failed":       return `runId=${msg.runId} error=${msg.error}`;
    case "run.event": {
      const ev = msg.event ?? {};
      if (ev.event === "tool.started")   return `tool=${ev.tool}`;
      if (ev.event === "tool.completed") return `tool=${ev.tool} duration=${ev.duration ?? "?"}ms err=${!!ev.error}`;
      if (ev.event === "message.delta")  return `delta="${String(ev.delta ?? "").slice(0, 40)}"`;
      if (ev.event === "run.completed")  return `outputLen=${String(ev.output ?? "").length}`;
      if (ev.event === "reasoning.available") return `reasoning="${String(ev.text ?? "").slice(0, 60)}"`;
      return `event=${ev.event}`;
    }
    case "session.error":    return `code=${msg.code} ${msg.message}`;
    case "log":              return `[${msg.level}] ${String(msg.message).slice(0, 80)}`;
    case "audio.output":     return `mimeType=${msg.mimeType} bytes=${msg.data?.length ?? 0}`;
    default:                 return "";
  }
}

function send(ws, msg) {
  logMsg("→", msg);
  ws.send(JSON.stringify(msg));
}

/**
 * Wait for the next message matching a predicate, with timeout.
 * Also collects and logs all messages seen while waiting.
 */
function waitFor(ws, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`));
    }, timeoutMs);

    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      logMsg("←", msg);
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };

    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`WebSocket closed (${code} ${reason.toString("utf8")}) while waiting for: ${label}`));
    };

    const onError = (err) => {
      cleanup();
      reject(new Error(`WebSocket error while waiting for ${label}: ${err.message}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

/**
 * Collect ALL messages until predicate matches a terminal one.
 * Returns { terminal, all } where terminal is the matching message.
 */
function collectUntil(ws, isTerminal, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const collected = [];

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms collecting until: ${label}\nCollected so far: ${collected.map(m => m.type).join(", ")}`));
    }, timeoutMs);

    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      logMsg("←", msg);
      collected.push(msg);
      if (isTerminal(msg)) {
        cleanup();
        resolve({ terminal: msg, all: collected });
      }
    };

    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`WebSocket closed (${code} ${reason.toString("utf8")}) while collecting until: ${label}`));
    };

    const onError = (err) => {
      cleanup();
      reject(new Error(`WebSocket error while collecting until ${label}: ${err.message}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

function assert(condition, message) {
  if (!condition) {
    log("FAIL", message, RED);
    process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("E2E", `Connecting to ${GATEWAY_URL}`, BOLD);
  log("E2E", `Provider: ${process.env.HERMES_LIVE_PROVIDER ?? "(not set, gateway default)"}`, DIM);
  log("E2E", `Auth: ${AUTH_TOKEN ? "token set" : "no token (allowUnauthenticated expected)"}`, DIM);

  // ── Connect ────────────────────────────────────────────────────────────────

  const wsUrl = GATEWAY_URL.startsWith("http")
    ? GATEWAY_URL.replace(/^http/, "ws")
    : GATEWAY_URL;

  const headers = {};
  if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;

  const ws = new WebSocket(wsUrl, { headers });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", (err) => reject(new Error(`Connection failed: ${err.message}\nGateway URL: ${wsUrl}`)));
    setTimeout(() => reject(new Error(`Connection timed out: ${wsUrl}`)), 10_000);
  });

  log("CONNECT", "WebSocket open", GREEN);

  const results = {
    sessionReady: null,
    hiResponse: null,
    runStarted: null,
    runEvents: [],
    toolsStarted: [],
    toolsCompleted: [],
    runCompleted: null,
    transcriptDeltas: [],
  };

  // ── Phase 1: session.start ─────────────────────────────────────────────────

  log("PHASE 1", "Starting session", BOLD);

  send(ws, {
    type: "session.start",
    profileId: PROFILE_ID,
    userLabel: USER_LABEL,
  });

  results.sessionReady = await waitFor(
    ws,
    (msg) => {
      if (msg.type === "session.error") throw new Error(`session.start failed: ${msg.code} — ${msg.message}`);
      return msg.type === "session.ready";
    },
    TIMEOUT_SESSION_READY,
    "session.ready",
  );

  log("PHASE 1", `✓ session.ready  model=${results.sessionReady.model}  hermesModel=${results.sessionReady.hermes?.model ?? "?"}`, GREEN);
  assert(results.sessionReady.type === "session.ready", "Expected session.ready");
  assert(results.sessionReady.sessionId, "session.ready must include sessionId");

  // ── Phase 2: "Hi" ──────────────────────────────────────────────────────────

  log("PHASE 2", 'Sending greeting: "Hi"', BOLD);

  send(ws, { type: "text.input", text: "Hi" });

  // Wait for the full "Hi" response to complete — must reach response.done before
  // sending Phase 3, otherwise the Powerdot query races with the still-active response
  // and the model processes both inputs together (treating the query as part of the greeting).
  const { terminal: hiTerminal, all: hiMessages } = await collectUntil(
    ws,
    (msg) => {
      if (msg.type === "session.error" && !msg.recoverable) {
        throw new Error(`Fatal session error after Hi: ${msg.code} — ${msg.message}`);
      }
      // Terminal: response fully done (run completed or realtime response.done)
      return (
        msg.type === "run.completed" ||
        (msg.type === "realtime.message" && msg.message?.type === "response.done")
      );
    },
    TIMEOUT_HI_RESPONSE,
    "response.done for Hi",
  );

  results.hiResponse = hiTerminal;
  results.transcriptDeltas = hiMessages.filter((m) => m.type === "transcript.delta");

  log("PHASE 2", `✓ Hi response complete: type=${hiTerminal.type}`, GREEN);
  if (results.transcriptDeltas.length > 0) {
    const greeting = results.transcriptDeltas.map((m) => m.text).join("");
    log("PHASE 2", `  Transcript: "${greeting.slice(0, 120)}"`, DIM);
  }

  // If a run started from "Hi", wait for it to complete before moving on
  if (hiTerminal.type === "run.started") {
    log("PHASE 2", "Hi triggered a Hermes run — waiting for completion before phase 3", YELLOW);
    await collectUntil(
      ws,
      (msg) => msg.type === "run.completed" || msg.type === "run.failed",
      TIMEOUT_RUN_COMPLETED,
      "run.completed after Hi",
    );
    log("PHASE 2", "Hi run completed", GREEN);
  }

  // ── Phase 3: Powerdot query ────────────────────────────────────────────────

  const POWERDOT_QUERY = "What was the Powerdot performance from yesterday by network?";
  log("PHASE 3", `Sending Powerdot query: "${POWERDOT_QUERY}"`, BOLD);

  send(ws, { type: "text.input", text: POWERDOT_QUERY });

  // Wait for run.started. The LLM may emit a short spoken announcement first
  // ("Let me pull the numbers.") before calling the tool — that's expected behavior.
  // Only fail if the response completes (response.done) without ever calling the tool.
  const { terminal: phase3Terminal, all: phase3Messages } = await collectUntil(
    ws,
    (msg) => {
      if (msg.type === "session.error" && !msg.recoverable) {
        throw new Error(`Fatal error after Powerdot query: ${msg.code} — ${msg.message}`);
      }
      if (msg.type === "run.failed") {
        throw new Error(`Run failed immediately: ${msg.error}`);
      }
      // Terminal: run.started (expected) OR response.done without a run (LLM answered directly)
      return (
        msg.type === "run.started" ||
        (msg.type === "realtime.message" && msg.message?.type === "response.done")
      );
    },
    TIMEOUT_RUN_STARTED,
    "run.started for Powerdot query",
  );

  // Diagnose: did LLM delegate or answer directly?
  if (phase3Terminal.type !== "run.started") {
    const directTranscript = phase3Messages
      .filter((m) => m.type === "transcript.delta")
      .map((m) => m.text)
      .join("");
    const audioChunks = phase3Messages.filter((m) => m.type === "audio.output").length;
    log("DIAGNOSIS", "⚠️  LLM answered directly instead of calling start_hermes_run", YELLOW);
    log("DIAGNOSIS", `   Audio chunks: ${audioChunks}`, YELLOW);
    log("DIAGNOSIS", `   Transcript: "${directTranscript.slice(0, 300)}"`, YELLOW);
    log("DIAGNOSIS", "   → LLM did NOT delegate to Hermes for this query.", YELLOW);
    log("DIAGNOSIS", "   → System prompt may need stronger delegation instructions.", YELLOW);
    log("DIAGNOSIS", "   → Or the model chose to answer from its own knowledge.", YELLOW);
    process.exit(1);
  }

  results.runStarted = phase3Terminal;

  assert(results.runStarted.runId, "run.started must include runId");
  log("PHASE 3", `✓ run.started  runId=${results.runStarted.runId}`, GREEN);

  // ── Phase 4: Stream Hermes events until run.completed ─────────────────────

  log("PHASE 4", "Streaming Hermes run events…", BOLD);

  const { terminal: runCompleted, all: runMessages } = await collectUntil(
    ws,
    (msg) => {
      if (msg.type === "run.failed") {
        throw new Error(`Hermes run failed: ${msg.error}`);
      }
      if (msg.type === "session.error" && !msg.recoverable) {
        throw new Error(`Fatal session error during run: ${msg.code} — ${msg.message}`);
      }
      if (msg.type === "run.event") {
        const ev = msg.event ?? {};
        if (ev.event === "tool.started")   results.toolsStarted.push(ev.tool);
        if (ev.event === "tool.completed") results.toolsCompleted.push(ev.tool);
        results.runEvents.push(ev);
      }
      return msg.type === "run.completed";
    },
    TIMEOUT_RUN_COMPLETED,
    "run.completed for Powerdot query",
  );

  results.runCompleted = runCompleted;

  // ── Assertions & Summary ───────────────────────────────────────────────────

  log("ASSERTIONS", "Validating results…", BOLD);

  assert(results.runCompleted.type === "run.completed", "Expected run.completed");
  assert(results.runCompleted.runId === results.runStarted.runId, "run.completed runId must match run.started runId");

  const output = results.runCompleted.output ?? "";
  assert(typeof output === "string" && output.length > 0, "run.completed output must be non-empty");
  assert(!output.toLowerCase().includes("error"), `Output should not contain 'error': "${output.slice(0, 200)}"`);

  assert(results.toolsStarted.length > 0, "Expected at least one tool.started event — Hermes must have used tools to fetch Powerdot data");

  log("RESULTS", "─────────────────────────────────────────────", BOLD);
  log("RESULTS", `Session ID:      ${results.sessionReady.sessionId}`, GREEN);
  log("RESULTS", `Run ID:          ${results.runStarted.runId}`, GREEN);
  log("RESULTS", `Tools started:   ${results.toolsStarted.join(", ") || "(none)"}`, results.toolsStarted.length > 0 ? GREEN : YELLOW);
  log("RESULTS", `Tools completed: ${results.toolsCompleted.join(", ") || "(none)"}`, GREEN);
  log("RESULTS", `Run events:      ${results.runEvents.length}`, GREEN);
  log("RESULTS", `Output length:   ${output.length} chars`, GREEN);
  log("RESULTS", "", RESET);
  log("RESULTS", "── Hermes output ──────────────────────────────", BOLD);
  // Print full output, wrapped at 100 chars
  const lines = output.match(/.{1,100}/g) ?? [output];
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  log("RESULTS", "───────────────────────────────────────────────", BOLD);

  // ── Close cleanly ──────────────────────────────────────────────────────────

  ws.close(1000, "e2e test complete");
  await new Promise((resolve) => ws.once("close", resolve));

  log("E2E", "✓ All assertions passed", GREEN);
  process.exit(0);
}

main().catch((err) => {
  log("E2E", `✗ ${err.message}`, RED);
  if (process.env.DEBUG) console.error(err);
  process.exit(err.message.startsWith("Connection") ? 2 : 1);
});
