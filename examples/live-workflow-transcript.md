# Text-Only Live Workflow Transcript

This transcript shows the intended Hermes Live Voice flow without a recording. It is a readable example of the user experience, not a latency benchmark or provider-quality claim.

## Scenario

The user is in the Hermes Dashboard Live Voice tab, connected to a saved chat named `release`, using OpenAI Realtime, Gemini Live, or the local speech-to-speech provider.

## Transcript

**User:** Audit this repository and run the tests in the background. While that runs, help me plan the release. Tell me when it is done.

**Hermes Live:** I started a background task for the repository audit. You can keep talking while Hermes works.

**Task inbox:** `task_8f3a...` accepted, queued, then running.

**User:** Good. What should I prepare while it runs?

**Hermes Live:** Prepare the release notes, check the provider evidence, and keep the security boundary text visible in the README. I will tell you when the audit finishes.

**Task progress:** Hermes is reading project files and running verification. Tool output is summarized and obvious credential patterns are redacted.

**User:** Pause listening.

**Hermes Live:** Listening is paused. The background task is still running.

**Client event:** The microphone is paused. The WebSocket remains connected.

**User action:** The user closes the browser tab.

**Gateway state:** The Hermes task continues. The retained task receipt and latest safe progress stay in the local task store.

**User action:** The user reopens Hermes Dashboard, selects the same saved chat, and connects Live Voice again.

**Hermes Live:** The repository audit is still running. One completion notice is unread.

**Task notification:** `task_8f3a...` completed.

**User:** Summarize the result.

**Hermes Live:** The audit completed. The test suite passed, no package audit vulnerabilities were found, and the remaining work is documentation polish plus provider evidence before release.

**User:** Create a follow-up task to update the README based on that.

**Hermes Live:** I started a follow-up task linked to the completed audit. It has a new task id and can be stopped independently.

## What this demonstrates

- The realtime provider handles speech and turn-taking.
- Hermes handles the actual repository work.
- Hermes Live creates a bounded background task and keeps the voice session responsive.
- Disconnecting the client does not stop the task.
- Reconnecting restores task state and unread completion notices.
- Follow-ups create separate tasks with explicit lineage.
