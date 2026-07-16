(function () {
  "use strict";

  const PLUGIN_NAME = "hermes-live";
  const STATUS_ENDPOINT = "/api/plugins/hermes-live/status";
  const LIVE_ENDPOINT = "/api/plugins/hermes-live/live";
  const MAX_TRANSCRIPT_ENTRIES = 80;
  const MAX_VISIBLE_RECENT_TASKS = 16;
  const MAX_VISIBLE_UNREAD_TASKS = 2_048;
  const MAX_TASK_DETAIL_CHARS = 12_000;
  const ACTIVE_TASK_STATES = new Set([
    "accepted",
    "queued",
    "running",
    "stopping",
    "unknown",
  ]);

  // Capture this while the IIFE is executing: document.currentScript is no
  // longer reliable after React mounts the page or an async import resolves.
  const ownScript = document.currentScript ||
    document.querySelector('script[data-hermes-plugin="hermes-live"]');
  const fallbackBase = new URL("./", document.baseURI || window.location.href);
  const assetBase = ownScript && ownScript.src
    ? new URL("./", ownScript.src)
    : new URL("dashboard-plugins/hermes-live/dist/", fallbackBase);
  let browserClientModule;

  function loadBrowserClient() {
    if (!browserClientModule) {
      browserClientModule = import(new URL("hermes-live-client.js", assetBase).href);
    }
    return browserClientModule;
  }

  function initialSnapshot() {
    return {
      connection: "idle",
      session: undefined,
      tasks: [],
      activeTasks: [],
      recentTasks: [],
      unreadNotifications: [],
    };
  }

  function initialMicrophone() {
    return { state: "idle", active: false };
  }

  function initialPlayback() {
    return { active: false, queued: 0, queuedMs: 0 };
  }

  function clampText(value, maximum) {
    const text = typeof value === "string" ? value : "";
    return text.length > maximum ? text.slice(0, maximum) + "\u2026" : text;
  }

  function friendlyError(error, fallback) {
    const message = error && typeof error.message === "string" ? error.message : "";
    if (!message) return fallback;
    return clampText(
      message.replace(/([?&](?:token|ticket)=)[^&\s)]+/gi, "$1[redacted]"),
      320,
    );
  }

  function shortId(value) {
    const text = typeof value === "string" ? value : "";
    if (text.length <= 22) return text;
    return text.slice(0, 11) + "\u2026" + text.slice(-7);
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function taskStatePresentation(state) {
    const values = {
      accepted: ["Accepted", "active"],
      queued: ["Queued", "active"],
      running: ["Running", "active"],
      stopping: ["Stopping", "warning"],
      completed: ["Completed", "success"],
      failed: ["Failed", "danger"],
      cancelled: ["Cancelled", "warning"],
      unknown: ["Check status", "danger"],
    };
    const value = values[state] || [titleCase(state || "updated"), "neutral"];
    return { label: value[0], tone: value[1] };
  }

  function isTaskActive(task) {
    return Boolean(task && ACTIVE_TASK_STATES.has(task.state));
  }

  function taskInboxItems(snapshot) {
    const activeTasks = Array.isArray(snapshot && snapshot.activeTasks) ? snapshot.activeTasks : [];
    const recentTasks = Array.isArray(snapshot && snapshot.recentTasks) ? snapshot.recentTasks : [];
    const notifications = Array.isArray(snapshot && snapshot.unreadNotifications)
      ? snapshot.unreadNotifications
      : [];
    const taskById = new Map();
    activeTasks.concat(recentTasks).forEach(function (task) {
      if (task && task.taskId && !taskById.has(task.taskId)) taskById.set(task.taskId, task);
    });
    const unreadByTask = new Map();
    notifications.slice(0, MAX_VISIBLE_UNREAD_TASKS).forEach(function (notification) {
      if (
        notification &&
        notification.taskId &&
        taskById.has(notification.taskId) &&
        !unreadByTask.has(notification.taskId)
      ) {
        unreadByTask.set(notification.taskId, notification);
      }
    });

    const items = [];
    const seenTaskIds = new Set();
    function appendTask(task) {
      if (!task || !task.taskId || seenTaskIds.has(task.taskId)) return;
      seenTaskIds.add(task.taskId);
      items.push({ task: task, notification: unreadByTask.get(task.taskId) });
    }

    activeTasks.forEach(appendTask);
    unreadByTask.forEach(function (_notification, taskId) { appendTask(taskById.get(taskId)); });
    recentTasks.slice(0, MAX_VISIBLE_RECENT_TASKS).forEach(appendTask);
    return items;
  }

  function taskProgressText(progress) {
    if (!progress || !progress.message) return "";
    const amount = progress.percent !== undefined
      ? Math.round(progress.percent) + "%"
      : progress.current !== undefined && progress.total !== undefined
        ? progress.current + "/" + progress.total
        : "";
    return [progress.message, amount].filter(Boolean).join(" \u00b7 ");
  }

  function taskDetail(task) {
    if (!task) return "";
    const result = task.result || {};
    const error = task.error || {};
    const value = result.output || result.summary || error.message || "";
    return clampText(value, MAX_TASK_DETAIL_CHARS);
  }

  function taskInboxSummary(snapshot) {
    const active = Array.isArray(snapshot && snapshot.activeTasks) ? snapshot.activeTasks.length : 0;
    const recent = Array.isArray(snapshot && snapshot.recentTasks) ? snapshot.recentTasks.length : 0;
    const unread = taskInboxItems(snapshot).filter(function (item) { return Boolean(item.notification); }).length;
    if (!active && !recent) return "No background tasks yet";
    const counts = active ? active + " active" : "No active tasks";
    return counts + " \u00b7 " + recent + " recent" + (unread ? " \u00b7 " + unread + " unread" : "");
  }

  function microphoneActiveGuidance(turnDetection) {
    return turnDetection === "disabled"
      ? "Push to talk is active. Speak, then stop the microphone to submit this turn."
      : "Speak naturally. You can interrupt Hermes at any time.";
  }

  function connectedSessionNotice(inputAudio, browserMicSupported) {
    if (browserMicSupported) {
      return "Connected. You can keep talking while tasks run.";
    }
    return inputAudio && inputAudio.enabled === false
      ? "Live Voice is connected in text mode. Type a message to Hermes."
      : "Live Voice is connected. Type a message to Hermes; microphone capture is unavailable for this session.";
  }

  function connectedSessionGuidance(browserMicSupported) {
    return browserMicSupported
      ? "Start the microphone or type a message below."
      : "Type a message below.";
  }

  function negotiatedInputAudio(snapshot, fallback) {
    const realtime = snapshot && snapshot.session && snapshot.session.realtime;
    const audio = realtime && realtime.audio;
    return audio && audio.input ? audio.input : (fallback || {});
  }

  function supportsBrowserMicrophone(inputAudio) {
    const mimeType = inputAudio && inputAudio.mimeType || "";
    return (!inputAudio || inputAudio.enabled !== false) &&
      (!mimeType || /^audio\/pcm(?:;|$)/i.test(mimeType));
  }

  function supportsBrowserPlayback(outputAudio) {
    const mimeType = outputAudio && outputAudio.mimeType || "";
    return (!outputAudio || outputAudio.enabled !== false) &&
      (!mimeType || /^audio\/pcm(?:;|$)/i.test(mimeType));
  }

  async function disconnectSession(audio, client, onAudioError) {
    void Promise.resolve()
      .then(function () {
        return audio ? audio.stopMicrophone({ endTurn: false }) : undefined;
      })
      .catch(function (error) {
        if (typeof onAudioError !== "function") return;
        try {
          onAudioError(error);
        } catch {
          // Protocol detach must remain independent of local UI reporting.
        }
      });
    await client.disconnect("user disconnected from dashboard");
  }

  function connectionClosedNotice(event, fatalNotice) {
    if (fatalNotice) return fatalNotice;
    return {
      tone: event && !event.clean ? "warning" : "neutral",
      text: event && !event.clean
        ? "Live Voice connection was lost. Reconnect to sync task updates."
        : "Live Voice disconnected.",
    };
  }

  function gatewayPresentation(status) {
    if (status.loading) return { label: "Checking", tone: "neutral", detail: "Probing the companion gateway" };
    if (status.configured === false) return {
      label: "Setup needed",
      tone: "warning",
      detail: "Configure the companion gateway in the Hermes environment.",
    };
    if (status.reachable === false) return {
      label: "Offline",
      tone: "danger",
      detail: "The companion gateway is configured but cannot be reached.",
    };
    if (status.ready === false) return {
      label: "Not ready",
      tone: "warning",
      detail: status.error || "The gateway is reachable but its provider or Hermes bridge is not ready.",
    };
    if (status.ready === true) return { label: "Ready", tone: "success", detail: "Gateway and Hermes bridge are ready." };
    if (status.error) return { label: "Unavailable", tone: "danger", detail: status.error };
    return { label: "Unknown", tone: "neutral", detail: "Gateway readiness has not been reported." };
  }

  function connectionPresentation(connection) {
    const values = {
      idle: ["Not connected", "neutral"],
      connecting: ["Connecting", "warning"],
      starting: ["Starting session", "warning"],
      ready: ["Live", "success"],
      closing: ["Disconnecting", "warning"],
      closed: ["Disconnected", "neutral"],
      failed: ["Connection failed", "danger"],
    };
    const value = values[connection] || [titleCase(connection), "neutral"];
    return { label: value[0], tone: value[1] };
  }

  function formatTaskTime(timestamp) {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function LiveVoicePage() {
    const SDK = window.__HERMES_PLUGIN_SDK__;
    if (!SDK || !SDK.React || !SDK.hooks) {
      return "Live Voice requires a newer Hermes Dashboard plugin SDK.";
    }

    const h = SDK.React.createElement;
    const hooks = SDK.hooks;
    if (typeof SDK.fetchJSON !== "function" || typeof SDK.buildWsUrl !== "function" ||
        typeof hooks.useState !== "function" || typeof hooks.useEffect !== "function" ||
        typeof hooks.useRef !== "function" || typeof hooks.useCallback !== "function") {
      return h("div", { className: "hlv-upgrade", role: "alert" },
        h("strong", null, "Dashboard update required"),
        h("p", null,
          "Live Voice needs the authenticated fetch and WebSocket helpers from a newer Hermes Dashboard. " +
          "Update Hermes, restart the dashboard, and reload this page.",
        ),
      );
    }

    const useState = hooks.useState;
    const useEffect = hooks.useEffect;
    const useRef = hooks.useRef;
    const useCallback = hooks.useCallback;

    const [gateway, setGateway] = useState({ loading: true });
    const [snapshot, setSnapshot] = useState(initialSnapshot);
    const [microphone, setMicrophone] = useState(initialMicrophone);
    const [playback, setPlayback] = useState(initialPlayback);
    const [transcript, setTranscript] = useState([]);
    const [textInput, setTextInput] = useState("");
    const [notice, setNotice] = useState(null);
    const [clientLoading, setClientLoading] = useState(true);
    const [busyAction, setBusyAction] = useState("");

    const clientRef = useRef(null);
    const audioRef = useRef(null);
    const ensureAudioRef = useRef(null);
    const audioUnsubscribersRef = useRef([]);
    const transcriptSequence = useRef(0);
    const transcriptEndRef = useRef(null);
    const fatalNoticeRef = useRef(null);

    const addTranscript = useCallback(function (speaker, text, final, source) {
      const normalized = clampText(text, 20_000);
      if (!normalized) return;
      setTranscript(function (current) {
        const last = current[current.length - 1];
        if (source === "stream" && last && last.source === "stream" &&
            last.speaker === speaker && !last.final) {
          const updated = current.slice();
          updated[updated.length - 1] = {
            ...last,
            text: clampText(last.text + normalized, 20_000),
            final: Boolean(final),
          };
          return updated;
        }
        const entry = {
          id: ++transcriptSequence.current,
          speaker: speaker || "system",
          text: normalized,
          final: Boolean(final),
          source: source || "stream",
        };
        return current.concat(entry).slice(-MAX_TRANSCRIPT_ENTRIES);
      });
    }, []);

    const finalizeAssistantTranscript = useCallback(function () {
      setTranscript(function (current) {
        const last = current[current.length - 1];
        if (!last || last.speaker !== "assistant" || last.final) return current;
        const updated = current.slice();
        updated[updated.length - 1] = { ...last, final: true };
        return updated;
      });
    }, []);

    const refreshStatus = useCallback(function () {
      setGateway(function (current) { return { ...current, loading: true, error: "" }; });
      return SDK.fetchJSON(STATUS_ENDPOINT)
        .then(function (value) {
          setGateway({ ...value, loading: false, error: value && value.error ? clampText(value.error, 260) : "" });
        })
        .catch(function (error) {
          setGateway({
            loading: false,
            error: friendlyError(error, "Could not reach the Live Voice dashboard service."),
          });
        });
    }, [SDK]);

    useEffect(function () {
      let active = true;
      refreshStatus();
      const interval = window.setInterval(function () {
        if (active) refreshStatus();
      }, 30_000);
      return function () {
        active = false;
        window.clearInterval(interval);
      };
    }, [refreshStatus]);

    useEffect(function () {
      let active = true;
      const clientUnsubscribers = [];

      function detachAudioListeners() {
        audioUnsubscribersRef.current.forEach(function (unsubscribe) { unsubscribe(); });
        audioUnsubscribersRef.current = [];
      }

      loadBrowserClient()
        .then(function (module) {
          if (!active) return;
          const client = new module.HermesLiveClient({
            webSocketUrlProvider: function () { return SDK.buildWsUrl(LIVE_ENDPOINT); },
          });
          clientRef.current = client;
          setSnapshot(client.getSnapshot());
          setClientLoading(false);

          ensureAudioRef.current = function () {
            const existing = audioRef.current;
            if (existing && existing.microphoneState !== "disposed") return existing;
            detachAudioListeners();
            const audio = new module.HermesLiveAudio(client, {
              workletUrl: new URL("mic-worklet.js", assetBase).href,
            });
            audioRef.current = audio;
            audioUnsubscribersRef.current = [
              audio.on("microphone", function (event) {
                if (active) setMicrophone(event);
              }),
              audio.on("playback", function (event) {
                if (active) setPlayback(event);
              }),
              audio.on("error", function (event) {
                if (active) setNotice({
                  tone: "danger",
                  text: friendlyError(event.error, "Browser audio failed."),
                });
              }),
              audio.on("audio.dropped", function () {
                if (active) setNotice({
                  tone: "warning",
                  text: "Some assistant audio was dropped to keep playback responsive.",
                });
              }),
            ];
            return audio;
          };

          clientUnsubscribers.push(
            client.subscribe(function (value) {
              if (active) setSnapshot(value);
            }),
            client.on("transcript.delta", function (message) {
              if (active) addTranscript(message.speaker, message.text, message.final, "stream");
            }),
            client.on("audio.output", function (message) {
              const audio = audioRef.current;
              if (!active || !audio) return;
              audio.play(message).catch(function (error) {
                if (active) setNotice({
                  tone: "danger",
                  text: friendlyError(error, "Assistant audio could not be played."),
                });
              });
            }),
            client.on("response.completed", function () {
              if (active) finalizeAssistantTranscript();
            }),
            client.on("response.cancelled", function () {
              if (!active) return;
              const audio = audioRef.current;
              if (audio) audio.clearPlayback();
              finalizeAssistantTranscript();
            }),
            client.on("response.failed", function (message) {
              if (!active) return;
              const audio = audioRef.current;
              if (audio) audio.clearPlayback();
              finalizeAssistantTranscript();
              setNotice({ tone: "danger", text: clampText(message.error, 300) });
            }),
            client.on("task.notification", function (message) {
              if (!active || message.notification.acknowledged) return;
              setNotice({ tone: "success", text: clampText(message.notification.message, 300) });
            }),
            client.on("task.failed", function (message) {
              if (active) setNotice({ tone: "danger", text: clampText(message.error.message, 300) });
            }),
            client.on("task.unknown", function (message) {
              if (active) setNotice({ tone: "warning", text: clampText(message.error.message, 300) });
            }),
            client.on("request.succeeded", function () {
              if (active) setBusyAction("");
            }),
            client.on("request.failed", function (event) {
              if (!active) return;
              setBusyAction("");
              setNotice({ tone: "danger", text: clampText(event.error.message, 300) });
            }),
            client.on("input.speech_started", function () {
              if (!active) return;
              const audio = audioRef.current;
              if (audio) audio.interrupt("provider detected user speech");
            }),
            client.on("audio.dropped", function () {
              if (active) setNotice({
                tone: "warning",
                text: "Microphone audio was briefly dropped because the connection was congested.",
              });
            }),
            client.on("error", function (event) {
              if (!active) return;
              setBusyAction("");
              const nextNotice = {
                tone: "danger",
                text: friendlyError(event.error, "The Live Voice session reported an error."),
              };
              if (event.detail && event.detail.type === "session.error" && event.detail.recoverable === false) {
                fatalNoticeRef.current = nextNotice;
              }
              setNotice(nextNotice);
            }),
            client.on("close", function (event) {
              if (!active) return;
              const oldAudio = audioRef.current;
              audioRef.current = null;
              detachAudioListeners();
              if (oldAudio) void oldAudio.dispose();
              setMicrophone(initialMicrophone());
              setPlayback(initialPlayback());
              setBusyAction("");
              setNotice(connectionClosedNotice(event, fatalNoticeRef.current));
            }),
          );
        })
        .catch(function (error) {
          if (!active) return;
          setClientLoading(false);
          setNotice({
            tone: "danger",
            text: friendlyError(error, "The Live Voice browser client could not be loaded."),
          });
        });

      return function () {
        active = false;
        ensureAudioRef.current = null;
        clientUnsubscribers.forEach(function (unsubscribe) { unsubscribe(); });
        detachAudioListeners();
        const audio = audioRef.current;
        const client = clientRef.current;
        audioRef.current = null;
        clientRef.current = null;
        if (audio) void audio.dispose();
        if (client) void client.disconnect("dashboard page closed").catch(function () { return undefined; });
      };
    }, [SDK, addTranscript, finalizeAssistantTranscript]);

    useEffect(function () {
      const element = transcriptEndRef.current;
      if (element && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }, [transcript.length]);

    function runAction(name, action) {
      setBusyAction(name);
      setNotice(null);
      return Promise.resolve()
        .then(action)
        .catch(function (error) {
          setNotice({ tone: "danger", text: friendlyError(error, "The action could not be completed.") });
        })
        .finally(function () { setBusyAction(""); });
    }

    function primePlaybackFromGesture() {
      const createAudio = ensureAudioRef.current;
      if (!createAudio) return null;
      const audio = createAudio();
      if (!supportsBrowserPlayback(outputAudio)) return audio;
      void audio.primePlayback().catch(function (error) {
        setNotice({
          tone: "warning",
          text: friendlyError(error, "Browser audio is blocked. Allow playback, then try again."),
        });
      });
      return audio;
    }

    function connect() {
      const client = clientRef.current;
      if (!client) return;
      fatalNoticeRef.current = null;
      primePlaybackFromGesture();
      runAction("connect", function () {
        return client.connect().then(function () {
          if (ensureAudioRef.current) ensureAudioRef.current();
          const connectedInputAudio = negotiatedInputAudio(client.getSnapshot(), inputAudio);
          setNotice({
            tone: "success",
            text: connectedSessionNotice(
              connectedInputAudio,
              supportsBrowserMicrophone(connectedInputAudio),
            ),
          });
          refreshStatus();
        });
      });
    }

    function disconnect() {
      const client = clientRef.current;
      if (!client) return;
      runAction("disconnect", function () {
        return disconnectSession(audioRef.current, client, function (error) {
          setNotice({
            tone: "warning",
            text: friendlyError(error, "Browser audio cleanup did not finish."),
          });
        }).then(function () {
          setNotice({
            tone: "neutral",
            text: "Voice disconnected. Reconnect to sync task updates.",
          });
        });
      });
    }

    function startMicrophone() {
      const audio = primePlaybackFromGesture();
      if (!audio) return;
      runAction("microphone", function () { return audio.startMicrophone(); });
    }

    function stopMicrophone() {
      const audio = audioRef.current;
      if (!audio) return;
      runAction("microphone", function () { return audio.stopMicrophone({ endTurn: true }); });
    }

    function interruptSpeech() {
      const audio = audioRef.current;
      const client = clientRef.current;
      if (!client) return;
      try {
        if (audio) audio.interrupt("interrupted from Hermes Dashboard");
        else client.cancelResponse("interrupted from Hermes Dashboard");
        setNotice({ tone: "neutral", text: "Assistant speech interrupted. Background tasks keep running." });
      } catch (error) {
        setNotice({ tone: "danger", text: friendlyError(error, "Assistant speech could not be interrupted.") });
      }
    }

    function stopTask(task) {
      const client = clientRef.current;
      if (!client || !task || task.state === "stopping") return;
      const action = "stop:" + task.taskId;
      setBusyAction(action);
      try {
        client.stopTask(task.taskId, "stopped from Hermes Dashboard");
        setNotice({ tone: "warning", text: "Stop requested for " + shortId(task.taskId) + ". Voice stays connected." });
      } catch (error) {
        setBusyAction("");
        setNotice({ tone: "danger", text: friendlyError(error, "The selected task could not be stopped.") });
      }
    }

    function acknowledgeTask(notification) {
      const client = clientRef.current;
      if (!client || !notification) return;
      const action = "ack:" + notification.taskId;
      setBusyAction(action);
      try {
        client.acknowledgeNotification(notification.taskId, notification.notificationId);
      } catch (error) {
        setBusyAction("");
        setNotice({ tone: "danger", text: friendlyError(error, "The task update could not be marked as read.") });
      }
    }

    function sendText(event) {
      event.preventDefault();
      const text = textInput.trim();
      const client = clientRef.current;
      if (!text || !client) return;
      try {
        const audio = primePlaybackFromGesture() || audioRef.current;
        if (audio) audio.interrupt("new Dashboard text input");
        else client.cancelResponse("new Dashboard text input");
        client.sendText(text);
        addTranscript("user", text, true, "local");
        setTextInput("");
      } catch (error) {
        setNotice({ tone: "danger", text: friendlyError(error, "The message could not be sent.") });
      }
    }

    const connection = connectionPresentation(snapshot.connection);
    const gatewayState = gatewayPresentation(gateway);
    const connected = snapshot.connection === "ready";
    const session = snapshot.session;
    const realtime = session && session.realtime ? session.realtime : {};
    const taskCapabilities = session && session.tasks ? session.tasks : gateway.tasks || {};
    const audioCapabilities = realtime.audio || gateway.audio || {};
    const inputAudio = audioCapabilities.input || {};
    const outputAudio = audioCapabilities.output || {};
    const inputMime = inputAudio.mimeType || "";
    const browserMicSupported = supportsBrowserMicrophone(inputAudio);
    const provider = realtime.provider || gateway.provider || "\u2014";
    const model = realtime.model || gateway.model || "\u2014";
    const protocolVersion = session && session.protocolVersion ? session.protocolVersion : gateway.protocolVersion || "\u2014";
    const activeTasks = Array.isArray(snapshot.activeTasks) ? snapshot.activeTasks : [];
    const unreadNotifications = Array.isArray(snapshot.unreadNotifications) ? snapshot.unreadNotifications : [];
    const inboxItems = taskInboxItems(snapshot);

    function StatusPill(props) {
      return h("span", { className: "hlv-pill hlv-pill--" + (props.tone || "neutral") },
        h("span", { className: "hlv-pill__dot", "aria-hidden": "true" }),
        props.children,
      );
    }

    function Metric(props) {
      return h("div", { className: "hlv-metric" },
        h("span", { className: "hlv-metric__label" }, props.label),
        h("strong", { className: "hlv-metric__value", title: String(props.value) }, props.value),
        props.detail ? h("span", { className: "hlv-metric__detail" }, props.detail) : null,
      );
    }

    function ControlButton(props) {
      return h("button", {
        type: props.type || "button",
        className: "hlv-button" +
          (props.variant ? " hlv-button--" + props.variant : "") +
          (props.wide ? " hlv-button--wide" : ""),
        disabled: Boolean(props.disabled),
        onClick: props.onClick,
        title: props.title,
        "aria-label": props.ariaLabel,
        "aria-pressed": props.pressed === undefined ? undefined : Boolean(props.pressed),
      }, props.icon ? h("span", { className: "hlv-button__icon", "aria-hidden": "true" }, props.icon) : null,
      h("span", null, props.children));
    }

    function TaskCard(item) {
      const task = item.task;
      const notification = item.notification;
      const state = taskStatePresentation(task.state);
      const progress = taskProgressText(task.progress);
      const detail = taskDetail(task);
      const stopBusy = busyAction === "stop:" + task.taskId;
      const ackBusy = busyAction === "ack:" + task.taskId;
      const titleId = "hlv-task-title-" + task.taskId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
      return h("article", {
        key: task.taskId,
        className: "hlv-task-item" + (notification ? " hlv-task-item--unread" : ""),
        "aria-labelledby": titleId,
      },
        h("div", { className: "hlv-task-item__header" },
          h("div", null,
            h("h3", { id: titleId, title: task.title || task.taskId }, task.title || "Background task"),
            h("code", { title: "Stable task ID: " + task.taskId }, shortId(task.taskId)),
          ),
          h(StatusPill, { tone: state.tone }, state.label),
        ),
        h("div", { className: "hlv-task-item__meta" },
          h("time", { dateTime: new Date(task.updatedAt).toISOString() }, formatTaskTime(task.updatedAt)),
        ),
        progress ? h("p", { className: "hlv-task-item__progress" }, progress) : null,
        notification ? h("p", { className: "hlv-task-item__notice", role: "status" }, notification.message) : null,
        detail ? h("details", { className: "hlv-task-item__details" },
          h("summary", null, task.state === "completed" ? "View result" : "View details"),
          h("pre", null, detail),
        ) : null,
        isTaskActive(task) || notification ? h("div", { className: "hlv-task-item__actions" },
          isTaskActive(task) ? h(ControlButton, {
            variant: "danger",
            disabled: !connected || task.state === "stopping" || stopBusy,
            onClick: function () { stopTask(task); },
            ariaLabel: "Stop task " + task.taskId,
          }, task.state === "stopping" || stopBusy ? "Stopping\u2026" : "Stop task") : null,
          notification ? h(ControlButton, {
            variant: "ghost",
            disabled: !connected || ackBusy,
            onClick: function () { acknowledgeTask(notification); },
            ariaLabel: "Mark task " + task.taskId + " update as read",
          }, ackBusy ? "Marking\u2026" : "Mark read") : null,
        ) : null,
      );
    }

    return h("div", { className: "hlv-page" },
      h("section", { className: "hlv-hero" },
        h("div", { className: "hlv-hero__copy" },
          h("span", { className: "hlv-kicker" },
            h("span", { className: "hlv-kicker__wave", "aria-hidden": "true" }, "\u223F"),
            "Hermes Live Voice",
          ),
          h("h1", null, "Hermes, now with a real-time voice."),
          h("p", null, "Speak, delegate, keep talking, and hear back when the work is done."),
        ),
        h("div", { className: "hlv-hero__status", "aria-live": "polite" },
          h(StatusPill, { tone: gatewayState.tone }, "Gateway ", gatewayState.label),
          h(StatusPill, { tone: connection.tone }, connection.label),
        ),
      ),

      notice ? h("div", {
        className: "hlv-notice hlv-notice--" + notice.tone,
        role: notice.tone === "danger" ? "alert" : "status",
      },
        h("span", null, notice.text),
        h("button", { type: "button", onClick: function () { setNotice(null); }, "aria-label": "Dismiss message" }, "\u00d7"),
      ) : null,

      h("div", { className: "hlv-durable-strip", role: "status" },
        h("span", { className: "hlv-durable-strip__icon", "aria-hidden": "true" }, "\u25c9"),
        h("div", null,
          h("strong", null, taskInboxSummary(snapshot)),
          h("span", null, " Voice can disconnect without cancelling tasks."),
        ),
      ),

      h("div", { className: "hlv-grid" },
        h("section", { className: "hlv-card hlv-console" },
          h("div", { className: "hlv-card__header" },
            h("div", null,
              h("span", { className: "hlv-eyebrow" }, "Voice console"),
              h("h2", null, connected ? "Session live" : "Ready when you are"),
            ),
            h(StatusPill, { tone: connection.tone }, connection.label),
          ),
          h("div", {
            className: "hlv-orb" +
              (microphone.active ? " hlv-orb--listening" : "") +
              (playback.active ? " hlv-orb--speaking" : ""),
            "aria-hidden": "true",
          },
            h("span", { className: "hlv-orb__ring hlv-orb__ring--one" }),
            h("span", { className: "hlv-orb__ring hlv-orb__ring--two" }),
            h("span", { className: "hlv-orb__core" }, microphone.active ? "\u25cf" : playback.active ? "\u223F" : "H"),
          ),
          h("div", { className: "hlv-console__state", "aria-live": "polite" },
            h("strong", null,
              microphone.state === "starting" ? "Requesting microphone\u2026" :
              microphone.active ? "Listening" : playback.active ? "Hermes is speaking" :
              connected ? "Connected and ready" : "Voice session is offline",
            ),
            h("span", null,
              microphone.active ? microphoneActiveGuidance(audioCapabilities.turnDetection) :
              playback.active ? "Interrupt speech whenever you want; background tasks keep running." :
              connected ? connectedSessionGuidance(browserMicSupported) : gatewayState.detail,
            ),
          ),
          h("div", { className: "hlv-connect-row" },
            connected
              ? h(ControlButton, {
                  variant: "secondary",
                  disabled: busyAction === "disconnect",
                  onClick: disconnect,
                }, busyAction === "disconnect" ? "Disconnecting\u2026" : "Disconnect voice")
              : h(ControlButton, {
                  variant: "primary",
                  wide: true,
                  disabled: clientLoading || busyAction === "connect" ||
                    ["connecting", "starting", "closing"].includes(snapshot.connection),
                  onClick: connect,
                }, clientLoading ? "Loading voice client\u2026" : busyAction === "connect" ? "Connecting\u2026" : "Connect Live Voice"),
          ),
          h("div", { className: "hlv-control-grid hlv-control-grid--voice" },
            microphone.active
              ? h(ControlButton, {
                  variant: "primary",
                  pressed: true,
                  disabled: busyAction === "microphone",
                  icon: "\u25a0",
                  onClick: stopMicrophone,
                }, busyAction === "microphone"
                  ? "Stopping\u2026"
                  : audioCapabilities.turnDetection === "disabled" ? "Stop & send turn" : "Stop microphone")
              : h(ControlButton, {
                  variant: "secondary",
                  pressed: false,
                  disabled: !connected || !browserMicSupported || busyAction === "microphone",
                  title: !browserMicSupported ? "This session does not expose browser-compatible PCM microphone input." : "",
                  icon: "\u25cf",
                  onClick: startMicrophone,
                }, busyAction === "microphone" ? "Starting\u2026" : "Start microphone"),
            h(ControlButton, {
              variant: "warning",
              disabled: !connected,
              icon: "\u2016",
              onClick: interruptSpeech,
              title: "Cancel only the current assistant response.",
            }, "Interrupt speech"),
          ),
          !browserMicSupported && connected ? h("p", { className: "hlv-inline-warning" },
            inputAudio.enabled === false
              ? "This provider session does not accept microphone audio. Text input remains available."
              : "Browser capture supports PCM16 input, but this session negotiated " + inputMime + ". Text input remains available.",
          ) : null,
          h("form", { className: "hlv-composer", onSubmit: sendText },
            h("label", { htmlFor: "hlv-text-input" }, "Type to Hermes"),
            h("div", { className: "hlv-composer__row" },
              h("textarea", {
                id: "hlv-text-input",
                rows: 2,
                maxLength: 16_000,
                value: textInput,
                disabled: !connected,
                placeholder: connected ? "Ask, delegate, or keep the conversation going\u2026" : "Connect Live Voice to send a message",
                onChange: function (event) { setTextInput(event.target.value); },
                onKeyDown: function (event) {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendText(event);
                },
              }),
              h("button", {
                type: "submit",
                className: "hlv-send",
                disabled: !connected || !textInput.trim(),
                "aria-label": "Send message",
                title: "Send (Command or Control + Enter)",
              }, "\u2191"),
            ),
            h("span", { className: "hlv-composer__hint" }, "Voice stays available while tasks run."),
          ),
        ),

        h("aside", { className: "hlv-side" },
          h("section", { className: "hlv-card hlv-session-card" },
            h("div", { className: "hlv-card__header" },
              h("div", null,
                h("span", { className: "hlv-eyebrow" }, "Connection details"),
                h("h2", null, "Live status"),
              ),
              h("button", {
                type: "button",
                className: "hlv-icon-button",
                onClick: refreshStatus,
                disabled: gateway.loading,
                title: "Refresh gateway status",
                "aria-label": "Refresh gateway status",
              }, "\u21bb"),
            ),
            h("div", { className: "hlv-metrics" },
              h(Metric, { label: "Gateway", value: gatewayState.label, detail: gatewayState.detail }),
              h(Metric, { label: "Realtime provider", value: titleCase(provider) }),
              h(Metric, { label: "Model", value: model }),
              h(Metric, { label: "Protocol", value: "v" + protocolVersion }),
              h(Metric, {
                label: "Background tasks",
                value: taskCapabilities.durable === false ? "Session only" : "Durable",
                detail: taskCapabilities.parallel
                  ? "Up to " + (taskCapabilities.maxConcurrent || "multiple") + " read-only tasks"
                  : "One task at a time",
              }),
              h(Metric, {
                label: "Microphone input",
                value: inputAudio.enabled === false ? "Disabled" : inputMime || "Negotiated on connect",
                detail: inputAudio.recommendedFrameMs ? inputAudio.recommendedFrameMs + " ms frames" : "",
              }),
            ),
            h("p", { className: "hlv-security-note" },
              h("span", { "aria-hidden": "true" }, "\u25c8"),
              " Dashboard authentication is exchanged server-side. Gateway credentials are never stored in this page.",
            ),
          ),
        ),
      ),

      h("section", {
        className: "hlv-card hlv-task-inbox",
        "aria-labelledby": "hlv-task-inbox-title",
      },
        h("div", { className: "hlv-card__header" },
          h("div", null,
            h("span", { className: "hlv-eyebrow" }, "Durable background work"),
            h("h2", { id: "hlv-task-inbox-title" }, "Task inbox"),
          ),
          h("div", { className: "hlv-task-inbox__counts" },
            activeTasks.length ? h(StatusPill, { tone: "active" }, activeTasks.length + " active") : null,
            h("span", {
              className: "hlv-unread-badge" + (unreadNotifications.length ? " hlv-unread-badge--active" : ""),
              "aria-label": unreadNotifications.length
                ? unreadNotifications.length + " unread task updates"
                : "No unread task updates",
            }, unreadNotifications.length),
          ),
        ),
        h("p", { className: "hlv-task-inbox__copy" },
          "Tasks can finish in any order. Each card keeps its task ID and latest state.",
        ),
        h("div", {
          className: "hlv-task-list",
          "aria-live": "polite",
          "aria-relevant": "additions text",
        },
          inboxItems.length
            ? inboxItems.map(TaskCard)
            : h("div", { className: "hlv-empty hlv-empty--compact" },
                h("span", { "aria-hidden": "true" }, "\u22ef"),
                h("p", null, "Delegate a background task during the conversation. It will appear here without blocking voice."),
              ),
        ),
      ),

      h("section", { className: "hlv-card hlv-conversation" },
        h("div", { className: "hlv-card__header" },
          h("div", null,
            h("span", { className: "hlv-eyebrow" }, "Realtime transcript"),
            h("h2", null, "Conversation"),
          ),
          transcript.length ? h("button", {
            type: "button",
            className: "hlv-text-button",
            onClick: function () { setTranscript([]); },
          }, "Clear transcript") : null,
        ),
        h("div", { className: "hlv-transcript", "aria-live": "polite", "aria-relevant": "additions text" },
          transcript.length
            ? transcript.map(function (entry) {
                return h("article", { key: entry.id, className: "hlv-message hlv-message--" + entry.speaker },
                  h("div", { className: "hlv-message__speaker" },
                    h("span", { className: "hlv-message__avatar", "aria-hidden": "true" }, entry.speaker === "user" ? "Y" : entry.speaker === "assistant" ? "V" : "i"),
                    h("strong", null, entry.speaker === "user" ? "You" : entry.speaker === "assistant" ? "Live voice" : "System"),
                    !entry.final ? h("span", { className: "hlv-message__streaming" }, "Live") : null,
                  ),
                  h("p", null, entry.text),
                );
              })
            : h("div", { className: "hlv-empty" },
                h("div", { className: "hlv-empty__mark", "aria-hidden": "true" }, "\u223F"),
                h("h3", null, "Your conversation will appear here"),
                h("p", null, "Connect, start the microphone, and speak naturally \u2014 or use text when voice is unavailable."),
              ),
          h("div", { ref: transcriptEndRef }),
        ),
      ),

      h("footer", { className: "hlv-footer" },
        h("p", null,
          "Voice is a detachable session. Explicit Stop buttons target one stable task; leaving this page does not cancel background work.",
        ),
      ),
    );
  }

  const registry = window.__HERMES_PLUGINS__;
  if (registry && typeof registry.register === "function") {
    registry.register(PLUGIN_NAME, LiveVoicePage);
  }
})();
