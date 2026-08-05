import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildLocalVoiceCommand,
  HUGGINGFACE_SPEECH_TO_SPEECH_VERSION,
  MANAGED_LOCAL_MAX_NEW_TOKENS,
  MANAGED_LOCAL_MIN_SILENCE_MS,
  MIN_MANAGED_LOCAL_MEMORY_BYTES,
  localVoiceStartupProgress,
  probeLocalVoiceEndpoint,
  resolveLocalVoiceCommand,
  runLocalVoiceCommand,
} from "../src/cli/local-voice.js";

describe("managed local voice launcher", () => {
  it("builds a pinned, shell-free Apple Silicon command", () => {
    const command = buildLocalVoiceCommand({
      uv: "/opt/uv",
      endpoint: "ws://127.0.0.1:9876/v1/realtime",
      platform: "darwin",
      arch: "arm64",
      caBundle: "/test/ca.pem",
      runtimeEntrypoint: "/test/huggingface-realtime-entry.py",
    });

    expect(command.command).toBe("/opt/uv");
    expect(command.environment).toEqual({
      HF_HUB_DISABLE_TELEMETRY: "1",
      SSL_CERT_FILE: "/test/ca.pem",
    });
    expect(command.args).toEqual([
      "run", "--isolated", "--no-env-file", "--no-config", "--directory", "/test",
      "--python", "3.12", "--with",
      `speech-to-speech==${HUGGINGFACE_SPEECH_TO_SPEECH_VERSION}`,
      "python", "/test/huggingface-realtime-entry.py",
      "--device", "mps", "--stt", "parakeet-tdt",
      "--llm_backend", "mlx-lm", "--model_name", "mlx-community/Qwen3.5-2B-4bit",
      "--llm_gen_max_new_tokens", String(MANAGED_LOCAL_MAX_NEW_TOKENS),
      "--tts", "qwen3", "--mode", "realtime",
      "--ws_host", "127.0.0.1", "--ws_port", "9876", "--language", "auto",
      "--min_silence_ms", String(MANAGED_LOCAL_MIN_SILENCE_MS),
      "--num_pipelines", "1",
    ]);
    expect(command.args).not.toContain("--local_mac_optimal_settings");
  });

  it("rejects remote launch targets and unsupported managed platforms", () => {
    expect(() => buildLocalVoiceCommand({
      uv: "uv",
      endpoint: "wss://voice.example.com/v1/realtime",
      platform: "darwin",
      arch: "arm64",
    })).toThrow(/loopback/u);
    expect(() => buildLocalVoiceCommand({
      uv: "uv",
      endpoint: "ws://127.0.0.1:8765/v1/realtime",
      platform: "linux",
      arch: "x64",
    })).toThrow(/Apple Silicon/u);
  });

  it("fails before model download when an Apple Silicon Mac lacks memory headroom", async () => {
    await expect(resolveLocalVoiceCommand({
      local: { url: "ws://127.0.0.1:8765/v1/realtime", voice: "Aiden", allowRemote: false },
    }, {
      platform: "darwin",
      arch: "arm64",
      totalMemoryBytes: MIN_MANAGED_LOCAL_MEMORY_BYTES - 1,
      findCommand: async () => "/opt/homebrew/bin/uv",
    })).rejects.toThrow(/at least 12 GB.*OpenAI or Gemini/u);
  });

  it("runs through uv without a shell or secrets in arguments", async () => {
    const runForeground = vi.fn(async (
      _command: string,
      _args: string[],
      _env: NodeJS.ProcessEnv,
    ) => 0);
    await runLocalVoiceCommand(["run"], {
      local: { url: "ws://localhost:8765/v1/realtime", voice: "Aiden", allowRemote: false },
    }, {
      env: { PATH: "/safe" },
      platform: "darwin",
      arch: "arm64",
      findCommand: async () => "/safe/uv",
      runForeground,
    });

    expect(runForeground).toHaveBeenCalledOnce();
    expect(runForeground.mock.calls[0]?.[0]).toBe("/safe/uv");
    expect(JSON.stringify(runForeground.mock.calls[0]?.[1])).not.toContain("API_KEY");
    expect(runForeground.mock.calls[0]?.[2]).toMatchObject({ PATH: "/safe" });
    expect(runForeground.mock.calls[0]?.[2].HF_HUB_DISABLE_TELEMETRY).toBe("1");
    if (process.platform === "darwin") {
      expect(runForeground.mock.calls[0]?.[2].SSL_CERT_FILE).toBeTruthy();
    }
  });

  it("reports whether the private loopback endpoint is actually listening", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    try {
      await expect(probeLocalVoiceEndpoint(`ws://127.0.0.1:${address.port}/v1/realtime`)).resolves.toBe(true);
      await expect(probeLocalVoiceEndpoint("wss://voice.example.com/v1/realtime")).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("distinguishes a running service from a ready local provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-live-local-status-"));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      await runLocalVoiceCommand(["status"], {
        local: { url: "ws://127.0.0.1:8765/v1/realtime", voice: "Aiden", allowRemote: false },
      }, {
        home,
        platform: "darwin",
        uid: 501,
        probeEndpoint: async () => true,
      });
      expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
        installed: false,
        running: false,
        endpoint: { url: "ws://127.0.0.1:8765/v1/realtime", listening: true },
      });
      expect(output.at(-1)).toContain("Another process is listening");
    } finally {
      log.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("turns upstream logs into stable, non-sensitive setup stages", () => {
    expect(localVoiceStartupProgress("Resolved 193 packages")).toBe("Installing the pinned local voice runtime.");
    expect(localVoiceStartupProgress("Loading Parakeet TDT model: parakeet on mps"))
      .toBe("Loading the local transcription model.");
    expect(localVoiceStartupProgress("LLM Backend: mlx-lm"))
      .toBe("Loading the local language model.");
    expect(localVoiceStartupProgress("Loading Qwen3-TTS model: private/model via mlx-audio"))
      .toBe("Loading the local speech model.");
    expect(localVoiceStartupProgress("INFO: Application startup complete."))
      .toBe("Local voice models are ready. Verifying the private voice session.");
    expect(localVoiceStartupProgress("unrecognized raw log detail")).toBeUndefined();
  });
});
