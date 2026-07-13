import { HermesLiveAudio, HermesLiveClient } from "/hermes-live-client.js";

const gatewayInput = document.querySelector("#gateway");
const tokenInput = document.querySelector("#token");
const connectButton = document.querySelector("#connect");
const micButton = document.querySelector("#mic");
const interruptButton = document.querySelector("#interrupt");
const stopButton = document.querySelector("#stop");
const form = document.querySelector("#text-form");
const textInput = document.querySelector("#text");
const sendButton = document.querySelector("#send");
const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");

let client;
let audio;
let connectPending = false;
const approvalQueue = [];

setInteractive(false);
gatewayInput.value = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/live`;

connectButton.addEventListener("click", () => {
  if (client?.connected || client?.state === "starting") {
    void client.disconnect().catch(showError);
    return;
  }
  if (connectPending || client?.state === "connecting") return;
  void connect().catch(showError);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  try {
    void audio.primePlayback().catch(showError);
    audio.interrupt("new text input");
    client.sendText(text);
    addLog("you", text);
    textInput.value = "";
  } catch (error) {
    showError(error);
  }
});

micButton.addEventListener("click", () => {
  void toggleMicrophone().catch(showError);
});

interruptButton.addEventListener("click", () => {
  try {
    audio.interrupt("demo user interrupted speech");
  } catch (error) {
    showError(error);
  }
});

stopButton.addEventListener("click", () => {
  try {
    if (client.activeRunId) client.stopRun("demo user stopped Hermes task");
  } catch (error) {
    showError(error);
  }
});

async function connect() {
  connectPending = true;
  const disposing = disposeSession();
  const nextClient = new HermesLiveClient({
    url: gatewayInput.value,
    token: tokenInput.value,
    profileId: "demo",
    userLabel: "web-demo",
  });
  const nextAudio = new HermesLiveAudio(nextClient, { workletUrl: "/mic-worklet.js" });
  client = nextClient;
  audio = nextAudio;
  bindSession(nextClient, nextAudio);
  connectButton.textContent = "Disconnect";
  setInteractive(false);
  void nextAudio.primePlayback().catch(showError);
  try {
    await disposing;
    await nextClient.connect();
  } finally {
    connectPending = false;
  }
}

function bindSession(nextClient, nextAudio) {
  nextClient.on("state", ({ state }) => {
    if (nextClient !== client) return;
    if (state === "connecting") setStatus("Connecting");
    if (state === "starting") setStatus("Starting session");
    if (state === "closing") setStatus("Disconnecting");
    if (state === "failed") setStatus("Connection failed");
  });
  nextClient.on("message", (message) => {
    if (nextClient === client) handleMessage(message);
  });
  nextClient.on("error", ({ error, code }) => {
    if (nextClient === client && code !== "session_error") showError(error);
  });
  nextClient.on("audio.dropped", ({ bufferedAmount }) => {
    if (nextClient === client) addLog("audio", `Microphone frame dropped under backpressure (${bufferedAmount} bytes queued).`);
  });
  nextClient.on("close", () => {
    if (nextClient !== client) return;
    resetApprovalQueue();
    setStatus("Disconnected");
    setInteractive(false);
    connectButton.textContent = "Connect";
    void nextAudio.dispose();
  });
  nextAudio.on("microphone", ({ active }) => {
    if (nextAudio !== audio) return;
    micButton.textContent = active ? "Stop mic" : "Start mic";
    setStatus(active ? "Streaming microphone" : nextClient.connected ? "Connected" : "Disconnected");
  });
  nextAudio.on("error", ({ error }) => {
    if (nextAudio === audio) showError(error);
  });
  nextAudio.on("audio.dropped", ({ queuedMs }) => {
    if (nextAudio === audio) addLog("audio", `Provider audio dropped because ${Math.round(queuedMs)}ms was already queued.`);
  });
}

function handleMessage(message) {
  if (message.type === "session.ready") {
    setStatus("Connected");
    setInteractive(true);
    addLog("session", JSON.stringify(message, null, 2));
  } else if (message.type === "transcript.delta") {
    addLog(message.speaker ?? "assistant", message.text ?? "");
  } else if (message.type === "input.speech_started") {
    audio.interrupt("provider detected user speech");
    addLog("speech", `started${message.audioStartMs === undefined ? "" : ` at ${message.audioStartMs}ms`}`);
  } else if (message.type === "audio.output") {
    void audio.play(message).catch(showError);
  } else if (message.type === "run.started") {
    addLog("run", `started ${message.runId}`);
  } else if (message.type === "run.event") {
    handleRunEvent(message);
  } else if (message.type === "run.completed") {
    addLog("hermes", message.output ?? "");
  } else if (message.type === "approval.request") {
    addApprovalRequest(message);
  } else if (message.type === "approval.responded") {
    resolveApprovalQueue(message);
    addLog("approval", `submitted ${message.choice} for ${message.runId}`);
  } else if (message.type === "run.failed" || message.type === "session.error") {
    setStatus(message.type === "run.failed" ? "Run failed" : "Error");
    audio.clearPlayback();
    if (message.type === "session.error" && !message.recoverable) {
      resetApprovalQueue();
      setInteractive(false);
    }
    addLog("error", JSON.stringify(message, null, 2));
  } else if (message.type === "run.stopping") {
    addLog("run", `stop requested for ${message.runId}: ${message.status}`);
  } else if (message.type === "run.stopped") {
    audio.clearPlayback();
    addLog("run", `stopped ${message.runId}: ${message.status}`);
  } else {
    addLog(message.type, JSON.stringify(message, null, 2));
  }
}

function handleRunEvent(message) {
  const event = message.event ?? {};
  if (event.event === "message.delta" && typeof event.delta === "string") {
    addLog("hermes", event.delta);
    return;
  }
  if (event.event === "approval.request" || event.event === "run.completed" || event.event === "run.failed") return;
  addLog("run.event", JSON.stringify(event, null, 2));
}

async function toggleMicrophone() {
  if (!audio) throw new Error("Connect before starting the microphone.");
  if (audio.microphoneActive) {
    await audio.stopMicrophone();
  } else {
    await audio.primePlayback();
    await audio.startMicrophone();
  }
}

async function disposeSession() {
  const previousAudio = audio;
  const previousClient = client;
  resetApprovalQueue();
  audio = undefined;
  client = undefined;
  await Promise.allSettled([
    previousClient?.disconnect("replaced by new connection"),
    previousAudio?.dispose(),
  ]);
}

function addLog(kind, value) {
  const entry = document.createElement("div");
  entry.className = "entry";
  entry.innerHTML = `<strong></strong><pre></pre>`;
  entry.querySelector("strong").textContent = kind;
  entry.querySelector("pre").textContent = value;
  logEl.append(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function addApprovalRequest(message) {
  const entry = document.createElement("div");
  entry.className = "entry";
  const title = document.createElement("strong");
  title.textContent = "approval";
  const body = document.createElement("pre");
  const approval = message.approval ?? {};
  const patternKeys = approvalPatternKeys(approval);
  const informed =
    (typeof approval.command === "string" && approval.command.length > 0) ||
    (typeof approval.description === "string" && approval.description.length > 0);
  body.textContent = [
    approval.description,
    approval.command ? `Command: ${approval.command}` : undefined,
    approval.approvalId ? `Approval: ${approval.approvalId}` : undefined,
    patternKeys.length
      ? `Permission pattern: ${patternKeys.join(", ")}`
      : informed
        ? "No inspectable permission pattern; session and permanent approval are unavailable."
        : "Request details are unavailable; denial is the only safe option.",
  ].filter(Boolean).join("\n") || "Hermes requested an approval without additional context.";
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const queueStatus = document.createElement("span");
  queueStatus.className = "approval-queue-status";

  const allowedChoices = ["once", "session", "always", "deny"];
  const suppliedChoices = Array.isArray(approval.choices) &&
      approval.choices.length > 0 &&
      approval.choices.every((choice) => typeof choice === "string" && allowedChoices.includes(choice))
    ? approval.choices
    : ["deny"];
  const choices = [...new Set(suppliedChoices)]
    .filter((choice) => allowedChoices.includes(choice))
    .filter((choice) => informed || choice === "deny")
    .filter((choice) => !["session", "always"].includes(choice) || patternKeys.length > 0)
    .filter((choice) => choice !== "always" || (approval.allowPermanent === true && patternKeys.length > 0));
  if (!choices.includes("deny")) choices.push("deny");
  const queued = {
    message,
    actions,
    buttons: [],
    queueStatus,
    permanentArmed: false,
    submitted: false,
  };
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    button.addEventListener("click", () => {
      if (approvalQueue[0] !== queued || queued.submitted) return;
      if (choice === "always" && (!queued.permanentArmed || button.textContent !== "confirm always")) {
        queued.permanentArmed = true;
        button.textContent = "confirm always";
        queueStatus.textContent = "Permanent approval changes future policy. Click confirm always again to continue.";
        return;
      }
      try {
        client.respondToApproval(choice, message.runId, { approvalId: approval.approvalId });
        queued.submitted = true;
        refreshApprovalQueue();
      } catch (error) {
        queued.permanentArmed = false;
        if (choice === "always") button.textContent = "always";
        refreshApprovalQueue();
        showError(error);
      }
    });
    queued.buttons.push(button);
    actions.append(button);
  }
  actions.append(queueStatus);

  entry.append(title, body, actions);
  logEl.append(entry);
  approvalQueue.push(queued);
  refreshApprovalQueue();
  logEl.scrollTop = logEl.scrollHeight;
}

function approvalPatternKeys(approval) {
  const values = [];
  const primary = inspectablePattern(approval.patternKey);
  if (primary) values.push(primary);
  if (Array.isArray(approval.patternKeys)) {
    for (const value of approval.patternKeys) {
      const pattern = inspectablePattern(value);
      if (pattern) values.push(pattern);
    }
  }
  return [...new Set(values)].slice(0, 32);
}

function inspectablePattern(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, 256);
}

function resolveApprovalQueue(message) {
  const index = approvalQueue.findIndex((queued) =>
    queued.message.runId === message.runId &&
    queued.message.approval?.approvalId === message.approvalId);
  if (index >= 0) {
    const queued = approvalQueue[index];
    queued.submitted = true;
    queued.queueStatus.textContent = `Resolved: ${message.choice}`;
    for (const button of queued.buttons) button.disabled = true;
    approvalQueue.splice(index, 1);
  }
  refreshApprovalQueue();
}

function refreshApprovalQueue() {
  approvalQueue.forEach((queued, index) => {
    const actionable = index === 0 && !queued.submitted;
    for (const button of queued.buttons) button.disabled = !actionable;
    if (!queued.submitted && !queued.permanentArmed) {
      queued.queueStatus.textContent = actionable
        ? "Answer this approval to continue."
        : "Queued: answer the earlier approval first (Hermes resolves approvals FIFO).";
    }
  });
}

function resetApprovalQueue() {
  for (const queued of approvalQueue) {
    queued.submitted = true;
    queued.queueStatus.textContent = "Session ended before this approval was answered.";
    for (const button of queued.buttons) button.disabled = true;
  }
  approvalQueue.length = 0;
}

function setStatus(value) {
  statusEl.textContent = value;
  statusEl.className = `status ${value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

function setInteractive(enabled) {
  textInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  micButton.disabled = !enabled;
  interruptButton.disabled = !enabled;
  stopButton.disabled = !enabled;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus("Error");
  addLog("error", message);
}
