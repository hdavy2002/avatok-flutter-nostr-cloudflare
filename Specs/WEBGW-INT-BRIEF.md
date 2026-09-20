
# Stream INT+F: integrate A and C, finish leftovers, clean the taxonomy  (tags [WEB-GATEWAY-INT], [WEB-GATEWAY-F])

Read Specs/WEBGW-COMMON.md. In this stream you MAY edit Specs/listing-taxonomy.json, run python3 scripts/gen_listing_taxonomy.py, edit web/src/lib/org.ts, and add (NOT apply) a D1 migration file. Still: never push, never deploy, never run wrangler/cf.sh against anything remote.

1. MERGE: `git merge webgw/a-home` then `git merge webgw/c-sweep` into this branch (webgw/int). Resolve conflicts (expected in web/scripts/check-homepage.mjs, web/src/layouts/Base.astro, sign-in.astro, sign-up.astro) keeping BOTH streams intent: A owns homepage/header/footer/picker removal; C owns entity wording, ideas (109 ideas), sign-in/up copy. Read Specs/WEBGW-A-REPORT.md and Specs/WEBGW-C-REPORT.md first; they list every leftover below.

2. LEFTOVERS flagged by A and C (fix all):
 - org.ts JSON-LD slogan "Apna hunar. Apni kamaai." -> "Turn your skill into income." Description likewise plain English, no banned words.
 - Any remaining homepage/Base default meta containing fanbase / private 1:1 video meetups / Hinglish.
 - web/src/components/ListingDetailsComp.astro category styling map: English, neutral labels and eyebrows. No "LIVE FRIENDS", "PRIVATE 1:1", "DIL SE", "STRANGERS WELCOME", "KISMAT DESK", "FULL MAKEOVER SCENE".
 - web/src/lib/globalCreatorIdeas.ts + pages/global-ideas.astro: remove the close-friends-studio idea and any similar; sweep banned words.
 - Preview/staging/archive pages that are publicly routable and still Hinglish or banned-word heavy (india-next, landing-steps-preview, global-next, archive/home-2026-09-09, and anything similar under web/src/pages): they are not product pages. Make each return a 301 to / via Astro.redirect (keep files small), remove them from sitemap ROUTES, and make sure check scripts still pass. Dead unreferenced HTML under web/src/landing/archive can be deleted.
 - Hero/footer links labelled "1:1 consultations" must go to ?group=book_their_time, not find_your_people.
 - Footer/hero trust check wording stays "Liveness-verified creators" (A verified this against policy).

3. STREAM F taxonomy (edit Specs/listing-taxonomy.json ONLY, then regenerate; never hand-edit generated mirrors; also update worker/src/lib/listing_section.ts mirror if the generator does not cover it, and say so in the report):
 - Add sections live_friends, adda_rooms, astro_tarot, glow_up to _hidden_sections.
 - Group headings/blurbs: india_goes_live -> heading "Live events", blurb plain English about ticketed live shows, pujas, classes and tours. book_their_time -> heading "1:1 consultations", blurb about booked, time-boxed video consultations with experts. find_your_people -> heading "Group classes", blurb about small-group classes and practice sessions, and move/define its visible sections so that it contains only group-class style sections (if no suitable visible section exists after hiding, create one section group_classes "Group classes" with categories: Language practice, Fitness & yoga batch, Exam revision, Music class, Cooking class; follow the JSON schema used by other sections). Do NOT rename group slugs.
 - Make sure a Puja & darshan path is prominent: live_puja and live_puja_ritual stay visible under india_goes_live.
 - Write migrations/<next>_webgw_taxonomy.sql for DB_META inserting any NEW listing_categories rows and marking categories of hidden sections inactive if the table has such a column (inspect the schema in existing migrations). DO NOT apply it. Print the exact apply command in the report.
 - python3 scripts/gen_listing_taxonomy.py --check must pass. The regenerated Dart file app/lib/core/listing_groups.dart may change; commit it.
 - Web marketplace chips and any copy that prints group headings must now read Live events / 1:1 consultations / Group classes.

4. VERIFY as in COMMON plus: node scripts/check-render-performance.mjs; worker typecheck (cd worker && npm ci && npx tsc --noEmit) if you touched worker/. Run astro dev and curl /, /marketplace, /ideas, /about, /terms, /privacy, /refunds, one /blog/creator-ideas/<slug>, one removed slug (expect redirect rule present in _redirects). Final grep from the C brief: list only hits in rendered public copy.

5. Commit(s) and write Specs/WEBGW-INT-REPORT.md: conflicts resolved, every file changed, migration apply command, anything left.
