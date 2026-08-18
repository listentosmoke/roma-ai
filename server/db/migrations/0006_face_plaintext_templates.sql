-- Face templates are stored WITHOUT application-level encryption.
--
-- Decision: the device this runs on uses full-disk encryption, so a second
-- at-rest layer was judged redundant for a local single-user deployment.
--
-- What that trades away, recorded so it is a known trade and not a surprise:
-- the AES-GCM layer also bound each template to its workspace+person+profile
-- as associated data, so a row edited to point at a different person failed to
-- open instead of misidentifying them. Plaintext storage cannot do that. It is
-- an accepted loss because anyone able to write to this database directly can
-- already do anything; it would NOT be acceptable on shared or server-hosted
-- storage. Voice templates are unaffected and remain encrypted.

ALTER TABLE face_templates ADD COLUMN template_plain TEXT;

-- The encryption columns stay (nullable) so re-enabling is additive, and so
-- any rows written by the previous build remain readable by their own path.
