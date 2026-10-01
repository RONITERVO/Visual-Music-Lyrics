#!/usr/bin/env python3
"""Local Suno lyric-video import: streamed OCR, bilingual audio alignment, audio only.
Suno cards supply sentence text/windows. Whisper cross-attention aligns that text
to audio. Machine estimates need review; collapsed/low-confidence words are flagged.
No network transcription, generated translations, or deletion of the input file.
"""
from __future__ import annotations
import argparse
from difflib import SequenceMatcher
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata


def normalized(text: str) -> str:
    return ''.join(c.lower() for c in unicodedata.normalize('NFKD', text) if c.isalnum())


def split_bilingual_text(text: str) -> tuple[str, str]:
    text = re.sub(r'\[[^\]]*\]', '', text).strip()
    match = re.fullmatch(r'(.*?)\s*\(([^()]*)\)\s*', text)
    return (match[1].strip(), match[2].strip()) if match else (text, '')


def extract_audio(video: Path, output: Path, ffmpeg: str) -> None:
    # Remux Suno AAC losslessly; convert other codecs if the M4A muxer rejects them.
    common = [ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(video),
              '-map', '0:a:0', '-vn', '-map_metadata', '-1']
    copy = subprocess.run(common + ['-c:a', 'copy', '-movflags', '+faststart', str(output)],
                          capture_output=True, timeout=180)
    if copy.returncode:
        subprocess.run(common + ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(output)],
                       check=True, capture_output=True, timeout=180)


def visual_sentences(video: Path, roi: tuple) -> tuple[list[dict], float, list[dict]]:
    import av
    import cv2
    import numpy as np
    from rapidocr import RapidOCR, LangRec, OCRVersion, ModelType
    engine = RapidOCR(params={'Rec.lang_type': LangRec.LATIN,
                             'Rec.ocr_version': OCRVersion.PPOCRV5,
                             'Rec.model_type': ModelType.MOBILE})
    observations = []

    def recognize(crop, start, end):
        if end - start < 0.18:
            return
        lines = []
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        # Projection preserves tiny standalone closing parentheses and clipped
        # word fragments which the generic text detector often drops entirely.
        occupied = (gray > 135).sum(axis=1) >= 3
        bands = []
        for y in np.flatnonzero(occupied):
            if bands and y - bands[-1][1] <= 5:
                bands[-1][1] = int(y)
            else:
                bands.append([int(y), int(y)])
        for top, bottom in bands:
            if bottom - top < 8:
                continue
            xs = np.flatnonzero((gray[top:bottom+1] > 135).any(axis=0))
            if not len(xs):
                continue
            y1, y2 = max(0, top-3), min(crop.shape[0], bottom+4)
            x1, x2 = max(0, int(xs[0])-3), min(crop.shape[1], int(xs[-1])+4)
            region = crop[y1:y2, x1:x2]
            result = engine(region, use_det=False, use_cls=False)
            if not result.txts:
                continue
            text, score = result.txts[0], float(result.scores[0])
            if score < 0.40:
                continue
            luminance = gray[y1:y2, x1:x2]
            center_y = (top+bottom)/2/crop.shape[0]
            active = bool(0.20 < center_y < 0.68 and float(np.percentile(luminance, 90)) >= 230)
            lines.append((y1, re.sub(r'\s+', ' ', text).strip(), score, active))
        lines.sort()
        text = ' '.join(line[1] for line in lines)
        if text:
            observations.append({'start': round(start, 3), 'end': round(end, 3), 'text': text,
                                 'confidence': min(line[2] for line in lines),
                                 'lines': [{'text': line[1], 'confidence': line[2], 'active': line[3]} for line in lines]})

    with av.open(str(video)) as container:
        if not container.streams.video:
            raise ValueError('Choose a Suno lyric video with visible captions.')
        stream = container.streams.video[0]
        duration = float(container.duration or 0) / av.time_base
        if not 0 < duration <= 900:
            raise ValueError('Local lyric import supports videos up to 15 minutes.')
        if stream.width * stream.height > 3840 * 2160:
            raise ValueError('Video exceeds the 4K import limit.')
        previous = representative = None
        start = last_time = 0.0
        for frame in container.decode(video=0):
            time = float(frame.time or 0)
            if time > 900:
                raise ValueError('Video exceeds the 15 minute import limit.')
            image = frame.to_ndarray(format='bgr24')
            h, w = image.shape[:2]
            x1, y1, x2, y2 = roi
            crop = image[int(y1*h):int(y2*h), int(x1*w):int(x2*w)]
            if crop.shape[1] > 1200:
                crop = cv2.resize(crop, (1200, round(crop.shape[0]*1200/crop.shape[1])))
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            changed = previous is not None and float(np.mean(cv2.absdiff(gray, previous))) >= 3.0
            if changed:
                recognize(representative, start, time)
                start = time
            representative = crop
            previous = gray
            last_time = time
        if representative is not None:
            recognize(representative, start, max(duration, last_time))

    sentences = assemble_sentences(observations)
    if not sentences:
        raise ValueError('No complete lyric sentences found. Try a different --roi or a timing JSON.')
    return sentences, duration, observations


def assemble_sentences(observations: list[dict]) -> list[dict]:
    # Suno may wrap in the middle of a word, and highlight only one physical
    # row. Stitch scrolling rows BEFORE splitting logical bilingual sentences.
    rows = []
    for observation in observations:
        incoming = observation['lines']
        cursor = max(0, len(rows)-8)
        for i, line in enumerate(incoming):
            key = normalized(line['text'])
            matches = [(SequenceMatcher(None, normalized(rows[j]['text']), key).ratio(), j)
                       for j in range(cursor, len(rows)) if key and normalized(rows[j]['text'])]
            score, matched = max(matches, default=(0, -1))
            if score >= 0.84:
                row = rows[matched]
                if line['confidence'] > row['confidence']:
                    row.update(text=line['text'], confidence=line['confidence'])
                cursor = matched + 1
            else:
                # A newly visible wrapped row can be between already-known rows.
                later_keys = [normalized(l['text']) for l in incoming[i+1:] if normalized(l['text'])]
                insert_at = next((j for j in range(cursor, len(rows)) if normalized(rows[j]['text']) in later_keys), len(rows))
                row = {**line, 'start': None, 'end': None}
                if not key and cursor > 0 and normalized(rows[cursor-1]['text']) == '':
                    row = rows[cursor-1]
                else:
                    rows.insert(insert_at, row)
                    cursor = insert_at + 1
            if line['active']:
                row['start'] = observation['start'] if row['start'] is None else min(row['start'], observation['start'])
                row['end'] = observation['end']
    # Parse balanced parentheses in the accumulated lyric stream. Section
    # labels are metadata; English asides are legitimate sung bottom-row cues.
    sentences = []
    pending = ''
    source_rows = []
    for row in rows:
        pending += (' ' if pending else '') + row['text']
        source_rows.append(row)
        pending = re.sub(r'\[[^\]]*\]', '', pending).strip()
        if ')' in pending and ('(' not in pending or pending.index(')') < pending.index('(')):
            pending = pending.replace(')', '', 1).strip()
        while ')' in pending and '(' in pending and pending.index('(') < pending.index(')'):
            closing = pending.index(')')
            text, pending = pending[:closing+1], pending[closing+1:].strip()
            primary, translation = split_bilingual_text(text)
            active = [r for r in source_rows if r['start'] is not None]
            if active and (primary or translation):
                sentences.append({'primary': primary, 'translation': translation,
                                  'start': min(r['start'] for r in active), 'end': max(r['end'] for r in active),
                                  'confidence': min(r['confidence'] for r in source_rows)})
            source_rows = [row] if pending else []
    merged = []
    for sentence in sentences:
        previous = merged[-1] if merged else None
        if previous and sentence['start'] <= previous['end'] + .5 and normalized(sentence['primary']) and normalized(sentence['primary']) == normalized(previous['primary']):
            previous['end'] = max(previous['end'], sentence['end'])
            if len(sentence['translation']) > len(previous['translation']):
                previous['translation'] = sentence['translation']
        else:
            merged.append(sentence)
    return merged


def match_phrase(text: str, reference: list[dict]) -> tuple[float, list[dict]]:
    """Rejoin hard-wrapped OCR words only when the nearby audio agrees."""
    expected = normalized(text)
    if not expected:
        return 0.0, []
    best = (0.0, [])
    for start in range(len(reference)):
        for count in range(1, min(20, len(reference)-start) + 1):
            candidate = ' '.join(word['word'].strip() for word in reference[start:start+count])
            compact = normalized(candidate)
            if len(compact) > len(expected)*1.5 + 4:
                break
            score = SequenceMatcher(None, expected, compact).ratio()
            if score > best[0]:
                best = (score, reference[start:start+count])
    return best


def repair_phrase(text: str, reference: list[dict]) -> tuple[str, bool]:
    score, matched = match_phrase(text, reference)
    candidate = ' '.join(word['word'].strip() for word in matched)
    # Only repair hard word wraps, not near-sounding substitutions such as
    # "hands" -> "head". Keep OCR text and flag disagreements for review.
    fragmented = bool(re.search(r'\b[^aAiI\W]\s+\w{3,}', text))
    safe = score == 1.0 or score >= .92 and fragmented
    return (candidate, candidate != text) if safe else (text, False)


def ordered_words(words: list[dict], start: float, end: float) -> list[dict]:
    """Keep uncertain collapsed alignments editable without overlapping languages."""
    boundary = end
    for word in reversed(words):
        if word['end'] > boundary or word['end'] <= word['start']:
            word['end'] = round(boundary, 3)
            word['start'] = round(min(word['start'], boundary - .02), 3)
            word['estimated'] = True
        boundary = word['start']
    if words and words[0]['start'] < start:
        # No measured room remains. Explicitly mark this sentence's fallback.
        step = (end-start)/len(words)
        for index, word in enumerate(words):
            word.update(start=round(start+index*step, 3), end=round(start+(index+1)*step, 3), estimated=True)
    return words


def align_sentences(sentences: list[dict], audio_path: Path, model_path: Path, duration: float) -> list[dict]:
    import numpy as np
    import torch
    import whisper
    from whisper.timing import find_alignment
    from whisper.tokenizer import get_tokenizer
    if not model_path.is_file():
        raise ValueError('Set LOCAL_WHISPER_MODEL to an installed multilingual Whisper .pt model.')
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'Aligning {len(sentences)} lyric sentences on {device}...', flush=True)
    model = whisper.load_model(str(model_path), device=device)
    tokenizer = get_tokenizer(model.is_multilingual, num_languages=model.num_languages, language='es', task='transcribe')
    audio = whisper.load_audio(str(audio_path))
    print('Checking lyric words against the audio...', flush=True)
    reference_path = audio_path.parent / 'audio-transcript.json'
    reference = model.transcribe(audio, language='es', task='transcribe', word_timestamps=True,
                                 condition_on_previous_text=False, temperature=0,
                                 fp16=device == 'cuda',
                                 initial_prompt='Spanish and English bilingual song. Transcribe both languages verbatim.')
    reference_path.write_text(json.dumps(reference, ensure_ascii=False, indent=2), encoding='utf-8')
    reference_words = [word for segment in reference.get('segments', []) for word in segment.get('words', [])]
    segments = []
    last_end = 0.0
    for index, sentence in enumerate(sentences):
        # Cards can arrive before the singer. Align in bounded audio windows.
        start = max(last_end, sentence['start'] - 1.5, 0)
        next_start = sentences[index + 1]['start'] if index + 1 < len(sentences) else duration
        end = min(duration, max(sentence['end'], next_start) + 1.2, start + 29)
        nearby = [w for w in reference_words if w['end'] > start and w['start'] < end]
        primary_match, primary_reference = match_phrase(sentence['primary'], nearby)
        english_match, english_reference = match_phrase(sentence['translation'], nearby)
        anchor = primary_reference if sentence['primary'] and primary_match >= .8 else english_reference if not sentence['primary'] and english_match >= .8 else []
        if anchor:
            start = max(start, anchor[0]['start'] - .12)
        primary, repaired_primary = repair_phrase(sentence['primary'], nearby)
        translation, repaired_translation = repair_phrase(sentence['translation'], nearby)
        primary_values = primary.split()
        english_values = translation.split()
        values = primary_values + english_values
        token_groups = [tokenizer.encode(' ' + value) for value in values]
        tokens = [token for group in token_groups for token in group]
        clip = audio[round(start*16000):round(end*16000)]
        if not len(clip) or not tokens:
            continue
        mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(clip), n_mels=model.dims.n_mels).to(device)
        alignment = find_alignment(model, tokenizer, tokens, mel, num_frames=len(clip)//160)
        # Preserve exact OCR word boundaries, including BPE-split words.
        token_times = []
        for timing in alignment:
            token_times.extend([(timing.start, timing.end, timing.probability)] * len(timing.tokens))
        cursor = 0
        words = []
        review = sentence['confidence'] < 0.85 or (bool(primary_values) and primary_match < .92) or (bool(english_values) and english_match < .92)
        for value, group in zip(values, token_groups):
            times = token_times[cursor:cursor + len(group)]
            cursor += len(group)
            if not times:
                raise ValueError(f'Incomplete word alignment for sentence {index+1}.')
            word_start = round(float(max(start, start + min(t[0] for t in times))), 3)
            word_end = round(float(min(end, start + max(t[1] for t in times))), 3)
            probability = float(np.mean([t[2] for t in times]))
            estimated = word_end - word_start < 0.02
            if estimated:
                word_start = min(word_start, end - 0.02)
                word_end = min(end, word_start + 0.02)
            review |= estimated or probability < 0.15
            words.append({'value': value, 'start': round(word_start, 3), 'end': round(word_end, 3),
                          'confidence': round(probability, 3), 'estimated': estimated})
        if not words:
            raise ValueError(f'Audio alignment failed for sentence {index+1}.')
        words = ordered_words(words, start, end)
        review |= any(word['estimated'] for word in words)
        segment = {
            'id': f'suno-{index+1}', 'start': words[0]['start'], 'end': words[-1]['end'],
            'primary': primary, 'translation': translation,
            'words': words[:len(primary_values)], 'translationWords': words[len(primary_values):],
            'translationTiming': 'sung', 'language_code': 'es', 'source': 'local-suno-ocr-whisper', 'order': index,
            'timingQuality': 'review' if review else 'aligned',
            'visualStart': sentence['start'], 'visualEnd': sentence['end'],
            'visualText': sentence['primary'] + ' (' + sentence['translation'] + ')',
            'textRepairedFromAudio': repaired_primary or repaired_translation,
        }
        segments.append(segment)
        last_end = segment['end']
        print(f'Aligned sentence {index+1}/{len(sentences)}', flush=True)
    return segments


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('-o', '--output-dir', type=Path, required=True)
    parser.add_argument('--model', type=Path, default=os.environ.get('LOCAL_WHISPER_MODEL'))
    parser.add_argument('--ffmpeg', default=os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg'))
    parser.add_argument('--roi', default='0.02,0.53,0.98,0.715', help='Normalized x1,y1,x2,y2 lyric area')
    parser.add_argument('--ocr-only', action='store_true', help='Inspect visual sentences without word alignment')
    args = parser.parse_args()
    if not args.video.is_file() or not args.ffmpeg:
        parser.error('An existing video and FFmpeg are required.')
    if not args.ocr_only and (not args.model or not args.model.is_file()):
        parser.error('Provide --model or LOCAL_WHISPER_MODEL (an installed multilingual Whisper .pt file).')
    roi = tuple(float(value) for value in args.roi.split(','))
    if len(roi) != 4 or not (0 <= roi[0] < roi[2] <= 1 and 0 <= roi[1] < roi[3] <= 1):
        parser.error('--roi must be normalized x1,y1,x2,y2 coordinates.')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    os.environ['PATH'] = str(Path(args.ffmpeg).resolve().parent) + os.pathsep + os.environ.get('PATH', '')
    audio_path = args.output_dir / 'audio.m4a'
    extract_audio(args.video, audio_path, args.ffmpeg)
    print('Reading lyric cards...', flush=True)
    sentences, duration, observations = visual_sentences(args.video, roi)
    (args.output_dir / 'visual-sentences.json').write_text(json.dumps({'sentences': sentences, 'observations': observations}, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.ocr_only:
        print(f'Found {len(sentences)} visual sentences. No word timing produced.', flush=True)
        return
    segments = align_sentences(sentences, audio_path, args.model, duration)
    result = {'title': args.video.stem, 'source': 'local-suno-ocr-whisper', 'duration': duration,
              'sourceLanguage': 'es', 'targetLanguage': 'en', 'translationTiming': 'sung',
              'reviewRequired': True,
              'warning': 'Machine-aligned lyrics: review OCR text and word timing before publishing.',
              'segments': segments}
    (args.output_dir / 'timing.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Saved audio.m4a and timing.json ({len(segments)} sentences).', flush=True)


if __name__ == '__main__':
    main()
