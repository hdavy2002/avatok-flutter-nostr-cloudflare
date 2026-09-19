# WEB-GATEWAY-RESTORE-TEXT-FIX1 — leftovers from the coordinator's review

Same worktree, same branch (`webgw/restore`, HEAD `827f9304`), same ABSOLUTE RULE as
`Specs/WEBGW-RESTORE-TEXT-BRIEF.md` (read it again first): **text/string values only, no
markup, attribute-name, class, href, route or behaviour change.** Reviewed wording to copy
from: `git show a42f2a41:<file>` (copy strings only, never checkout files).

The coordinator's render check (astro dev + curl, tags stripped) still finds Hinglish and
banned words on public pages. Fix every item below; each is a string literal or text node.

1. `web/src/islands/auth/LoginIsland.tsx` — line ~262 `uiT("web-auth.4aec6108de24a9f0","Ya phir")`
   → `"Or"`; line ~267 `source="Chai ho jaye?"` / `source="Woh bhi ho jayega."` → the SAME
   English you put in `sign-in.astro` for those two keys (`web-auth.147f03f49b15afba`,
   `web-auth.eef3540404312d17`) so island and page agree. This is why the live `/sign-in`
   still shows "Ya phir … Chai ho jaye? Woh bhi ho jayega." after hydration.
2. `web/src/islands/auth/SignUpIsland.tsx` ~line 668 — same `"Ya phir"` → `"Or"`.
3. `web/src/islands/auth/AuthKit.tsx` ~line 375 — `source="Desi · Dil Se · Global"` → the same
   English you used for `web-auth.1dbccd09995a56ce` in the pages ("Homegrown · Heartfelt · Global").
4. `web/src/components/ListingDetailsComp.astro` `CATS` map (~lines 57–63): only the `label` and
   `eyebrow` string values, using `a42f2a41`'s wording — `friends` → label `'1:1 CONSULTATIONS'`,
   eyebrow `'02 · ONE-ON-ONE · BOOKED TIME'`; `adda` → `'GROUP CLASSES'`, `'03 · SMALL GROUP ·
   OPEN SEATS'`; `astro` → `'ASTROLOGY & TAROT'`, `'READINGS · LIVE SESSIONS'`; `glow` →
   `'STYLE & GROOMING'`, `'CONSULTATIONS · BOOKED TIME'`. Keys, `kind`, `photo` unchanged.
   Also ~line 777 `alt="Desi swag"` → `alt="Swag sticker"`.
5. `web/src/components/BazaarHero.astro` ~line 73 — "Live streams, astrology sessions, adda rooms,
   AI agents and full glow-ups — book your seat or jump straight into a live show." → "Live
   streams, classes, consultations, AI agents and ticketed shows — book your seat or jump
   straight into a live show." (keep the line break positions similar).
6. `web/src/lib/indiaLandingSource.ts` — every `'Dance adda'` (lines ~34 and ~98) → `'Dance class'`.
   Check the corresponding English catalog key value in `shared/i18n/source/` and update it too.
7. `web/src/lib/verticals.ts` — it is imported by `marketGroups.ts`. If any of its strings
   (`'Pawri zone'`, `'Ye hamari pawri ho rahi hai!'`, `'Adda rooms'`, `'Adda'`, `'Robot dost'`,
   `'Gyaan desk'`, `'& gyaan.'`, `'Jo dhoondoge, wahi milega.'`, `'Live friends'`…) can reach a
   rendered page, give them the same English you used in `marketGroups.ts`. If they are provably
   dead (marketGroups overrides them all), leave them and say so in the report.
8. `web/src/pages/blog/index.astro` ~line 52 — "115 desi ideas. Your next paid session." →
   "109 creator ideas. Your next paid session."
9. `web/src/islands/live-gs/LiveGsViewer.tsx` ~line 486 — `source="Sab spots bhar gaye — koi buy
   zaroori nahi tha."` → `"All spots are taken — no purchase was needed."`
10. `web/src/lib/listingDefaults.ts` ~lines 103/115 — "desi observations, everyday chaos" →
    "everyday Indian observations, everyday chaos"; `'Fans of desi observational comedy'` →
    `'Lovers of observational comedy'` ("fans" is banned).
11. "chat with" is banned: `web/src/lib/creatorIdeas.ts` descriptions ("chat with viewers" ×3 →
    "talk to viewers"), `web/src/content/help/getting-started/web-vs-app.md` ("including chat
    with the creator" → "including messaging the creator"). Grep the whole of `web/src` for
    `chat with` afterwards (policy pages that prohibit things excepted).
12. `web/src/lib/creatorGuides.ts` prose still says "private" (~17 lines, e.g. "Keep private rooms
    and other people off-camera") and may say "friends"/"fans": reword each occurrence the way
    `a42f2a41`'s `creatorGuides.ts` did (confidential / personal / off-camera / audience). Same
    for any `private`/`friends`/`fans` left in `creatorIdeas.ts` description prose (the `private|`
    FORMAT column at the start of each row is a data key — do NOT touch it).
13. `web/src/components/help/HelpFaqStrip.astro` ~line 60 alt text → `alt="Illustration — what will
    people say — the help centre's FAQ banner."`
14. `web/src/pages/india-next.astro` and `web/src/pages/landing-steps-preview.astro` (noindex
    preview routes that share the homepage `data-i18n` keys): give the hero H1 spans, kicker,
    description, CTAs, chips and ideas eyebrow/heading the exact same English as `index.astro`
    (same keys → same strings). Text only; the pages stay.

Then re-run the full verify from the first brief (build + 4 check scripts), re-run the
homepage/ideas structural diff, and run this scan against `npx astro dev` on `/`,
`/marketplace`, `/sign-in`, `/sign-up`, `/about`, `/ideas`, `/l/avatok-upi-smoke-2026`, one
`/blog/creator-ideas/<slug>`, `/help`:

```
python3 - <<'EOF'
import re,sys,urllib.request
banned=r"\b(private|meetup|fanbase|fans|find your people|friends|companionship|lonely|chat with|dating|Ave Maria|Pvt Ltd|apna|kamaai|adda|pawri|khojo|dhoondo|paisa|pehla|naya|jayega|karo|desi|dil se|gyaan|kismat|dost)\b"
for p in ['','marketplace','sign-in','sign-up','about','ideas','l/avatok-upi-smoke-2026','blog/creator-ideas/gaon-ki-subah','help']:
    h=urllib.request.urlopen('http://localhost:4332/'+p).read().decode()
    h=re.sub(r'<script[^>]*>.*?</script>','',h,flags=re.S); h=re.sub(r'<style[^>]*>.*?</style>','',h,flags=re.S)
    attrs=' '.join(re.findall(r'(?:alt|aria-label|title|content|placeholder)="([^"]*)"',h))
    text=re.sub(r'<[^>]+>',' ',h); blob=text+' '+attrs
    # the language picker menu legitimately lists native language names — drop that block
    blob=re.sub(r'Choose language.*?(Log in|Sign out)','',blob,flags=re.S)
    print('/'+p, sorted(set(m.group(0).lower() for m in re.finditer(banned,blob,flags=re.I))), 'devanagari:',len(re.findall(r'[ऀ-ॿ]+',blob)))
EOF
```
Expected: no hits except "private" on the UPI smoke listing (that is D1 data, not web copy)
and none on the others; devanagari 0 outside the language picker. Paste the output in
`Specs/WEBGW-RESTORE-TEXT-FIX1-REPORT.md` with the list of files changed and the verify output.

Commit with `python3 scripts/git_safe_commit.py "[WEB-GATEWAY-RESTORE-TEXT-FIX1] <what>" <paths…>`.
Never push, never deploy, never touch `worker/`, `app/`, `listingTaxonomy.ts`.
