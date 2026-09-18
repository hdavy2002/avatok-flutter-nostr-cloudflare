-- [WEB-GATEWAY-E 2026-09-18] 8 badged EXAMPLE listings for the payment-gateway
-- reviewer (and any visitor before real creators onboard).
--
-- WHAT THESE ARE
-- Non-bookable, non-payable sample listings, owned by one official avaTOK
-- account, published so the marketplace is never empty pre-launch. Every
-- money/booking entry point in the worker (routes/listings.ts bookListing,
-- routes/commercial_checkout.ts commercialHold/commercialCheckout,
-- routes/pay.ts payCreateOrder, routes/cashfree.ts cashfreeCreateOrder)
-- refuses a row with is_example=1 before any ledger or gateway call — see
-- Specs/WEBGW-E-REPORT.md for the exact guard list.
--
-- OWNER — the existing official account
-- --------------------------------------
-- [WEB-GATEWAY-FIX1] Every row below is owned by `avatok_team` / "avaTOK
-- Team", uid `user_3GMM0uFG84V20RTmbY1MypELJhD` — the coordinator verified
-- this is the existing official account in production D1. This is the
-- account's public face for every example listing, so a reviewer sees a
-- real "avaTOK" creator profile rather than a personal account.
--
-- APPLY (staging first, then prod — never applies itself; NOT run by this task)
--     scripts/cf.sh worker d1 execute DB_META --remote --file=scripts/seed_example_listings.sql
--     ALLOW_PROD=1 scripts/cf.sh worker d1 execute DB_META --remote --file=scripts/seed_example_listings.sql
--
-- IDEMPOTENT: every id is deterministic (`ex-<slug>-1`) and every statement is
-- INSERT OR REPLACE, so re-running this file after edits replaces rather than
-- duplicates. It does NOT wipe anything — dropping these rows later is a
-- plain `DELETE FROM listings WHERE id LIKE 'ex-%';`.
--
-- SHAPE — verified against (read, not guessed):
--   worker/migrations/listings.sql                      (base columns)
--   worker/migrations/2026-07-18-listings-taxonomy-columns.sql (vertical, attrs,
--                                                         cat/playbook/template_version)
--   worker/migrations/2026-08-31-listings-section.sql    (section)
--   worker/migrations/2026-09-02-listings-content.sql    (blurb, slug, schedule_mode,
--                                                         timezone, billing_unit,
--                                                         free_entry, max_per_booking)
--   worker/migrations/2026-09-18-listing-is-example.sql  (is_example — apply THIS
--                                                         migration first, or every
--                                                         INSERT below fails with
--                                                         "no such column: is_example")
--   worker/src/lib/listing_blockers.ts, listing_section.ts (kind/category/capacity
--                                                         rules these rows satisfy)
--   scripts/seed_listings.py                              (prior art for the exact
--                                                         INSERT column list/order)
--
-- CATEGORY MAPPING — two of the eight briefs named a category with no existing
-- id in Specs/listing-taxonomy.json. Mapped to the closest real id rather than
-- inventing one (see Specs/WEBGW-E-REPORT.md for the full reasoning):
--   "exam and study help"  -> teachers        (Tutors & teachers) — but see
--                              [WEB-GATEWAY-FIX1] below: this row's own
--                              category was then changed to a group_classes one.
--   "games and quizzes"    -> live_everyday   (Everyday life)
--
-- [WEB-GATEWAY-FIX1] GROUP-CLASS SECTION — the three multi-seat "group class"
-- rows (ex-examrev-1, ex-spokenenglish-1, ex-yoga-1) were originally seeded
-- with section='consulting' and a 1:1 category, which put them under the
-- "1:1 consultations" marketplace chip despite being capacity>1 group
-- sessions. Stream F added a dedicated group_classes section
-- (Specs/listing-taxonomy.json, worker/src/lib/listing_section.ts,
-- worker/migrations/2026-09-18-webgw-taxonomy.sql) with categories
-- group_exam_revision / group_language_practice / group_fitness_batch — these
-- three rows now use section='group_classes' and the matching group_*
-- category, so they surface under "Group classes" instead. Guitar
-- (ex-guitar-1, category music, capacity 1) and career mentoring
-- (ex-careermentor-1, category career_coach, capacity 1) are genuine 1:1s and
-- stay section='consulting'.
--
-- SCHEDULE — never expires. The three `live_event` rows carry a real
-- (SQLite-computed, always "today + N days") future `starts_at` so the card
-- renders like a real upcoming show rather than a blank date; the five
-- `consult` rows use `schedule_mode='always_on'` with no fixed date at all.
-- Either way, routes/listings.ts expireEndedEventListings and
-- routes/commercial_lifecycle.ts runCommercialOrphanNoShowSweep both skip
-- `is_example=1` rows outright, so neither can ever complete/cancel/refund one
-- regardless of how stale this seed gets.
--
-- COVER IMAGES — reference /seed/<slug>.jpg under web/public/seed/. The real
-- photos are supplied later by the coordinator; this repo currently has a
-- neutral placeholder copied to each of the 8 paths so nothing 404s (see the
-- report for the exact source file).

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-havan-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'live_event',
   'Ganga-side havan in Haridwar, live with recording',
   'A havan performed on the banks of the Ganga at Haridwar, with your name and sankalp read out during the ceremony.

Join the ceremony live from wherever you are, and receive a recording afterwards to keep. This listing is not affiliated with any temple; the officiant is an independent priest.',
   'live_puja', 501, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/ganga-havan-haridwar-live.jpg"}]',
   ((CAST(strftime('%s','now') AS INTEGER)*1000) + 200*24*60*60*1000), 90, NULL, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'live_streaming', 'ganga-havan-haridwar-live',
   'A havan on the banks of the Ganga at Haridwar — live, with a recording to keep.',
   'fixed_date', NULL, NULL, 'Asia/Kolkata', 'session', 0, 4, NULL, NULL, NULL,
   1);

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-examrev-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'consult',
   'Exam revision sprint: Class 12 Physics with a professor',
   'A focused revision session on Class 12 Physics, led by a professor, covering the topics students find hardest before the board exam.

Students get worked examples, a chance to ask questions live, and a short set of practice problems to try afterwards.',
   'group_exam_revision', 299, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/exam-revision-physics-class12.jpg"}]',
   NULL, 90, 30, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'group_classes', 'exam-revision-physics-class12',
   'Class 12 Physics revision with a professor, live before the board exam.',
   'always_on', NULL, NULL, 'Asia/Kolkata', NULL, 0, 4, NULL, NULL, NULL,
   1);

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-biryani-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'live_event',
   'My grandmother''s secret biryani, cook-along',
   'A live cook-along for a family biryani recipe, passed down and cooked step by step alongside the host.

Follow along in your own kitchen with the ingredient list shared in advance, and end the session with a finished dish and the exact method to repeat it.',
   'live_cooking', 199, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/grandmothers-biryani-cookalong.jpg"}]',
   ((CAST(strftime('%s','now') AS INTEGER)*1000) + 210*24*60*60*1000), 75, NULL, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'live_streaming', 'grandmothers-biryani-cookalong',
   'A live cook-along for a family biryani recipe, step by step.',
   'fixed_date', NULL, NULL, 'Asia/Kolkata', 'session', 0, 4, NULL, NULL, NULL,
   1);

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-quiznight-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'live_event',
   'Friday quiz night: Bollywood and cricket',
   'A live quiz night with rounds on Bollywood trivia and cricket history, hosted for a mixed group of players.

Play along from home, answer in the chat, and see live scores as the rounds go on — a light session for a Friday evening.',
   'live_everyday', 99, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/friday-quiz-bollywood-cricket.jpg"}]',
   ((CAST(strftime('%s','now') AS INTEGER)*1000) + 220*24*60*60*1000), 60, NULL, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'live_streaming', 'friday-quiz-bollywood-cricket',
   'A Friday quiz night — Bollywood trivia and cricket history, live.',
   'fixed_date', NULL, NULL, 'Asia/Kolkata', 'session', 0, 4, NULL, NULL, NULL,
   1);

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-spokenenglish-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'consult',
   'Spoken English practice circle (max 8)',
   'A small group practice circle for spoken English, capped at eight people so everyone gets time to talk.

The host guides the conversation, corrects gently, and keeps the group moving through everyday topics — built for confidence, not grammar drills.',
   'group_language_practice', 149, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/spoken-english-practice-circle.jpg"}]',
   NULL, 60, 8, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'group_classes', 'spoken-english-practice-circle',
   'A small spoken-English practice circle, capped at eight people.',
   'always_on', NULL, NULL, 'Asia/Kolkata', NULL, 0, 4, NULL, NULL, NULL,
   1);

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-guitar-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'consult',
   'Beginner guitar: your first three songs',
   'A 45-minute 1:1 guitar session for complete beginners, built around learning your first three songs.

The instructor works at your pace, covering basic chords and strumming, so you leave with something you can actually play.',
   'music', 499, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/beginner-guitar-first-songs.jpg"}]',
   NULL, 45, 1, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'consulting', 'beginner-guitar-first-songs',
   'Your first three songs on guitar — a 45-minute 1:1 for beginners.',
   'always_on', NULL, NULL, 'Asia/Kolkata', NULL, 0, 1, NULL, NULL, NULL,
   1);

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-yoga-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'consult',
   'Morning yoga batch, 7 am',
   'A live morning yoga session at 7 am, run as a small batch so the instructor can watch everyone''s form.

Bring your own mat and a bit of floor space — the session covers stretching, breathing and a short guided practice to start the day.',
   'group_fitness_batch', 99, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/morning-yoga-batch-7am.jpg"}]',
   NULL, 45, 20, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'group_classes', 'morning-yoga-batch-7am',
   'A live 7am yoga batch, kept small so the instructor can watch your form.',
   'always_on', NULL, NULL, 'Asia/Kolkata', NULL, 0, 4, NULL, NULL, NULL,
   1);

INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential,
   is_example)
VALUES
  ('ex-careermentor-1', 'user_3GMM0uFG84V20RTmbY1MypELJhD', 'consult',
   'Career mentoring: CV review and mock interview',
   'A 45-minute 1:1 mentoring session covering a CV review and a mock interview, run by an experienced mentor.

You get direct feedback on your CV, practice answering common interview questions, and a short list of things to improve before your next real interview.',
   'career_coach', 799, 'INR', 'IN', 0, NULL,
   '[{"type":"image","url":"/seed/career-mentoring-cv-interview.jpg"}]',
   NULL, 45, 1, 'published', 0,
   NULL, 0, (CAST(strftime('%s','now') AS INTEGER)*1000), (CAST(strftime('%s','now') AS INTEGER)*1000),
   'commerce', NULL, NULL, 1, 1, 1,
   'consulting', 'career-mentoring-cv-interview',
   'CV review and a mock interview, 45 minutes 1:1 with a mentor.',
   'always_on', NULL, NULL, 'Asia/Kolkata', NULL, 0, 1, NULL, NULL, NULL,
   1);
