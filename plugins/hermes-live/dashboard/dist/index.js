(function () {
  "use strict";

  const PLUGIN_NAME = "hermes-live";
  const STATUS_ENDPOINT = "/api/plugins/hermes-live/status";
  const LIVE_ENDPOINT = "/api/plugins/hermes-live/live";
  const MAX_VISIBLE_RECENT_TASKS = 16;
  const MAX_VISIBLE_UNREAD_TASKS = 2_048;
  const ACTIVE_TASK_STATES = new Set([
    "accepted",
    "queued",
    "running",
    "stopping",
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

  // Hermes documents /chat?resume=<id> as its native conversation route.
  // Never infer the selected conversation from private React state or DOM.
  function selectedChat() {
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("resume");
    return {
      active: /(?:^|\/)chat\/?$/.test(url.pathname),
      sessionId: sessionId && /^[A-Za-z0-9_.:-]{1,256}$/.test(sessionId) ? sessionId : null,
      key: url.pathname + url.search,
    };
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
    return value;
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

  function connectedSessionNotice(inputAudio, browserMicSupported, listening) {
    if (browserMicSupported) {
      return listening
        ? "Connected and listening. You can keep talking while tasks run."
        : "Connected. You can keep talking while tasks run.";
    }
    return inputAudio && inputAudio.enabled === false
      ? "Voice input is unavailable for this session."
      : "Voice is connected, but microphone capture is unavailable for this session.";
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

  async function startMicrophoneAfterConnect(audio, inputAudio, isCurrent) {
    if (!audio || !supportsBrowserMicrophone(inputAudio)) return { started: false };
    try {
      await audio.startMicrophone();
      if (typeof isCurrent === "function" && !isCurrent()) {
        try {
          await audio.stopMicrophone({ endTurn: false });
        } catch (_) {}
        return { started: false, stale: true };
      }
      return { started: true };
    } catch (error) {
      return { started: false, error: error };
    }
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
      detail: "Run hermes-live setup, then restart Hermes Dashboard.",
    };
    if (status.reachable === false) return {
      label: "Offline",
      tone: "danger",
      detail: "The gateway is offline. Run hermes-live service status, then hermes-live doctor.",
    };
    if (status.error === "wrong_gateway_service") return {
      label: "Wrong service",
      tone: "danger",
      detail: "Another app is using the configured port. Run hermes-live setup, then restart Hermes Dashboard.",
    };
    if (status.ready === false) return {
      label: "Not ready",
      tone: "warning",
      detail: status.provider === "local"
        ? "Local voice is not ready. Run hermes-live local restart, then hermes-live doctor."
        : (status.error || "The provider or Hermes bridge is not ready.") + " Run hermes-live doctor for the exact fix.",
    };
    if (status.ready === true) return { label: "Ready", tone: "success", detail: "Gateway and Hermes bridge are ready." };
    if (status.error) return {
      label: "Unavailable",
      tone: "danger",
      detail: status.error + " Run hermes-live doctor for the exact fix.",
    };
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

  function connectControlPresentation(gateway, clientLoading, busyAction, connection) {
    const transition = ["connecting", "starting", "closing"].includes(connection);
    const gatewayReady = gateway && gateway.ready === true;
    return {
      disabled: Boolean(clientLoading || busyAction === "connect" || transition || !gatewayReady),
      label: clientLoading
        ? "Loading voice client\u2026"
        : busyAction === "connect"
          ? "Connecting\u2026"
          : gateway && gateway.loading
            ? "Checking gateway\u2026"
            : !gatewayReady
              ? "Gateway not ready"
              : "Connect",
    };
  }

  function ControlButton(props) {
    const SDK = window.__HERMES_PLUGIN_SDK__;
    return SDK.React.createElement(SDK.components.Button, {
      type: "button", size: "sm", outlined: true,
      disabled: Boolean(props.disabled), onClick: props.onClick,
      title: props.title, "aria-label": props.ariaLabel,
      "aria-pressed": props.pressed,
    }, props.children);
  }

  function LiveVoiceControls() {
    const SDK = window.__HERMES_PLUGIN_SDK__;
    if (!SDK || !SDK.React || !SDK.hooks) {
      return "Live Voice requires a newer Hermes Dashboard plugin SDK.";
    }

    const h = SDK.React.createElement;
    const hooks = SDK.hooks;
    const UI = SDK.components || {};
    if (typeof SDK.fetchJSON !== "function" || typeof SDK.buildWsUrl !== "function" ||
        typeof hooks.useState !== "function" || typeof hooks.useEffect !== "function" ||
        typeof hooks.useRef !== "function" || typeof hooks.useCallback !== "function" ||
        !UI.Button || !UI.Card || !UI.CardContent || !UI.Badge) {
      return h("div", { role: "alert" },
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
    const [chat, setChat] = useState(selectedChat);
    const chatRef = useRef(chat);
    const [snapshot, setSnapshot] = useState(initialSnapshot);
    const [microphone, setMicrophone] = useState(initialMicrophone);
    const [playback, setPlayback] = useState(initialPlayback);
    const [notice, setNotice] = useState(null);
    const [clientLoading, setClientLoading] = useState(true);
    const [busyAction, setBusyAction] = useState("");
    const [pendingTaskActions, setPendingTaskActions] = useState([]);

    const clientRef = useRef(null);
    const audioRef = useRef(null);
    const ensureAudioRef = useRef(null);
    const audioUnsubscribersRef = useRef([]);
    const disconnectNoticeRef = useRef(null);
    const taskRequestsRef = useRef(new Map());

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
              audio.on("audio.dropped", function (event) {
                if (!active) return;
                var seconds = Math.round(event.maxQueuedAudioMs / 1000);
                console.warn("[Hermes Live] Assistant playback buffer overflowed.", event);
                setNotice({
                  tone: "warning",
                  text: "Assistant audio exceeded the " + seconds + " second playback buffer. This reply is incomplete.",
                });
              }),
            ];
            return audio;
          };

          clientUnsubscribers.push(
            client.subscribe(function (value) {
              if (!active) return;
              setSnapshot(value);
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
            client.on("response.started", function () {
              if (!active) return;
              const retained = disconnectNoticeRef.current;
              if (retained && !retained.sticky) disconnectNoticeRef.current = null;
            }),
            client.on("response.cancelled", function () {
              if (!active) return;
              const audio = audioRef.current;
              if (audio) audio.clearPlayback();
            }),
            client.on("response.failed", function (message) {
              if (!active) return;
              const audio = audioRef.current;
              if (audio) audio.clearPlayback();
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
            client.on("request.succeeded", function (event) {
              if (!active) return;
              taskRequestsRef.current.delete(event.requestId);
              setPendingTaskActions(Array.from(taskRequestsRef.current.values()));
              if (event.request.type === "task.get" && event.response.tasks.length === 0) {
                setNotice({ tone: "warning", text: "This task is no longer retained by the gateway." });
              }
            }),
            client.on("request.failed", function (event) {
              if (!active) return;
              taskRequestsRef.current.delete(event.requestId);
              setPendingTaskActions(Array.from(taskRequestsRef.current.values()));
              setNotice({ tone: "danger", text: clampText(event.error.message, 300) });
            }),
            client.on("input.speech_started", function () {
              if (!active) return;
              const audio = audioRef.current;
              if (audio) audio.interrupt("provider detected user speech");
            }),
            client.on("input.pause_requested", function () {
              if (!active) return;
              const audio = audioRef.current;
              if (!audio) {
                setNotice({ tone: "neutral", text: "Listening is paused. Press Start microphone when you want to resume." });
                return;
              }
              void audio.stopMicrophone({ endTurn: false }).then(function () {
                if (active) setNotice({
                  tone: "neutral",
                  text: "Listening paused by voice command. Press Start microphone when you want to resume.",
                });
              }).catch(function (error) {
                if (active) setNotice({
                  tone: "warning",
                  text: friendlyError(error, "The microphone pause did not finish. Press Pause microphone."),
                });
              });
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
              if (event.code === "connection_lost" && disconnectNoticeRef.current) {
                setNotice(disconnectNoticeRef.current.notice);
                return;
              }
              const nextNotice = {
                tone: "danger",
                text: friendlyError(event.error, "The Live Voice session reported an error."),
              };
              if (event.detail && event.detail.type === "session.error") {
                disconnectNoticeRef.current = {
                  notice: nextNotice,
                  sticky: event.detail.recoverable === false,
                };
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
              taskRequestsRef.current.clear();
              setPendingTaskActions([]);
              setNotice(connectionClosedNotice(
                event,
                disconnectNoticeRef.current && disconnectNoticeRef.current.notice,
              ));
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
    }, [SDK]);

    useEffect(function () {
      function syncChat() {
        const next = selectedChat();
        if (next.key === chatRef.current.key) return;
        chatRef.current = next;
        setChat(next);
        const client = clientRef.current;
        if (client && ["connecting", "starting", "ready"].includes(client.getSnapshot().connection)) {
          const audio = audioRef.current;
          if (audio) audio.clearPlayback();
          void disconnectSession(audio, client).catch(function (error) {
            setNotice({ tone: "danger", text: friendlyError(error, "Could not detach voice from the previous chat.") });
          });
        }
      }
      // Browser navigation events cover Back/Forward. Hermes's router also
      // changes the documented URL with pushState, which emits no event.
      const interval = window.setInterval(syncChat, 250);
      window.addEventListener("popstate", syncChat);
      window.addEventListener("focus", syncChat);
      return function () {
        window.clearInterval(interval);
        window.removeEventListener("popstate", syncChat);
        window.removeEventListener("focus", syncChat);
      };
    }, []);

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
      const target = selectedChat();
      if (!client || !target.active || !target.sessionId) return;
      chatRef.current = target;
      disconnectNoticeRef.current = null;
      const audio = primePlaybackFromGesture();
      runAction("connect", function () {
        const conversation = { mode: "resume", sessionId: target.sessionId };
        return client.connect({ conversation: conversation }).then(function () {
          if (selectedChat().key !== target.key) return disconnectSession(audio, client);
          if (ensureAudioRef.current) ensureAudioRef.current();
          const connectedInputAudio = negotiatedInputAudio(client.getSnapshot(), inputAudio);
          const browserMicrophoneSupported = supportsBrowserMicrophone(connectedInputAudio);
          setNotice({
            tone: "success",
            text: browserMicrophoneSupported
              ? "Live Voice connected. Allow microphone access to start talking."
              : connectedSessionNotice(connectedInputAudio, false, false),
          });
          void startMicrophoneAfterConnect(audio, connectedInputAudio, function () {
            return clientRef.current === client && client.connected && audioRef.current === audio && selectedChat().key === target.key;
          }).then(function (microphoneStart) {
            if (clientRef.current !== client || !client.connected || audioRef.current !== audio || selectedChat().key !== target.key) return;
            setNotice(microphoneStart.error
              ? {
                  tone: "warning",
                  text: friendlyError(
                    microphoneStart.error,
                    "Live Voice connected, but microphone access failed. Allow it and press Start microphone.",
                  ),
                }
              : {
                  tone: "success",
                  text: connectedSessionNotice(
                    connectedInputAudio,
                    browserMicrophoneSupported,
                    microphoneStart.started,
                  ),
                });
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

    function runTaskAction(action, sendRequest, errorMessage) {
      if (Array.from(taskRequestsRef.current.values()).includes(action)) return false;
      try {
        const requestId = sendRequest();
        taskRequestsRef.current.set(requestId, action);
        setPendingTaskActions(Array.from(taskRequestsRef.current.values()));
        return true;
      } catch (error) {
        setNotice({ tone: "danger", text: friendlyError(error, errorMessage) });
        return false;
      }
    }

    function stopTask(task) {
      const client = clientRef.current;
      if (!client || !task || task.state === "stopping") return;
      if (runTaskAction("stop:" + task.taskId, function () {
        return client.stopTask(task.taskId, "stopped from Hermes Dashboard");
      }, "The selected task could not be stopped.")) {
        setNotice({ tone: "warning", text: "Stop requested for " + (task.title || "this task") + "." });
      }
    }

    function acknowledgeTask(notification) {
      const client = clientRef.current;
      if (!client || !notification) return;
      runTaskAction("ack:" + notification.taskId, function () {
        return client.acknowledgeNotification(notification.taskId, notification.notificationId);
      }, "The task update could not be marked as read.");
    }

    function loadTaskResult(task) {
      const client = clientRef.current;
      if (!client || !client.connected || !task.result || task.result.output !== undefined || !task.result.truncated) return;
      runTaskAction("get:" + task.taskId, function () { return client.getTask(task.taskId); }, "Could not load this result. Try again.");
    }

    const connection = connectionPresentation(snapshot.connection);
    const gatewayState = gatewayPresentation(gateway);
    const connectControl = connectControlPresentation(gateway, clientLoading, busyAction, snapshot.connection);
    const connected = snapshot.connection === "ready";
    const session = snapshot.session;
    const realtime = session && session.realtime ? session.realtime : {};
    const audioCapabilities = realtime.audio || gateway.audio || {};
    const inputAudio = audioCapabilities.input || {};
    const outputAudio = audioCapabilities.output || {};
    const browserMicSupported = supportsBrowserMicrophone(inputAudio);
    const inboxItems = taskInboxItems(snapshot);

    function TaskCard(item) {
      const task = item.task;
      const notification = item.notification;
      const state = taskStatePresentation(task.state);
      const progress = taskProgressText(task.progress);
      const detail = taskDetail(task);
      const result = task.result || {};
      const needsResult = task.state === "completed" && result.truncated && result.output === undefined;
      const loading = pendingTaskActions.includes("get:" + task.taskId);
      return h(UI.Card, { key: task.taskId, "data-voice-task": task.taskId },
        h(UI.CardContent, { style: { padding: "1rem" } },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" } },
          h("strong", null, task.title || "Background task"),
          h(UI.Badge, { variant: "outline" }, state.label),
        ),
        progress ? h("p", { style: { opacity: 0.7 } }, progress) : null,
        notification ? h("p", { role: "status" }, notification.message) : null,
        detail || needsResult ? h("details", {
          "data-voice-result": true,
          onToggle: function (event) { if (event.currentTarget.open) loadTaskResult(task); },
        },
          h("summary", null, task.state === "completed" ? "View result" : "View details"),
          loading ? h("p", { role: "status" }, "Loading result…") : null,
          h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "20rem", overflow: "auto" } }, detail),
          needsResult ? h("p", { style: { opacity: 0.7 } },
            connected ? "Summary shown. Load the retained result for full details." : "Reconnect to load the retained result.",
            connected ? h(ControlButton, { disabled: loading, onClick: function () { loadTaskResult(task); } }, "Load full result") : null,
          ) : result.truncated ? h("p", { style: { opacity: 0.7 } }, "This result was shortened before storage.") : null,
        ) : null,
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem" } },
          isTaskActive(task) ? h(ControlButton, {
            disabled: !connected || task.state === "stopping" || pendingTaskActions.includes("stop:" + task.taskId),
            onClick: function () { stopTask(task); },
            ariaLabel: "Stop task " + (task.title || task.taskId),
          }, task.state === "stopping" ? "Stopping…" : "Stop task") : null,
          notification ? h(ControlButton, {
            disabled: !connected || pendingTaskActions.includes("ack:" + task.taskId),
            onClick: function () { acknowledgeTask(notification); },
          }, "Mark read") : null,
        ),
        ),
      );
    }

    return h(UI.Card, { "aria-label": "Live Voice" },
      h(UI.CardContent, { style: { padding: "0.75rem 1rem" } },
        h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" } },
          h("strong", { style: { marginRight: "auto" } }, "Live Voice"),
          h(UI.Badge, { variant: "outline", role: "status" },
            playback.active ? "Speaking" : microphone.active ? "Listening" : connection.label,
          ),
          connected ? h(ControlButton, {
            disabled: busyAction === "disconnect", onClick: disconnect,
            title: "End voice; background tasks keep running.",
          }, "End voice") : h(ControlButton, {
            disabled: connectControl.disabled || !chat.active || !chat.sessionId, onClick: connect,
          }, connectControl.label === "Connect" ? "Start voice" : connectControl.label),
          connected && browserMicSupported ? h(ControlButton, {
            disabled: busyAction === "microphone", pressed: microphone.active,
            onClick: microphone.active ? stopMicrophone : startMicrophone,
          }, microphone.active
            ? audioCapabilities.turnDetection === "disabled" ? "Stop & send turn" : "Pause microphone"
            : "Start microphone") : null,
          connected ? h(ControlButton, { onClick: interruptSpeech,
            title: "Interrupt speech; background tasks keep running.",
          }, "Interrupt speech") : null,
          inboxItems.length ? h("details", { style: { flexBasis: "100%" }, "data-voice-tasks": true },
            h("summary", { style: { cursor: "pointer" } }, "Tasks · " + taskInboxSummary(snapshot)),
            h("div", { style: { display: "grid", gap: "0.5rem", marginTop: "0.75rem", maxHeight: "45vh", overflow: "auto" } },
              inboxItems.map(TaskCard),
            ),
          ) : null,
        ),
        !chat.sessionId ? h("p", null, "Select a saved chat in Hermes’s conversation list to start voice.") : null,
        !connected && !gateway.ready ? h("p", { role: "status" }, gatewayState.detail) : null,
        connected && microphone.active && audioCapabilities.turnDetection === "disabled"
          ? h("p", null, microphoneActiveGuidance("disabled")) : null,
        notice ? h("div", { role: notice.tone === "danger" ? "alert" : "status", style: { display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" } },
          h("span", { style: { flex: 1 } }, notice.text),
          h(ControlButton, { onClick: function () { setNotice(null); }, ariaLabel: "Dismiss message" }, "Dismiss"),
        ) : null,
      ),
    );
  }

  const registry = window.__HERMES_PLUGINS__;
  if (registry && typeof registry.register === "function") {
    registry.register(PLUGIN_NAME, function () {
      const SDK = window.__HERMES_PLUGIN_SDK__;
      return SDK.React.createElement("a", { href: "/chat" }, "Open Hermes Chat to use Live Voice.");
    });
    if (typeof registry.registerSlot === "function") {
      registry.registerSlot(PLUGIN_NAME, "chat:top", LiveVoiceControls);
    }
  }
})();
