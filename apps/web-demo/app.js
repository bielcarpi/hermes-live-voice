const gatewayInput = document.querySelector("#gateway");
const tokenInput = document.querySelector("#token");
const connectButton = document.querySelector("#connect");
const micButton = document.querySelector("#mic");
const stopButton = document.querySelector("#stop");
const form = document.querySelector("#text-form");
const textInput = document.querySelector("#text");
const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");

let socket;
let activeRunId = "";
let audioContext;
let playbackContext;
let playbackCursor = 0;
let mediaStream;
let workletNode;

gatewayInput.value = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/live`;

connectButton.addEventListener("click", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.close(1000, "user disconnected");
    return;
  }
  connect();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  send({ type: "text.input", text });
  addLog("you", text);
  textInput.value = "";
});

micButton.addEventListener("click", async () => {
  if (workletNode) {
    await stopMic();
    return;
  }
  await startMic();
});

stopButton.addEventListener("click", () => {
  send({ type: "run.stop", runId: activeRunId || undefined, reason: "demo user clicked stop" });
});

function connect() {
  const url = new URL(gatewayInput.value);
  const token = tokenInput.value.trim();
  if (token) url.searchParams.set("token", token);

  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    setStatus("Connected");
    connectButton.textContent = "Disconnect";
    send({ type: "session.start", profileId: "demo", userLabel: "web-demo" });
  });
  socket.addEventListener("close", () => {
    setStatus("Disconnected");
    connectButton.textContent = "Connect";
    if (workletNode) void stopMic({ notify: false });
  });
  socket.addEventListener("error", () => setStatus("WebSocket error"));
  socket.addEventListener("message", (event) => handleMessage(JSON.parse(event.data)));
}

function handleMessage(message) {
  if (message.type === "session.ready") {
    addLog("session", JSON.stringify(message, null, 2));
  } else if (message.type === "transcript.delta") {
    addLog(message.speaker ?? "assistant", message.text ?? "");
  } else if (message.type === "audio.output") {
    void playPcmAudio(message.data, message.mimeType);
  } else if (message.type === "run.started") {
    activeRunId = message.runId;
    addLog("run", `started ${message.runId}`);
  } else if (message.type === "run.completed") {
    activeRunId = "";
    addLog("hermes", message.output ?? "");
  } else if (message.type === "approval.request") {
    activeRunId = message.runId;
    addApprovalRequest(message);
  } else if (message.type === "approval.responded") {
    addLog("approval", `submitted ${message.choice} for ${message.runId}`);
  } else if (message.type === "run.failed" || message.type === "session.error") {
    if (message.type === "run.failed") activeRunId = "";
    addLog("error", JSON.stringify(message, null, 2));
  } else if (message.type === "run.stopped") {
    activeRunId = "";
    addLog("run", `stopped ${message.runId}: ${message.status}`);
  } else if (message.type !== "realtime.message") {
    addLog(message.type, JSON.stringify(message, null, 2));
  }
}

async function startMic() {
  ensureOpen();
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new AudioContext({ sampleRate: 24000 });
  await audioContext.audioWorklet.addModule("/mic-worklet.js");
  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-capture");
  const captureRate = Math.round(audioContext.sampleRate);
  workletNode.port.onmessage = (event) => {
    send({ type: "audio.input", data: arrayBufferToBase64(event.data), mimeType: `audio/pcm;rate=${captureRate}` });
  };
  source.connect(workletNode);
  micButton.textContent = "Stop mic";
  setStatus("Streaming microphone");
}

async function stopMic({ notify = true } = {}) {
  if (notify && socket?.readyState === WebSocket.OPEN) {
    send({ type: "audio.end" });
  }
  workletNode?.disconnect();
  workletNode = undefined;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = undefined;
  await audioContext?.close();
  audioContext = undefined;
  micButton.textContent = "Mic";
  setStatus("Connected");
}

async function playPcmAudio(base64, mimeType) {
  const rate = Number(/rate=(\d+)/.exec(mimeType || "")?.[1] || 24000);
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  if (!playbackContext || playbackContext.state === "closed" || playbackContext.sampleRate !== rate) {
    playbackContext = new AudioContext({ sampleRate: rate });
    playbackCursor = 0;
  }
  if (playbackContext.state === "suspended") {
    await playbackContext.resume();
  }
  const ctx = playbackContext;
  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime + 0.02, playbackCursor || 0);
  source.start(startAt);
  playbackCursor = startAt + buffer.duration;
  source.addEventListener(
    "ended",
    () => {
      if (playbackCursor <= ctx.currentTime) {
        playbackCursor = 0;
      }
    },
    { once: true },
  );
}

function send(message) {
  ensureOpen();
  socket.send(JSON.stringify(message));
}

function ensureOpen() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Connect before sending messages.");
  }
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

  for (const choice of ["once", "session", "always", "deny"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice;
    button.addEventListener("click", () => {
      send({ type: "approval.respond", runId: message.runId, choice });
      for (const control of actions.querySelectorAll("button")) {
        control.disabled = true;
      }
    });
    actions.append(button);
  }

  entry.append(title, body, actions);
  logEl.append(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(value) {
  statusEl.textContent = value;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
