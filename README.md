# roma-ai

the extension of your brain

## Realtime Voice STT Web App

Roma AI now includes a browser-based realtime speech-to-text workspace built for low-latency transcription workflows.

### Features

- Realtime microphone transcription with interim and final text using the browser Web Speech API.
- Voice activity detection from the Web Audio API for fast pause detection and automatic transcript chunking.
- Efficient online speaker separation using lightweight acoustic feature clustering.
- Speaker renaming, manual speaker forcing, signal meter, pause timeline, and JSON export.

### Run locally

```bash
npm install
npm run dev
```

Open the Vite URL in Chrome or Edge, grant microphone access, and press **Start transcription**.

> Note: Browser-native realtime STT availability depends on the browser. Chrome and Edge currently provide the best Web Speech API support.
