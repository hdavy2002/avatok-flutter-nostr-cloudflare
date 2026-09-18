
# WEB-GATEWAY common rules (read fully before editing)

Goal: a payment-gateway risk reviewer must classify avatok.ai in 30 seconds as a marketplace for
online puja bookings, online classes, expert consultations and ticketed live events. Today the copy
is Hinglish and uses words that read like a paid-companionship app.

HARD RULES
- Work ONLY inside this git worktree, only under web/ (and Specs/ for notes). Do not touch app/ or worker/.
- NEVER git push. NEVER deploy. NEVER run wrangler, cf.sh, gh workflow. Commit locally on the current branch only.
- Never hand-edit generated files: web/src/lib/listingTaxonomy.ts, app/lib/core/listing_groups.dart.
- Legal-entity wording is owned by Stream C only; follow the ENTITY CLEANUP section of the C brief exactly.
- Do not name founders anywhere ([WEB-SEO-7]).
- CSS: --ava-* tokens are dead in production. Use existing --zine-* tokens or define tokens on the component. Match the existing cream, bold marketplace look of the homepage. No new fonts.
- All visible copy is plain English. No Hinglish, no Devanagari on the pages you touch.
- Banned words in public copy (except inside policy pages that PROHIBIT these things): private, meetup, fanbase, fans, find your people, friends, companionship, lonely, chat with, date/dating.
  Use: audience, customers, students, clients, session, consultation, class.
- Format names everywhere: "Live events", "1:1 consultations", "Group classes".
- Money: rupee prices only. No token or wallet wording on the homepage.
- Many elements carry data-i18n keys / <ui-copy>. When you change an English source string, make sure the rendered page shows the NEW English (check how web/src/lib/i18n resolves keys; update or remove the key so stale translations are not served).

VERIFY BEFORE EVERY COMMIT (from web/):
  npm ci   (first time only)
  PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build && node scripts/check-homepage.mjs && node scripts/check-help.mjs
check-homepage.mjs fails if any #anchor linked from the homepage or footer has no matching id.
A green build does not prove SSR pages render: also run the built site or astro preview and curl the pages you changed; grep for a marker string from your new markup.

FINISH: commit with the tag given in your stream brief, then write Specs/WEBGW-<stream>-REPORT.md listing files changed, decisions taken, anything you could not do, and the exact verify output. Do not push.
