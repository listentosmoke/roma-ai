#!/usr/bin/env python3
"""WhisperX + pyannote backend adapter for true speaker diarization.

Install separately when you want the real model backend:
  python -m pip install torch whisperx

Run through the Node backend with:
  ROMA_STT_DIARIZE_COMMAND='python backend/whisperx_diarize.py --audio {audio} --output {output} --model small --hf-token '$HF_TOKEN npm run backend
"""

import argparse
import json
from pathlib import Path

import torch
import whisperx


def main():
    parser = argparse.ArgumentParser(description='Transcribe audio with WhisperX and assign speakers with pyannote diarization.')
    parser.add_argument('--audio', required=True, help='Path to input audio file')
    parser.add_argument('--output', required=True, help='Path to output JSON file')
    parser.add_argument('--model', default='small', help='Whisper model size or path')
    parser.add_argument('--language', default=None, help='Optional language code')
    parser.add_argument('--hf-token', default=None, help='Hugging Face token accepted for pyannote diarization models')
    parser.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    parser.add_argument('--compute-type', default='float16' if torch.cuda.is_available() else 'int8')
    args = parser.parse_args()

    audio_path = Path(args.audio)
    output_path = Path(args.output)
    model = whisperx.load_model(args.model, args.device, compute_type=args.compute_type, language=args.language)
    audio = whisperx.load_audio(str(audio_path))
    result = model.transcribe(audio, batch_size=16)
    detected_language = result.get('language') or args.language

    align_model, metadata = whisperx.load_align_model(language_code=detected_language, device=args.device)
    aligned = whisperx.align(result['segments'], align_model, metadata, audio, args.device, return_char_alignments=False)

    diarize_model = whisperx.DiarizationPipeline(use_auth_token=args.hf_token, device=args.device)
    diarization = diarize_model(audio)
    assigned = whisperx.assign_word_speakers(diarization, aligned)

    segments = []
    text_parts = []
    for segment in assigned.get('segments', []):
        text = segment.get('text', '').strip()
        if text:
            text_parts.append(text)
        segments.append({
            'speaker': segment.get('speaker', 'unknown'),
            'startedAt': round(float(segment.get('start', 0)) * 1000),
            'endedAt': round(float(segment.get('end', 0)) * 1000),
            'text': text,
        })

    output_path.write_text(json.dumps({
        'text': ' '.join(text_parts).strip(),
        'segments': segments,
        'language': detected_language,
        'provider': 'whisperx+pyannote',
    }, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
