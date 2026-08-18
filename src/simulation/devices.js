// Virtual media-device boundary. Replaces navigator.mediaDevices.getUserMedia
// with a version that answers audio/video requests with the simulation
// engines' REAL MediaStreamTracks. Everything downstream — createMicCapture's
// ScriptProcessor/resample/PCM16 chain and createCameraSource's
// video-element/canvas chain — is the UNMODIFIED production code, consuming
// these tracks exactly as it would a physical device's.
//
// Tracks are cloned per request so the app's own track.stop() on Stop only
// ends its clone, never the engine's master track. The original getUserMedia
// stays reachable for anything the interposer does not simulate.

export function installVirtualDevices({ audioEngine, videoEngine }) {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices) throw new Error('navigator.mediaDevices unavailable — not a secure context?');
  const original = mediaDevices.getUserMedia.bind(mediaDevices);
  let installed = true;
  const issued = { audio: 0, video: 0 };

  async function virtualGetUserMedia(constraints = {}) {
    if (!installed) return original(constraints);
    const wants = {
      audio: Boolean(constraints.audio),
      video: Boolean(constraints.video),
    };
    if (!wants.audio && !wants.video) return original(constraints);
    const tracks = [];
    if (wants.audio) {
      await audioEngine.resume();
      const track = audioEngine.stream.getAudioTracks()[0]?.clone();
      if (!track) throw new DOMException('Virtual microphone track unavailable.', 'NotReadableError');
      tracks.push(track);
      issued.audio += 1;
    }
    if (wants.video) {
      const track = videoEngine.stream.getVideoTracks()[0]?.clone();
      if (!track) throw new DOMException('Virtual camera track unavailable.', 'NotReadableError');
      tracks.push(track);
      issued.video += 1;
    }
    return new MediaStream(tracks);
  }

  Object.defineProperty(mediaDevices, 'getUserMedia', { value: virtualGetUserMedia, configurable: true });

  return {
    issuedCounts: () => ({ ...issued }),
    uninstall() {
      installed = false;
      Object.defineProperty(mediaDevices, 'getUserMedia', { value: original, configurable: true });
    },
  };
}
