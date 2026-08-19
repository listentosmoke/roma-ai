-- Face evidence provenance.
--
-- `face_match` / `face_enrollment` identity evidence records which enrolled
-- template produced the match. There is deliberately no image or frame
-- reference to go with it: frames are used to compute an embedding and then
-- dropped (see server/routes/faceApi.mjs), so the profile id is the whole of
-- the trail — enough to answer "which template said that", never enough to
-- reconstruct what the camera saw.
--
-- Nullable, because every other evidence type has no face profile at all.

ALTER TABLE identity_evidence ADD COLUMN face_profile_id TEXT;

CREATE INDEX IF NOT EXISTS idx_identity_evidence_face_profile
  ON identity_evidence(workspace_id, face_profile_id);
