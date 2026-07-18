# AI Marketplace — What We Built (plain English)

**Date:** 2026-07-18 · **Status:** all code on `main` (pushed), **nothing live yet** — every part is switched OFF behind a flag.

---

## 1. The one-paragraph version

We replaced the old "fill in a form" way of creating a listing with an **AI chat** that
interviews the seller and writes the listing for them. Underneath it, we built a proper
**category system** (property, cars, jobs, etc.), **pale marketplace cards** and **five
detail-page styles**, a **token-based fee** (5 free, then $1 each), an **expiry system**,
and an optional **memory feature** so the AI remembers a returning seller. It is all built,
tested for type-safety, and pushed — but it is **dark** (turned off), so no real user sees
any of it until you flip the switches and deploy.

---

## 2. What each piece does (in order they'd be used)

**A seller opens "Create listing" →**

1. **AI chat instead of a form.** Ava greets the seller by name, shows category buttons,
   and asks questions one at a time — "how many bedrooms?", "what's the lowest you'd
   accept?". The seller can upload photos mid-chat and paste a YouTube link. Ava writes the
   title, description and tags. The seller taps **Publish** on a review card at the end.
   *The AI can never publish on its own — a human always taps the button.*

2. **The AI can't be tricked into leaking the seller's secrets.** If the seller says "take
   $45k if you must, I'm relocating," that goes into a **private** box the AI is never even
   shown. What the AI is allowed to say, and the price floor it must respect, are separated
   and enforced in code — not by politely asking the AI to keep quiet.

3. **Price coaching.** Ava tells the seller "similar flats near you go for ₹45–60L" — but
   only when there's enough real data. With fewer than 3 comparable listings it stays quiet
   rather than making up a number.

**A buyer browses →**

4. **Pale cards.** Each listing shows as a soft, tinted card (a different gentle colour per
   type) with photo, price, favourite heart and review stars — matching the app's dark look
   without being a jarring white block.

5. **Five detail-page styles, one layout.** A property, a car, a doctor and a job seeker
   each need a different page — so the detail page changes its middle section and its
   button ("Talk to my agent" vs "Book a slot" vs "Ask anything") based on the category,
   while keeping the same top (photo/video hero, owner's AvaTOK number, QR code) and bottom
   (reviews, report button).

**Money & housekeeping →**

6. **5 free, then a token fee.** A seller gets 5 free listings; after that it's 100 tokens
   (= $1) per listing for 30 days. Built so a double-tap or a network retry can **never**
   charge twice.

7. **Expiry.** Listings last 30 days. The system quietly warns the owner 3 days before,
   hides it when it expires, and tidies it away after 30 more days. Renewing is just paying
   again.

8. **The AI remembers returning sellers** (optional). If turned on, Ava can say "welcome
   back, you've posted 3 before." Its access is deliberately fenced: it can see the seller's
   *own listing history only* — never their chats, wallet, or contacts.

---

## 3. Two live problems we fixed along the way (not part of the plan)

- **A hidden marketplace was wide open in production.** An older "AvaOLX" listings feature
  had **no on/off switch and no content checking** — anyone could post unmoderated public
  text. We added both.
- **The identity check couldn't be turned off, and a child-safety check failed the wrong
  way.** Fixed both (these were the Guardian safety items).

---

## 4. What is DARK (built, but switched OFF)

Nothing below reaches a real user until you turn it on. Each is a single switch (a "flag"
in KV), and the safe order is **staging first, then production**.

| Switch | What turning it ON does |
|---|---|
| `marketplaceEnabled` | Makes the marketplace visible at all |
| `aiComposeEnabled` | Turns on the AI chat for creating listings |
| `olxEnabled` | The old OLX surface (now moderated) |
| `listingFeeEnabled` | Starts charging for listings beyond the free 5 |
| `listingBrainEnrichmentEnabled` | Lets the AI remember returning sellers |

There is also a **beta-free-everything** switch already on, which means **even if you turn
the fee on, nobody is charged** until you also turn beta-free off. So money is double-locked.

---

## 5. What is PENDING (deliberately not built)

- **"Talk to my agent" as a live back-and-forth conversation.** Right now the buyer's
  agent chat is the older one-shot version. The full multi-turn version was **deferred** by
  you (it's Phase 4).
- **The dating / matrimony marketplace ("Connect").** The structure is in place (it's built
  to be a second section in the same app), but **no dating categories are switched on** and
  it is **unscheduled** — it needs an age-check, child-safety image scanning, and a legal
  review of the content rules before it can ship. That was your call and it stands.

---

## 6. What still needs doing to get it FULLY WORKING

These are the steps between "code is on main" and "a real seller creates a listing." None
are large, but they are real.

1. **Run the database changes.** We added new tables and columns (categories, listing
   details, entitlements, compose sessions). These need to be applied to the database —
   **staging first, then production** — using the guarded scripts we wrote. (Production
   already has some of them from earlier hand-edits; the scripts are written to skip what's
   already there and only add what's missing.)

2. **Deploy the server.** The code is on `main` but production still runs the *old* server.
   A deploy is needed. **Important:** this same branch also contains a large, separate
   project (the "AvaBrain" AI rewrite by another workstream). We recommend **deploying and
   checking that separately** from the marketplace, because it changes how *every* AI call
   in the app works — much bigger blast radius than our dark-by-default marketplace.

3. **Flip the switches, in order, on staging.** Turn on `marketplaceEnabled`, then
   `aiComposeEnabled`, test creating a real listing end-to-end, then the rest. Only move to
   production once staging looks right.

4. **Before charging anyone: set up Play billing.** To actually take money on Android, a
   Google service account (`PLAY_SERVICE_ACCOUNT_JSON`) must be configured — otherwise the
   token top-up fails and you'd have a paywall with no way to pay. This is a setup task, not
   code.

5. **Build the app (APK/AAB) and ship it.** The Flutter (phone app) side — the AI chat
   screen, the new cards, the detail pages — only reaches phones through a normal app build,
   which you trigger manually. *We did not trigger any build.*

6. **One small gap:** the QR code on a listing shows and shares fine, but scanning it won't
   *open* the listing yet — the app needs a small deep-link handler added (`/l/<id>`).

---

## 7. One thing worth fixing regardless (a standing risk we found)

**The server has no type-checking in its release process.** There's a check script, but no
automated step runs it, and the deploy tool strips types without looking at them. We found
**~24 pre-existing errors that have been shipping to production invisibly** — including a
real duplicated-import bug. We caught every one of *our own* mistakes only by running the
check by hand each step. **Wiring that one check into CI is probably the highest-value hour
available**, and it protects everything, not just the marketplace.

---

## 8. Scoreboard

| Phase | What | State |
|---|---|---|
| 0A | Foundations (fix drift, real kill switches, delete dead phone code) | ✅ on main |
| 0B | Guardian safety fixes (2 live bugs) | ✅ on main |
| 1 | Category engine (property/cars/jobs…, two "verticals") | ✅ on main |
| 2 | AI compose chat | ✅ on main |
| 3 | Buyer surfaces (pale cards + 5 detail pages) | ✅ on main |
| 5 | Money (5 free, token fee, expiry) | ✅ on main |
| 6 | AI memory of returning sellers | ✅ on main |
| 4 | Live multi-turn buyer↔agent chat | ⏸ deferred (your call) |
| C | Dating / matrimony ("Connect") | ⏸ unscheduled (needs age + CSAM + legal) |

**Everything shippable is shipped to `main` and dark. The remaining work is turning it on,
deploying, and the app build — not more building.**
