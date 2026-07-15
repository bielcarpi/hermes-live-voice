import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const dashboardUrl = new URL("../plugins/hermes-live/dashboard/", import.meta.url);

describe("Hermes Dashboard plugin", () => {
  it("registers the Live Voice tab synchronously as a dependency-free IIFE", () => {
    const register = vi.fn();
    const window = {
      __HERMES_PLUGINS__: { register },
      location: { href: "http://127.0.0.1:9119/live-voice" },
    };
    const document = dashboardDocument();
    const source = dashboardSource();

    vm.runInNewContext(source, { document, URL, window }, {
      filename: "plugins/hermes-live/dashboard/dist/index.js",
    });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("hermes-live", expect.any(Function));
  });

  it("declares an official Dashboard tab, assets, and backend with package-version parity", () => {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", dashboardUrl), "utf8"));
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(manifest).toMatchObject({
      name: "hermes-live",
      label: "Live Voice",
      icon: "Zap",
      version: packageJson.version,
      tab: { path: "/live-voice", position: "after:chat" },
      entry: "dist/index.js",
      css: "dist/style.css",
      api: "plugin_api.py",
    });
  });

  it("uses only host-authenticated Dashboard APIs and contains no static secret hooks", () => {
    const source = dashboardSource();

    expect(source).toContain("SDK.buildWsUrl(LIVE_ENDPOINT)");
    expect(source).toContain("SDK.fetchJSON(STATUS_ENDPOINT)");
    expect(source).not.toContain("__HERMES_SESSION_TOKEN__");
    expect(source).not.toContain("HERMES_LIVE_AUTH_TOKEN");
    expect(source).not.toContain("OPENAI_API_KEY");
    expect(source).not.toContain("GEMINI_API_KEY");
  });

  it("presents durable multi-task work without legacy singleton controls", () => {
    const source = dashboardSource();
    const forbidden = [
      ["stop", "Run"],
      ["active", "Run"],
      ["run", "Id"],
      ["respond", "ToAppro", "val"],
      ["waiting_for_appro", "val"],
    ].map((parts) => parts.join(""));

    expect(source).toContain("Hermes has a voice. Now it keeps working.");
    expect(source).toContain("Keep talking. Hermes keeps working.");
    expect(source).toContain("Task inbox");
    expect(source).toContain("stable task ID");
    expect(source).toContain('client.stopTask(task.taskId, "stopped from Hermes Dashboard")');
    expect(source).toContain("client.acknowledgeNotification(notification.taskId, notification.notificationId)");
    expect(source).toContain("leaving this page does not cancel background work");
    expect(source).toContain('className: "hlv-task-item"');
    for (const token of forbidden) expect(source).not.toContain(token);
  });

  it("keeps speech interruption independent from exact task stopping", () => {
    const source = dashboardSource();

    expect(source).toContain('audio.interrupt("interrupted from Hermes Dashboard")');
    expect(source).toContain('audio.interrupt("provider detected user speech")');
    expect(source).toContain('audio.interrupt("new Dashboard text input")');
    expect(source).toContain("Assistant speech interrupted. Background tasks keep running.");
    expect(source).toContain("Interrupt speech");
    expect(source).toContain("Stop task");
    expect(source).toContain("audio.clearPlayback()");
    expect(source).toContain("audio.primePlayback()");
    expect(source).toContain("primePlaybackFromGesture();");
  });

  it("keeps stable task identity and attaches unread updates under out-of-order completion", () => {
    const utilities = loadDashboardUtilities();
    const activeSecond = task("task_second", "running", 8, 2_000);
    const activeFirst = task("task_first", "queued", 3, 1_000);
    const finishedThird = task("task_third", "completed", 11, 3_000, { result: { summary: "done" } });
    const notification = {
      taskId: "task_third",
      notificationId: "note_third",
      message: "Third task finished first.",
    };

    const items = utilities.taskInboxItems({
      activeTasks: [activeSecond, activeFirst],
      recentTasks: [finishedThird],
      unreadNotifications: [notification],
    });

    expect(items.map((item: any) => item.task.taskId)).toEqual(["task_second", "task_first", "task_third"]);
    expect(items[0].notification).toBeUndefined();
    expect(items[2]).toMatchObject({ task: { taskId: "task_third", sequence: 11 }, notification });
  });

  it("bounds the recent inbox while preserving every active task", () => {
    const utilities = loadDashboardUtilities();
    const active = Array.from({ length: 3 }, (_, index) => task(`active_${index}`, "running", index + 1, index));
    const recent = Array.from({ length: 30 }, (_, index) => task(`recent_${index}`, "completed", index + 1, index));

    const items = utilities.taskInboxItems({ activeTasks: active, recentTasks: recent, unreadNotifications: [] });

    expect(items).toHaveLength(19);
    expect(items.slice(0, 3).map((item: any) => item.task.taskId)).toEqual([
      "active_0",
      "active_1",
      "active_2",
    ]);
    expect(items.at(-1).task.taskId).toBe("recent_15");
  });

  it("summarizes task state, progress, results, errors, and unread counts", () => {
    const utilities = loadDashboardUtilities();

    expect(utilities.taskStatePresentation("running")).toEqual({ label: "Running", tone: "active" });
    expect(utilities.taskStatePresentation("completed")).toEqual({ label: "Completed", tone: "success" });
    expect(utilities.taskStatePresentation("failed")).toEqual({ label: "Failed", tone: "danger" });
    expect(utilities.isTaskActive({ state: "unknown" })).toBe(true);
    expect(utilities.isTaskActive({ state: "completed" })).toBe(false);
    expect(utilities.taskProgressText({ message: "Reviewing", percent: 48.6 })).toBe("Reviewing · 49%");
    expect(utilities.taskProgressText({ message: "Files", current: 2, total: 5 })).toBe("Files · 2/5");
    expect(utilities.taskDetail({ result: { output: "full output", summary: "summary" } })).toBe("full output");
    expect(utilities.taskDetail({ error: { message: "failed safely" } })).toBe("failed safely");
    expect(utilities.taskInboxSummary({
      activeTasks: [task("one", "running", 1, 1)],
      recentTasks: [task("two", "completed", 2, 2)],
      unreadNotifications: [{ taskId: "two" }],
    })).toBe("1 active · 1 recent · 1 unread");
    expect(utilities.taskInboxSummary({ activeTasks: [], recentTasks: [], unreadNotifications: [] }))
      .toBe("No background tasks yet");
  });

  it("attempts protocol detach even when microphone cleanup fails", async () => {
    const utilities = loadDashboardUtilities();
    const audio = { stopMicrophone: vi.fn(async () => { throw new Error("capture cleanup failed"); }) };
    const client = { disconnect: vi.fn(async () => undefined) };
    const onAudioError = vi.fn();

    await expect(utilities.disconnectSession(audio, client, onAudioError)).resolves.toBeUndefined();
    expect(audio.stopMicrophone).toHaveBeenCalledWith({ endTurn: false });
    expect(client.disconnect).toHaveBeenCalledWith("user disconnected from dashboard");
    await vi.waitFor(() => expect(onAudioError).toHaveBeenCalledWith(expect.objectContaining({
      message: "capture cleanup failed",
    })));
  });

  it("does not wait for stalled microphone cleanup before detaching voice", async () => {
    const utilities = loadDashboardUtilities();
    const audio = { stopMicrophone: vi.fn(async () => await new Promise(() => undefined)) };
    const client = { disconnect: vi.fn(async () => undefined) };

    await expect(utilities.disconnectSession(audio, client)).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves fatal errors and accurately describes durable work after closure", () => {
    const utilities = loadDashboardUtilities();
    const fatal = { tone: "danger", text: "The provider rejected this voice session." };

    expect(utilities.connectionClosedNotice({ clean: true }, fatal)).toMatchObject(fatal);
    expect(utilities.connectionClosedNotice({ clean: false }, null)).toMatchObject({
      tone: "warning",
      text: "Live Voice connection was lost. Background tasks keep working; reconnect to sync their state.",
    });
    expect(utilities.connectionClosedNotice({ clean: true }, null).text).toContain(
      "Background tasks keep working",
    );
  });

  it("gives accurate microphone and text-only guidance from negotiated capabilities", () => {
    const utilities = loadDashboardUtilities();

    expect(utilities.microphoneActiveGuidance("disabled")).toContain("stop the microphone to submit");
    expect(utilities.microphoneActiveGuidance("semantic_vad")).toContain("Speak naturally");
    expect(utilities.connectedSessionNotice({ enabled: false }, false))
      .toBe("Live Voice is connected in text mode. Type a message to Hermes.");
    expect(utilities.connectedSessionGuidance(false)).toBe("Type a message below.");
    expect(utilities.connectedSessionNotice({ enabled: true }, true)).toContain("Keep talking");
    expect(utilities.connectedSessionGuidance(true)).toContain("Start the microphone");
    expect(utilities.supportsBrowserPlayback({ enabled: false })).toBe(false);
    expect(utilities.supportsBrowserPlayback({ enabled: true, mimeType: "audio/pcm;rate=24000" })).toBe(true);
    expect(utilities.supportsBrowserPlayback({ enabled: true, mimeType: "audio/opus" })).toBe(false);
    expect(utilities.supportsBrowserMicrophone({ enabled: true, mimeType: "audio/pcm;rate=16000" })).toBe(true);
  });

  it("uses freshly negotiated audio and never primes playback for text-only sessions", () => {
    const utilities = loadDashboardUtilities();
    const source = dashboardSource();
    const staleStatusInput = { enabled: true, mimeType: "audio/pcm;rate=16000" };
    const negotiated = { session: { realtime: { audio: { input: { enabled: false } } } } };

    const inputAudio = utilities.negotiatedInputAudio(negotiated, staleStatusInput);
    expect(inputAudio).toMatchObject({ enabled: false });
    expect(utilities.supportsBrowserMicrophone(inputAudio)).toBe(false);
    expect(utilities.negotiatedInputAudio({}, staleStatusInput)).toMatchObject(staleStatusInput);
    expect(source).toContain("if (!supportsBrowserPlayback(outputAudio)) return audio;");
  });
});

function dashboardSource(): string {
  return readFileSync(new URL("dist/index.js", dashboardUrl), "utf8");
}

function dashboardDocument() {
  return {
    baseURI: "http://127.0.0.1:9119/",
    currentScript: {
      src: "http://127.0.0.1:9119/api/dashboard-plugins/hermes-live/dist/index.js",
    },
    querySelector: vi.fn(),
  };
}

function task(
  taskId: string,
  state: string,
  sequence: number,
  updatedAt: number,
  extra: Record<string, unknown> = {},
) {
  return { taskId, title: taskId, state, sequence, updatedAt, ...extra };
}

function loadDashboardUtilities(): Record<string, (...args: any[]) => any> {
  const source = dashboardSource().replace(
    "  function LiveVoicePage() {",
    `  window.__HERMES_LIVE_TEST_UTILITIES__ = {
      connectedSessionGuidance,
      connectedSessionNotice,
      connectionClosedNotice,
      disconnectSession,
      isTaskActive,
      microphoneActiveGuidance,
      negotiatedInputAudio,
      supportsBrowserPlayback,
      supportsBrowserMicrophone,
      taskDetail,
      taskInboxItems,
      taskInboxSummary,
      taskProgressText,
      taskStatePresentation,
    };

  function LiveVoicePage() {`,
  );
  const window: Record<string, any> = {
    location: { href: "http://127.0.0.1:9119/live-voice" },
  };

  vm.runInNewContext(source, { document: dashboardDocument(), Error, Promise, URL, window }, {
    filename: "plugins/hermes-live/dashboard/dist/index.js",
  });

  return window.__HERMES_LIVE_TEST_UTILITIES__;
}
