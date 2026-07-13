import type { Readable, Writable } from "node:stream";
import { clearLine, createInterface, cursorTo } from "node:readline";
import WebSocket from "ws";
import type { ApprovalChoice } from "../domain/protocol/client-protocol.js";
import { ApprovalChoiceSchema } from "../domain/protocol/client-protocol.js";
import { HERMES_LIVE_PROTOCOL_VERSION } from "../domain/protocol/version.js";
import { sanitizeOneShotApproval } from "./one-shot-approval.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_SERVER_MESSAGE_BYTES = 8_000_000;
const MAX_TERMINAL_TEXT_CHARS = 20_000;
const MAX_RENDERED_TEXT_CHARS = 20_000;
const MAX_PENDING_APPROVALS = 128;

export interface TerminalGatewaySessionOptions {
  url: string;
  authToken?: string;
  userLabel?: string;
  connectTimeoutMs?: number;
  onLine?: (line: string) => void;
}

export interface InteractiveTerminalOptions extends TerminalGatewaySessionOptions {
  input?: Readable;
  output?: Writable;
}

export interface PendingTerminalApproval {
  runId: string;
  approvalId: string;
  command?: string;
  description?: string;
  patternKeys: string[];
  choices: ApprovalChoice[];
  allowPermanent: boolean;
}

export interface TerminalGatewaySnapshot {
  connected: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  responseActive: boolean;
  activeRunId?: string;
  pendingApproval?: PendingTerminalApproval;
  pendingApprovals: PendingTerminalApproval[];
}

export interface TerminalCommandResult {
  closeRequested: boolean;
}

/**
 * A small Node client for controlling an already-running Hermes Live gateway.
 * It deliberately does not capture or play audio: local microphone users should
 * use Hermes Voice Mode, while browser/dashboard clients own gateway audio I/O.
 */
export class TerminalGatewaySession {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly userLabel: string;
  private readonly connectTimeoutMs: number;
  private readonly onLine: (line: string) => void;
  private socket?: WebSocket;
  private ready = false;
  private intentionalClose = false;
  private requestSequence = 0;
  private sessionId?: string;
  private provider?: string;
  private model?: string;
  private responseActive = false;
  private assistantTranscript = "";
  private responseHadAudio = false;
  private activeRunId?: string;
  private pendingApprovals: PendingTerminalApproval[] = [];
  private permanentApprovalArmedFor?: string;
  private resolveClosed!: () => void;
  private closedResolved = false;
  readonly closed: Promise<void>;

  constructor(options: TerminalGatewaySessionOptions) {
    this.url = normalizeGatewayWebSocketUrl(options.url);
    this.authToken = options.authToken;
    this.userLabel = sanitizeMetadata(options.userLabel ?? process.env.USER ?? "terminal");
    this.connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.onLine = options.onLine ?? ((line) => process.stdout.write(`${line}\n`));
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get snapshot(): TerminalGatewaySnapshot {
    return {
      connected: this.ready,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.model ? { model: this.model } : {}),
      responseActive: this.responseActive,
      ...(this.activeRunId ? { activeRunId: this.activeRunId } : {}),
      ...(this.pendingApprovals[0] ? { pendingApproval: clonePendingApproval(this.pendingApprovals[0]) } : {}),
      pendingApprovals: this.pendingApprovals.map(clonePendingApproval),
    };
  }

  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error("This terminal gateway session has already been used.");
    }

    const headers = this.authToken ? { authorization: `Bearer ${this.authToken}` } : undefined;
    const socket = new WebSocket(this.url, {
      ...(headers ? { headers } : {}),
      handshakeTimeout: this.connectTimeoutMs,
      followRedirects: false,
      maxPayload: MAX_SERVER_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(() => {
        settle(new Error(`Gateway did not complete the protocol handshake within ${this.connectTimeoutMs}ms.`));
        socket.close(1002, "session handshake timeout");
      }, this.connectTimeoutMs);
      timeout.unref?.();

      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            type: "session.start",
            protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
            profileId: "terminal",
            userLabel: this.userLabel,
          }),
        );
      });
      socket.on("message", (raw) => {
        try {
          const message = parseServerMessage(raw);
          if (message.type === "session.ready") {
            if (message.protocolVersion !== HERMES_LIVE_PROTOCOL_VERSION) {
              throw new Error(
                `Gateway protocol mismatch: expected v${HERMES_LIVE_PROTOCOL_VERSION}, received ${String(message.protocolVersion)}.`,
              );
            }
            this.handleSessionReady(message);
            settle();
            return;
          }
          if (!this.ready && message.type === "session.error") {
            settle(new Error(safeMessage(message.message, "Gateway rejected the terminal session.")));
            socket.close(1002, "session rejected");
            return;
          }
          this.handleServerMessage(message);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Gateway sent an invalid protocol message.";
          if (!this.ready) settle(new Error(sanitizeTerminalText(message, 500)));
          this.line(`[protocol] ${sanitizeTerminalText(message, 500)}`);
          socket.close(1002, "invalid server message");
        }
      });
      socket.once("error", () => {
        if (!this.ready) settle(new Error("Could not connect to the Hermes Live gateway."));
        else this.line("[connection] Gateway WebSocket error; the session may close.");
      });
      socket.once("close", (code) => {
        const wasReady = this.ready;
        const hadActiveRun = Boolean(this.activeRunId);
        this.ready = false;
        this.responseActive = false;
        this.activeRunId = undefined;
        this.pendingApprovals = [];
        this.permanentApprovalArmedFor = undefined;
        if (!wasReady) settle(new Error(`Gateway closed before session.ready (code ${code}).`));
        if (wasReady && !this.intentionalClose) {
          this.line(
            `[connection] Disconnected (code ${code}).${hadActiveRun ? " The gateway was asked to stop the active Hermes task." : ""}`,
          );
        }
        this.resolveClosedOnce();
      });
    }).catch((error) => {
      socket.terminate();
      this.resolveClosedOnce();
      throw error;
    });
  }

  execute(input: string): TerminalCommandResult {
    const line = input.trim();
    if (!line) return { closeRequested: false };

    const confirmingPermanentApproval = line.toLowerCase() === "/approve always";
    if (!confirmingPermanentApproval) this.permanentApprovalArmedFor = undefined;

    if (!line.startsWith("/")) {
      if (line.length > MAX_TERMINAL_TEXT_CHARS) {
        this.line(`[input] Text is too long for the terminal client (maximum ${MAX_TERMINAL_TEXT_CHARS} characters).`);
        return { closeRequested: false };
      }
      if (!this.send({ type: "text.input", id: this.nextRequestId(), text: line })) return { closeRequested: false };
      this.line("[you] Sent.");
      return { closeRequested: false };
    }

    const [command, ...args] = line.split(/\s+/);
    switch (command?.toLowerCase()) {
      case "/help":
        this.printHelp();
        return { closeRequested: false };
      case "/status":
        this.printStatus();
        return { closeRequested: false };
      case "/interrupt":
        this.responseActive = false;
        this.send({ type: "response.cancel", id: this.nextRequestId(), reason: "terminal user interrupted provider response" });
        this.line("[voice] Provider response interruption requested. An active Hermes task keeps running.");
        return { closeRequested: false };
      case "/stop":
        if (!this.activeRunId) {
          this.line("[Hermes] There is no active Hermes task to stop.");
          return { closeRequested: false };
        }
        this.send({
          type: "run.stop",
          id: this.nextRequestId(),
          runId: this.activeRunId,
          reason: "terminal user stopped Hermes task",
        });
        this.line(`[Hermes] Stop requested for ${singleLine(this.activeRunId, 120)}.`);
        return { closeRequested: false };
      case "/approve":
        this.respondToApproval(args);
        return { closeRequested: false };
      case "/quit":
      case "/exit":
        if (this.activeRunId && args[0]?.toLowerCase() !== "--force") {
          this.line("[safety] A Hermes task is active. Use /stop first, or /quit --force to disconnect and stop it.");
          return { closeRequested: false };
        }
        return { closeRequested: true };
      default:
        this.line(`[input] Unknown command ${singleLine(command ?? line, 80)}. Use /help.`);
        return { closeRequested: false };
    }
  }

  async close(): Promise<void> {
    if (this.closedResolved) return;
    this.intentionalClose = true;
    const socket = this.socket;
    if (!socket) {
      this.resolveClosedOnce();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "session.close", id: this.nextRequestId() }));
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }

    await Promise.race([this.closed, delay(Math.max(12_000, this.connectTimeoutMs))]);
    if (!this.closedResolved) {
      socket.terminate();
      await this.closed;
      throw new Error("The gateway did not confirm session shutdown; verify any active Hermes task before reconnecting.");
    }
  }

  private handleSessionReady(message: Record<string, unknown>): void {
    this.ready = true;
    this.sessionId = stringValue(message.sessionId);
    const realtime = recordValue(message.realtime);
    this.provider = stringValue(realtime?.provider);
    this.model = stringValue(realtime?.model) ?? stringValue(message.model);
    const target = [this.provider, this.model].filter(Boolean).join(" / ") || "gateway";
    this.line(`[connection] Connected to ${singleLine(target, 240)} (protocol v${HERMES_LIVE_PROTOCOL_VERSION}).`);
    this.line("[mode] Text-control console only: gateway audio is not captured or played here.");
    this.line("[mode] For a local microphone, run Hermes and press Ctrl+B for official Hermes Voice Mode.");
  }

  private handleServerMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "response.started":
        this.responseActive = true;
        this.assistantTranscript = "";
        this.responseHadAudio = false;
        break;
      case "transcript.delta":
        if (message.speaker === "assistant" && typeof message.text === "string") {
          this.assistantTranscript = `${this.assistantTranscript}${message.text}`.slice(0, MAX_RENDERED_TEXT_CHARS);
        }
        break;
      case "audio.output":
        this.responseHadAudio = true;
        break;
      case "response.completed":
        this.responseActive = false;
        this.flushAssistantResponse();
        break;
      case "response.cancelled":
        this.responseActive = false;
        this.flushAssistantResponse();
        this.line("[voice] Provider response interrupted.");
        break;
      case "response.failed":
        this.responseActive = false;
        this.line(`[voice] Provider response failed: ${safeMessage(message.error, "unknown error")}`);
        this.resetResponseOutput();
        break;
      case "run.started": {
        const runId = stringValue(message.runId);
        if (runId) this.activeRunId = runId;
        this.line(`[Hermes] Task started${runId ? ` (${singleLine(runId, 120)})` : ""}.`);
        break;
      }
      case "run.event":
        this.renderRunEvent(recordValue(message.event));
        break;
      case "approval.request":
        this.renderApprovalRequest(message);
        break;
      case "approval.responded":
        this.resolvePendingApprovals(message);
        this.permanentApprovalArmedFor = undefined;
        this.line(`[approval] Hermes received ${safeMessage(message.choice, "the response")}.`);
        if (this.pendingApprovals[0]) this.renderActionableApproval(this.pendingApprovals[0]);
        break;
      case "run.completed":
        this.renderRunTerminal("completed", message);
        break;
      case "run.failed":
        this.renderRunTerminal("failed", message);
        break;
      case "run.stopping":
        this.line(`[Hermes] Task stop requested (${safeMessage(message.status, "stopping")}); waiting for terminal confirmation.`);
        break;
      case "run.stopped":
        this.renderRunTerminal("stopped", message);
        break;
      case "session.error":
        this.line(`[error] ${safeMessage(message.message, "Gateway request failed.")}`);
        break;
      case "log":
        if (message.level === "warn" || message.level === "error") {
          this.line(`[gateway ${message.level}] ${safeMessage(message.message, "Gateway event")}`);
        }
        break;
    }
  }

  private flushAssistantResponse(): void {
    const transcript = sanitizeTerminalText(this.assistantTranscript.trim(), MAX_RENDERED_TEXT_CHARS);
    if (transcript) this.line(prefixMultiline("[voice] ", transcript));
    else if (this.responseHadAudio) {
      this.line("[voice] Audio response received. Use the Hermes Dashboard or browser demo to hear gateway audio.");
    }
    this.resetResponseOutput();
  }

  private resetResponseOutput(): void {
    this.assistantTranscript = "";
    this.responseHadAudio = false;
  }

  private renderRunEvent(event: Record<string, unknown> | undefined): void {
    const eventName = stringValue(event?.event);
    if (!eventName || ["message.delta", "approval.request", "run.completed", "run.failed", "run.cancelled"].includes(eventName)) {
      return;
    }
    const tool = stringValue(event?.tool) ?? stringValue(event?.tool_name);
    this.line(`[Hermes] ${singleLine(eventName, 120)}${tool ? `: ${singleLine(tool, 120)}` : ""}`);
  }

  private renderApprovalRequest(message: Record<string, unknown>): void {
    const runId = stringValue(message.runId) ?? this.activeRunId;
    if (!runId) {
      this.line("[approval] Hermes requested approval without a valid run id; denying is the safe default.");
      return;
    }
    const approval = recordValue(message.approval);
    const rawApprovalId = stringValue(approval?.approvalId) ?? "";
    const approvalId = singleLine(rawApprovalId, 256);
    if (!approvalId || approvalId !== rawApprovalId || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(approvalId)) {
      throw new Error("Gateway approval request did not include a safe approval id.");
    }
    const projected = sanitizeOneShotApproval(approval);
    const pending: PendingTerminalApproval = {
      runId,
      approvalId,
      ...(projected.command ? { command: projected.command } : {}),
      ...(projected.description ? { description: projected.description } : {}),
      patternKeys: projected.patternKeys,
      choices: projected.choices,
      allowPermanent: projected.allowPermanent,
    };
    const existingIndex = this.pendingApprovals.findIndex(
      (entry) => entry.runId === runId && entry.approvalId === pending.approvalId,
    );
    if (existingIndex >= 0) this.pendingApprovals[existingIndex] = pending;
    else {
      if (this.pendingApprovals.length >= MAX_PENDING_APPROVALS) {
        throw new Error("Gateway exceeded the safe pending approval queue limit.");
      }
      this.pendingApprovals.push(pending);
    }
    this.permanentApprovalArmedFor = undefined;
    const position = this.pendingApprovals.indexOf(pending);
    if (position <= 0) this.renderActionableApproval(pending);
    else {
      this.line(
        `[approval] Queued #${position + 1}: ${singleLine(pending.description ?? pending.command ?? "Hermes needs permission to continue.", 500)}`,
      );
      this.line("[approval] Answer the earlier approval first; Hermes resolves approval requests in FIFO order.");
    }
  }

  private respondToApproval(args: string[]): void {
    const pending = this.pendingApprovals[0];
    if (!pending) {
      this.line("[approval] There is no pending approval request.");
      return;
    }
    const parsed = ApprovalChoiceSchema.safeParse(args[0]?.toLowerCase());
    if (!parsed.success) {
      this.line(`[approval] Choose one of: ${pending.choices.join(", ")}.`);
      return;
    }
    const choice = parsed.data;
    if (!pending.choices.includes(choice)) {
      this.line(`[approval] ${choice} is not allowed for this request. Choose: ${pending.choices.join(", ")}.`);
      return;
    }
    if (choice === "always") {
      if (!pending.allowPermanent) {
        this.line("[approval] Permanent approval is not allowed for this request.");
        return;
      }
      const approvalIdentity = pendingApprovalIdentity(pending);
      if (this.permanentApprovalArmedFor !== approvalIdentity) {
        this.permanentApprovalArmedFor = approvalIdentity;
        this.line("[safety] Permanent approval changes future policy. Repeat /approve always to confirm.");
        return;
      }
    }
    if (
      this.send({
        type: "approval.respond",
        id: this.nextRequestId(),
        runId: pending.runId,
        approvalId: pending.approvalId,
        choice,
      })
    ) {
      this.line(`[approval] Sent ${choice}.`);
      this.permanentApprovalArmedFor = undefined;
    }
  }

  private resolvePendingApprovals(message: Record<string, unknown>): void {
    const runId = stringValue(message.runId);
    const approvalId = stringValue(message.approvalId);
    if (!runId || !approvalId || message.resolved !== 1) return;
    this.pendingApprovals = this.pendingApprovals.filter(
      (entry) => entry.runId !== runId || entry.approvalId !== approvalId,
    );
  }

  private renderActionableApproval(pending: PendingTerminalApproval): void {
    this.line(`[approval] ${singleLine(pending.description ?? "Hermes needs permission to continue.", 500)}`);
    if (pending.command) this.line(`[approval] Command: ${singleLine(pending.command, 1_000)}`);
    if (pending.patternKeys.length > 0) {
      this.line(`[approval] Permission pattern: ${pending.patternKeys.map((value) => singleLine(value, 256)).join(", ")}`);
    } else if (!pending.command && !pending.description) {
      this.line("[approval] Hermes did not provide enough inspectable action details; this request can only be denied.");
    } else {
      this.line("[approval] Hermes did not provide an inspectable permission pattern; permanent approval is unavailable.");
    }
    this.line(`[approval] Choices: ${pending.choices.join(", ")}. Use /approve <choice>; deny is the safe default.`);
  }

  private renderRunTerminal(status: "completed" | "failed" | "stopped", message: Record<string, unknown>): void {
    const runId = stringValue(message.runId);
    if (!runId || !this.activeRunId || runId === this.activeRunId) {
      this.activeRunId = undefined;
      this.pendingApprovals = [];
      this.permanentApprovalArmedFor = undefined;
    }
    if (status === "completed") {
      const output = sanitizeTerminalText(stringValue(message.output) ?? "", MAX_RENDERED_TEXT_CHARS).trim();
      this.line(`[Hermes] Task completed.${output ? `\n${indentMultiline(output)}` : ""}`);
    } else if (status === "failed") {
      this.line(`[Hermes] Task failed: ${safeMessage(message.error, "unknown error")}`);
    } else {
      this.line(`[Hermes] Task stopped (${safeMessage(message.status, "stopped")}).`);
    }
  }

  private printHelp(): void {
    this.line(`Commands:
  <text>                 Send a text turn through the realtime gateway
  /interrupt             Stop provider speech/response; Hermes work keeps running
  /stop                  Stop the active Hermes task
  /approve <choice>      Answer the pending approval request
  /status                Show local connection/task state (never credentials)
  /quit                  Disconnect; refused while a Hermes task is active
  /quit --force          Disconnect and make the gateway stop the active task
  /help                  Show this help

This console intentionally has no microphone/audio dependencies. For local voice,
run Hermes and press Ctrl+B. For remote gateway audio, use the Dashboard/browser UI.`);
  }

  private printStatus(): void {
    const approval = this.pendingApprovals[0]
      ? `${this.pendingApprovals.length} pending; next (${this.pendingApprovals[0].choices.join("/")})`
      : "none";
    this.line(`Status:
  connection: ${this.ready ? "ready" : "not ready"}
  provider: ${singleLine(this.provider ?? "unknown", 120)}
  model: ${singleLine(this.model ?? "unknown", 200)}
  provider response: ${this.responseActive ? "active" : "idle"}
  Hermes task: ${this.activeRunId ? `active (${singleLine(this.activeRunId, 120)})` : "idle"}
  approval: ${approval}`);
  }

  private send(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) {
      this.line("[connection] The gateway session is not ready.");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `terminal_${this.requestSequence}`;
  }

  private line(value: string): void {
    this.onLine(sanitizeTerminalText(value, MAX_RENDERED_TEXT_CHARS));
  }

  private resolveClosedOnce(): void {
    if (this.closedResolved) return;
    this.closedResolved = true;
    this.resolveClosed();
  }
}

export async function runInteractiveTerminal(options: InteractiveTerminalOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = Boolean((input as Readable & { isTTY?: boolean }).isTTY && (output as Writable & { isTTY?: boolean }).isTTY);
  let reader: ReturnType<typeof createInterface> | undefined;
  let promptVisible = false;

  const render = (line: string): void => {
    if (interactive && reader && promptVisible) {
      clearLine(output, 0);
      cursorTo(output, 0);
    }
    output.write(line.endsWith("\n") ? line : `${line}\n`);
    if (interactive && reader && promptVisible) reader.prompt(true);
  };

  const session = new TerminalGatewaySession({ ...options, onLine: render });
  await session.connect();
  render("[help] Type /help for controls. Disconnecting stops any active Hermes task.");

  reader = createInterface({ input, output, terminal: interactive });
  if (interactive) {
    reader.setPrompt("hermes-live> ");
    promptVisible = true;
    reader.prompt();
  }

  await new Promise<void>((resolve, reject) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      promptVisible = false;
      reader?.close();
      input.pause();
      void session.close().then(resolve, reject);
    };

    reader?.on("line", (line) => {
      const result = session.execute(line);
      if (result.closeRequested) shutdown();
      else if (interactive) reader?.prompt();
    });
    reader?.on("SIGINT", () => {
      const snapshot = session.snapshot;
      if (snapshot.responseActive) {
        session.execute("/interrupt");
        if (interactive) reader?.prompt();
      } else if (snapshot.activeRunId) {
        session.execute("/stop");
        if (interactive) reader?.prompt();
      } else {
        shutdown();
      }
    });
    reader?.once("close", shutdown);
    void session.closed.then(() => {
      if (shuttingDown) return;
      shuttingDown = true;
      promptVisible = false;
      reader?.close();
      input.pause();
      resolve();
    });
  });
}

export function normalizeGatewayWebSocketUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HERMES_LIVE_URL must be an absolute http(s) or ws(s) URL.");
  }
  if (url.username || url.password) {
    throw new Error("HERMES_LIVE_URL must not contain credentials; use HERMES_LIVE_AUTH_TOKEN.");
  }
  if (url.searchParams.has("token")) {
    throw new Error("HERMES_LIVE_URL must not contain a token query; use HERMES_LIVE_AUTH_TOKEN.");
  }
  if (url.hash) throw new Error("HERMES_LIVE_URL must not contain a URL fragment.");
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = basePath.endsWith("/v1/live") ? basePath : `${basePath}/v1/live`;
  } else if (url.protocol === "ws:" || url.protocol === "wss:") {
    if (url.pathname === "/" || !url.pathname) url.pathname = "/v1/live";
  } else {
    throw new Error("HERMES_LIVE_URL must use http, https, ws, or wss.");
  }
  return url.toString();
}

export function sanitizeTerminalText(value: string, maxChars = MAX_RENDERED_TEXT_CHARS): string {
  const withoutTerminalSequences = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
  const sanitized: string[] = [];
  for (const character of withoutTerminalSequences) {
    if (sanitized.length >= maxChars) break;
    const code = character.charCodeAt(0);
    if (
      character === "\n" ||
      character === "\t" ||
      (
        code >= 32 &&
        code !== 127 &&
        !(code >= 128 && code <= 159) &&
        code !== 0x061c &&
        code !== 0x200e &&
        code !== 0x200f &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      )
    ) {
      sanitized.push(character);
    }
  }
  return sanitized.join("");
}

function parseServerMessage(raw: WebSocket.RawData): Record<string, unknown> {
  const value = JSON.parse(raw.toString("utf8")) as unknown;
  const message = recordValue(value);
  if (!message || typeof message.type !== "string") throw new Error("Gateway sent an invalid protocol message.");
  return message;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function safeMessage(value: unknown, fallback: string): string {
  return singleLine(stringValue(value) ?? fallback, 500);
}

function singleLine(value: string, maxChars: number): string {
  return sanitizeTerminalText(value, maxChars).replace(/\s+/g, " ").trim();
}

function prefixMultiline(prefix: string, value: string): string {
  const [first = "", ...rest] = value.split("\n");
  return `${prefix}${first}${rest.length > 0 ? `\n${rest.map((line) => `  ${line}`).join("\n")}` : ""}`;
}

function indentMultiline(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function sanitizeMetadata(value: string): string {
  return singleLine(value, 256) || "terminal";
}

function pendingApprovalIdentity(pending: PendingTerminalApproval): string {
  return `${pending.runId}:${pending.approvalId}`;
}

function clonePendingApproval(pending: PendingTerminalApproval): PendingTerminalApproval {
  return {
    ...pending,
    patternKeys: [...pending.patternKeys],
    choices: [...pending.choices],
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
