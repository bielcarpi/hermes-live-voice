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

setInteractive(false);
gatewayInput.value = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/live`;

connectButton.addEventListener("click", () => {
  if (client?.connected || client?.state === "starting") {
    client.disconnect();
    return;
  }
  if (client?.state === "connecting") return;
  void connect().catch(showError);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  try {
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
  await disposeSession();
  client = new HermesLiveClient({
    url: gatewayInput.value,
    token: tokenInput.value,
    profileId: "demo",
    userLabel: "web-demo",
  });
  audio = new HermesLiveAudio(client, { workletUrl: "/mic-worklet.js" });
  bindSession(client, audio);
  connectButton.textContent = "Disconnect";
  setInteractive(false);
  await client.connect();
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
    addLog("approval", `submitted ${message.choice} for ${message.runId}`);
  } else if (message.type === "run.failed" || message.type === "session.error") {
    setStatus(message.type === "run.failed" ? "Run failed" : "Error");
    audio.clearPlayback();
    if (message.type === "session.error" && !message.recoverable) setInteractive(false);
    addLog("error", JSON.stringify(message, null, 2));
  } else if (message.type === "run.stopped") {
    audio.clearPlayback();
    addLog("run", `stopped ${message.runId}: ${message.status}`);
  } else if (message.type !== "realtime.message") {
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
    await audio.startMicrophone();
  }
}

async function disposeSession() {
  const previousAudio = audio;
  const previousClient = client;
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
  body.textContent = JSON.stringify(message.event, null, 2);
  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const informed = typeof message.event?.command === "string" || typeof message.event?.description === "string";
  const choices = informed ? ["once", "session", "always", "deny"] : ["once", "deny"];
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    button.addEventListener("click", () => {
      client.respondToApproval(choice, message.runId);
      for (const control of actions.querySelectorAll("button")) control.disabled = true;
    });
    actions.append(button);
  }

  entry.append(title, body, actions);
  logEl.append(entry);
  logEl.scrollTop = logEl.scrollHeight;
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
