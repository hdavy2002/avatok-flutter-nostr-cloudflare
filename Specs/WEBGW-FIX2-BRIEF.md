# Stream FIX2: residual Hinglish copy found by the coordinator  (commit tag [WEB-GATEWAY-FIX2])

Worktree /Users/davy/.cache/deepastra/webgw-20260918/int, branch `webgw/int`. Read Specs/WEBGW-COMMON.md.
Never push, deploy, or run wrangler/cf.sh/gh workflow. Only touch the files named here plus the report.

1. `web/src/islands/auth/LoginIsland.tsx` line ~267:
   `<p className="auth-aside"><UiText id="web-auth.147f03f49b15afba" source="Chai ho jaye?" /><br /><UiText id="web-auth.eef3540404312d17" source="Woh bhi ho jayega." /></p>`
   Stream C already rewrote the same two keys in sign-in.astro as "Ready for a break?" / "We'll have you
   set up in a moment." Use the same two English strings here (keep the ids). Then grep LoginIsland.tsx,
   SignUpIsland.tsx and AuthKit.tsx for any other non-English decorative copy (Hinglish words such as
   chai, dil, desi, yaar, jaldi, karo, hai, milega; any Devanagari) and fix in plain English.

2. Search placeholder "Dhoondo: tarot, adda, rizz, shayari, antakshari…" appears in
   `web/src/islands/marketplace/SearchBox.tsx` (~line 31) and `web/src/components/BazaarSearchStrip.astro`
   (~line 40). Replace with: "Search: yoga, guitar, exam revision, live puja…" in both. (tarot/adda are
   hidden sections now; the placeholder must not advertise them.)

3. Verify from web/: `PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXZhdG9rLmFpJA npm run build && node
   scripts/check-homepage.mjs && node scripts/check-help.mjs && node scripts/check-performance.mjs`, then
   `npx astro dev --port 4325`, curl /sign-in and /marketplace and confirm zero occurrences of
   "Chai ho", "Dhoondo", "antakshari".

4. Commit: `python3 scripts/git_safe_commit.py "[WEB-GATEWAY-FIX2] Residual Hinglish: login aside and search placeholder" <paths>`
   (fallback: git add -- <paths> && git commit). Write Specs/WEBGW-FIX2-REPORT.md (files changed, verify output).
