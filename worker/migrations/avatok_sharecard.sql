-- AvaTOK Number — QR share card (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §10A) — 2026-06-26.
-- The stable, non-expiring QR resolves server-side to the sharer's contact card.
-- The server stores only HASHES of phone/email, so the card the user CHOSE to
-- share (explicit consent when they tap Share / show their QR) is persisted as a
-- small JSON snapshot keyed by their share_token. Holds: first/last name, personal
-- email, and the number that represents them (AvaTOK number for paid users, real
-- phone for free users). Apply to DB_META (avatok-meta).
ALTER TABLE users ADD COLUMN share_card TEXT;  -- JSON: {firstName,lastName,email,number,plan}
