// Client-side voice-selection persistence. Mirrors proactive/preferences.js's
// localStorage pattern. Stores only a voice ID string — never fetched/validated
// here; useVoiceDelivery.js is responsible for checking a loaded value against
// the server's real catalog (GET /api/tts/voices) and falling back safely.

const STORAGE_KEY = 'roma.selectedVoice';

export function loadSelectedVoice() {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function saveSelectedVoice(voiceId) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (voiceId) localStorage.setItem(STORAGE_KEY, voiceId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage may be unavailable */ }
}
