#!/usr/bin/env python3
"""faster-whisper runner: reads JSON from stdin, writes JSON to stdout.

Never downloads models. The model path is provided in the payload and must
already exist on the local filesystem.
"""

import base64
import io
import json
import sys


def _health():
    """Verify the faster_whisper module is importable."""
    try:
        import faster_whisper  # noqa: F401
        print(json.dumps({"status": "ok"}))
    except Exception:
        print(json.dumps({"status": "error"}))
        sys.exit(1)


def _transcribe(payload):
    """Run transcription and print JSON result to stdout."""
    audio_b64 = payload["audio_base64"]
    model_path = payload["model_path"]
    model_cache_dir = payload["model_cache_dir"]
    language = payload.get("language")
    task = payload.get("task", "transcribe")

    audio_bytes = base64.b64decode(audio_b64)

    from faster_whisper import WhisperModel

    model = WhisperModel(
        model_path,
        device="cpu",
        compute_type="int8",
        download_root=model_cache_dir,
        local_files_only=True,
    )

    audio_input = io.BytesIO(audio_bytes)

    segments, info = model.transcribe(
        audio_input,
        language=language,
        task=task,
        vad_filter=True,
    )

    text_parts = []
    for segment in segments:
        text_parts.append(segment.text)

    text = " ".join(part.strip() for part in text_parts if part.strip())

    result = {"text": text}
    if info.language:
        result["language"] = info.language

    print(json.dumps(result))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--health":
        _health()
        return

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception:
        print(json.dumps({"error": "invalid_input"}))
        sys.exit(1)

    try:
        _transcribe(payload)
    except Exception:
        print(json.dumps({"error": "inference_failed"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
