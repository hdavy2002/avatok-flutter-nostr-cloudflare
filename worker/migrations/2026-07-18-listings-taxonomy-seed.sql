-- [AVA-MKT-TAXONOMY-2] Commerce taxonomy seed + legacy category back-fill + v1 snapshots.
--
-- DATA, NOT SCHEMA. Companion to 2026-07-18-listings-taxonomy-columns.sql, which
-- adds the columns this file writes into. Phase 1 of
-- Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md (§2.1, §2.3, §2.4).
-- DB: avatok-meta (DB_META).
--
-- APPLY ORDER — THIS FILE IS LAST. It requires BOTH:
--   * 2026-07-18-marketplace-verticals.sql  (the vertical + version tables)
--   * 2026-07-18-listings-taxonomy-columns.sql  (the columns; otherwise every
--     statement here dies with "no such column: intent")
--
-- ---------------------------------------------------------------------------
-- PART 1 OF 4 — THE 10 LEGACY CATEGORIES. READ THIS BEFORE CHANGING ANYTHING.
--
-- listings.sql:13-23 already seeds 10 CREATOR-SERVICE categories — teachers,
-- astrologers, professors, fitness, music, cooking, business, language, art,
-- wellness. THEY ARE LIVE AND THEY MUST KEEP WORKING. They are not commerce
-- goods: listings.kind is 'live_event' | 'consult' (listings.sql:29), i.e. a
-- person selling their TIME, not an object.
--
-- The mapping, and the reasoning for each axis:
--
--   vertical = 'commerce'  — by DEFAULT, with NO UPDATE STATEMENT AT ALL.
--     Only two verticals exist (plan §2.0) and these are plainly not Connect.
--     The ADD COLUMN DEFAULT 'commerce' back-fills them for free, which is the
--     whole reason that default was chosen: the two-vertical design's headline
--     property is "nothing existing changes behaviour", and the strongest form
--     of that is not touching the rows at all. Commerce is not "goods" — it is
--     "everything that is not Connect", and a paid consult is commerce.
--
--   intent = 'BOOK'  — the correction this file exists to make.
--     The ADD COLUMN default is 'SELL' (SQLite demands a default on NOT NULL,
--     and SELL is the majority across the new taxonomy), and SELL IS WRONG HERE:
--     nobody buys a teacher. Plan §2's intent table defines BOOK as "takes an
--     appointment slot / qualify, then book a slot", with examples "doctor,
--     salon, TUTOR, CONSULTANT". Every one of the 10 is a tutor or a consultant:
--     teachers/professors/language are tutors; astrologers/fitness/music/cooking/
--     business/art/wellness are consultants. The schema agrees — `starts_at` +
--     `duration_min` for live events and `capacity` (1|10|20) for consults are
--     slot mechanics, and a consult with capacity=1 IS an appointment. BOOK is
--     the only intent of the five that describes what these rows already do.
--     (Not LEAD: a LEAD hands off to the owner's inbox and the buyer never
--     transacts in-flow. These rows have `orders`, escrow and a joined_count —
--     the booking IS the transaction. Not PROFILE: the buyer is evaluating an
--     offering with a price and a time, not a person.)
--
--   price_semantics = 'from'  — the honest reading of `listings.price`.
--     Not 'asking': asking implies ONE negotiable number for ONE object, and
--     these prices vary by capacity within a single category (a 1:1 consult and
--     a group of 20 are the same category at different prices). Not 'per_month':
--     that is rental. And listing_promotions (early_bird + promo_code, A5,
--     listings.sql:101-110) means the number on the card is a CEILING that
--     discounts move — 'from' is the only value of the five that does not lie on
--     a card once a promo is live.
--
--   detail_template = 'book'  — follows the intent; there is no third choice.
--
--   field_schema / agent_playbook = LEFT NULL  — deliberately.
--     NULL means "asks no category-specific attrs", which is EXACTLY today's
--     behaviour. A NULL schema must never start demanding fields of a flow that
--     already works — the mirror image of plan §2.4's "a schema bump must not
--     orphan data". Giving these 10 a schema is a product decision about the
--     consult flow, not a migration.
--
-- IDEMPOTENCY OF THIS UPDATE — `price_semantics IS NULL` IS THE LATCH.
--   These rows are ADMIN-EDITABLE (plan §2, "category = data, not code"), so a
--   re-run must never revert an operator. price_semantics is the perfect marker
--   because its ADD COLUMN carries NO DEFAULT: it is NULL on every pre-existing
--   row and can ONLY become non-NULL by this statement or by a deliberate admin
--   write. So the UPDATE fires exactly once, ever, on each database:
--     * first run  -> price_semantics IS NULL matches -> 10 rows corrected.
--     * re-run     -> price_semantics = 'from' -> WHERE matches 0 rows -> no-op.
--     * after an admin retunes one to 'asking' -> still non-NULL -> untouched.
--   `AND intent = 'SELL'` is a second, independent guard: it confirms the row is
--   still on the migration artefact and has not been deliberately set elsewhere.
--   Both must hold, so the statement only ever touches a pristine row.
-- ---------------------------------------------------------------------------

UPDATE listing_categories
   SET intent          = 'BOOK',
       price_semantics = 'from',
       detail_template = 'book'
 WHERE id IN ('teachers','astrologers','professors','fitness','music','cooking',
              'business','language','art','wellness')
   AND price_semantics IS NULL
   AND intent = 'SELL';

-- ---------------------------------------------------------------------------
-- PART 2 OF 4 — THE COMMERCE TAXONOMY (plan §2.1).
--
-- OLX's taxonomy is the reference because it is the one Indian sellers already
-- have in their heads — matching it means the compose AI's category picker needs
-- no explanation. Mapped onto the five intents, so it costs nothing structurally.
--
-- PETS IS EXCLUDED. NOT AN OMISSION — M-D13, resolved.
--   Pets is on OLX's list and is deliberately NOT on ours. It is the one row with
--   its own legal surface (livestock rules, endangered-species law, puppy-mill
--   legislation, which differ per market) AND a known scam vector. Plan §2.1:
--   "Recommend excluding from v1 and adding deliberately later, not sweeping it
--   in because OLX has it." If a future reader adds a 'pets' row: that is a
--   policy decision with a legal review attached, not a taxonomy tidy-up.
--
-- SERVICES SPLITS BY INTENT, NOT BY NAME. A plumber is LEAD (call me), a salon is
--   BOOK (slot). Same word, different template — this is exactly what the intent
--   layer buys. Seeded as LEAD; a 'salon' BOOK row is a later INSERT.
--
-- DIGITAL GOODS is AvaOLX's existing flow (plan §2.0b) folded in as an intent
--   rather than run as a third engine. AvaOLX today is an unmoderated, unflagged
--   public listing surface with no UI, sitting in prod (olx.ts never calls
--   guardWrite; there is no olxEnabled flag). This row is the destination for
--   that fold-in; it is not urgent, and the row is inert until the client shows it.
--
-- `sort` starts at 20 to leave 1-10 to the legacy rows and 11-19 free.
-- `agent_playbook` is NULL on every row: playbooks are Phase 3 (plan §3.6/§4.3)
--   and M-D6 is still open. A category with no playbook has no "talk to my agent"
--   behaviour of its own, which is the correct state until that decision lands.
--
-- IDEMPOTENCY: INSERT OR IGNORE against `id TEXT PRIMARY KEY`.
--   OR IGNORE, NOT OR REPLACE — load-bearing. These rows are admin-editable, and
--   REPLACE would silently revert an operator's field_schema or price_semantics
--   edit on the next re-run, i.e. re-running a migration would quietly undo tuning
--   that had been done in prod. IGNORE means the seed is a first-write default and
--   the database is the source of truth from then on.
-- ---------------------------------------------------------------------------

-- `required` vs `min_required` — two levels, on purpose, and they are not the
-- same thing:
--   "required": true   -> THE AI SHOULD ASK for it (a prompt-level expectation).
--   "min_required":[…] -> THE SERVER WILL NOT PUBLISH without it (the hard gate).
-- The gap between them is where real listings live. A plot of land has no
-- bedrooms, so `bedrooms` is required:true (ask, because most property is a
-- dwelling) but is NOT in min_required (a plot must still be able to publish).
-- Collapsing these into one flag makes the compose AI either nag about
-- irrelevant fields or stop asking about important ones.

INSERT OR IGNORE INTO listing_categories
  (id, label, emoji, sort, active, vertical, intent, detail_template, price_semantics, field_schema)
VALUES

-- --- Vehicles --------------------------------------------------------------
('cars', 'Cars', '🚗', 20, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"make","label":"Make","type":"text","required":true,"ask":"Which make is it — Maruti, Hyundai, Toyota, something else?"},{"k":"model","label":"Model","type":"text","required":true,"ask":"And the model?"},{"k":"variant","label":"Variant","type":"text","required":false,"ask":"Which variant or trim, if you know it?"},{"k":"year","label":"Year","type":"int","required":true,"ask":"What year was it registered?"},{"k":"km_driven","label":"Kilometres driven","type":"number","required":true,"ask":"How many kilometres has it done?","unit":["km","miles"]},{"k":"fuel","label":"Fuel","type":"enum","required":true,"ask":"Petrol, diesel, CNG, electric or hybrid?","options":["Petrol","Diesel","CNG","LPG","Electric","Hybrid"]},{"k":"transmission","label":"Transmission","type":"enum","required":true,"ask":"Manual or automatic?","options":["Manual","Automatic"]},{"k":"owners","label":"Number of owners","type":"int","required":false,"ask":"How many owners has it had, including you?"},{"k":"service_history","label":"Service history","type":"enum","required":false,"ask":"Do you have the service history?","options":["Full","Partial","None"]},{"k":"insurance_to","label":"Insurance valid until","type":"date","required":false,"ask":"When is the insurance valid until?"},{"k":"condition","label":"Condition","type":"enum","required":false,"ask":"How would you describe the condition?","options":["Excellent","Good","Fair","Needs work"]},{"k":"negotiable","label":"Price negotiable","type":"bool","required":false,"ask":"Is the price negotiable?"}],"min_required":["make","model","year","km_driven","fuel"]}'),

('bikes', 'Bikes & scooters', '🏍️', 21, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"make","label":"Make","type":"text","required":true,"ask":"Which make?"},{"k":"model","label":"Model","type":"text","required":true,"ask":"And the model?"},{"k":"year","label":"Year","type":"int","required":true,"ask":"What year is it?"},{"k":"km_driven","label":"Kilometres driven","type":"number","required":true,"ask":"How many kilometres has it done?","unit":["km","miles"]},{"k":"engine_cc","label":"Engine (cc)","type":"int","required":false,"ask":"What is the engine size in cc?"},{"k":"condition","label":"Condition","type":"enum","required":false,"ask":"How would you describe the condition?","options":["Excellent","Good","Fair","Needs work"]},{"k":"negotiable","label":"Price negotiable","type":"bool","required":false,"ask":"Is the price negotiable?"}],"min_required":["make","model","year"]}'),

('commercial_vehicles', 'Commercial vehicles & spares', '🚚', 22, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"vehicle_type","label":"Type","type":"enum","required":true,"ask":"What kind of commercial vehicle or part is it?","options":["Truck","Tempo / Pickup","Bus / Van","Tractor","Construction vehicle","Spare part","Accessory"]},{"k":"make","label":"Make","type":"text","required":true,"ask":"Which make?"},{"k":"model","label":"Model","type":"text","required":false,"ask":"And the model?"},{"k":"year","label":"Year","type":"int","required":false,"ask":"What year is it?"},{"k":"km_driven","label":"Kilometres driven","type":"number","required":false,"ask":"How many kilometres has it done?","unit":["km","miles"]},{"k":"condition","label":"Condition","type":"enum","required":false,"ask":"How would you describe the condition?","options":["Excellent","Good","Fair","Needs work"]}],"min_required":["vehicle_type","make"]}'),

-- --- Property --------------------------------------------------------------
-- The reference schema. Plan §2.2 quotes an abridged version of this one.
('property_sale', 'Properties for sale', '🏠', 23, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"property_type","label":"Property type","type":"enum","required":true,"ask":"What kind of property is it — a flat, a house, a plot, a shop?","options":["Flat / Apartment","Independent house","Villa","Plot / Land","Shop / Showroom","Office","Warehouse"]},{"k":"bedrooms","label":"Bedrooms","type":"int","required":true,"ask":"How many bedrooms?"},{"k":"bathrooms","label":"Bathrooms","type":"int","required":false,"ask":"How many bathrooms?"},{"k":"area","label":"Area","type":"number","required":true,"ask":"How big is it? Give me a number and tell me the unit.","unit":["sqft","sqm","marla","kanal","acre"]},{"k":"furnishing","label":"Furnishing","type":"enum","required":false,"ask":"Is it furnished, semi-furnished or unfurnished?","options":["Unfurnished","Semi-furnished","Fully furnished"]},{"k":"floor","label":"Floor","type":"int","required":false,"ask":"Which floor is it on?"},{"k":"total_floors","label":"Total floors","type":"int","required":false,"ask":"How many floors are there in the building?"},{"k":"age_years","label":"Age of property","type":"int","required":false,"ask":"How old is the property in years? Say 0 if it is new."},{"k":"facing","label":"Facing","type":"enum","required":false,"ask":"Which direction does it face?","options":["North","South","East","West","North-East","North-West","South-East","South-West"]},{"k":"amenities","label":"Amenities","type":"multi","required":false,"ask":"Which of these does it have?","options":["Parking","Lift","Power backup","Garden","Pool","Security","Gym","Water supply","Club house"]},{"k":"ownership","label":"Ownership","type":"enum","required":false,"ask":"Is it freehold or leasehold?","options":["Freehold","Leasehold","Co-operative society","Power of attorney"]},{"k":"negotiable","label":"Price negotiable","type":"bool","required":false,"ask":"Is the price negotiable?"}],"min_required":["property_type","area"]}'),

-- RENT / per_month is the one place price_semantics earns its keep on its own:
-- the same integer in listings.price is an asking price one row up and a monthly
-- rent here, and the card would lie in one of the two without it.
('property_rent', 'Properties for rent', '🏘️', 24, 1, 'commerce', 'RENT', 'rent', 'per_month',
 '{"fields":[{"k":"property_type","label":"Property type","type":"enum","required":true,"ask":"What kind of property is it?","options":["Flat / Apartment","Independent house","Villa","PG / Hostel","Shop / Showroom","Office","Warehouse"]},{"k":"bedrooms","label":"Bedrooms","type":"int","required":true,"ask":"How many bedrooms?"},{"k":"bathrooms","label":"Bathrooms","type":"int","required":false,"ask":"How many bathrooms?"},{"k":"area","label":"Area","type":"number","required":true,"ask":"How big is it? Give me a number and the unit.","unit":["sqft","sqm","marla"]},{"k":"furnishing","label":"Furnishing","type":"enum","required":true,"ask":"Is it furnished, semi-furnished or unfurnished?","options":["Unfurnished","Semi-furnished","Fully furnished"]},{"k":"deposit","label":"Security deposit","type":"number","required":false,"ask":"How much is the security deposit?"},{"k":"min_tenancy_months","label":"Minimum tenancy","type":"int","required":false,"ask":"What is the minimum tenancy, in months?"},{"k":"available_from","label":"Available from","type":"date","required":false,"ask":"When is it available from?"},{"k":"tenant_prefs","label":"Tenant preferences","type":"multi","required":false,"ask":"Any tenant preferences?","options":["Family","Bachelors","Company lease","Students","Any"]},{"k":"amenities","label":"Amenities","type":"multi","required":false,"ask":"Which of these does it have?","options":["Parking","Lift","Power backup","Garden","Pool","Security","Gym","Water supply","Club house"]}],"min_required":["property_type","area","furnishing"]}'),

-- --- Goods -----------------------------------------------------------------
('mobiles', 'Mobile phones & tablets', '📱', 25, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"brand","label":"Brand","type":"text","required":true,"ask":"Which brand?"},{"k":"model","label":"Model","type":"text","required":true,"ask":"And which model?"},{"k":"storage_gb","label":"Storage (GB)","type":"int","required":false,"ask":"How much storage does it have, in GB?"},{"k":"condition","label":"Condition","type":"enum","required":true,"ask":"What condition is it in?","options":["Like new","Excellent","Good","Fair","For parts"]},{"k":"age_months","label":"Age (months)","type":"int","required":false,"ask":"How old is it, in months?"},{"k":"warranty_to","label":"Warranty until","type":"date","required":false,"ask":"Is it still under warranty? Until when?"},{"k":"box_and_bill","label":"Box & bill","type":"enum","required":false,"ask":"Do you still have the box and the bill?","options":["Both","Box only","Bill only","Neither"]}],"min_required":["brand","model","condition"]}'),

('electronics', 'Electronics & appliances', '🔌', 26, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"item_type","label":"Item","type":"text","required":true,"ask":"What is it — a TV, a fridge, a laptop, something else?"},{"k":"brand","label":"Brand","type":"text","required":false,"ask":"Which brand?"},{"k":"model","label":"Model","type":"text","required":false,"ask":"And the model, if you know it?"},{"k":"age_years","label":"Age (years)","type":"int","required":false,"ask":"How old is it, in years?"},{"k":"condition","label":"Condition","type":"enum","required":true,"ask":"What condition is it in?","options":["Like new","Excellent","Good","Fair","For parts"]},{"k":"warranty_to","label":"Warranty until","type":"date","required":false,"ask":"Is it still under warranty? Until when?"},{"k":"box_and_bill","label":"Box & bill","type":"enum","required":false,"ask":"Do you have the box and the bill?","options":["Both","Box only","Bill only","Neither"]}],"min_required":["item_type","condition"]}'),

('furniture', 'Furniture & home', '🛋️', 27, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"item_type","label":"Item","type":"text","required":true,"ask":"What is it — a sofa, a bed, a dining table, something else?"},{"k":"material","label":"Material","type":"text","required":false,"ask":"What is it made of?"},{"k":"dimensions","label":"Dimensions","type":"text","required":false,"ask":"Roughly what size is it?"},{"k":"condition","label":"Condition","type":"enum","required":true,"ask":"What condition is it in?","options":["Like new","Excellent","Good","Fair","Needs work"]},{"k":"delivery","label":"Delivery","type":"enum","required":false,"ask":"Can you deliver it, or is it pickup only?","options":["Pickup only","Delivery available","Delivery included"]}],"min_required":["item_type","condition"]}'),

('fashion', 'Fashion & accessories', '👗', 28, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"item_type","label":"Item","type":"text","required":true,"ask":"What is it?"},{"k":"brand","label":"Brand","type":"text","required":false,"ask":"Which brand?"},{"k":"size","label":"Size","type":"text","required":false,"ask":"What size is it?"},{"k":"condition","label":"Condition","type":"enum","required":true,"ask":"What condition is it in?","options":["New with tags","Like new","Good","Fair"]}],"min_required":["item_type","condition"]}'),

('hobbies', 'Books, sports & hobbies', '📖', 29, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"item_type","label":"Item","type":"text","required":true,"ask":"What is it — a book, sports gear, an instrument, something else?"},{"k":"brand","label":"Brand or author","type":"text","required":false,"ask":"Which brand, or who is the author?"},{"k":"condition","label":"Condition","type":"enum","required":true,"ask":"What condition is it in?","options":["Like new","Excellent","Good","Fair"]}],"min_required":["item_type","condition"]}'),

('digital_goods', 'Digital goods', '💾', 30, 1, 'commerce', 'SELL', 'sell', 'asking',
 '{"fields":[{"k":"goods_type","label":"Type","type":"enum","required":true,"ask":"What kind of digital product is it?","options":["Template","Ebook","Course","Software","Preset / Filter","Audio","Artwork","Other"]},{"k":"file_format","label":"Format","type":"text","required":false,"ask":"What format is the file in?"},{"k":"license","label":"Licence","type":"enum","required":false,"ask":"What licence does the buyer get?","options":["Personal use","Commercial use","Extended commercial"]},{"k":"delivery","label":"Delivery","type":"enum","required":false,"ask":"How is it delivered?","options":["Instant download","Emailed","Link after purchase"]}],"min_required":["goods_type"]}'),

-- --- Jobs & services -------------------------------------------------------
-- Two intents that look like one category and are not. Hiring is LEAD (the
-- employer wants applicants in their inbox); seeking is PROFILE (the buyer is
-- evaluating a PERSON). Same word "jobs", different template, different agent job.
('jobs_hiring', 'Jobs — hiring', '💼', 31, 1, 'commerce', 'LEAD', 'lead', 'range',
 '{"fields":[{"k":"role","label":"Role","type":"text","required":true,"ask":"What is the role called?"},{"k":"seniority","label":"Seniority","type":"enum","required":false,"ask":"What level is it?","options":["Intern","Entry","Mid","Senior","Lead","Manager","Director"]},{"k":"employment_type","label":"Employment type","type":"enum","required":true,"ask":"Is it full-time, part-time, contract or freelance?","options":["Full-time","Part-time","Contract","Freelance","Internship"]},{"k":"work_mode","label":"Work mode","type":"enum","required":false,"ask":"On-site, hybrid or remote?","options":["On-site","Hybrid","Remote"]},{"k":"must_haves","label":"Must-haves","type":"multi","required":false,"ask":"What are the must-have skills or qualifications?"},{"k":"openings","label":"Openings","type":"int","required":false,"ask":"How many openings are there?"}],"min_required":["role","employment_type"]}'),

('jobs_seeking', 'Jobs — seeking', '🧑‍💻', 32, 1, 'commerce', 'PROFILE', 'profile', 'asking',
 '{"fields":[{"k":"title","label":"Title","type":"text","required":true,"ask":"What do you do — what is your job title?"},{"k":"years_experience","label":"Years of experience","type":"int","required":true,"ask":"How many years of experience do you have?"},{"k":"skills","label":"Skills","type":"multi","required":false,"ask":"What are your main skills?"},{"k":"notice_period_days","label":"Notice period (days)","type":"int","required":false,"ask":"What is your notice period, in days?"},{"k":"work_mode","label":"Work mode","type":"enum","required":false,"ask":"Are you looking for on-site, hybrid or remote?","options":["On-site","Hybrid","Remote","Any"]},{"k":"work_auth","label":"Work authorisation","type":"text","required":false,"ask":"Where are you authorised to work?"}],"min_required":["title","years_experience"]}'),

('services', 'Services', '🔧', 33, 1, 'commerce', 'LEAD', 'lead', 'from',
 '{"fields":[{"k":"service_type","label":"Service","type":"text","required":true,"ask":"What service do you offer?"},{"k":"service_radius_km","label":"Service radius (km)","type":"int","required":false,"ask":"How far will you travel, in kilometres?"},{"k":"callout_fee","label":"Callout fee","type":"number","required":false,"ask":"Do you charge a callout fee?"},{"k":"availability","label":"Availability","type":"multi","required":false,"ask":"When are you available?","options":["Weekdays","Weekends","Evenings","Emergency / 24x7"]},{"k":"experience_years","label":"Years of experience","type":"int","required":false,"ask":"How many years have you been doing this?"}],"min_required":["service_type"]}'),

-- --- The escape hatch ------------------------------------------------------
-- Plan §2.3 REQUIRES this row to exist. When nothing fits, the compose AI files
-- the listing under category='other' and writes its suggestion into
-- listings.proposed_category — and THE LISTING PUBLISHES NORMALLY. If this row is
-- missing, that path points at a category that does not exist and the escape
-- hatch becomes the blocker it was designed to remove. Do not delete it.
--
-- field_schema NULL: 'other' by definition has no known schema, so it asks
-- nothing beyond the base fields. intent 'SELL' is a KNOWN COARSE APPROXIMATION
-- and worth flagging — there is no per-listing intent column, so a listing filed
-- under 'other' inherits SELL regardless of the intent the AI actually inferred.
-- That is acceptable precisely because 'other' is a WAITING ROOM: the fix is the
-- admin promoting a high-volume proposed_category into a real row with the right
-- intent, which is the loop §2.3 describes. It is not a reason to add a
-- per-listing intent column.
('other', 'Other', '📦', 999, 1, 'commerce', 'SELL', 'sell', 'asking', NULL);

-- ---------------------------------------------------------------------------
-- PART 3 OF 4 — v1 SNAPSHOTS (plan §2.4).
--
-- Every listing PINS the versions it was born with, and buildAgentContext loads
-- the playbook at listings.playbook_version — NEVER "latest". Both the columns
-- migration and this seed default those pins to 1, so THE v1 ROW MUST EXIST or
-- every listing on the platform pins to a version that cannot be resolved.
--
-- INSERT ... SELECT, not 16 hand-written copies of the JSON above. This matters:
-- a literal restatement of each field_schema is the same data written twice, and
-- the two copies drift the first time someone edits one and forgets the other —
-- in a table whose ENTIRE PURPOSE is being a trustworthy record of what was in
-- force. Selecting from listing_categories makes the snapshot true by
-- construction, and it covers the 10 legacy rows in the same statement.
--
-- created_at is a FIXED LITERAL (1784332800000 = 2026-07-18T00:00:00Z), not
-- strftime('now'): a migration should produce the same bytes on every database it
-- is applied to, so staging and prod agree, and re-running cannot make the
-- audit trail depend on when someone happened to run it.
--
-- IDEMPOTENCY: INSERT OR IGNORE against PRIMARY KEY (category, version).
--   * first run -> one v1 row per category.
--   * re-run    -> every (category, 1) exists -> all ignored -> no-op.
--   * after an admin bumps a category to v2 -> this would ADD the missing (cat,2)
--     snapshot and leave (cat,1) untouched, because IGNORE never overwrites. That
--     is convergent and safe: it can only ever fill a hole, never rewrite history.
--     Re-running this file is not the admin edit path, but it must be harmless if
--     someone does, and it is.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO listing_category_versions
  (category, version, field_schema, agent_playbook, detail_template, created_at)
SELECT id, cat_version, field_schema, agent_playbook, detail_template, 1784332800000
  FROM listing_categories;

-- ---------------------------------------------------------------------------
-- PART 4 OF 4 — WHAT IS DELIBERATELY NOT HERE.
--
-- 1. NO CONNECT CATEGORIES. Plan §2.1b: "Do not seed until §2.6 clears — a
--    category row is what makes a compose flow reachable, so seeding these IS
--    shipping the vertical." The 'connect' VERTICAL row exists (see
--    2026-07-18-marketplace-verticals.sql) and is inert without categories. Dating
--    and Matrimony are two rows and half an hour of work; they are gated on age
--    assurance, CSAM detection, a policy carve-out and a Play answer — none of
--    which are engineering decisions. Do not add them to "test the plumbing".
--
-- 2. NO 'pets' ROW. M-D13 — see the Part 2 header.
--
-- 3. NO agent_playbook ON ANY ROW. Phase 3, and M-D6 is open.
--
-- 4. NO field_schema ON THE 10 LEGACY ROWS. See the Part 1 header.
--
-- VERIFY (read-only, either environment):
--   scripts/cf.sh worker d1 execute DB_META --remote --command \
--     "SELECT id, vertical, intent, price_semantics, cat_version FROM listing_categories ORDER BY sort;"
--   -- expect: 10 legacy rows BOOK/from, 15 commerce rows, 0 connect rows.
--   scripts/cf.sh worker d1 execute DB_META --remote --command \
--     "SELECT vertical, COUNT(*) FROM listing_categories GROUP BY vertical;"
--   -- expect: commerce = 25, and NO 'connect' group at all.
-- ---------------------------------------------------------------------------
