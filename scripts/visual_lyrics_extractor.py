#!/usr/bin/env python3
"""
Visual Lyrics & Word-Timestamp Extractor for Suno/Karaoke Videos.
Integrated for Visual-Music-Lyrics (https://github.com/RONITERVO/Visual-Music-Lyrics).

Features:
1. Frame-cut detection in lyric area using video pixel difference.
2. Character stroke luminance/transparency analysis (opaque white active vs dim inactive).
3. Automatic bilingual split (primary lyrics + parenthetical translation).
4. Audio extraction from video to standalone .wav for separate audio playback.
5. Optional Whisper Large-v3-Turbo CUDA word alignment for millisecond per-word timing.
6. Export to JSON (Visual-Music-Lyrics native), SRT, VTT, and LRC.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

import av
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR


def format_timestamp_srt(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_timestamp_vtt(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def format_timestamp_lrc(seconds: float) -> str:
    total_cs = int(round(seconds * 100))
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    m = total_s // 60
    return f"[{m:02d}:{s:02d}.{cs:02d}]"


def split_bilingual_text(text: str) -> Tuple[str, str]:
    """Splits 'Spanish text (English translation)' into primary and translation."""
    norm = re.sub(r"\s+", " ", text).strip()
    match = re.match(r"^(.*?)\s*[\(\[]([^)\]]+)[\)\]]\s*$", norm)
    if match:
        primary = match.group(1).strip()
        translation = match.group(2).strip()
        if primary:
            return primary, translation
    return norm, ""


def detect_cuts(
    frames_gray: List[np.ndarray],
    y1: int,
    y2: int,
    x1: int,
    x2: int,
    diff_threshold: float = 4.0,
) -> List[int]:
    cuts = [0]
    n = len(frames_gray)
    for i in range(n - 1):
        roi1 = frames_gray[i][y1:y2, x1:x2]
        roi2 = frames_gray[i + 1][y1:y2, x1:x2]
        diff = float(np.mean(np.abs(roi1.astype(int) - roi2.astype(int))))
        if diff >= diff_threshold:
            cuts.append(i + 1)
    cuts.append(n)
    return cuts


def is_active_line(line_crop_bgr: np.ndarray, threshold: float = 215.0) -> Tuple[bool, float]:
    gray = cv2.cvtColor(line_crop_bgr, cv2.COLOR_BGR2GRAY)
    p80 = float(np.percentile(gray, 80))
    return (p80 >= threshold, p80)


def extract_audio_from_video(video_path: Path, output_wav: Path) -> bool:
    """Extract 16-bit 48kHz WAV audio from video using ffmpeg."""
    ffmpeg_cmd = shutil.which("ffmpeg") or r"C:\Users\ronit\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-7.1.1-full_build\bin\ffmpeg.exe"
    if not Path(ffmpeg_cmd).exists() and not shutil.which("ffmpeg"):
        print("Warning: ffmpeg not found, skipping audio extraction.")
        return False

    cmd = [
        str(ffmpeg_cmd),
        "-y",
        "-i", str(video_path),
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "48000",
        "-ac", "2",
        str(output_wav),
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"Extracted audio: {output_wav.name}")
        return True
    except Exception as e:
        print(f"Warning: ffmpeg audio extraction failed: {e}")
        return False


def run_whisper_word_alignment(
    audio_path: Path,
    model_path: str = r"D:\AI\ComfyUI\models\stt\whisper\large-v3-turbo.pt",
) -> List[Dict[str, Any]]:
    """Runs Whisper Large-v3-Turbo on CUDA to get word timestamps."""
    comfy_python = Path(r"D:\AI\ComfyUI\.venv\Scripts\python.exe")
    python_exe = str(comfy_python) if comfy_python.exists() else sys.executable

    script = f"""
import whisper, json
model = whisper.load_model(r"{model_path}", device="cuda")
result = model.transcribe(r"{audio_path}", word_timestamps=True, fp16=True)
words = []
for s in result.get("segments", []):
    for w in s.get("words", []):
        words.append({{"word": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3)}})
print("___WHISPER_WORDS_JSON___")
print(json.dumps(words, ensure_ascii=False))
"""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        proc = subprocess.run([python_exe, "-c", script], capture_output=True, env=env)
        stdout_text = proc.stdout.decode("utf-8", errors="replace")
        if "___WHISPER_WORDS_JSON___" in stdout_text:
            payload = stdout_text.split("___WHISPER_WORDS_JSON___")[1].strip()
            words = json.loads(payload)
            print(f"Whisper CUDA aligned {len(words)} words.")
            return words
        else:
            stderr_text = proc.stderr.decode("utf-8", errors="replace")
            if stderr_text:
                print(f"Whisper alignment stderr: {stderr_text[:200]}")
    except Exception as e:
        print(f"Whisper alignment note: {e}")
    return []


def match_words_to_sentences(
    sentences: List[Dict[str, Any]],
    whisper_words: List[Dict[str, Any]],
) -> None:
    """Matches Whisper word timings to each visual sentence span."""
    for s in sentences:
        s_start = s["start"] - 0.25
        s_end = s["end"] + 0.35
        matched = []
        for w in whisper_words:
            if s_start <= w["start"] <= s_end:
                matched.append({
                    "word": w["word"],
                    "start": w["start"],
                    "end": w["end"],
                })
        s["words"] = matched


def extract_visual_sentence_timings(
    video_path: str | Path,
    active_threshold: float = 215.0,
    diff_threshold: float = 4.0,
    with_whisper: bool = False,
    extract_audio: bool = True,
    output_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    video_path = Path(video_path)
    if not video_path.is_file():
        raise FileNotFoundError(f"Video file not found: {video_path}")

    out_dir = output_dir or video_path.parent
    base_name = video_path.stem

    # 1. Optionally extract WAV audio for separate playback
    wav_path = out_dir / f"{base_name}.wav"
    if extract_audio and not wav_path.exists():
        extract_audio_from_video(video_path, wav_path)

    # 2. Decode video frames
    container = av.open(str(video_path))
    stream = container.streams.video[0]
    duration_s = float(stream.duration * stream.time_base) if stream.duration else 0.0
    r_frame_rate = float(stream.average_rate or 10.0)

    print(f"Decoding {video_path.name} ({stream.width}x{stream.height} @ {r_frame_rate:.1f} fps, {duration_s:.1f}s)...")
    frames_bgr: List[np.ndarray] = []
    frames_gray: List[np.ndarray] = []
    for frame in container.decode(video=0):
        bgr = frame.to_ndarray(format="bgr24")
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        frames_bgr.append(bgr)
        frames_gray.append(gray)

    num_frames = len(frames_bgr)
    frame_interval = 1.0 / r_frame_rate if r_frame_rate > 0 else 0.1
    H, W = frames_gray[0].shape
    y1, y2 = int(0.48 * H), int(0.74 * H)
    x1, x2 = int(0.15 * W), int(0.85 * W)

    # 3. Detect transitions and OCR stable intervals
    cuts = detect_cuts(frames_gray, y1, y2, x1, x2, diff_threshold=diff_threshold)
    engine = RapidOCR()
    raw_segments: List[Dict[str, Any]] = []

    for idx in range(len(cuts) - 1):
        sf = cuts[idx]
        ef = cuts[idx + 1]
        mid = (sf + ef) // 2

        start_time = round(sf * frame_interval, 2)
        end_time = round(ef * frame_interval, 2)

        crop_bgr = frames_bgr[mid][y1:y2, x1:x2]
        res, _ = engine(crop_bgr)

        active_lines: List[Dict[str, Any]] = []
        if res:
            for bbox, text, score in res:
                ys = [int(p[1]) for p in bbox]
                xs = [int(p[0]) for p in bbox]
                min_y, max_y = max(0, min(ys)), min(crop_bgr.shape[0], max(ys))
                min_x, max_x = max(0, min(xs)), min(crop_bgr.shape[1], max(xs))

                line_crop = crop_bgr[min_y:max_y, min_x:max_x]
                if line_crop.size == 0:
                    continue

                active, p80 = is_active_line(line_crop, threshold=active_threshold)
                cleaned = re.sub(r"\s+", " ", text).strip()
                if "SUNO" in cleaned.upper() or "AMOR DIGITAL" in cleaned:
                    continue

                if active and cleaned:
                    active_lines.append({"text": cleaned, "y": min_y, "p80": p80})

        active_lines.sort(key=lambda item: item["y"])
        combined_text = " ".join(item["text"] for item in active_lines).strip()
        raw_segments.append({
            "start": start_time,
            "end": end_time,
            "active_lines": active_lines,
            "text": combined_text,
        })

    # 4. Group lines into complete sentences
    line_spans: List[Dict[str, Any]] = []
    for seg in raw_segments:
        s = seg["start"]
        e = seg["end"]
        for l in seg["active_lines"]:
            t = l["text"].strip()
            norm = re.sub(r"[^a-zA-ZáéíóúñÁÉÍÓÚÑ]", "", t).lower()
            if not norm:
                continue

            if line_spans and re.sub(r"[^a-zA-ZáéíóúñÁÉÍÓÚÑ]", "", line_spans[-1]["text"]).lower() == norm and abs(line_spans[-1]["end"] - s) <= 0.2:
                best_t = t if len(t) > len(line_spans[-1]["text"]) else line_spans[-1]["text"]
                line_spans[-1]["text"] = best_t
                line_spans[-1]["end"] = e
            else:
                line_spans.append({"text": t, "start": s, "end": e})

    final_sentences: List[Dict[str, Any]] = []
    i = 0
    while i < len(line_spans):
        curr = line_spans[i]
        t1, s1, e1 = curr["text"], curr["start"], curr["end"]
        open1, close1 = t1.count("("), t1.count(")")

        if i + 1 < len(line_spans) and (open1 > close1 or not t1.rstrip().endswith(")")):
            nxt = line_spans[i + 1]
            t2, e2 = nxt["text"], nxt["end"]
            combined = re.sub(r"\s+", " ", f"{t1} {t2}").strip()
            end = max(e1, e2)
            primary, translation = split_bilingual_text(combined)
            final_sentences.append({
                "id": f"seg_{len(final_sentences)+1}",
                "start": s1,
                "end": end,
                "duration": round(end - s1, 2),
                "text": combined,
                "primary": primary,
                "translation": translation,
                "words": [],
            })
            i += 2
        else:
            primary, translation = split_bilingual_text(t1)
            final_sentences.append({
                "id": f"seg_{len(final_sentences)+1}",
                "start": s1,
                "end": e1,
                "duration": round(e1 - s1, 2),
                "text": t1,
                "primary": primary,
                "translation": translation,
                "words": [],
            })
            i += 1

    cleaned_sentences = [s for s in final_sentences if re.search(r"[a-zA-ZáéíóúñÁÉÍÓÚÑ]", s["text"])]
    for idx, s in enumerate(cleaned_sentences, 1):
        s["order"] = idx

    # 5. Optional Whisper word alignment
    if with_whisper:
        audio_target = wav_path if wav_path.exists() else video_path
        words = run_whisper_word_alignment(audio_target)
        if words:
            match_words_to_sentences(cleaned_sentences, words)

    return {
        "title": base_name,
        "video": str(video_path),
        "audio": str(wav_path) if wav_path.exists() else None,
        "duration": duration_s,
        "segments": cleaned_sentences,
    }


def export_srt(sentences: List[Dict[str, Any]], output_path: Path) -> None:
    lines = []
    for i, s in enumerate(sentences, 1):
        lines.append(str(i))
        lines.append(f"{format_timestamp_srt(s['start'])} --> {format_timestamp_srt(s['end'])}")
        display = s["primary"] + (f" ({s['translation']})" if s.get("translation") else "")
        lines.append(display)
        lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")


def export_lrc(sentences: List[Dict[str, Any]], output_path: Path) -> None:
    lines = []
    for s in sentences:
        display = s["primary"] + (f" ({s['translation']})" if s.get("translation") else "")
        lines.append(f"{format_timestamp_lrc(s['start'])}{display}")
    output_path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="Visual Lyrics & Word Timing Extractor for Suno Videos (Visual-Music-Lyrics)."
    )
    parser.add_argument("video", help="Path to video file (.mp4)")
    parser.add_argument("-o", "--output-dir", default=None, help="Output directory")
    parser.add_argument("-w", "--whisper", action="store_true", help="Align word timestamps using Whisper CUDA")
    parser.add_argument("--no-audio-extract", action="store_true", help="Do not extract separate .wav")
    args = parser.parse_args()

    video_path = Path(args.video)
    out_dir = Path(args.output_dir) if args.output_dir else video_path.parent

    data = extract_visual_sentence_timings(
        video_path=video_path,
        with_whisper=args.whisper,
        extract_audio=not args.no_audio_extract,
        output_dir=out_dir,
    )

    base = video_path.stem
    json_path = out_dir / f"{base}.json"
    srt_path = out_dir / f"{base}.srt"
    lrc_path = out_dir / f"{base}.lrc"

    json_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    export_srt(data["segments"], srt_path)
    export_lrc(data["segments"], lrc_path)

    print(f"\n[Visual-Music-Lyrics] Saved {len(data['segments'])} segments:")
    print(f"  - JSON (Native): {json_path}")
    print(f"  - SRT Subtitles: {srt_path}")
    print(f"  - LRC Lyrics   : {lrc_path}")


if __name__ == "__main__":
    main()
