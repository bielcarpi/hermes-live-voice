"""
CustomVoice Configuration Benchmark
====================================
Compares baseline (no instruct, no gen_kwargs) vs new config (instruct + sampling knobs)
across 3 representative conversation-turn lengths, 3 iterations each.

Measures:
  - TTFC  (time-to-first-chunk)  — perceived latency
  - Total inference time
  - Audio duration
  - RTF  (real-time factor = audio_duration / inference_time, higher = faster)

Usage:
    cd backend
    python scripts/bench_customvoice.py
    python scripts/bench_customvoice.py --iterations 5
    python scripts/bench_customvoice.py --output results.json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from queue import Queue
from threading import Event
from typing import Any

import numpy as np

# ── paths ──────────────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_PATH = REPO_ROOT / "src"
if str(SRC_PATH) not in sys.path:
    sys.path.insert(0, str(SRC_PATH))

logging.basicConfig(
    level=logging.WARNING,  # suppress handler internals — we print our own table
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# Keep our own logger visible
logger = logging.getLogger("bench_customvoice")
logger.setLevel(logging.INFO)

PIPELINE_SR = 16_000  # handler resamples to 16 kHz

# ── representative texts ───────────────────────────────────────────────────────
TEXTS = {
    "short":
        "Got it. I'll look into that right away.",
    "medium":
        "Sure, I can help with that. "
        "The main thing to keep in mind is that the configuration you choose "
        "will affect both the speed and the consistency of the output.",
    "long":
        "Alright, let me walk you through what's happening here. "
        "The TTS model generates speech token by token, so the first chunk "
        "arrives as soon as the first few codec frames are ready. "
        "After that, audio streams continuously until the sentence is complete. "
        "The real-time factor tells you how fast generation is relative to "
        "playback — anything above one means we're generating faster than "
        "real time, which is what you want for a smooth conversation.",
}

# ── configs under test ─────────────────────────────────────────────────────────
CONFIGS: dict[str, dict[str, Any]] = {
    "baseline": {
        "model_name": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        "speaker": "Aiden",
        "language": "auto",
        "instruct": None,
        "non_streaming_mode": True,
        "max_new_tokens": 1536,
        "gen_kwargs": {},
    },
    "new_config": {
        "model_name": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        "speaker": "Aiden",
        "language": "auto",
        "instruct": (
            "Speak at a steady, natural pace with a clear and warm tone. "
            "Keep volume and energy consistent across sentences."
        ),
        "non_streaming_mode": True,
        "max_new_tokens": 2048,
        "gen_kwargs": {
            "temperature": 0.7,
            "top_p": 0.95,
            "top_k": 50,
            "repetition_penalty": 1.05,
        },
    },
}


# ── result container ───────────────────────────────────────────────────────────

class RunResult:
    def __init__(self) -> None:
        self.ttfc: list[float] = []
        self.total: list[float] = []
        self.audio_s: list[float] = []
        self.errors: list[str] = []

    def add(self, ttfc: float | None, total: float, audio_s: float) -> None:
        if ttfc is not None:
            self.ttfc.append(ttfc)
        self.total.append(total)
        self.audio_s.append(audio_s)

    def rtf(self) -> float:
        if not self.total or not self.audio_s:
            return 0.0
        return float(np.mean(self.audio_s)) / float(np.mean(self.total))

    def summary(self) -> dict[str, Any]:
        def _s(xs: list[float]) -> dict[str, float]:
            if not xs:
                return {}
            return {
                "avg": round(float(np.mean(xs)), 4),
                "min": round(float(np.min(xs)), 4),
                "max": round(float(np.max(xs)), 4),
                "std": round(float(np.std(xs)), 4),
            }

        return {
            "ttfc_s": _s(self.ttfc),
            "inference_s": _s(self.total),
            "audio_s": _s(self.audio_s),
            "avg_rtf": round(self.rtf(), 3),
            "n": len(self.total),
            "errors": self.errors,
        }


# ── benchmark logic ────────────────────────────────────────────────────────────

def build_handler(cfg: dict[str, Any]) -> Any:
    from speech_to_speech.TTS.qwen3_tts_handler import Qwen3TTSHandler

    stop_event = Event()
    should_listen = Event()
    queue_in: Queue[Any] = Queue()
    queue_out: Queue[Any] = Queue()

    handler = Qwen3TTSHandler(
        stop_event,
        queue_in=queue_in,
        queue_out=queue_out,
        setup_args=(should_listen,),
        setup_kwargs=cfg,
    )
    return handler


def run_one(handler: Any, text: str) -> tuple[float | None, float, float]:
    """Run one inference pass. Returns (ttfc, total_time, audio_duration)."""
    from speech_to_speech.pipeline.messages import TTSInput

    msg = TTSInput(text=text)

    start = time.perf_counter()
    ttfc: float | None = None
    first = True
    total_samples = 0

    for chunk in handler.process(msg):
        if first and chunk is not None:
            ttfc = time.perf_counter() - start
            first = False
        if chunk is None:
            continue
        try:
            arr = np.frombuffer(chunk, dtype=np.int16) if isinstance(chunk, (bytes, bytearray)) else chunk
            total_samples += len(arr)
        except Exception:
            pass

    total = time.perf_counter() - start
    audio_s = total_samples / PIPELINE_SR if total_samples > 0 else 0.0
    return ttfc, total, audio_s


def benchmark_config(
    config_name: str,
    cfg: dict[str, Any],
    texts: dict[str, str],
    iterations: int,
) -> dict[str, RunResult]:
    logger.info(f"  Loading handler for [{config_name}] …")
    warmup_start = time.perf_counter()
    handler = build_handler(cfg)
    warmup_s = time.perf_counter() - warmup_start
    logger.info(f"  Handler ready in {warmup_s:.1f}s")

    results: dict[str, RunResult] = {label: RunResult() for label in texts}

    for label, text in texts.items():
        for i in range(iterations):
            logger.info(f"    [{config_name}] text={label} iter={i+1}/{iterations}")
            try:
                ttfc, total, audio_s = run_one(handler, text)
                results[label].add(ttfc, total, audio_s)
                ttfc_str = f"{ttfc:.3f}s" if ttfc else "n/a"
                rtf = audio_s / total if total > 0 else 0
                logger.info(
                    f"      TTFC={ttfc_str}  total={total:.3f}s  "
                    f"audio={audio_s:.2f}s  RTF={rtf:.2f}"
                )
            except Exception as e:
                logger.error(f"      ERROR: {e}", exc_info=True)
                results[label].errors.append(str(e))

    handler.cleanup()
    return results


# ── printing ───────────────────────────────────────────────────────────────────

COL = 14

def _fmt(val: float | None, unit: str = "s") -> str:
    if val is None:
        return " " * COL
    return f"{val:.3f}{unit}".rjust(COL)


def print_table(all_results: dict[str, dict[str, RunResult]]) -> None:
    configs = list(all_results.keys())
    texts = list(next(iter(all_results.values())).keys())

    print()
    print("=" * 90)
    print("  CUSTOMVOICE BENCHMARK  —  baseline vs new_config")
    print("=" * 90)

    metrics = [
        ("TTFC avg",       lambda r: r.summary()["ttfc_s"].get("avg")),
        ("TTFC std",       lambda r: r.summary()["ttfc_s"].get("std")),
        ("Infer avg",      lambda r: r.summary()["inference_s"].get("avg")),
        ("Infer std",      lambda r: r.summary()["inference_s"].get("std")),
        ("Audio avg",      lambda r: r.summary()["audio_s"].get("avg")),
        ("RTF",            lambda r: r.summary()["avg_rtf"]),
    ]

    for text_label in texts:
        print(f"\n  Text: {text_label!r}  ({len(TEXTS[text_label])} chars)")
        print(f"  {'Metric':<14}" + "".join(c.rjust(COL) for c in configs))
        print("  " + "-" * (14 + COL * len(configs)))
        for metric_name, getter in metrics:
            row = f"  {metric_name:<14}"
            for cfg_name in configs:
                r = all_results[cfg_name][text_label]
                val = getter(r)
                unit = "x" if metric_name == "RTF" else "s"
                row += _fmt(val, unit)
            print(row)

    # delta summary
    if len(configs) == 2:
        print()
        print("  DELTA  (new_config vs baseline)  — negative = faster / lower")
        print(f"  {'Text':<10}  {'TTFC Δ':>10}  {'Infer Δ':>10}  {'RTF Δ':>10}")
        print("  " + "-" * 44)
        base_r = all_results["baseline"]
        new_r  = all_results["new_config"]
        for text_label in texts:
            b = base_r[text_label].summary()
            n = new_r[text_label].summary()
            b_ttfc  = b["ttfc_s"].get("avg")
            n_ttfc  = n["ttfc_s"].get("avg")
            b_inf   = b["inference_s"].get("avg")
            n_inf   = n["inference_s"].get("avg")
            d_ttfc  = f"{n_ttfc - b_ttfc:+.3f}s" if (b_ttfc and n_ttfc) else "n/a"
            d_inf   = f"{n_inf  - b_inf  :+.3f}s" if (b_inf  and n_inf ) else "n/a"
            d_rtf   = f"{n['avg_rtf'] - b['avg_rtf']:+.3f}x"
            print(f"  {text_label:<10}  {d_ttfc:>10}  {d_inf:>10}  {d_rtf:>10}")

    print()
    print("=" * 90)


# ── main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark baseline vs new CustomVoice config")
    parser.add_argument("--iterations", type=int, default=3, help="Iterations per text/config (default: 3)")
    parser.add_argument("--output", type=str, default=None, help="Save JSON results to this file")
    parser.add_argument(
        "--texts",
        nargs="+",
        choices=list(TEXTS.keys()),
        default=list(TEXTS.keys()),
        help="Which text lengths to test (default: all)",
    )
    parser.add_argument(
        "--configs",
        nargs="+",
        choices=list(CONFIGS.keys()),
        default=list(CONFIGS.keys()),
        help="Which configs to run (default: all)",
    )
    args = parser.parse_args()

    selected_texts = {k: TEXTS[k] for k in args.texts}
    selected_configs = {k: CONFIGS[k] for k in args.configs}

    print(f"\nRunning {len(selected_configs)} config(s) × {len(selected_texts)} text(s) × {args.iterations} iter(s)")
    print(f"Configs : {list(selected_configs.keys())}")
    print(f"Texts   : {list(selected_texts.keys())}\n")

    all_results: dict[str, dict[str, RunResult]] = {}

    for config_name, cfg in selected_configs.items():
        print(f"▶  {config_name}")
        all_results[config_name] = benchmark_config(
            config_name, cfg, selected_texts, args.iterations
        )

    print_table(all_results)

    if args.output:
        data = {
            cfg_name: {
                text_label: result.summary()
                for text_label, result in text_results.items()
            }
            for cfg_name, text_results in all_results.items()
        }
        out_path = Path(args.output)
        out_path.write_text(json.dumps(data, indent=2))
        print(f"Results saved to {out_path}")


if __name__ == "__main__":
    main()
