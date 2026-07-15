# Roadmap

Hermes Live Voice is focused on one job: make Hermes Agent available behind a natural, interruptible realtime voice session without moving Hermes tools, memory, skills, or approvals into the speech provider.

The roadmap favors a small, trustworthy bridge over a broad voice platform.

## Now: reliable self-hosted developer preview

- Keep Gemini Live and OpenAI Realtime adapters aligned with their documented event shapes.
- Make installation, provider verification, and failure messages obvious.
- Preserve the three-tool boundary between realtime providers and Hermes.
- Keep credentials and Hermes session keys server-side.
- Improve deterministic coverage with captured provider fixtures.
- Keep the Dashboard integration, shared browser client, bundled demo, and terminal control surface aligned on protocol v2.
- Collect installation, latency, interruption, and long-session evidence from real users.

## Next: excellent voice-agent experience

- Return a run id immediately and deliver bounded progress/completion notifications asynchronously so provider conversation does not pause for the full Hermes task.
- Safe structured narration for long Hermes runs, using allowlisted status messages rather than raw model reasoning or tool output.
- Reconnect grace and explicit run reattachment for unreliable mobile networks.
- Gemini context-window compression, session resumption, and `GoAway` handling for sessions beyond the current single-connection preview path.
- Optional OpenAI spoken-input transcription with an explicit transcription model, separate-cost disclosure, and normalized user transcript events.
- Session, delegation, interruption, latency, error, and cost telemetry hooks.
- Explicit client event-detail policies for production integrations.
- Track a stable public Hermes Dashboard backend-auth contract and test the plugin against an explicit upstream version matrix.
- A curated extension for the community Hermes WebUI, paired with a small authenticated same-origin WebSocket proxy.
- Accessibility testing with screen readers and real microphone permission flows across supported browsers.

## Later: proven deployment needs

These are demand-driven rather than assumed requirements:

- Signed short-lived client identity and per-user Hermes profile mapping.
- Per-user quotas, concurrency limits, and provider cost controls.
- WebRTC/Opus transport through an established media stack when real clients need it.
- Additional realtime providers through the existing adapter port.
- A separately maintained local speech adapter if users can demonstrate an offline deployment need.
- Optional full-duplex terminal audio only if users demonstrate a need beyond official Hermes Voice Mode; it should not add native audio dependencies to the core package.

The project does not plan to become a telephony platform, device fleet manager, generic agent framework, or bundled speech-model server.

## Provider roadmap

Provider compatibility is earned through tests, not model-name configuration alone. A model is listed as supported only after:

1. A real session connects and acknowledges configuration.
2. Speech input and speech output work with the expected audio format.
3. Hermes gateway tool calls and tool responses complete.
4. Barge-in, response cancellation, and playback truncation behave correctly.
5. Provider errors close or recover without leaking credentials.
6. Captured event fixtures cover the documented protocol shape.

Provider source of truth: [OpenAI Realtime and audio](https://developers.openai.com/api/docs/guides/realtime) and the [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api). Future model names stay out of the roadmap until they are publicly documented and pass the compatibility gates above.

## Adoption gates

Before expanding the scope, the project is looking for evidence that the bridge is useful beyond its bundled demo:

- independent installations that reach a real provider session;
- repeat users rather than one-time clones;
- clients built outside this repository;
- setup completed in under ten minutes by a new user;
- real requests where Hermes tools, memory, skills, or approvals matter;
- concrete preference for full-duplex realtime speech over the simpler built-in Hermes Voice Mode.

If you are building one of these clients, open a focused [feature request](https://github.com/bielcarpi/hermes-live-voice/issues/new?template=feature_request.md) or start a GitHub Discussion with the deployment shape and evidence.
