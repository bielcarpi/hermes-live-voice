# Local runtime v1.2.0 validation

Date: 2026-10-07. Result: **managed local audio checks passed**.

## Environment

Apple Silicon Mac with 16 GB memory, macOS, Node 24.19.0, Python 3.12.13,
and `speech-to-speech` 1.0.0. The test used the shipped Python wrapper and
managed launch settings in an isolated Python environment.

- STT: `mlx-community/parakeet-tdt-0.6b-v3`.
- LLM: `mlx-community/Qwen3.5-2B-4bit`.
- TTS: `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit`.
- Managed turn routing enabled; partial transcription disabled; one pipeline.

The local download needed `HF_HUB_DISABLE_XET=1` after Xet downloads stalled.
This was a test-environment setting, not a new application default.

## Live checks

`provider-smoke --functional` passed the real local adapter, synthetic task
tool call, receipt audio, and clean connection closure.

The gateway smoke streamed a 3.65-second synthetic voice fixture as 24 kHz
mono PCM16. Real VAD and STT recognized the delegation request. A fake Hermes
worker received exactly one run. The check cancelled speech after its first
audio frame, detached through the client protocol, and reconnected to the
same running task. It then completed the worker and received the exact final
spoken notice, audio frames, and a completed response.

A short saved-chat reply containing bold text, a bullet, and line breaks
produced 15 audio frames and the expected final transcript. It bypassed LLM
inference after the formatting fix. Service logs contained none of the
synthetic user or assistant phrases checked after these sessions.

## Limits and unsuccessful comparisons

This verifies synthesized audio bytes and transcripts, not physical microphone
capture, speaker playback, acoustic barge-in, or subjective speech quality.
The task worker was a fixture. No configured real Hermes worker or hosted
provider credentials were available for a fresh deployment `launch-check`.

The Mac was heavily loaded and used about 17 GB of swap. Before the formatting
fix, the short reply's model summary took 105 seconds. Direct speech took
30 seconds in another run, including 21 seconds to first audio. The later
completion notice reached first audio in 0.53 seconds. These are observations
under changing load, not performance guarantees. Long or complex summaries
still require the local LLM and can be slow under memory pressure.

The unmanaged model-selected tool check exceeded 120 seconds. The larger
upstream default model also exceeded 120 seconds in a summary comparison, so
the managed profile keeps its previously used 2B model. These failures do not
qualify the unmanaged configuration.

OpenAI and Gemini live audio remain unverified. Their deterministic adapter
tests pass; the existing fake OpenAI server also exercises the functional CLI
and gateway cancellation, completion, and reconnect checks.

## Automated coverage

The release candidate passes 753 tests, the Python speech contract, malformed
WebSocket command checks, package installation, and Zod 3/4 consumer checks.
The current Hermes image compatibility run passed against v0.21.5, alongside
the pinned v0.20.0 image. CI also checks Linux, Windows, and the Docker runtime.

Use [provider testing](../live-provider-testing.md) to repeat the checks on the
target deployment. A second maintainer still needs to be named before
independent review can be required.
