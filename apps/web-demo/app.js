import { HermesLiveAudio, HermesLiveClient } from "/hermes-live-client.js";

const ACTIVE_TASK_STATES = new Set([
  "accepted",
  "queued",
  "running",
  "stopping",
  "unknown",
]);
const MAX_VISIBLE_RECENT_TASKS = 12;
const MAX_VISIBLE_UNREAD_TASKS = 2_048;
const MAX_TASK_DETAIL_CHARS = 8_000;
const MAX_CONVERSATION_ENTRIES = 100;

const gatewayInput = document.querySelector("#gateway");
const tokenInput = document.querySelector("#token");
const connectButton = document.querySelector("#connect");
const micButton = document.querySelector("#mic");
const interruptButton = document.querySelector("#interrupt");
const form = document.querySelector("#text-form");
const textInput = document.querySelector("#text");
const sendButton = document.querySelector("#send");
const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");
const tasksEl = document.querySelector("#tasks");
const taskBadgeEl = document.querySelector("#task-badge");
const taskSummaryEl = document.querySelector("#task-summary");

let client;
let audio;
let connectPending = false;
let fatalSessionError = "";

setInteractive(false);
renderTaskInbox(emptyTaskSnapshot());
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
    if (client.session?.realtime?.audio?.output?.enabled) {
      void audio.primePlayback().catch(showError);
    }
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

async function connect() {
  connectPending = true;
  fatalSessionError = "";
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
  void nextAudio.primePlayback().catch((error) => {
    // Prime from the Connect gesture so real speech providers can unlock
    // autoplay. A text-only provider such as mock mode has no playback path,
    // so a browser without an audio device must not turn the session red.
    if (nextAudio === audio && nextClient.session?.realtime?.audio?.output?.enabled === true) {
      showError(error);
    }
  });
  try {
    await disposing;
    await nextClient.connect();
  } finally {
    connectPending = false;
  }
}

function bindSession(nextClient, nextAudio) {
  nextClient.subscribe((snapshot) => {
    if (nextClient === client) renderTaskInbox(snapshot);
  });
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
    if (nextClient === client) {
      addLog("audio", `Microphone frame dropped under backpressure (${bufferedAmount} bytes queued).`);
    }
  });
  nextClient.on("close", () => {
    if (nextClient !== client) return;
    setStatus(fatalSessionError ? "Error" : "Disconnected");
    setInteractive(false);
    connectButton.textContent = "Connect";
    renderTaskInbox(nextClient.getSnapshot());
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
    if (nextAudio === audio) {
      addLog("audio", `Provider audio dropped because ${Math.round(queuedMs)}ms was already queued.`);
    }
  });
}

function handleMessage(message) {
  if (message.type === "session.ready") {
    fatalSessionError = "";
    setStatus("Connected");
    setInteractive(true);
    addLog("session", "Live voice connected. You can keep talking while tasks run.");
  } else if (message.type === "transcript.delta") {
    addLog(message.speaker ?? "assistant", message.text ?? "");
  } else if (message.type === "input.speech_started") {
    audio.interrupt("provider detected user speech");
    addLog("speech", `started${message.audioStartMs === undefined ? "" : ` at ${message.audioStartMs}ms`}`);
  } else if (message.type === "audio.output") {
    void audio.play(message).catch(showError);
  } else if (message.type === "task.notification" && !message.notification.acknowledged) {
    addLog("task", message.notification.message);
  } else if (message.type === "task.failed" || message.type === "task.unknown") {
    addLog("task", message.error.message);
  } else if (message.type === "session.error") {
    setStatus("Error");
    audio?.clearPlayback();
    if (!message.recoverable) {
      fatalSessionError = String(message.message ?? "The Live Voice session failed.");
      setInteractive(false);
    }
    addLog("error", message.message ?? "The Live Voice session reported an error.");
  } else if (message.type === "log" && message.level !== "debug") {
    addLog(message.level, message.message);
  }
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
  audio = undefined;
  client = undefined;
  await Promise.allSettled([
    previousClient?.disconnect("replaced by new connection"),
    previousAudio?.dispose(),
  ]);
}

function renderTaskInbox(snapshot) {
  const activeTasks = Array.isArray(snapshot?.activeTasks) ? snapshot.activeTasks : [];
  const recentTasks = Array.isArray(snapshot?.recentTasks) ? snapshot.recentTasks : [];
  const unreadNotifications = Array.isArray(snapshot?.unreadNotifications)
    ? snapshot.unreadNotifications
    : [];
  const inboxItems = taskInboxItems(activeTasks, recentTasks, unreadNotifications);
  const visibleUnreadCount = inboxItems.filter((item) => item.notification).length;

  taskBadgeEl.textContent = String(visibleUnreadCount);
  taskBadgeEl.dataset.unread = visibleUnreadCount > 0 ? "true" : "false";
  taskBadgeEl.setAttribute(
    "aria-label",
    visibleUnreadCount === 0
      ? "No unread task updates"
      : `${visibleUnreadCount} unread task ${visibleUnreadCount === 1 ? "update" : "updates"}`,
  );
  taskSummaryEl.textContent = taskInboxSummary(activeTasks.length, recentTasks.length);
  tasksEl.innerHTML = "";

  if (inboxItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "task-empty";
    const mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "⋯";
    const copy = document.createElement("p");
    copy.textContent = "Tasks delegated during the conversation will appear here.";
    empty.append(mark, copy);
    tasksEl.append(empty);
    return;
  }

  for (const { task, notification } of inboxItems) {
    tasksEl.append(createTaskCard(task, notification, snapshot?.connection === "ready"));
  }
}

function taskInboxItems(activeTasks, recentTasks, unreadNotifications) {
  const taskById = new Map();
  for (const task of activeTasks.concat(recentTasks)) {
    if (task?.taskId && !taskById.has(task.taskId)) taskById.set(task.taskId, task);
  }
  const unreadByTask = new Map();
  for (const notification of unreadNotifications.slice(0, MAX_VISIBLE_UNREAD_TASKS)) {
    if (
      notification?.taskId &&
      taskById.has(notification.taskId) &&
      !unreadByTask.has(notification.taskId)
    ) {
      unreadByTask.set(notification.taskId, notification);
    }
  }

  const items = [];
  const seenTaskIds = new Set();
  const appendTask = (task) => {
    if (!task?.taskId || seenTaskIds.has(task.taskId)) return;
    seenTaskIds.add(task.taskId);
    items.push({ task, notification: unreadByTask.get(task.taskId) });
  };
  activeTasks.forEach(appendTask);
  unreadByTask.forEach((_notification, taskId) => appendTask(taskById.get(taskId)));
  recentTasks.slice(0, MAX_VISIBLE_RECENT_TASKS).forEach(appendTask);
  return items;
}

function createTaskCard(task, notification, connected) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.dataset.taskId = task.taskId;
  card.dataset.unread = notification ? "true" : "false";

  const header = document.createElement("div");
  header.className = "task-card__header";
  const title = document.createElement("h3");
  title.textContent = task.title || "Background task";
  title.title = task.title || task.taskId;
  const state = document.createElement("span");
  state.className = `task-state task-state--${task.state}`;
  state.textContent = taskStateLabel(task.state);
  header.append(title, state);

  const meta = document.createElement("div");
  meta.className = "task-card__meta";
  const id = document.createElement("code");
  id.textContent = task.taskId;
  id.title = `Stable task ID: ${task.taskId}`;
  const updated = document.createElement("time");
  updated.dateTime = new Date(task.updatedAt).toISOString();
  updated.textContent = formatTaskTime(task.updatedAt);
  meta.append(id, updated);

  card.append(header, meta);
  if (task.progress?.message) {
    const progress = document.createElement("p");
    progress.className = "task-card__progress";
    progress.textContent = taskProgressText(task.progress);
    card.append(progress);
  }
  if (notification) {
    const notice = document.createElement("p");
    notice.className = "task-card__notification";
    notice.textContent = notification.message;
    card.append(notice);
  }

  const actions = document.createElement("div");
  actions.className = "task-card__actions";
  if (isTaskStoppable(task)) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "danger";
    stop.textContent = task.state === "stopping" ? "Stopping…" : "Stop task";
    stop.disabled = !connected || task.state === "stopping";
    stop.setAttribute("aria-label", `Stop task ${task.taskId}`);
    stop.addEventListener("click", () => {
      try {
        client.stopTask(task.taskId, "stopped from Hermes Live web demo");
      } catch (error) {
        showError(error);
      }
    });
    actions.append(stop);
  }
  if (notification) {
    const acknowledge = document.createElement("button");
    acknowledge.type = "button";
    acknowledge.className = "secondary";
    acknowledge.textContent = "Mark read";
    acknowledge.disabled = !connected;
    acknowledge.setAttribute("aria-label", `Mark task ${task.taskId} update as read`);
    acknowledge.addEventListener("click", () => {
      try {
        client.acknowledgeNotification(task.taskId, notification.notificationId);
      } catch (error) {
        showError(error);
      }
    });
    actions.append(acknowledge);
  }
  if (actions.childElementCount > 0) card.append(actions);

  const detail = taskDetail(task);
  if (detail) {
    const details = document.createElement("details");
    details.className = "task-card__details";
    const summary = document.createElement("summary");
    summary.textContent = task.state === "completed" ? "View result" : "View details";
    const output = document.createElement("pre");
    output.textContent = detail;
    details.append(summary, output);
    card.append(details);
  }
  return card;
}

function emptyTaskSnapshot() {
  return { connection: "idle", activeTasks: [], recentTasks: [], unreadNotifications: [] };
}

function taskInboxSummary(activeCount, recentCount) {
  if (activeCount === 0 && recentCount === 0) return "No background tasks yet";
  if (activeCount === 0) return `${recentCount} recent ${recentCount === 1 ? "task" : "tasks"}`;
  return `${activeCount} active · ${recentCount} recent`;
}

function taskStateLabel(state) {
  const labels = {
    accepted: "Accepted",
    queued: "Queued",
    running: "Running",
    stopping: "Stopping",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    unknown: "Check status",
  };
  return labels[state] || "Updated";
}

function taskProgressText(progress) {
  const amount = progress.percent !== undefined
    ? `${Math.round(progress.percent)}%`
    : progress.current !== undefined && progress.total !== undefined
      ? `${progress.current}/${progress.total}`
      : "";
  return [progress.message, amount].filter(Boolean).join(" · ");
}

function taskDetail(task) {
  const value = task.result?.output ?? task.result?.summary ?? task.error?.message ?? "";
  if (!value) return "";
  return value.length > MAX_TASK_DETAIL_CHARS
    ? `${value.slice(0, MAX_TASK_DETAIL_CHARS)}\n\n[Result truncated in this view]`
    : value;
}

function isTaskStoppable(task) {
  return ACTIVE_TASK_STATES.has(task.state);
}

function formatTaskTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addLog(kind, value) {
  const text = String(value ?? "");
  if (!text) return;
  const entry = document.createElement("div");
  entry.className = "entry";
  entry.innerHTML = `<strong></strong><pre></pre>`;
  entry.querySelector("strong").textContent = kind;
  entry.querySelector("pre").textContent = text;
  logEl.append(entry);
  const entries = logEl.querySelectorAll(".entry");
  if (entries.length > MAX_CONVERSATION_ENTRIES) entries[0].remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(value) {
  statusEl.textContent = value;
  statusEl.className = `status ${value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

function setInteractive(enabled) {
  textInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  micButton.disabled = !enabled || client?.session?.realtime?.audio?.input?.enabled !== true;
  interruptButton.disabled = !enabled || client?.session?.realtime?.audio?.output?.enabled !== true;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus("Error");
  addLog("error", message);
}
