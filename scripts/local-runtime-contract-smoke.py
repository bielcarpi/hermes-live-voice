#!/usr/bin/env python3
"""Exercise the managed speech-to-speech compatibility contract without models."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "assets" / "huggingface-realtime-entry.py"


class FakeMessage:
    def __init__(self, **values: Any) -> None:
        self.__dict__.update(values)


class GenerateResponseRequest:
    def __init__(self, response: Any, runtime_config: Any) -> None:
        self.response = response
        self.runtime_config = runtime_config
        self.turn_id = "turn_1"
        self.turn_revision = 1
        self.speech_stopped_at_s = 0.5
        self.response_key = "response_1"


class BaseLanguageModelHandler:
    def __init__(self) -> None:
        self.cancel_scope = SimpleNamespace(generation=7)
        self.latest = True

    def _turn_is_latest(self, _turn_id: str, _revision: int) -> bool:
        return self.latest

    def process(self, request: Any) -> Any:
        tools = getattr(request.response, "tools", None)
        yield ("original", list(tools if tools is not None else request.runtime_config.session.tools))


class RealtimeService:
    def __init__(self, runtime_config: Any) -> None:
        self.runtime_config = runtime_config
        self.text_prompt_queue = object()
        self.queue_seen: list[Any] = []

    def _state(self, _conn_id: str) -> Any:
        return SimpleNamespace(runtime_config=self.runtime_config)

    def _on_transcription_completed(self, _conn_id: str, _event: Any) -> str:
        self.queue_seen.append(self.text_prompt_queue)
        return "completed"


def install_fake_upstream() -> None:
    modules = {
        "speech_to_speech": types.ModuleType("speech_to_speech"),
        "speech_to_speech.api": types.ModuleType("speech_to_speech.api"),
        "speech_to_speech.api.openai_realtime": types.ModuleType(
            "speech_to_speech.api.openai_realtime"
        ),
        "speech_to_speech.api.openai_realtime.service": types.ModuleType(
            "speech_to_speech.api.openai_realtime.service"
        ),
        "speech_to_speech.LLM": types.ModuleType("speech_to_speech.LLM"),
        "speech_to_speech.LLM.language_model": types.ModuleType(
            "speech_to_speech.LLM.language_model"
        ),
        "speech_to_speech.STT": types.ModuleType("speech_to_speech.STT"),
        "speech_to_speech.STT.parakeet_tdt_handler": types.ModuleType(
            "speech_to_speech.STT.parakeet_tdt_handler"
        ),
        "speech_to_speech.TTS": types.ModuleType("speech_to_speech.TTS"),
        "speech_to_speech.TTS.qwen3_tts_handler": types.ModuleType(
            "speech_to_speech.TTS.qwen3_tts_handler"
        ),
        "speech_to_speech.pipeline": types.ModuleType("speech_to_speech.pipeline"),
        "speech_to_speech.pipeline.messages": types.ModuleType(
            "speech_to_speech.pipeline.messages"
        ),
    }
    modules["speech_to_speech.api.openai_realtime.service"].RealtimeService = RealtimeService
    modules["speech_to_speech.LLM.language_model"].BaseLanguageModelHandler = (
        BaseLanguageModelHandler
    )
    modules["speech_to_speech.STT.parakeet_tdt_handler"].console = object()
    modules["speech_to_speech.TTS.qwen3_tts_handler"].console = object()
    messages = modules["speech_to_speech.pipeline.messages"]
    messages.GenerateResponseRequest = GenerateResponseRequest
    messages.LLMResponseChunk = type("LLMResponseChunk", (FakeMessage,), {})
    messages.EndOfResponse = type("EndOfResponse", (FakeMessage,), {})
    sys.modules.update(modules)


def runtime_config(create_response: bool, tools: list[str] | None = None) -> Any:
    return SimpleNamespace(
        session=SimpleNamespace(
            audio=SimpleNamespace(
                input=SimpleNamespace(
                    turn_detection={"create_response": create_response},
                )
            ),
            tools=list(tools or ["session_tool"]),
        )
    )


def load_entrypoint() -> Any:
    spec = importlib.util.spec_from_file_location("hermes_live_hf_entry", ENTRYPOINT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {ENTRYPOINT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    install_fake_upstream()
    entrypoint = load_entrypoint()

    entrypoint.version = lambda _name: "9.9.9"
    try:
        entrypoint._install_create_response_patch()
    except RuntimeError as error:
        assert "expected speech-to-speech 1.0.0" in str(error)
    else:
        raise AssertionError("An unreviewed speech-to-speech version must fail closed")

    entrypoint.version = lambda _name: entrypoint.EXPECTED_VERSION
    entrypoint._install_create_response_patch()
    entrypoint._install_exact_speech_patch()
    entrypoint._install_private_runtime_logging_patch()
    entrypoint._install_private_runtime_logging_patch()

    deferred = RealtimeService(runtime_config(False))
    queue = deferred.text_prompt_queue
    assert deferred._on_transcription_completed("conn", object()) == "completed"
    assert deferred.queue_seen == [None]
    assert deferred.text_prompt_queue is queue

    automatic = RealtimeService(runtime_config(True))
    assert automatic._on_transcription_completed("conn", object()) == "completed"
    assert automatic.queue_seen == [automatic.text_prompt_queue]

    handler = BaseLanguageModelHandler()
    if "--conversation-responses" in sys.argv:
        # Exercise actual gateway payloads, including the summary fallback,
        # against the same patch stack that the managed runtime installs.
        for payload in json.load(sys.stdin):
            response = SimpleNamespace(**payload, model_fields_set=set(payload))
            runtime = runtime_config(False, ["private_session_tool"])
            output = list(handler.process(GenerateResponseRequest(response, runtime)))
            exact = payload["metadata"].get("hermes_live_exact_speech")
            if exact is not None:
                assert [type(item).__name__ for item in output] == ["LLMResponseChunk", "EndOfResponse"]
                assert output[0].text == exact
                assert output[0].cancel_generation == 7
            else:
                assert output == [("original", [])], "Summary responses must reach the model with tools disabled"
            assert runtime.session.tools == ["private_session_tool"]

    exact_response = SimpleNamespace(
        metadata={
            "hermes_live_purpose": "conversation_answer",
            "hermes_live_exact_speech": "The task is running.",
        },
        model_fields_set=set(),
        tools=None,
    )
    exact_output = list(handler.process(GenerateResponseRequest(exact_response, runtime_config(False))))
    assert [type(item).__name__ for item in exact_output] == [
        "LLMResponseChunk",
        "EndOfResponse",
    ]
    assert exact_output[0].text == "The task is running."
    assert all(item.response_key == "response_1" for item in exact_output)

    handler.latest = False
    stale_output = list(handler.process(GenerateResponseRequest(exact_response, runtime_config(False))))
    assert [type(item).__name__ for item in stale_output] == ["EndOfResponse"]
    assert stale_output[0].response_key == "response_1"
    handler.latest = True

    for invalid in ("", "x" * 501, "bad\nmetadata"):
        response = SimpleNamespace(
            metadata={
                "hermes_live_purpose": "task_notification",
                "hermes_live_exact_speech": invalid,
            },
            model_fields_set=set(),
            tools=None,
        )
        try:
            list(handler.process(GenerateResponseRequest(response, runtime_config(False))))
        except RuntimeError as error:
            assert "exact speech metadata is invalid" in str(error)
        else:
            raise AssertionError("Invalid exact speech metadata must fail closed")

    no_tools_response = SimpleNamespace(metadata={}, model_fields_set={"tools"}, tools=[])
    no_tools_runtime = runtime_config(False, ["private_session_tool"])
    no_tools_output = list(
        handler.process(GenerateResponseRequest(no_tools_response, no_tools_runtime))
    )
    assert no_tools_output == [("original", [])]
    assert no_tools_runtime.session.tools == ["private_session_tool"]

    inherited_response = SimpleNamespace(metadata={}, model_fields_set=set(), tools=None)
    inherited_runtime = runtime_config(False, ["session_tool"])
    inherited_output = list(
        handler.process(GenerateResponseRequest(inherited_response, inherited_runtime))
    )
    assert inherited_output == [("original", ["session_tool"])]

    for module_name in (
        "speech_to_speech.STT.parakeet_tdt_handler",
        "speech_to_speech.TTS.qwen3_tts_handler",
    ):
        assert sys.modules[module_name].console.print("private transcript") is None

    print("Managed local runtime contract smoke passed.")


if __name__ == "__main__":
    main()
