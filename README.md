# Roma AI Realtime Voice STT

A browser-based realtime speech-to-text lab focused on fast microphone capture, streaming interim transcripts, pause detection, and lightweight speaker-turn labeling.

## Features

- Native Web Speech API transcription for very low setup overhead and realtime interim text.
- Web Audio API voice activity detection using smoothed RMS energy.
- Pause detection and turn splitting for readable transcripts.
- Heuristic speaker separation based on pause gaps and acoustic energy profiles.
- Export finalized transcript turns as a text file.

> Note: Browser-native STT does not provide true biometric diarization. The app labels likely speaker turns with a lightweight heuristic so it remains fast in the browser. For production-grade diarization, connect the UI to a streaming STT/diarization backend.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL in Chrome or Edge and grant microphone permission.
