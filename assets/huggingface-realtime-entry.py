"""Hermes Live entrypoint for the pinned Hugging Face realtime server.

speech-to-speech 1.0.0 publishes the OpenAI Realtime ``create_response``
turn-detection field but always starts an LLM response after final STT. Hermes
Live needs the documented false setting so it can route explicit background
commands without a second, conflicting model decision.
"""

from __future__ import annotations

import importlib
from importlib.metadata import version
from typing import Any


EXPECTED_VERSION = "1.0.0"


class _SilentContentConsole:
    """Drop upstream transcript rendering from the managed service logs."""

    def print(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def _install_private_runtime_logging_patch() -> None:
    """Silence terminal transcripts in service logs; upstream loggers redact by default."""

    for module_name in (
        "speech_to_speech.STT.parakeet_tdt_handler",
        "speech_to_speech.TTS.qwen3_tts_handler",
    ):
        module = importlib.import_module(module_name)
        module.console = _SilentContentConsole()


def _create_response_enabled(runtime_config: Any) -> bool:
    audio = getattr(getattr(runtime_config, "session", None), "audio", None)
    audio_input = getattr(audio, "input", None)
    turn_detection = getattr(audio_input, "turn_detection", None)
    if turn_detection is None:
        return True
    if isinstance(turn_detection, dict):
        value = turn_detection.get("create_response")
    else:
        value = getattr(turn_detection, "create_response", None)
    return True if value is None else bool(value)


def _install_create_response_patch() -> None:
    installed = version("speech-to-speech")
    if installed != EXPECTED_VERSION:
        raise RuntimeError(
            f"Hermes Live expected speech-to-speech {EXPECTED_VERSION}, got {installed}."
        )

    from speech_to_speech.api.openai_realtime.service import RealtimeService

    original = RealtimeService._on_transcription_completed
    if getattr(original, "_hermes_live_create_response_patch", False):
        return

    def patched(self: Any, conn_id: str, event: Any) -> Any:
        state = self._state(conn_id)
        if _create_response_enabled(state.runtime_config):
            return original(self, conn_id, event)

        # The upstream method performs all transcript bookkeeping and emits
        # the final protocol event. Temporarily withholding only its LLM queue
        # preserves that behavior while honoring create_response=false. The
        # handler is synchronous on one pipeline event loop, so no other
        # connection can observe this bounded substitution.
        queue = self.text_prompt_queue
        self.text_prompt_queue = None
        try:
            return original(self, conn_id, event)
        finally:
            self.text_prompt_queue = queue

    patched._hermes_live_create_response_patch = True  # type: ignore[attr-defined]
    RealtimeService._on_transcription_completed = patched


def _install_exact_speech_patch() -> None:
    from speech_to_speech.LLM.language_model import BaseLanguageModelHandler
    from speech_to_speech.pipeline.messages import (
        EndOfResponse,
        GenerateResponseRequest,
        LLMResponseChunk,
    )

    original = BaseLanguageModelHandler.process
    if getattr(original, "_hermes_live_exact_speech_patch", False):
        return

    def patched(self: Any, request: Any) -> Any:
        if isinstance(request, GenerateResponseRequest):
            response = request.response
            metadata = getattr(response, "metadata", None) if response else None
            purpose = metadata.get("hermes_live_purpose") if isinstance(metadata, dict) else None
            exact = metadata.get("hermes_live_exact_speech") if isinstance(metadata, dict) else None
            if purpose in {"conversation_answer", "tool_receipt", "task_notification"}:
                if (
                    not isinstance(exact, str)
                    or not exact.strip()
                    or len(exact) > 500
                    or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in exact)
                ):
                    raise RuntimeError("Hermes Live exact speech metadata is invalid.")
                generation = self.cancel_scope.generation if self.cancel_scope else None
                if not self._turn_is_latest(request.turn_id, request.turn_revision):
                    yield EndOfResponse(
                        turn_id=request.turn_id,
                        turn_revision=request.turn_revision,
                        cancel_generation=generation,
                        response_key=request.response_key,
                    )
                    return
                yield LLMResponseChunk(
                    text=exact,
                    runtime_config=request.runtime_config,
                    response=response,
                    turn_id=request.turn_id,
                    turn_revision=request.turn_revision,
                    speech_stopped_at_s=request.speech_stopped_at_s,
                    cancel_generation=generation,
                    response_key=request.response_key,
                )
                yield EndOfResponse(
                    turn_id=request.turn_id,
                    turn_revision=request.turn_revision,
                    cancel_generation=generation,
                    response_key=request.response_key,
                )
                return
        yield from original(self, request)

    patched._hermes_live_exact_speech_patch = True  # type: ignore[attr-defined]
    BaseLanguageModelHandler.process = patched


def main() -> None:
    _install_create_response_patch()
    _install_exact_speech_patch()
    _install_private_runtime_logging_patch()
    from speech_to_speech.cli import main as upstream_main

    upstream_main()


if __name__ == "__main__":
    main()
