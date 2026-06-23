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
const playbackSources = new Set();
const playbackItems = new Map();
let lastPlaybackItem;
let mediaStream;
let workletNode;

gatewayInput.value = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/live`;

connectButton.addEventListener("click", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    clearPlayback();
    socket.close(1000, "user disconnected");
    return;
  }
  if (socket?.readyState === WebSocket.CONNECTING) {
    return;
  }
  try {
    connect();
  } catch (error) {
    showError(error);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  try {
    const truncate = clearPlayback();
    requestResponseCancel("new text input", truncate);
    send({ type: "text.input", text });
    addLog("you", text);
    textInput.value = "";
  } catch (error) {
    showError(error);
  }
});

micButton.addEventListener("click", async () => {
  try {
    if (workletNode) {
      await stopMic();
      return;
    }
    await startMic();
  } catch (error) {
    showError(error);
    await stopMic({ notify: false, status: socket?.readyState === WebSocket.OPEN ? "Connected" : "Disconnected" });
  }
});

stopButton.addEventListener("click", () => {
  try {
    const truncate = clearPlayback();
    requestResponseCancel("demo user clicked stop", truncate);
    if (activeRunId) {
      send({ type: "run.stop", runId: activeRunId, reason: "demo user clicked stop" });
    }
  } catch (error) {
    showError(error);
  }
});

function connect() {
  const url = new URL(gatewayInput.value);
  const token = tokenInput.value.trim();
  if (token) url.searchParams.set("token", token);

  const nextSocket = new WebSocket(url);
  socket = nextSocket;
  setStatus("Connecting");
  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    activeRunId = "";
    setStatus("Starting session");
    connectButton.textContent = "Disconnect";
    nextSocket.send(JSON.stringify({ type: "session.start", profileId: "demo", userLabel: "web-demo" }));
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    activeRunId = "";
    socket = undefined;
    clearPlayback();
    setStatus("Disconnected");
    connectButton.textContent = "Connect";
    if (workletNode) void stopMic({ notify: false, status: "Disconnected" });
  });
  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket) return;
    setStatus("WebSocket error");
  });
  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) return;
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      showError(error);
    }
  });
}

function handleMessage(message) {
  if (message.type === "session.ready") {
    setStatus("Connected");
    addLog("session", JSON.stringify(message, null, 2));
  } else if (message.type === "transcript.delta") {
    addLog(message.speaker ?? "assistant", message.text ?? "");
  } else if (message.type === "input.speech_started") {
    const truncate = clearPlayback();
    requestResponseCancel("provider detected user speech", truncate);
    addLog("speech", `started${message.audioStartMs === undefined ? "" : ` at ${message.audioStartMs}ms`}`);
  } else if (message.type === "audio.output") {
    void playPcmAudio(message.data, message.mimeType, message.itemId, message.contentIndex);
  } else if (message.type === "run.started") {
    activeRunId = message.runId;
    addLog("run", `started ${message.runId}`);
  } else if (message.type === "run.event") {
    handleRunEvent(message);
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
    setStatus(message.type === "run.failed" ? "Run failed" : "Error");
    clearPlayback();
    addLog("error", JSON.stringify(message, null, 2));
  } else if (message.type === "run.stopped") {
    activeRunId = "";
    clearPlayback();
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
  if (event.event === "approval.request" || event.event === "run.completed" || event.event === "run.failed") {
    return;
  }
  addLog("run.event", JSON.stringify(event, null, 2));
}

async function startMic() {
  ensureOpen();
  const truncate = clearPlayback();
  requestResponseCancel("microphone started", truncate);
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new AudioContext({ sampleRate: 24000 });
  await audioContext.audioWorklet.addModule("/mic-worklet.js");
  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-capture");
  const captureRate = Math.round(audioContext.sampleRate);
  workletNode.port.onmessage = (event) => {
    if (event.data?.type === "flushed") return;
    send({ type: "audio.input", data: arrayBufferToBase64(event.data), mimeType: `audio/pcm;rate=${captureRate}` });
  };
  source.connect(workletNode);
  micButton.textContent = "Stop mic";
  setStatus("Streaming microphone");
}

async function stopMic({ notify = true, status = "Connected" } = {}) {
  await flushMicWorklet();
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
  setStatus(status);
}

async function flushMicWorklet() {
  const node = workletNode;
  if (!node) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 80);
    const onMessage = (event) => {
      if (event.data?.type !== "flushed") return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      node.port.removeEventListener("message", onMessage);
    };
    node.port.addEventListener("message", onMessage);
    node.port.postMessage({ type: "flush" });
  });
}

async function playPcmAudio(base64, mimeType, itemId, contentIndex = 0) {
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
  const itemKey = itemId ? `${itemId}:${contentIndex}` : "";
  if (itemId) {
    lastPlaybackItem = { itemId, contentIndex };
    if (!playbackItems.has(itemKey)) {
      playbackItems.set(itemKey, { itemId, contentIndex, playedMs: 0 });
    }
  }
  const sourceRecord = { source, context: ctx, itemKey, startAt, duration: buffer.duration, stopped: false };
  playbackSources.add(sourceRecord);
  playbackCursor = startAt + buffer.duration;
  source.addEventListener(
    "ended",
    () => {
      playbackSources.delete(sourceRecord);
      if (!sourceRecord.stopped && sourceRecord.itemKey) {
        addPlayedAudio(sourceRecord.itemKey, sourceRecord.duration * 1000);
      }
      if (playbackCursor <= ctx.currentTime) {
        playbackCursor = 0;
      }
    },
    { once: true },
  );
}

function clearPlayback() {
  const hadQueuedAudio = playbackSources.size > 0;
  playbackCursor = 0;
  for (const sourceRecord of playbackSources) {
    if (sourceRecord.itemKey) {
      const playedSeconds = Math.max(0, Math.min(sourceRecord.duration, sourceRecord.context.currentTime - sourceRecord.startAt));
      addPlayedAudio(sourceRecord.itemKey, playedSeconds * 1000);
    }
    sourceRecord.stopped = true;
    try {
      sourceRecord.source.stop();
    } catch {
      // The source may already have ended.
    }
  }
  playbackSources.clear();
  const truncate =
    hadQueuedAudio && lastPlaybackItem
      ? playbackItems.get(`${lastPlaybackItem.itemId}:${lastPlaybackItem.contentIndex}`)
      : undefined;
  playbackItems.clear();
  lastPlaybackItem = undefined;
  return truncate
    ? { itemId: truncate.itemId, contentIndex: truncate.contentIndex, audioEndMs: Math.max(0, Math.floor(truncate.playedMs)) }
    : undefined;
}

function addPlayedAudio(itemKey, playedMs) {
  const item = playbackItems.get(itemKey);
  if (item) {
    item.playedMs += Math.max(0, playedMs);
  }
}

function send(message) {
  ensureOpen();
  socket.send(JSON.stringify(message));
}

function requestResponseCancel(reason, truncate) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "response.cancel", reason, ...(truncate ? { truncate } : {}) }));
  }
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

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus("Error");
  addLog("error", message);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
