-- [SAATHUM-TAXONOMY-FIX-1 2026-09-20] Reconcile D1 listing_categories with the
-- Saathum keep-list. The 2026-09-20-saathum-taxonomy.sql migration was written
-- against Specs/listing-taxonomy.json, which does not know about the 20 legacy
-- classifieds/group-class rows that still live in D1, and it also switched off
-- 'astrologers', which is on the keep-list. Exactly 13 categories stay active.
UPDATE listing_categories SET active = 1 WHERE id = 'astrologers';
UPDATE listing_categories SET active = 0 WHERE id NOT IN (
  'live_puja','live_puja_ritual','live_temple','live_satsang','live_festival',
  'astrologers','palmistry','tarot_reading','numerology','kundli_matching',
  'vastu','pandit_consultation','meditation'
);
