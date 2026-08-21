// Enrollment images kept on disk, as redundancy for the templates.
//
// This REVERSES an earlier decision, deliberately and on request. Face
// identity previously stored no image at all: frames were embedded and
// dropped. That is the more private design, and it has one hard cost — a
// template is a 512-number projection through one specific encoder, so if that
// model is ever replaced or a template is corrupted, the enrollment is gone
// and the person has to sit in front of a camera again. Keeping the frames
// that produced it means a re-enrollment is a background job instead.
//
// The boundaries that make that acceptable, and which this module enforces:
//
//   - ONLY enrollment frames are kept. Recognition frames — the continuous
//     ones, the ones nobody consented to individually — are still dropped the
//     moment they have been embedded. This is not a recording of what the
//     camera sees.
//   - Images live beside the database, under the same full-disk encryption,
//     never in it (blobs bloat SQLite and its WAL).
//   - Deleting a profile deletes its images. Deleting a person deletes their
//     profiles, and so their images. Verified by test, not by intention.
//   - Nothing here is ever served into a prompt or to a model. The only
//     consumer is the People panel, showing the user their own enrollments.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** JPEG magic bytes, so a mislabeled or hostile payload is not written to disk as an image. */
function looksLikeJpeg(buffer) {
  return buffer?.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
}

function looksLikePng(buffer) {
  return buffer?.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_PROFILE = 8;

export function createFaceImageStore({ root = resolve(process.cwd(), 'data', 'faces'), maxPerProfile = MAX_IMAGES_PER_PROFILE } = {}) {
  /**
   * A profile id is generated server-side, but this path is still built
   * defensively: anything that is not the exact id shape cannot reach the
   * filesystem, so no id can ever traverse out of the store.
   */
  function directoryFor(workspaceId, faceProfileId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(workspaceId)) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(faceProfileId))) return null;
    return join(root, String(workspaceId), String(faceProfileId));
  }

  return {
    root,

    /**
     * @param {Buffer[]} images the same frames the template was averaged from
     * @returns {{ ok: boolean, stored: number, reasonCode?: string }}
     */
    save({ workspaceId, faceProfileId, images = [] }) {
      const dir = directoryFor(workspaceId, faceProfileId);
      if (!dir) return { ok: false, stored: 0, reasonCode: 'invalid_identifier' };
      const usable = images
        .filter((image) => Buffer.isBuffer(image) && image.length <= MAX_IMAGE_BYTES && (looksLikeJpeg(image) || looksLikePng(image)))
        .slice(0, maxPerProfile);
      if (!usable.length) return { ok: false, stored: 0, reasonCode: 'no_usable_images' };

      try {
        mkdirSync(dir, { recursive: true });
        usable.forEach((image, index) => {
          writeFileSync(join(dir, `${String(index).padStart(2, '0')}.${looksLikePng(image) ? 'png' : 'jpg'}`), image);
        });
        return { ok: true, stored: usable.length };
      } catch (error) {
        // Losing the redundancy copy must never fail the enrollment itself.
        return { ok: false, stored: 0, reasonCode: 'write_failed', detail: error?.message ?? null };
      }
    },

    list({ workspaceId, faceProfileId }) {
      const dir = directoryFor(workspaceId, faceProfileId);
      if (!dir || !existsSync(dir)) return [];
      try {
        return readdirSync(dir)
          .filter((name) => /\.(jpg|png)$/i.test(name))
          .sort()
          .map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
      } catch { return []; }
    },

    read({ workspaceId, faceProfileId, name }) {
      const dir = directoryFor(workspaceId, faceProfileId);
      if (!dir || !/^[0-9]{2}\.(jpg|png)$/i.test(String(name))) return null;
      const path = join(dir, String(name));
      try { return existsSync(path) ? readFileSync(path) : null; } catch { return null; }
    },

    /** Deleting a template must take its images with it, or "forget them" is a lie. */
    remove({ workspaceId, faceProfileId }) {
      const dir = directoryFor(workspaceId, faceProfileId);
      if (!dir) return { ok: false, removed: 0 };
      const count = this.list({ workspaceId, faceProfileId }).length;
      try { rmSync(dir, { recursive: true, force: true }); return { ok: true, removed: count }; }
      catch { return { ok: false, removed: 0 }; }
    },

    counts({ workspaceId }) {
      const dir = join(root, String(workspaceId));
      if (!existsSync(dir)) return { profiles: 0, images: 0 };
      try {
        const profiles = readdirSync(dir);
        let images = 0;
        for (const profile of profiles) images += this.list({ workspaceId, faceProfileId: profile }).length;
        return { profiles: profiles.length, images };
      } catch { return { profiles: 0, images: 0 }; }
    },
  };
}
