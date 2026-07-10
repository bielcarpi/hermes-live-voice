from speech_to_speech.LLM.tool_call.function_tool import FunctionTool
from speech_to_speech.LLM.tool_call.tool_prompt import build_tool_system_prompt
from speech_to_speech.LLM.voice_prompt import build_voice_system_prompt


def test_voice_prompt_tail_omits_tool_usage_guidance():
    prompt = build_voice_system_prompt("Be concise.")

    assert "## Voice output (read this section carefully)" in prompt
    assert "Speak, don't write." in prompt
    assert "Prefer one spoken sentence" in prompt
    assert "## Tool Usage" not in prompt
    assert "Speech is the default." not in prompt


def test_voice_prompt_tail_has_no_idle_action_language():
    prompt = build_voice_system_prompt("Be concise.")

    assert "idle behavior" not in prompt
    assert "idle action" not in prompt


def test_local_tool_prompt_forbids_multiple_tool_calls():
    prompt = build_tool_system_prompt(
        [
            FunctionTool(
                type="function",
                name="dance",
                description="Dance once.",
                parameters={"type": "object", "properties": {}},
            )
        ]
    )

    assert "Only one tool call may appear in a response." in prompt
    assert "Multiple tool calls can live" not in prompt
