"""Hermes Live entrypoint for the pinned Hugging Face realtime server.

speech-to-speech 0.2.11 publishes the OpenAI Realtime ``create_response``
turn-detection field but always starts an LLM response after final STT. Hermes
Live needs the documented false setting so it can route explicit background
commands without a second, conflicting model decision.
"""

from __future__ import annotations

import importlib
import logging
from importlib.metadata import version
from typing import Any


EXPECTED_VERSION = "0.2.11"


class _SilentContentConsole:
    """Drop upstream transcript rendering from the managed service logs."""

    def print(self, *_args: Any, **_kwargs: Any) -> None:
        return None


class _DropContentBelowWarning(logging.Filter):
    """Keep failures actionable without persisting ordinary conversation text."""

    _hermes_live_private_content_filter = True

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno >= logging.WARNING


def _install_private_runtime_logging_patch() -> None:
    """Suppress content-bearing output in the pinned managed runtime.

    The upstream Parakeet and Qwen handlers print transcripts directly to a
    Rich console, while its notifier and LLM output processor log the same
    content. Hermes Live runs this process as a background service, where that
    otherwise becomes an unexpected durable conversation log.
    """

    for module_name in (
        "speech_to_speech.STT.parakeet_tdt_handler",
        "speech_to_speech.TTS.qwen3_tts_handler",
    ):
        module = importlib.import_module(module_name)
        module.console = _SilentContentConsole()

    for logger_name in (
        "speech_to_speech.STT.transcription_notifier",
        "speech_to_speech.LLM.lm_output_processor",
    ):
        logger = logging.getLogger(logger_name)
        if not any(
            getattr(active, "_hermes_live_private_content_filter", False)
            for active in logger.filters
        ):
            logger.addFilter(_DropContentBelowWarning())


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
                yield LLMResponseChunk(
                    text=exact,
                    runtime_config=request.runtime_config,
                    response=response,
                    turn_id=request.turn_id,
                    turn_revision=request.turn_revision,
                    speech_stopped_at_s=request.speech_stopped_at_s,
                    cancel_generation=generation,
                )
                yield EndOfResponse(
                    turn_id=request.turn_id,
                    turn_revision=request.turn_revision,
                    cancel_generation=generation,
                )
                return
        yield from original(self, request)

    patched._hermes_live_exact_speech_patch = True  # type: ignore[attr-defined]
    BaseLanguageModelHandler.process = patched


def _install_empty_response_tools_patch() -> None:
    from speech_to_speech.LLM.language_model import BaseLanguageModelHandler
    from speech_to_speech.pipeline.messages import GenerateResponseRequest

    original = BaseLanguageModelHandler.process
    if getattr(original, "_hermes_live_empty_tools_patch", False):
        return

    def patched(self: Any, request: Any) -> Any:
        response = request.response if isinstance(request, GenerateResponseRequest) else None
        fields = getattr(response, "model_fields_set", set()) if response else set()
        if response and "tools" in fields and response.tools == []:
            session = request.runtime_config.session
            previous = session.tools
            session.tools = []
            try:
                yield from original(self, request)
            finally:
                session.tools = previous
            return
        yield from original(self, request)

    patched._hermes_live_empty_tools_patch = True  # type: ignore[attr-defined]
    BaseLanguageModelHandler.process = patched


def _install_transformers_tool_content_patch() -> None:
    """Keep MLX/Hugging Face chat templates compatible after tool calls.

    speech-to-speech 0.2.11 serializes assistant function-call history without
    a ``content`` key. Qwen templates read that key even when ``tool_calls`` is
    present, so the follow-up response fails before generation. Normalize only
    that assistant history shape and leave every other message unchanged.
    """

    from speech_to_speech.LLM.chat import Chat

    original = Chat.to_transformers_chat
    if getattr(original, "_hermes_live_tool_content_patch", False):
        return

    def patched(self: Any) -> list[dict[str, Any]]:
        messages = original(self)
        for message in messages:
            if (
                isinstance(message, dict)
                and message.get("role") == "assistant"
                and isinstance(message.get("tool_calls"), list)
            ):
                message.setdefault("content", "")
        return messages

    patched._hermes_live_tool_content_patch = True  # type: ignore[attr-defined]
    Chat.to_transformers_chat = patched


def main() -> None:
    _install_create_response_patch()
    _install_exact_speech_patch()
    _install_empty_response_tools_patch()
    _install_transformers_tool_content_patch()
    _install_private_runtime_logging_patch()
    from speech_to_speech.s2s_pipeline import main as upstream_main

    upstream_main()


if __name__ == "__main__":
    main()
