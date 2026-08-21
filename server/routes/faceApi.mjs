// Authenticated face-identity routes. Same boundary discipline as
// server/routes/dataApi.mjs: the principal comes from the auth layer and never
// from the body, everything is workspace-scoped, bodies are bounded, and
// errors are generic.
//
// Images arrive as base64 JPEG/PNG from the browser's own camera and are used
// to produce an embedding. What happens next depends on WHY they arrived:
//
//   ENROLLMENT frames are kept, as redundancy for the template they produced —
//   a template is a projection through one specific encoder, so without the
//   originals a model change means asking the person to sit in front of a
//   camera again. See server/faceIdentity/imageStore.mjs.
//
//   IDENTIFICATION frames are dropped the moment they are embedded, exactly as
//   before. Those are continuous and nobody consented to them individually;
//   keeping them would make this a recording of everything the camera sees.
//
// CONSENT IS NOT ENFORCED in this build (see server/faceIdentity/service.mjs).

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) { reject(new Error('Image too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Body was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

/** Decode a data URL or bare base64 payload into an image buffer. */
function decodeImage(value) {
  if (typeof value !== 'string' || !value) return null;
  const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  try {
    const buffer = Buffer.from(base64, 'base64');
    return buffer.length > 64 && buffer.length <= MAX_IMAGE_BYTES ? buffer : null;
  } catch { return null; }
}

function createRateLimiter({ windowMs = 10_000, max = 30 } = {}) {
  const hits = new Map();
  return function check(key) {
    const at = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    recent.push(at);
    hits.set(key, recent);
    return recent.length <= max;
  };
}

export function createFaceApiHandlers({ faceIdentity, auth, identityRepository = null, auditRepository = null, imageStore = null }) {
  // Identification runs per camera cycle, so it gets a looser budget than
  // enrollment, which is a deliberate human action.
  const identifyLimit = createRateLimiter({ windowMs: 10_000, max: 40 });
  const enrollLimit = createRateLimiter({ windowMs: 60_000, max: 10 });

  async function principalOf(req, res) {
    const resolved = await auth.resolvePrincipal(req);
    if (!resolved.ok) { sendJson(res, resolved.status ?? 401, { error: 'Unauthorized.', code: resolved.reasonCode }); return null; }
    return resolved.principal;
  }

  function audit(principal, fields) {
    try { auditRepository?.forWorkspace(principal.workspaceId)?.record({ principalId: principal.userId, ...fields }); } catch { /* auditing never breaks a request */ }
  }

  return {
    async health(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      sendJson(res, 200, { ok: true, face: faceIdentity.describe() });
    },

    async detect(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      if (!identifyLimit(principal.userId)) { sendJson(res, 429, { error: 'Rate limit exceeded.', code: 'rate_limited' }); return; }
      const body = await readJsonBody(req);
      const image = decodeImage(body.image);
      if (!image) { sendJson(res, 400, { error: 'A base64 image is required.', code: 'image_required' }); return; }
      sendJson(res, 200, await faceIdentity.detect(image));
    },

    async enroll(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      if (!enrollLimit(principal.userId)) { sendJson(res, 429, { error: 'Too many enrollments.', code: 'rate_limited' }); return; }
      const body = await readJsonBody(req);
      // One image, or several of the same face — several is strongly preferred,
      // because a single frame binds someone to one pose and one lighting.
      const raw = Array.isArray(body.images) ? body.images.slice(0, 8) : [body.image];
      const images = raw.map(decodeImage).filter(Boolean);
      if (!images.length) { sendJson(res, 400, { error: 'At least one base64 image is required.', code: 'image_required' }); return; }
      if (!body.personId) { sendJson(res, 400, { error: 'personId is required.', code: 'person_required' }); return; }

      const result = await faceIdentity.enroll({ workspaceId: principal.workspaceId, personId: body.personId, imageBuffers: images });
      audit(principal, {
        action: 'face.enroll', resourceType: 'face_profile', resourceId: result.profile?.faceProfileId ?? null,
        outcome: result.ok ? 'enrolled' : 'rejected', reasonCode: result.reasonCode ?? null,
      });
      // Record the enrollment as identity evidence, so a later face_match
      // has a provenance chain ending in a deliberate human action rather
      // than in a template that simply appeared.
      if (result.ok && identityRepository?.forWorkspace) {
        try {
          identityRepository.forWorkspace(principal.workspaceId, principal.userId).attachFaceProfile?.(body.personId, result.profile.faceProfileId, {
            provider: result.profile.provider ?? null,
            providerModel: result.profile.model ?? null,
            quality: result.profile.aggregateQuality ?? null,
            sampleCount: result.samplesUsed ?? null,
          });
        } catch { /* enrollment must not fail because its evidence could not be written */ }
      }
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async identify(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      if (!identifyLimit(principal.userId)) { sendJson(res, 429, { error: 'Rate limit exceeded.', code: 'rate_limited' }); return; }
      const body = await readJsonBody(req);
      const image = decodeImage(body.image);
      if (!image) { sendJson(res, 400, { error: 'A base64 image is required.', code: 'image_required' }); return; }
      const result = await faceIdentity.identify({
        workspaceId: principal.workspaceId,
        imageBuffer: image,
        candidatePersonIds: Array.isArray(body.candidatePersonIds) ? body.candidatePersonIds.slice(0, 50) : null,
      });
      // Only a decisive match is audited: logging every below-threshold frame
      // would turn the audit log into a surveillance record of everyone seen.
      for (const face of result.faces ?? []) {
        if (face.match) audit(principal, { action: 'face.match', resourceType: 'person', resourceId: face.match.personId, outcome: 'matched', reasonCode: `similarity_${face.match.similarity.toFixed(2)}` });
      }
      sendJson(res, 200, result);
    },

    async listProfiles(req, res) {
      const principal = await principalOf(req, res); if (!principal) return;
      sendJson(res, 200, { profiles: faceIdentity.templates.forWorkspace(principal.workspaceId).listActive() });
    },

    async deleteProfile(req, res, params) {
      const principal = await principalOf(req, res); if (!principal) return;
      const result = faceIdentity.templates.forWorkspace(principal.workspaceId).delete(params.id);
      // "Forget this face" has to mean the pictures too, or it is a lie.
      const images = imageStore?.remove({ workspaceId: principal.workspaceId, faceProfileId: params.id }) ?? { removed: 0 };
      audit(principal, { action: 'face.delete', resourceType: 'face_profile', resourceId: params.id, outcome: result.ok ? 'deleted' : 'not_found', reasonCode: `images_${images.removed}` });
      sendJson(res, result.ok ? 200 : 404, { ...result, imagesRemoved: images.removed });
    },

    /** The enrollment frames for one profile — the People panel shows the user their own enrollments. */
    async listImages(req, res, params) {
      const principal = await principalOf(req, res); if (!principal) return;
      if (!imageStore) { sendJson(res, 200, { images: [], enabled: false }); return; }
      const profile = faceIdentity.templates.forWorkspace(principal.workspaceId).get(params.id);
      if (!profile) { sendJson(res, 404, { error: 'No such face profile.', code: 'not_found' }); return; }
      sendJson(res, 200, { enabled: true, images: imageStore.list({ workspaceId: principal.workspaceId, faceProfileId: params.id }) });
    },

    async readImage(req, res, params) {
      const principal = await principalOf(req, res); if (!principal) return;
      if (!imageStore) { sendJson(res, 404, { error: 'Enrollment images are not kept.', code: 'not_configured' }); return; }
      const profile = faceIdentity.templates.forWorkspace(principal.workspaceId).get(params.id);
      if (!profile) { sendJson(res, 404, { error: 'No such face profile.', code: 'not_found' }); return; }
      const bytes = imageStore.read({ workspaceId: principal.workspaceId, faceProfileId: params.id, name: params.name });
      if (!bytes) { sendJson(res, 404, { error: 'No such image.', code: 'not_found' }); return; }
      res.statusCode = 200;
      res.setHeader('Content-Type', String(params.name).endsWith('.png') ? 'image/png' : 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(bytes);
    },
  };
}

const ROUTES = [
  ['GET', '/api/face/health', 'health'],
  ['POST', '/api/face/detect', 'detect'],
  ['POST', '/api/face/enroll', 'enroll'],
  ['POST', '/api/face/identify', 'identify'],
  ['GET', '/api/face/profiles', 'listProfiles'],
  ['DELETE', '/api/face/profiles/:id', 'deleteProfile'],
  ['GET', '/api/face/profiles/:id/images', 'listImages'],
  ['GET', '/api/face/profiles/:id/images/:name', 'readImage'],
];

function matchPath(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export function attachFaceApi(middlewares, handlers) {
  middlewares.use(async (req, res, next) => {
    if (!req.url.startsWith('/api/face')) { next(); return; }
    const pathname = new URL(req.url, 'http://internal').pathname;
    for (const [method, pattern, handler] of ROUTES) {
      if (req.method !== method) continue;
      const params = matchPath(pattern, pathname);
      if (!params) continue;
      try { await handlers[handler](req, res, params); }
      catch (error) { sendJson(res, 500, { error: error?.message ?? 'Internal error.', code: 'server_error' }); }
      return;
    }
    sendJson(res, 404, { error: 'No such face route.', code: 'not_found' });
  });
}
