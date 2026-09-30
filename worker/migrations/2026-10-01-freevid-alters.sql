-- [SAATHUM-FREEVID-BASE-1 2026-10-01] Free events + video crop. DB: avatok-meta (DB_META).
-- ALTER-only file (CLAUDE.md rule 6): apply with scripts/d1_apply_alters.py.
-- NOT APPLIED by the implementing agent — production write, owner confirms first.
--
-- listings.free_watch: 1 = a FREE event. Anyone signed in with an email may watch its
--   video; no payment, no booking, no WhatsApp check (owner decision 2026-10-01).
--   Checkout refuses these listings.
-- event_videos.crop_*: the part of the 16:9 YouTube frame the public sees, as
--   fractions 0..1 (x,y = top-left, w,h = size). All NULL = no crop.
ALTER TABLE listings ADD COLUMN free_watch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_videos ADD COLUMN crop_x REAL;
ALTER TABLE event_videos ADD COLUMN crop_y REAL;
ALTER TABLE event_videos ADD COLUMN crop_w REAL;
ALTER TABLE event_videos ADD COLUMN crop_h REAL;
