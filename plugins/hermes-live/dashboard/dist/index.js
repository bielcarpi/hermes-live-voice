(function () {
  "use strict";

  const PLUGIN_NAME = "hermes-live";
  const STATUS_ENDPOINT = "/api/plugins/hermes-live/status";
  const LIVE_ENDPOINT = "/api/plugins/hermes-live/live";
  const MAX_TRANSCRIPT_ENTRIES = 80;
  const MAX_ACTIVITY_ENTRIES = 40;

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
      run: { state: "idle" },
      pendingApprovals: [],
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
    if (text.length <= 14) return text;
    return text.slice(0, 7) + "\u2026" + text.slice(-5);
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function approvalKey(request, index) {
    const approval = request && request.approval ? request.approval : {};
    return String(approval.approvalId || request.runId || "approval") + ":" + index;
  }

  function approvalTitleId(request, index) {
    const approval = request && request.approval ? request.approval : {};
    const key = String(approval.approvalId || request.runId || "approval")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .slice(0, 64);
    return "hlv-approval-title-" + key + "-" + index;
  }

  function supportsTargetedApprovalResponses(session) {
    return Boolean(
      session &&
      session.hermes &&
      session.hermes.capabilities &&
      session.hermes.capabilities.run_approval_response_by_id === true,
    );
  }

  function approvalSupportPresentation(session) {
    if (!session) return {
      value: "Negotiated on connect",
      detail: "Approval controls require Hermes to target responses by approval ID.",
    };
    if (supportsTargetedApprovalResponses(session)) return {
      value: "Available",
      detail: "Responses are correlated to a stable Hermes approval ID.",
    };
    return {
      value: "Fail closed",
      detail: "This Hermes version cannot safely target approval responses; approval-requiring runs are denied where possible, stopped, and disconnected for verification.",
    };
  }

  function microphoneActiveGuidance(turnDetection) {
    return turnDetection === "disabled"
      ? "Push to talk is active. Speak, then stop the microphone to submit this turn."
      : "Speak naturally. You can interrupt Hermes at any time.";
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
          // Protocol disconnect must remain independent of local UI reporting.
        }
      });
    await client.disconnect("user disconnected from dashboard");
  }

  function connectionClosedNotice(event, fatalNotice) {
    if (fatalNotice) return fatalNotice;
    return {
      tone: event && !event.clean ? "warning" : "neutral",
      text: event && !event.clean
        ? "Live Voice connection was lost. Check the gateway and reconnect."
        : "Live Voice disconnected.",
    };
  }

  function approvalPatternKeys(approval) {
    const values = [];
    const primary = inspectablePattern(approval.patternKey);
    if (primary) values.push(primary);
    if (Array.isArray(approval.patternKeys)) {
      approval.patternKeys.forEach(function (value) {
        const pattern = inspectablePattern(value);
        if (pattern) values.push(pattern);
      });
    }
    return Array.from(new Set(values)).slice(0, 32);
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

  function approvalChoiceLabel(choice) {
    const labels = {
      once: "Allow once",
      session: "Allow this session",
      always: "Always allow",
      deny: "Deny",
    };
    return labels[choice] || titleCase(choice);
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

  function summarizeRunEvent(event) {
    if (!event || typeof event !== "object") return null;
    const name = typeof event.event === "string" ? event.event : "Hermes update";
    if (name === "message.delta" || name === "message_delta") return null;
    const detail = typeof event.status === "string"
      ? event.status
      : typeof event.message === "string"
        ? event.message
        : "";
    return { label: titleCase(name), detail: clampText(detail, 180), tone: "neutral" };
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
    const [activity, setActivity] = useState([]);
    const [textInput, setTextInput] = useState("");
    const [notice, setNotice] = useState(null);
    const [clientLoading, setClientLoading] = useState(true);
    const [busyAction, setBusyAction] = useState("");
    const [confirmDisconnect, setConfirmDisconnect] = useState(false);
    const [confirmPermanent, setConfirmPermanent] = useState("");

    const clientRef = useRef(null);
    const audioRef = useRef(null);
    const ensureAudioRef = useRef(null);
    const audioUnsubscribersRef = useRef([]);
    const transcriptSequence = useRef(0);
    const activitySequence = useRef(0);
    const transcriptEndRef = useRef(null);
    const fatalNoticeRef = useRef(null);

    const addActivity = useCallback(function (label, detail, tone) {
      const entry = {
        id: ++activitySequence.current,
        label: clampText(label, 100),
        detail: clampText(detail || "", 180),
        tone: tone || "neutral",
        at: Date.now(),
      };
      setActivity(function (current) {
        return current.concat(entry).slice(-MAX_ACTIVITY_ENTRIES);
      });
    }, []);

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
              if (active) {
                const audio = audioRef.current;
                if (audio) audio.clearPlayback();
                finalizeAssistantTranscript();
                addActivity("Assistant speech interrupted", "The active realtime response was cancelled.", "warning");
              }
            }),
            client.on("response.failed", function (message) {
              if (active) {
                const audio = audioRef.current;
                if (audio) audio.clearPlayback();
                finalizeAssistantTranscript();
                setNotice({ tone: "danger", text: clampText(message.error, 300) });
              }
            }),
            client.on("run.started", function (message) {
              if (active) addActivity("Hermes task started", "Run " + shortId(message.runId), "active");
            }),
            client.on("run.event", function (message) {
              if (!active) return;
              const summary = summarizeRunEvent(message.event);
              if (summary) addActivity(summary.label, summary.detail, summary.tone);
            }),
            client.on("approval.request", function (message) {
              if (active) {
                setConfirmPermanent("");
                addActivity(
                  "Approval required",
                  message.approval.description || "Hermes is waiting for your decision.",
                  "warning",
                );
              }
            }),
            client.on("approval.responded", function (message) {
              if (active) {
                setConfirmPermanent("");
                setBusyAction("");
                addActivity("Approval answered", approvalChoiceLabel(message.choice), "success");
              }
            }),
            client.on("run.completed", function (message) {
              if (active) addActivity("Hermes task completed", "Run " + shortId(message.runId), "success");
            }),
            client.on("run.failed", function (message) {
              if (active) {
                addActivity("Hermes task failed", message.error, "danger");
                setNotice({ tone: "danger", text: clampText(message.error, 300) });
              }
            }),
            client.on("run.stopping", function (message) {
              if (active) addActivity("Hermes task stopping", titleCase(message.status), "warning");
            }),
            client.on("run.stopped", function (message) {
              if (active) addActivity("Hermes task stopped", titleCase(message.status), "warning");
            }),
            client.on("input.speech_started", function () {
              if (active) {
                const audio = audioRef.current;
                if (audio) audio.interrupt("provider detected user speech");
                addActivity("You started speaking", "Assistant playback interrupted for barge-in.", "active");
              }
            }),
            client.on("audio.dropped", function () {
              if (active) setNotice({
                tone: "warning",
                text: "Microphone audio was briefly dropped because the connection was congested.",
              });
            }),
            client.on("error", function (event) {
              if (active) {
                setBusyAction("");
                setConfirmPermanent("");
                const nextNotice = {
                  tone: "danger",
                  text: friendlyError(event.error, "The Live Voice session reported an error."),
                };
                if (event.detail && event.detail.type === "session.error" && event.detail.recoverable === false) {
                  fatalNoticeRef.current = nextNotice;
                }
                setNotice(nextNotice);
              }
            }),
            client.on("close", function (event) {
              if (!active) return;
              const oldAudio = audioRef.current;
              audioRef.current = null;
              detachAudioListeners();
              if (oldAudio) void oldAudio.dispose();
              setMicrophone(initialMicrophone());
              setPlayback(initialPlayback());
              setConfirmDisconnect(false);
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
    }, [SDK, addActivity, addTranscript, finalizeAssistantTranscript]);

    useEffect(function () {
      const element = transcriptEndRef.current;
      if (element && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }, [transcript.length]);

    useEffect(function () {
      if (snapshot.run.state === "idle") {
        setConfirmDisconnect(false);
        setConfirmPermanent("");
        return undefined;
      }
      function warnBeforeLeaving(event) {
        event.preventDefault();
        event.returnValue = "";
      }
      window.addEventListener("beforeunload", warnBeforeLeaving);
      return function () { window.removeEventListener("beforeunload", warnBeforeLeaving); };
    }, [snapshot.run.state]);

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
          setNotice({ tone: "success", text: "Live Voice is connected. You can speak or type to Hermes." });
          refreshStatus();
        });
      });
    }

    function disconnect(force) {
      const activeRun = snapshot.run.state !== "idle";
      if (activeRun && !force) {
        setConfirmDisconnect(true);
        return;
      }
      const client = clientRef.current;
      if (!client) return;
      setConfirmDisconnect(false);
      runAction("disconnect", function () {
        const audio = audioRef.current;
        return disconnectSession(audio, client, function (error) {
          addActivity(
            "Microphone cleanup incomplete",
            friendlyError(error, "Browser audio cleanup did not finish."),
            "warning",
          );
        })
          .then(function () {
            setNotice({
              tone: "neutral",
              text: activeRun
                ? "Disconnected. The gateway confirmed shutdown and accepted a stop request for the active Hermes task."
                : "Live Voice disconnected.",
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
        setNotice({ tone: "neutral", text: "Assistant speech interrupted. The Hermes task, if any, is still running." });
      } catch (error) {
        setNotice({ tone: "danger", text: friendlyError(error, "Assistant speech could not be interrupted.") });
      }
    }

    function stopTask() {
      const client = clientRef.current;
      if (!client || snapshot.run.state === "idle") return;
      try {
        client.stopRun("stopped from Hermes Dashboard");
        setNotice({ tone: "warning", text: "Hermes task stop requested. The voice session remains connected." });
      } catch (error) {
        setNotice({ tone: "danger", text: friendlyError(error, "The Hermes task could not be stopped.") });
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

    function respondToApproval(request, index, choice, confirmed) {
      const key = approvalKey(request, index);
      if (index !== 0) {
        setNotice({ tone: "warning", text: "Answer the earliest approval first; Hermes resolves approvals in queue order." });
        return;
      }
      if (choice === "always" && (
        request.approval.allowPermanent !== true || approvalPatternKeys(request.approval).length === 0
      )) {
        setNotice({ tone: "danger", text: "Permanent approval requires an inspectable permission pattern." });
        setConfirmPermanent("");
        return;
      }
      if (choice === "always" && !confirmed) {
        setConfirmPermanent(key);
        return;
      }
      const client = clientRef.current;
      if (!client) return;
      setBusyAction("approval:" + key);
      try {
        client.respondToApproval(choice, request.runId, { approvalId: request.approval.approvalId });
        setConfirmPermanent("");
      } catch (error) {
        setBusyAction("");
        setNotice({ tone: "danger", text: friendlyError(error, "The approval response could not be sent.") });
      }
    }

    const connection = connectionPresentation(snapshot.connection);
    const gatewayState = gatewayPresentation(gateway);
    const connected = snapshot.connection === "ready";
    const activeRun = snapshot.run.state !== "idle";
    const session = snapshot.session;
    const realtime = session && session.realtime ? session.realtime : {};
    const audioCapabilities = realtime.audio || gateway.audio || {};
    const inputAudio = audioCapabilities.input || {};
    const outputAudio = audioCapabilities.output || {};
    const inputMime = inputAudio.mimeType || "";
    const browserMicSupported = inputAudio.enabled !== false && (!inputMime || /^audio\/pcm(?:;|$)/i.test(inputMime));
    const provider = realtime.provider || gateway.provider || "\u2014";
    const model = realtime.model || gateway.model || "\u2014";
    const protocolVersion = session && session.protocolVersion ? session.protocolVersion : gateway.protocolVersion || "\u2014";
    const approvalSupport = approvalSupportPresentation(session);
    const approvalResponsesSupported = supportsTargetedApprovalResponses(session);
    const pendingApprovals = approvalResponsesSupported && Array.isArray(snapshot.pendingApprovals)
      ? snapshot.pendingApprovals
      : [];

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
        autoFocus: Boolean(props.autoFocus),
        onClick: props.onClick,
        title: props.title,
        "aria-pressed": props.pressed === undefined ? undefined : Boolean(props.pressed),
      }, props.icon ? h("span", { className: "hlv-button__icon", "aria-hidden": "true" }, props.icon) : null,
      h("span", null, props.children));
    }

    function ApprovalCard(request, index) {
      const approval = request.approval || {};
      const informed = Boolean(approval.command || approval.description);
      const patternKeys = approvalPatternKeys(approval);
      const isActionable = index === 0;
      const suppliedChoices = Array.isArray(approval.choices) ? approval.choices : [];
      const choices = suppliedChoices
        .filter(function (choice) { return ["once", "session", "always", "deny"].includes(choice); })
        .filter(function (choice) { return informed || choice === "deny"; })
        .filter(function (choice) {
          return !["session", "always"].includes(choice) || patternKeys.length > 0;
        })
        .filter(function (choice) {
          return choice !== "always" || (approval.allowPermanent === true && patternKeys.length > 0);
        });
      if (!choices.includes("deny")) choices.push("deny");
      const key = approvalKey(request, index);
      const titleId = approvalTitleId(request, index);
      const isBusy = busyAction === "approval:" + key;
      const permanentConfirmation = isActionable && confirmPermanent === key;
      return h("article", {
        className: "hlv-approval",
        key: key,
        role: "region",
        "aria-labelledby": titleId,
      },
        h("div", { className: "hlv-approval__header" },
          h("span", { className: "hlv-approval__shield", "aria-hidden": "true" }, "!"),
          h("div", null,
            h("span", { className: "hlv-eyebrow" }, isActionable ? "Approval required" : "Approval queued"),
            h("h3", { id: titleId }, approval.description || "Hermes wants permission to continue"),
          ),
        ),
        approval.command ? h("pre", { className: "hlv-command" }, h("code", null, approval.command)) : null,
        patternKeys.length
          ? h("p", { className: "hlv-approval__pattern" },
              "Permission pattern: ",
              h("code", null, patternKeys.join(", ")),
            )
          : informed
            ? h("p", { className: "hlv-approval__opaque" },
                "No inspectable permission pattern was supplied. Only a one-time decision or denial is available.",
              )
            : h("p", { className: "hlv-approval__opaque" },
                "Hermes did not provide enough inspectable action details. This request can only be denied.",
              ),
        !isActionable
          ? h("p", { className: "hlv-approval__queued", role: "status" },
              "Answer the earlier approval first. Hermes resolves approval requests in FIFO order.",
            )
          : permanentConfirmation
          ? h("div", { className: "hlv-permanent", role: "alert" },
              h("strong", null, "Make this permission permanent?"),
              h("p", null,
                "This changes Hermes' approval policy for future matching actions, not just this voice session. " +
                "Only continue if you understand and trust the pattern above.",
              ),
              h("div", { className: "hlv-button-row" },
                h(ControlButton, {
                  variant: "danger",
                  disabled: isBusy,
                  autoFocus: true,
                  onClick: function () { respondToApproval(request, index, "always", true); },
                }, isBusy ? "Sending\u2026" : "Confirm always allow"),
                h(ControlButton, {
                  variant: "ghost",
                  disabled: isBusy,
                  onClick: function () { setConfirmPermanent(""); },
                }, "Cancel"),
              ),
            )
          : h("div", { className: "hlv-button-row hlv-approval__actions" },
              choices.map(function (choice, choiceIndex) {
                return h(ControlButton, {
                  key: choice,
                  variant: choice === "deny" ? "danger" : choice === "always" ? "warning" : "secondary",
                  disabled: isBusy,
                  autoFocus: isActionable && choiceIndex === 0,
                  onClick: function () { respondToApproval(request, index, choice, false); },
                }, isBusy ? "Sending\u2026" : approvalChoiceLabel(choice));
              }),
            ),
      );
    }

    return h("div", { className: "hlv-page" },
      h("section", { className: "hlv-hero" },
        h("div", { className: "hlv-hero__copy" },
          h("span", { className: "hlv-kicker" },
            h("span", { className: "hlv-kicker__wave", "aria-hidden": "true" }, "\u223F"),
            "Hermes Live Voice",
          ),
          h("h1", null, "Talk to Hermes. Stay in control."),
          h("p", null,
            "A realtime voice workspace for interruptible conversation, visible task progress, and fail-closed task controls.",
          ),
        ),
        h("div", { className: "hlv-hero__status", "aria-live": "polite" },
          h(StatusPill, { tone: gatewayState.tone }, "Gateway ", gatewayState.label),
          h(StatusPill, { tone: connection.tone }, connection.label),
        ),
      ),

      notice ? h("div", { className: "hlv-notice hlv-notice--" + notice.tone, role: notice.tone === "danger" ? "alert" : "status" },
        h("span", null, notice.text),
        h("button", { type: "button", onClick: function () { setNotice(null); }, "aria-label": "Dismiss message" }, "\u00d7"),
      ) : null,

      activeRun ? h("div", { className: "hlv-lifecycle-warning", role: "status" },
        h("span", { className: "hlv-lifecycle-warning__icon", "aria-hidden": "true" }, "\u25c9"),
        h("div", null,
          h("strong", null, "Hermes task is active"),
          h("span", null,
            " Disconnecting asks the gateway to stop this task; wait for shutdown confirmation. Refreshing or navigating away can only request cleanup. Interrupt Speech only stops the current spoken response.",
          ),
        ),
      ) : null,

      confirmDisconnect ? h("div", { className: "hlv-disconnect-confirm", role: "alert" },
        h("div", null,
          h("strong", null, "Disconnect and stop the active Hermes task?"),
          h("p", null, "The gateway will request a stop for run " + shortId(snapshot.run.runId) + " and confirm whether session shutdown completed."),
        ),
        h("div", { className: "hlv-button-row" },
          h(ControlButton, { variant: "danger", onClick: function () { disconnect(true); } }, "Disconnect & stop"),
          h(ControlButton, { variant: "ghost", onClick: function () { setConfirmDisconnect(false); } }, "Keep connected"),
        ),
      ) : null,

      pendingApprovals.length ? h("section", {
        className: "hlv-approval-stack",
        "aria-label": "Pending approvals",
        "aria-live": "assertive",
        "aria-relevant": "additions removals",
      },
        pendingApprovals.map(ApprovalCard),
      ) : null,

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
              playback.active ? "Use Interrupt Speech to cut off this response without stopping the task." :
              connected ? "Start the microphone or type a message below." : gatewayState.detail,
            ),
          ),
          h("div", { className: "hlv-connect-row" },
            connected
              ? h(ControlButton, {
                  variant: "secondary",
                  disabled: busyAction === "disconnect",
                  onClick: function () { disconnect(false); },
                }, busyAction === "disconnect" ? "Disconnecting\u2026" : "Disconnect")
              : h(ControlButton, {
                  variant: "primary",
                  wide: true,
                  disabled: clientLoading || busyAction === "connect" ||
                    ["connecting", "starting", "closing"].includes(snapshot.connection),
                  onClick: connect,
                }, clientLoading ? "Loading voice client\u2026" : busyAction === "connect" ? "Connecting\u2026" : "Connect Live Voice"),
          ),
          h("div", { className: "hlv-control-grid" },
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
                  title: !browserMicSupported ? "This provider session does not expose browser-compatible PCM microphone input." : "",
                  icon: "\u25cf",
                  onClick: startMicrophone,
                }, busyAction === "microphone" ? "Starting\u2026" : "Start microphone"),
            h(ControlButton, {
              variant: "warning",
              disabled: !connected,
              icon: "\u2016",
              onClick: interruptSpeech,
              title: "Cancel the current assistant response but keep any Hermes task running.",
            }, "Interrupt speech"),
            h(ControlButton, {
              variant: "danger",
              disabled: !connected || !activeRun || snapshot.run.state === "stopping",
              icon: "\u25a0",
              onClick: stopTask,
              title: "Stop the active Hermes task but keep the voice session connected.",
            }, snapshot.run.state === "stopping" ? "Stopping task\u2026" : "Stop Hermes task"),
          ),
          !browserMicSupported && connected ? h("p", { className: "hlv-inline-warning" },
            inputAudio.enabled === false
              ? "This provider session does not accept microphone audio. Text input remains available."
              : "Browser capture supports PCM16 input, but this session negotiated " + inputMime + ". Text input remains available.",
          ) : null,
          connected && !approvalResponsesSupported ? h("p", {
            className: "hlv-inline-warning",
            role: "status",
          },
            "Approval controls are unavailable with this Hermes version. Approval-requiring runs are denied where possible, stopped, and disconnected for verification.",
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
                placeholder: connected ? "Ask a question or give Hermes a task\u2026" : "Connect Live Voice to send a message",
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
            h("span", { className: "hlv-composer__hint" }, "Voice and text share the same live session."),
          ),
        ),

        h("aside", { className: "hlv-side" },
          h("section", { className: "hlv-card hlv-session-card" },
            h("div", { className: "hlv-card__header" },
              h("div", null,
                h("span", { className: "hlv-eyebrow" }, "Session contract"),
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
                label: "Microphone input",
                value: inputAudio.enabled === false ? "Disabled" : inputMime || "Negotiated on connect",
                detail: inputAudio.recommendedFrameMs ? inputAudio.recommendedFrameMs + " ms frames" : "",
              }),
              h(Metric, {
                label: "Audio output",
                value: outputAudio.enabled === false ? "Disabled" : outputAudio.mimeType || "Negotiated on connect",
                detail: audioCapabilities.turnDetection ? titleCase(audioCapabilities.turnDetection) : "",
              }),
              h(Metric, {
                label: "Approvals",
                value: approvalSupport.value,
                detail: approvalSupport.detail,
              }),
            ),
            h("p", { className: "hlv-security-note" },
              h("span", { "aria-hidden": "true" }, "\u25c8"),
              " Dashboard authentication is exchanged server-side. Gateway credentials are never stored in this page.",
            ),
          ),

          h("section", { className: "hlv-card hlv-task-card" },
            h("div", { className: "hlv-card__header" },
              h("div", null,
                h("span", { className: "hlv-eyebrow" }, "Hermes execution"),
                h("h2", null, activeRun ? "Task in progress" : "Task activity"),
              ),
              activeRun ? h(StatusPill, { tone: snapshot.run.state === "stopping" ? "warning" : "active" },
                snapshot.run.state === "stopping" ? "Stopping" : "Running",
              ) : null,
            ),
            activeRun ? h("div", { className: "hlv-run-id" },
              h("span", null, "Active run"),
              h("code", { title: snapshot.run.runId }, shortId(snapshot.run.runId)),
            ) : null,
            activity.length
              ? h("ol", { className: "hlv-activity" }, activity.slice(-8).reverse().map(function (entry) {
                  return h("li", { key: entry.id, className: "hlv-activity__item hlv-activity__item--" + entry.tone },
                    h("span", { className: "hlv-activity__marker", "aria-hidden": "true" }),
                    h("div", null,
                      h("strong", null, entry.label),
                      entry.detail ? h("span", null, entry.detail) : null,
                    ),
                  );
                }))
              : h("div", { className: "hlv-empty hlv-empty--compact" },
                  h("span", { "aria-hidden": "true" }, "\u22ef"),
                  h("p", null, "Hermes task events will appear here when a conversation triggers tools or a run."),
                ),
            snapshot.lastRun ? h("div", { className: "hlv-last-run hlv-last-run--" + snapshot.lastRun.status },
              h("strong", null, "Last task: " + titleCase(snapshot.lastRun.status)),
              snapshot.lastRun.output ? h("p", null, clampText(snapshot.lastRun.output, 800)) : null,
              snapshot.lastRun.error ? h("p", null, clampText(snapshot.lastRun.error, 400)) : null,
            ) : null,
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
                h("p", null, "Connect, start the microphone, and speak naturally \u2014 or use the text composer when voice is unavailable."),
              ),
          h("div", { ref: transcriptEndRef }),
        ),
      ),

      h("footer", { className: "hlv-footer" },
        h("p", null,
          "Live Voice is a session surface, not a background job monitor. Leaving this page closes the voice session and requests cleanup for its active Hermes task.",
        ),
      ),
    );
  }

  const registry = window.__HERMES_PLUGINS__;
  if (registry && typeof registry.register === "function") {
    registry.register(PLUGIN_NAME, LiveVoicePage);
  }
})();
