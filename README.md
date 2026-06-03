# Roma AI Realtime Voice STT

A browser-based realtime speech-to-text lab focused on fast microphone capture, streaming interim transcripts, pause detection, backend diarization, and measurable transcript quality.

## Features

- Native Web Speech API transcription for very low setup overhead and realtime interim text.
- Web Audio API voice activity detection using smoothed RMS energy.
- Pause detection and turn splitting for readable transcripts.
- Optional backend path for **true diarization** with WhisperX + pyannote or another command-line model adapter.
- Export finalized transcript turns as a text file.
- Built-in benchmark lab for comparing reference transcripts against STT output with WER, CER, edit counts, word accuracy, real-time factor, and diarization error rate.

> Note: Browser-native STT does not provide true biometric diarization. The browser labels likely speaker turns with a lightweight heuristic for speed. For real diarization, run the backend and connect it to a model such as WhisperX + pyannote.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL in Chrome or Edge and grant microphone permission.

## Run the backend

The Node backend exposes benchmark and audio-processing APIs:

```bash
npm run backend
```

Endpoints:

- `GET /api/health` shows whether a true diarization command is configured.
- `GET /api/self-benchmark` runs the built-in self benchmark and returns WER/DER summaries.
- `POST /api/benchmark` scores JSON payloads with WER, CER, RTF, and DER.
- `POST /api/transcribe-diarize` accepts raw `audio/*` bytes, saves them temporarily, and invokes the configured model command.

To enable true diarization with WhisperX + pyannote, install the Python model dependencies separately and configure the command. A Hugging Face token with access to the pyannote diarization model is typically required.

```bash
python -m pip install torch whisperx
export HF_TOKEN=your_hugging_face_token
export ROMA_STT_DIARIZE_COMMAND='python backend/whisperx_diarize.py --audio {audio} --output {output} --model small --hf-token '$HF_TOKEN
npm run backend
```

The command must write JSON to `{output}` with this shape:

```json
{
  "text": "full transcript",
  "segments": [
    { "speaker": "SPEAKER_00", "startedAt": 0, "endedAt": 2500, "text": "hello" }
  ],
  "provider": "whisperx+pyannote"
}
```

## Benchmarking STT and diarization quality

Speech-to-text systems are commonly evaluated by comparing a known reference transcript to the model or browser hypothesis. Roma AI reports:

- **WER (word error rate):** `(substitutions + insertions + deletions) / reference words`.
- **CER (character error rate):** the same edit-distance idea at character level.
- **Word accuracy:** `1 - WER`, clamped visually in the UI.
- **RTF (real-time factor):** processing or wall time divided by audio duration; values below `1.0` are faster than realtime.
- **DER (diarization error rate):** missed speech + false alarm + speaker confusion divided by reference speech duration.

For a realistic benchmark, play or read a labeled test passage into the app, paste the ground-truth reference into the benchmark lab, click **Use live transcript**, and compare the score across browsers, microphones, noise levels, languages, and speaking styles. For true diarization, upload the audio file in the benchmark lab while the backend is running with `ROMA_STT_DIARIZE_COMMAND` configured.

To run the repository's self benchmark:

```bash
npm run benchmark
```

The command prints WER/CER/DER/RTF and writes `benchmark-results/latest.json`.

## Automated checks

```bash
npm test
npm run build
```
