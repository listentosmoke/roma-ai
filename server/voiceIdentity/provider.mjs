const DEFAULT_MODEL_ID = 'Xenova/wavlm-base-plus-sv';
const DEFAULT_MODEL_REVISION = 'e61029603001bd11295c36d878698708bf59190f';

export const VOICE_PROVIDER_THRESHOLDS = Object.freeze({
  strongMatch: 0.86,
  candidate: 0.80,
  nonMatch: 0.65,
  ambiguityMargin: 0.04,
  minQuality: 0.55,
  maxCandidates: 12,
});

function normalize(values) {
  const vector = Float32Array.from(values);
  let square = 0;
  for (const value of vector) square += value * value;
  const norm = Math.sqrt(square);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('Speaker encoder returned an invalid zero-length embedding.');
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

export function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) throw new Error('Speaker templates must have equal, non-zero dimensions.');
  let dot = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftSquare += left[i] * left[i];
    rightSquare += right[i] * right[i];
  }
  return dot / Math.max(Number.EPSILON, Math.sqrt(leftSquare * rightSquare));
}

function pcm16ToFloat32(pcm) {
  const bytes = Buffer.from(pcm);
  if (!bytes.length || bytes.length % 2) throw new Error('Speaker encoder requires non-empty PCM16 audio.');
  const audio = new Float32Array(bytes.length / 2);
  for (let i = 0; i < audio.length; i += 1) audio[i] = bytes.readInt16LE(i * 2) / 32768;
  return audio;
}

function classify(score, quality, thresholds) {
  if (quality < thresholds.minQuality) return { decision: 'indeterminate', reasonCode: 'low_quality_sample' };
  if (score >= thresholds.strongMatch) return { decision: 'match', reasonCode: 'strong_similarity' };
  if (score >= thresholds.candidate) return { decision: 'candidate', reasonCode: 'candidate_similarity' };
  return { decision: 'non_match', reasonCode: score < thresholds.nonMatch ? 'different_speaker' : 'below_candidate_threshold' };
}

export function createWavlmSpeakerProvider({
  modelId = process.env.VOICE_IDENTITY_MODEL ?? DEFAULT_MODEL_ID,
  modelRevision = process.env.VOICE_IDENTITY_MODEL_REVISION ?? DEFAULT_MODEL_REVISION,
  dtype = process.env.VOICE_IDENTITY_DTYPE ?? 'q8',
  device = process.env.VOICE_IDENTITY_DEVICE ?? 'cpu',
  thresholds: overrides = {},
  maxQueue = 4,
  now = Date.now,
  runtimeLoader = null,
} = {}) {
  const thresholds = Object.freeze({ ...VOICE_PROVIDER_THRESHOLDS, ...overrides });
  let runtimePromise = null;
  let loadError = null;
  let active = 0;
  const queue = [];

  async function load() {
    if (!runtimePromise) {
      const modulePromise = runtimeLoader ? Promise.resolve().then(runtimeLoader) : import('@huggingface/transformers');
      runtimePromise = modulePromise
        .then(async ({ AutoProcessor, AutoModel }) => {
          const [processor, model] = await Promise.all([
            AutoProcessor.from_pretrained(modelId, { revision: modelRevision }),
            AutoModel.from_pretrained(modelId, { revision: modelRevision, dtype, device }),
          ]);
          return { processor, model };
        })
        .catch((error) => {
          loadError = error;
          runtimePromise = null;
          throw error;
        });
    }
    return runtimePromise;
  }

  function schedule(task, signal) {
    if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true, reasonCode: 'cancelled' });
    if (active + queue.length >= maxQueue) return Promise.resolve({ ok: false, reasonCode: 'provider_queue_full' });
    return new Promise((resolve, reject) => {
      queue.push({ task, signal, resolve, reject });
      drain();
    });
  }

  function drain() {
    if (active || !queue.length) return;
    const item = queue.shift();
    if (item.signal?.aborted) { item.resolve({ ok: false, cancelled: true, reasonCode: 'cancelled' }); drain(); return; }
    active += 1;
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { active -= 1; drain(); });
  }

  async function extractTemplate({ pcm, quality = 1, signal } = {}) {
    return schedule(async () => {
      const startedAt = now();
      const { processor, model } = await load();
      if (signal?.aborted) return { ok: false, cancelled: true, reasonCode: 'cancelled' };
      const output = await model(await processor(pcm16ToFloat32(pcm)));
      const raw = output.embeddings?.data ?? output.logits?.data;
      if (!raw?.length) throw new Error('Speaker encoder returned no embedding.');
      const template = normalize(raw);
      return {
        ok: true,
        template,
        dimensions: template.length,
        quality,
        provider: 'local_wavlm',
        model: modelId,
        modelRevision,
        modelVersion: `${modelRevision}:${dtype}`,
        templateVersion: 1,
        calibratedConfidence: null,
        latencyMs: now() - startedAt,
        reasonCode: 'template_extracted',
      };
    }, signal);
  }

  function compareTemplates({ template, profileTemplate, quality = 1 } = {}) {
    const score = cosineSimilarity(template, profileTemplate);
    return {
      ok: true,
      score,
      similarity: score,
      quality,
      calibratedConfidence: null,
      ...classify(score, quality, thresholds),
      provider: 'local_wavlm',
      model: modelId,
      modelRevision,
      templateVersion: 1,
    };
  }

  function identifyTemplates({ template, candidateProfiles = [], quality = 1 } = {}) {
    const bounded = candidateProfiles.slice(0, thresholds.maxCandidates);
    const matches = bounded.map((profile) => ({
      voiceProfileId: profile.voiceProfileId,
      personId: profile.personId,
      ...compareTemplates({ template, profileTemplate: profile.template, quality }),
    })).sort((a, b) => b.score - a.score);
    const top = matches[0] ?? null;
    const second = matches[1] ?? null;
    let decision = top?.decision ?? 'non_match';
    let reasonCode = top?.reasonCode ?? 'no_candidates';
    if (top && second && top.score >= thresholds.candidate && top.score - second.score < thresholds.ambiguityMargin) {
      decision = 'ambiguous';
      reasonCode = 'competing_voice_candidates';
    }
    return { ok: true, decision, reasonCode, matches, candidateCount: bounded.length, thresholds };
  }

  return {
    async warmup() {
      const startedAt = now();
      try { await load(); return { ok: true, latencyMs: now() - startedAt }; }
      catch (error) { return { ok: false, reasonCode: 'provider_load_failed', error: error.message }; }
    },
    extractTemplate,
    compareTemplates,
    identifyTemplates,
    getProviderStatus() {
      return {
        available: !loadError,
        mode: 'local_real',
        provider: 'local_wavlm',
        model: modelId,
        modelRevision,
        modelVersion: `${modelRevision}:${dtype}`,
        dimensions: 512,
        sampleRate: 16000,
        local: true,
        modelLoaded: Boolean(runtimePromise && !loadError),
        queueDepth: queue.length,
        active,
        thresholds,
        warning: 'Speaker similarity is probabilistic evidence, not authentication or verified liveness.',
      };
    },
    thresholds,
  };
}

export { DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION };
