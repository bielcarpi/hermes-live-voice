import { describe, expect, it, vi } from "vitest";
import {
  buildLocalVoiceCommand,
  HUGGINGFACE_SPEECH_TO_SPEECH_VERSION,
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
    });

    expect(command.command).toBe("/opt/uv");
    expect(command.environment).toEqual({ SSL_CERT_FILE: "/test/ca.pem" });
    expect(command.args).toEqual([
      "tool", "run", "--python", "3.12", "--from",
      `speech-to-speech==${HUGGINGFACE_SPEECH_TO_SPEECH_VERSION}`,
      "speech-to-speech", "--device", "mps", "--stt", "parakeet-tdt",
      "--llm_backend", "mlx-lm", "--model_name", "mlx-community/Qwen3-4B-Instruct-2507-4bit",
      "--tts", "qwen3", "--mode", "realtime",
      "--ws_host", "127.0.0.1", "--ws_port", "9876", "--language", "auto",
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

  it("runs through uv without a shell or secrets in arguments", async () => {
    const runForeground = vi.fn(async (
      _command: string,
      _args: string[],
      _env: NodeJS.ProcessEnv,
    ) => 0);
    await runLocalVoiceCommand(["start"], {
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
    if (process.platform === "darwin") {
      expect(runForeground.mock.calls[0]?.[2].SSL_CERT_FILE).toBeTruthy();
    }
  });
});
