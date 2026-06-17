# Changelog

## 0.1.0

- Initial public gateway shape.
- Add Gemini Live, OpenAI Realtime, and mock live providers.
- Add Hermes run/event/approval/stop bridge.
- Add browser demo, docs, examples, and optional plugin metadata.
- Protect readiness/capabilities behind gateway auth when configured.
- Validate base64 audio frames and PCM16 byte alignment before provider forwarding.
- Keep internal Hermes session keys server-side.
- Add OpenAI push-to-talk/VAD turn detection configuration.
- Add live-provider testing guide, Docker healthcheck, CI Docker build, and web demo syntax checks.
