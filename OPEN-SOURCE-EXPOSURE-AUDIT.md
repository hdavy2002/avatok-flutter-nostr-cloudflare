# Open-source exposure audit — avatok-app (client)

**Question:** If I make the AvaTOK client public, what am I exposing? Will it hurt
my business, leak my safety logic, or let people misuse me?

**Bottom line:** Open-sourcing the *client* is **lower-risk than it feels**,
because your architecture already keeps the crown jewels server-side. The client
is the "skin." Your moat — scam/grooming detection, the money engine, anti-abuse
rules, moderation — lives in the **closed backend** and would NOT be in this repo.
The real, concrete risks are narrow and fixable: one review-login endpoint, the
client-side paywall, and third-party "mod" apps. None of them expose your safety
*logic*.

A reframing that matters: the app is **already shipped publicly as an APK**, which
anyone can decompile. Open-sourcing mainly (a) lowers the effort bar and (b) adds
explanatory comments. It does not magically reveal things a determined attacker
couldn't already extract.

---

## What you WOULD expose

### 1. A complete, annotated map of your backend API — MEDIUM
`app/lib/core/config.dart` lists **64 endpoint constants** with comments
explaining each route and its auth model (NIP-98 signed events, kind-27235, plus
an optional Clerk JWT bearer). This hands an attacker a ready-made map of your
attack surface and how auth works.
- *Mitigation already in place:* every mutation is identity-bound by a NIP-98
  signature, so attackers can "only act as themselves." Server rate-limiting is
  the real defense.
- *Caveat:* extractable from the APK today — open source just makes it trivial.

### 2. The store-review login endpoint — MEDIUM/HIGH (narrow but real)
`kReviewLoginUrl = .../api/review/login // POST {email,password} → {ticket}` is
still referenced in `config.dart`. This spotlights that a **no-OTP login path
exists** that trades email+password for a Clerk sign-in ticket. That's a juicy,
specific target for credential-guessing against the allowlisted reviewer account.
- *Fix:* remove this constant (and `kReviewerEmail`) from the open client
  entirely; keep the bypass purely server-side, hard rate-limited, with a strong
  rotating password and a server-side email allowlist.

### 3. Client-side paywall — MEDIUM (conditional, monetization)
`paid_feature.dart` gates premium Ava features (MCP tools, image/voice gen,
always-on Guardian) with a **client-side wrapper** (`PaidFeature` → checks the
wallet, then runs the action). When the client is open source, a forked/patched
build can simply delete the wrapper and call the action directly.
- **This only costs you money if the server doesn't independently enforce
  entitlement/charging.** The code points spend at `/api/wallet/spend` (WalletDO),
  which is the right place — but every paid action's *server endpoint* must
  re-verify the spend/entitlement and never trust the client gate.
- *Fix:* audit each paid feature for server-side enforcement before going public.

### 4. Feature mechanics & roadmap — LOW
Comments reveal that Guardian scanning runs on incoming messages (cheap scan +
optional always-on), that Delegate auto-replies when you're offline, the
parent/child account-scoping model, and phase-by-phase plans. Minor intel; mostly
helps a scammer *know* they might be scanned (not *how*).

---

## What you would NOT expose (your moat stays closed)

- **Guardian scam/spam/grooming DETECTION logic** — server-side
  (`POST /api/ava/guardian/scan`). The client only calls it and renders the
  verdict. The rules/model that decide "this is a scam" are **not in this repo.**
- **Delegate disclosure is server-stamped.** `worker/src/routes/ava_delegate.ts`
  wraps every delegate reply as `Ava — for <name>:` and even strips any
  client/model-supplied prefix to avoid double-disclosure. **A hostile fork cannot
  remove the "this is Ava, not the human" label** — impersonation via patched
  client is blocked at the server.
- **Money engine, ledger, anti-abuse rules, moderation** — all in the closed
  `worker/` + `consumers/`. Not in the client repo.
- **Secrets/keys** — already scrubbed to placeholders; nothing live in the repo.
- **Server-side rate limiting / fraud detection** — invisible to the client.

---

## Will it hurt your business?

| Dimension | Risk | Why |
|---|---|---|
| Core IP / moat | **Low** | The client is the UI shell; value = server logic + network effects, both closed. |
| Revenue leakage | **Medium (fixable)** | Only if paid features aren't server-enforced. Patched free-tier clients become trivial with open source. |
| Competitor copying | **Low–Medium** | A forked client is useless without your backend; a rival still has to build the entire service. Open source mostly saves them UI time. |
| Abuse / scripting | **Medium** | A clean API map makes spam, mass-DM, and directory scraping easier. Mitigated by NIP-98 identity binding + server rate limits. |
| Safety integrity (your users) | **Low** | Detection + disclosure are server-enforced; your app's users are protected regardless of forks. |
| Brand / reputation | **Medium** | Someone could ship an "AvaTOK-mod" with protections stripped. They can't use your backend or brand (trademark), but it can cause confusion. |

---

## How people could misuse it

1. **Patched forks** — strip the paywall (revenue), lie past the client-side age
   group, or disable Guardian. *Reality check:* these affect only the **fork's own
   users**, not yours. The main downside is brand confusion, not harm to your
   userbase — and the server still enforces detection, disclosure, and identity.
2. **API recon → scripted abuse** — enumerate/scrape public endpoints
   (`/api/resolve`, `/api/search`, `/api/handle/check`, `/api/communities`),
   mass-DM, or harvest the directory. Defended by server rate limits + auth.
3. **Targeting `/api/review/login`** — attempt unauthorized no-OTP access. Remove
   from the client and harden server-side.
4. **Cloning your UX** — a competitor forks the client to bootstrap a lookalike.
   Cheap to do, but worthless without rebuilding your backend.

---

## Recommendations before (or instead of) going public

1. **Remove the review-login references** (`kReviewLoginUrl`, `kReviewerEmail`)
   from the open client; keep that flow server-only and hardened.
2. **Verify server-side entitlement on every paid action** — never trust the
   client paywall. This is the single most important monetization fix.
3. **Confirm all safety-critical enforcement is server-side** — Guardian verdicts
   ✓, Delegate disclosure ✓ already; double-check moderation, age/identity
   verification, and any content gating.
4. **Rate-limit public/enumeration endpoints** server-side.
5. **Pick a license that matches your goal.** If you want "open for transparency
   but not for competitors to monetize," use a **source-available** license
   (e.g., PolyForm Noncommercial or Business Source License) instead of Apache-2.0.
   This directly answers the "people will use my code to compete / earn" worry
   while still letting you display openness.
6. **Optionally scrub intent-revealing comments** (auth nuances, the bypass) —
   or accept them as low-value to attackers.

## Verdict

Your instinct that open-sourcing would gut the safety features is **mostly
unfounded** — the detection and disclosure that protect women and children are
enforced on the server and survive even a malicious fork. The decision is really
about **monetization philosophy and fork-management appetite**, not safety-logic
leakage. If you do open it, do #1–#4 first, and strongly consider a
source-available license (#5) so "open" doesn't mean "free for competitors."
Keeping it private for now is also a perfectly reasonable default while you grow.
