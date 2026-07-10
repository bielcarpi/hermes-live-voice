import { fireSound, toggleMute } from "./sounds.js";

const gatewayInput = document.querySelector("#gateway");
const tokenInput = document.querySelector("#token");
const connectButton = document.querySelector("#connect");
const micButton = document.querySelector("#mic");
const stopButton = document.querySelector("#stop");
const muteButton = document.querySelector("#mute");
const form = document.querySelector("#text-form");
const textInput = document.querySelector("#text");
const statusEl = document.querySelector("#status");
const filtersEl = document.querySelector("#filters");
const logEl = document.querySelector("#log");

const FILTER_KINDS = ["you", "assistant", "agent", "run", "run.event", "session", "speech", "error", "approval", "log"];
const filterableKinds = new Set(FILTER_KINDS);
const activeKinds = new Set(FILTER_KINDS);

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
let currentTranscriptEntry = null;
let currentTranscriptSpeaker = "";
let currentSpeechEntry;
let pendingResponseSince;
let awaitingFirstAudio = false;
let currentTurnTtfaMs;
let currentTurnSpokenMs = 0;

let loadingToneContext;
let loadingToneOscillator;
let loadingToneGain;
let loadingToneRunId = "";

gatewayInput.value = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/live`;
renderFilters();

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
    finalizeTranscriptEntry();
    requestResponseCancel("new text input", truncate);
    send({ type: "text.input", text });
    startAssistantResponseClock();
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

muteButton?.addEventListener("click", () => {
  const muted = toggleMute();
  muteButton.textContent = muted ? "Unmute sounds" : "Mute sounds";
  muteButton.setAttribute("aria-pressed", String(muted));
});

async function startLoadingTone() {
  stopLoadingTone();
  try {
    loadingToneContext = new AudioContext({ sampleRate: 24000 });
    await loadingToneContext.resume();
    const now = loadingToneContext.currentTime;

    loadingToneGain = loadingToneContext.createGain();
    loadingToneGain.gain.setValueAtTime(0, now);
    loadingToneGain.gain.setValueAtTime(0.001, now + 0.005);
    loadingToneGain.gain.exponentialRampToValueAtTime(0.06, now + 0.5);
    loadingToneGain.connect(loadingToneContext.destination);

    loadingToneOscillator = loadingToneContext.createOscillator();
    loadingToneOscillator.type = "sine";
    loadingToneOscillator.frequency.setValueAtTime(432, now);
    loadingToneOscillator.connect(loadingToneGain);
    loadingToneOscillator.start();

    const osc2 = loadingToneContext.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(648, now);
    const osc2Gain = loadingToneContext.createGain();
    osc2Gain.gain.setValueAtTime(0.25, now);
    osc2.connect(osc2Gain);
    osc2Gain.connect(loadingToneGain);
    osc2.start();
  } catch {
    loadingToneContext = undefined;
    loadingToneOscillator = undefined;
    loadingToneGain = undefined;
  }
}

function stopLoadingTone() {
  if (!loadingToneContext) return;
  try {
    if (loadingToneGain) {
      const now = loadingToneContext.currentTime;
      loadingToneGain.gain.cancelScheduledValues(now);
      loadingToneGain.gain.setValueAtTime(loadingToneGain.gain.value, now);
      loadingToneGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    }
    const ctx = loadingToneContext;
    setTimeout(() => ctx.close().catch(() => {}), 450);
  } catch { /* ignore */ }
  loadingToneContext = undefined;
  loadingToneOscillator = undefined;
  loadingToneGain = undefined;
  loadingToneRunId = "";
}

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
    nextSocket.send(JSON.stringify({ type: "session.start", profileId: "demo", userLabel: "web" }));
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    activeRunId = "";
    socket = undefined;
    clearPlayback();
    stopLoadingTone();
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
    finalizeTranscriptEntry();
    currentSpeechEntry = undefined;
    setStatus("Connected");
    addLog("session", JSON.stringify(message, null, 2));
  } else if (message.type === "transcript.delta") {
    appendTranscript(message.speaker ?? "assistant", message.text ?? "");
  } else if (message.type === "input.speech_started") {
    finalizeTranscriptEntry();
    const truncate = clearPlayback();
    requestResponseCancel("provider detected user speech", truncate);
    awaitingFirstAudio = false;
    pendingResponseSince = undefined;
    currentSpeechEntry = beginSpeechEntry();
  } else if (message.type === "input.speech_stopped") {
    const entry = currentSpeechEntry ?? beginSpeechEntry();
    renderSpeechChip(entry, message.durationS);
    currentSpeechEntry = undefined;
    startAssistantResponseClock();
  } else if (message.type === "audio.output") {
    if (awaitingFirstAudio && pendingResponseSince !== undefined) {
      currentTurnTtfaMs = performance.now() - pendingResponseSince;
      awaitingFirstAudio = false;
      renderTimingChip(ensureAssistantEntry());
    }
    void playPcmAudio(message.data, message.mimeType, message.itemId, message.contentIndex);
  } else if (message.type === "run.started") {
    finalizeTranscriptEntry();
    activeRunId = message.runId;
    fireSound("run.started");
    addLog("run", `started ${message.runId}`);
  } else if (message.type === "run.event") {
    handleRunEvent(message);
  } else if (message.type === "run.completed") {
    activeRunId = "";
    stopLoadingTone();
    fireSound("run.completed");
    if (currentTranscriptEntry && currentTranscriptSpeaker === "agent") {
      finalizeTranscriptEntry();
    } else {
      addLog("agent", message.output ?? "");
    }
  } else if (message.type === "approval.request") {
    activeRunId = message.runId;
    addApprovalRequest(message);
  } else if (message.type === "approval.responded") {
    addLog("approval", `submitted ${message.choice} for ${message.runId}`);
  } else if (message.type === "run.failed" || message.type === "session.error") {
    if (message.type === "run.failed") {
      activeRunId = "";
      finalizeTranscriptEntry();
      stopLoadingTone();
    } else {
      stopLoadingTone();
    }
    fireSound(message.type === "run.failed" ? "run.failed" : "session.error");
    setStatus(message.type === "run.failed" ? "Run failed" : "Error");
    clearPlayback();
    addLog("error", JSON.stringify(message, null, 2));
  } else if (message.type === "run.stopped") {
    activeRunId = "";
    stopLoadingTone();
    clearPlayback();
    addLog("run", `stopped ${message.runId}: ${message.status}`);
  } else if (message.type !== "realtime.message") {
    addLog(message.type, JSON.stringify(message, null, 2));
  }
}

function handleRunEvent(message) {
  const event = message.event ?? {};
  if (event.event === "message.delta" && typeof event.delta === "string") {
    appendTranscript("agent", event.delta);
    return;
  }
  if (event.event === "approval.request" || event.event === "run.completed" || event.event === "run.failed") {
    return;
  }
  fireSound("run.event");
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
  if (loadingToneGain && loadingToneContext) {
    loadingToneGain.gain.setValueAtTime(0, loadingToneContext.currentTime);
  }
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
  currentTurnSpokenMs += buffer.duration * 1000;
  renderTimingChip(ensureAssistantEntry());
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
      if (playbackSources.size === 0 && loadingToneGain && loadingToneContext && loadingToneRunId) {
        loadingToneGain.gain.exponentialRampToValueAtTime(0.06, loadingToneContext.currentTime + 0.4);
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
  const entry = createLogEntry(kind);
  const body = document.createElement("pre");
  body.textContent = value;
  entry.append(body);
  prependLogEntry(entry);
  return entry;
}

function beginSpeechEntry() {
  const entry = createLogEntry("speech");
  prependLogEntry(entry);
  return entry;
}

function appendTranscript(speaker, text) {
  const entry = ensureTranscriptEntry(speaker);
  entry.querySelector("pre").textContent += text;
  logEl.scrollTop = 0;
}

function finalizeTranscriptEntry() {
  currentTranscriptEntry = null;
  currentTranscriptSpeaker = "";
}

function addApprovalRequest(message) {
  const entry = createLogEntry("approval");
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

  entry.append(body, actions);
  prependLogEntry(entry);
}

function renderFilters() {
  if (!filtersEl) return;
  filtersEl.textContent = "";
  for (const kind of FILTER_KINDS) {
    const button = document.createElement("button");
    button.className = "filter-pill";
    button.type = "button";
    button.dataset.kind = kind;
    button.setAttribute("data-kind", kind);
    button.textContent = kind;
    syncFilterPill(button, true);
    button.addEventListener("click", () => {
      if (activeKinds.has(kind)) {
        activeKinds.delete(kind);
      } else {
        activeKinds.add(kind);
      }
      syncFilterPill(button, activeKinds.has(kind));
      applyFiltersToEntries();
    });
    filtersEl.append(button);
  }
}

function syncFilterPill(button, isActive) {
  button.setAttribute("aria-pressed", String(isActive));
  toggleClassName(button, "is-inactive", !isActive);
}

function applyFiltersToEntries() {
  for (const entry of logEl.querySelectorAll(".entry")) {
    applyFilterState(entry);
  }
}

function applyFilterState(entry) {
  const kind = entry.dataset.kind ?? entry.getAttribute("data-kind") ?? "";
  const isHidden = filterableKinds.has(kind) && !activeKinds.has(kind);
  toggleClassName(entry, "filter-hidden", isHidden);
}

function toggleClassName(element, className, enabled) {
  const tokens = (element.className || "").split(/\s+/).filter(Boolean);
  const index = tokens.indexOf(className);
  if (enabled && index === -1) {
    tokens.push(className);
  } else if (!enabled && index !== -1) {
    tokens.splice(index, 1);
  }
  element.className = tokens.join(" ");
}

function createLogEntry(kind) {
  const entry = document.createElement("div");
  entry.className = "entry";
  entry.dataset.kind = kind;
  entry.setAttribute("data-kind", kind);

  const title = document.createElement("strong");
  const label = document.createElement("span");
  label.className = "entry-label";
  label.textContent = kind;
  const timingChip = document.createElement("span");
  timingChip.className = "timing-chip";
  timingChip.hidden = true;

  title.append(label, timingChip);
  entry.append(title);
  applyFilterState(entry);
  return entry;
}

function prependLogEntry(entry) {
  logEl.prepend(entry);
  logEl.scrollTop = 0;
}

function ensureTranscriptEntry(speaker) {
  if (currentTranscriptEntry && currentTranscriptSpeaker === speaker) {
    return currentTranscriptEntry;
  }
  currentTranscriptEntry = addLog(speaker, "");
  currentTranscriptSpeaker = speaker;
  return currentTranscriptEntry;
}

function ensureAssistantEntry() {
  return ensureTranscriptEntry("assistant");
}

function renderTimingChip(entry) {
  const chip = entry.querySelector(".timing-chip");
  const parts = [
    currentTurnTtfaMs === undefined ? undefined : `TTFA ${Math.round(currentTurnTtfaMs)}ms`,
    currentTurnSpokenMs > 0 ? `spoken ${(currentTurnSpokenMs / 1000).toFixed(1)}s` : undefined,
  ].filter(Boolean);
  chip.textContent = parts.join(" · ");
  chip.hidden = parts.length === 0;
}

function renderSpeechChip(entry, durationS) {
  const chip = entry.querySelector(".timing-chip");
  const hasDuration = typeof durationS === "number" && Number.isFinite(durationS) && durationS > 0;
  chip.textContent = hasDuration ? `spoken ${durationS.toFixed(1)}s` : "";
  chip.hidden = !hasDuration;
}

function startAssistantResponseClock() {
  pendingResponseSince = performance.now();
  awaitingFirstAudio = true;
  currentTurnTtfaMs = undefined;
  currentTurnSpokenMs = 0;
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
