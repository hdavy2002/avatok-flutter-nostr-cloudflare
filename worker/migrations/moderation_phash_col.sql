-- Cache the perceptual hash alongside the AI scan result so a re-upload of
-- identical bytes (same sha256) skips the R2 fetch + Photon decode entirely.
ALTER TABLE moderation_results ADD COLUMN phash TEXT;
