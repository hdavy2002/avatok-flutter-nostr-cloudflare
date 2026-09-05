# SPEC 2026-09-05 — Three marketplace groups, sub-category blips, hourly pricing

**Owner decisions, taken 2026-09-05. This file is the CONTRACT four parallel
agents build against. Where it disagrees with an older spec, this file wins for
the areas it covers. Where an agent thinks it needs to invent something this file
does not answer, it must STOP and ask the coordinator rather than guess — the
whole point of this document is that four people do not each invent a different
taxonomy.**

Issue ids: `[MKT-3GROUP-1]` (taxonomy + marketplace), `[LIST-FORM-2]` (wizard),
`[PRICE-HOURLY-1]` (fees).

---

## 1. Three groups, not seven sections

The marketplace shows **three** top-level groups. Each renders its sub-categories
as tappable "blips" under the heading (on mobile, under the section border);
tapping a blip filters the cards below it.

| Group id | Heading on screen | What it is |
|---|---|---|
| `india_goes_live` | **India goes live** | Live streaming — one creator broadcasting, many paying viewers |
| `find_your_people` | **Find your people** | Paid human company. Real people you pay for their time — a listener, a friend to talk to. 1:1 (and small 1:many) |
| `book_their_time` | **Book their time** | Professionals — consultants, astrologers, tutors, coaches. 1:1 |

### 1.1 "Voices with character" is REMOVED

The AI voice-agent group comes off the front page and out of the marketplace.
The `ai_agent` kind stays disabled in the wizard's step 1 (it already renders as
"Coming soon"), and `ai_voice_agents` stays in the `SECTIONS` union in
`worker/src/lib/listing_section.ts` — **existing rows still carry it and deleting
the value would orphan them.** It simply maps to no group, so nothing renders it.

### 1.2 Mapping from the existing seven sections

`listings.section` already exists ([MARKET-SECTION-1], migration
`2026-08-31-listings-section.sql`). Do NOT invent a parallel column — add the
group as a *grouping of sections*, and backfill:

| Existing section | New group |
|---|---|
| `live_streaming` | `india_goes_live` |
| `live_friends` | `find_your_people` |
| `adda_rooms` | `find_your_people` |
| `consulting` | `book_their_time` |
| `astro_tarot` | `book_their_time` |
| `glow_up` | `book_their_time` |
| `ai_voice_agents` | *(none — hidden)* |

⚠️ `adda_rooms` is gated on `conferenceEnabled`, which is **`false` in production**
(verified on the live config 2026-09-05, not read from DEFAULTS). Its blip must
therefore be hidden in the marketplace, not merely empty — see
`publishBlockedReason`. A visible blip that can never have cards behind it is
indistinguishable on screen from "nobody has listed one yet", and only one of the
two is a bug.

---

## 2. Sub-categories (the blips)

Sub-category = the existing `listings.category` value. Categories live in the D1
table `listing_categories` (`id, label, emoji, active, sort`) and are served by
`GET /api/explore/categories`. **The server is the authority.** Clients ship a
static mirror ONLY as an offline fallback and must prefer the fetched list.

Add a `group_id` column to `listing_categories`. Existing service categories are
re-pointed; new ones are inserted. Marketplace-goods categories (cars, property,
mobiles, …) get `group_id = NULL` and are untouched — they are a different
product and are not part of this change.

### 2.1 India goes live

`live_cooking` Cooking 🍳 · `live_trek` Treks & hiking 🥾 · `live_puja` Puja &
darshan 🪔 · `live_temple` Temple tours 🛕 · `live_festival` Festivals 🎉 ·
`live_music` Music 🎵 · `live_dance` Dance 💃 · `live_travel` Travel & road trips
🛵 · `live_food_walk` Street food walks 🍜 · `live_fitness` Yoga & fitness 🧘 ·
`live_sports` Sports 🏏 · `live_art` Art & craft 🎨 · `live_satsang` Satsang &
sermons 📿 · `live_everyday` Everyday life ☕

### 2.2 Find your people

`listener` Listener 👂 · `home_friend` Home friend 🏠 · `late_night_friend`
Late-night friend 🌙 · `quiet_company` Quiet company 🤍 · `chat_buddy` Chat buddy
💬 · `walk_talk` Walk & talk 🚶 · `language_buddy` Language buddy 🗣️ ·
`college_friends` College circle 🎓 · `senior_company` Senior company 🌻 ·
`queer_friendly` Queer-friendly space 🏳️‍🌈 · `live_friends` Live friends 👥
*(existing)* · `adda_rooms` Adda rooms ☕ *(existing, flag-gated — hide)*

**Wording rule, from the owner: none of this may read like an adult site.** These
are paid conversations with real people. "Friend", "company", "listener",
"buddy", "circle" — never "date", "girlfriend", "boyfriend", "companion",
"intimate", or anything that pairs a person with a body part or an age.

### 2.3 Book their time

`astrologers` Astrologers 🔮 *(existing)* · `teachers` Tutors & teachers 📚
*(existing)* · `professors` Professors 🎓 *(existing)* · `business` Business &
startups 💼 *(existing)* · `money_finance` Money & finance 💰 · `career_coach`
Career coaching 🧭 · `fitness` Fitness coaching 💪 *(existing)* · `wellness`
Wellness 🧘 *(existing)* · `music` Music lessons 🎵 *(existing)* · `language`
Language lessons 🗣️ *(existing)* · `art` Art & design 🎨 *(existing)* ·
`glow_up` Style & glow-up ✨ *(existing)* · `legal_tax` Legal & tax ⚖️ ·
`tech_help` Tech help 🛠️ · `services` Other professional 🔧 *(existing)*

---

## 3. `media_mode` — audio only vs audio + video

New column: `listings.media_mode TEXT NOT NULL DEFAULT 'audio_video'`, values
`'audio_video' | 'audio_only'`. Accepted on create/edit, returned on every read
that a client renders a session from.

The creator picks it in wizard step 2. The rule the app must later enforce:

- `audio_only` → **the video control is not shown at all** while streaming or in
  a 1:1. The creator never appears on camera.
- `audio_video` → **the creator may not turn video off.** They sold a video
  session; a video session that becomes an audio one mid-way is a refund.

⚠️ **This spec only lands the FIELD** — the column, the form control, and the
value reaching the client. Wiring it into the GetStream call UI is separate work
and is NOT in scope for the agents working from this file. Do not half-wire it:
a control that reads the flag on one screen and ignores it on another is worse
than one that does not read it yet.

---

## 4. Pricing — everything is per hour

The `billing_unit` / "Charged per" dropdown is **removed from the wizard**. Every
session — live stream, audio call, 1:1 — is priced **per hour**, and a session
shorter than an hour still bills the hour.

The column `listings.billing_unit` STAYS and is written as `'hour'`. It is on the
client↔server wire and in D1; removing it breaks every shipped client that reads
it. (Same rule as the frozen `*_coins` field names in CLAUDE.md.)

### 4.1 The formula

Per participant, per hour, in tokens (1 token = ₹1):

```
FLAT      = 25      // tokens, per participant, PER HOUR
COMMISSION= 20      // percent, of what is left after the flat fee
MIN_PRICE = 49      // tokens per hour — the wizard refuses less

fee     = FLAT + round((price - FLAT) * COMMISSION / 100)
creator = price - fee
```

Worked examples to show in the form:

| Creator sets | avaTOK takes | Creator keeps |
|---|---|---|
| ₹100/hr | ₹25 + 20% of ₹75 = **₹40** | **₹60** |
| ₹49/hr (the floor) | ₹25 + 20% of ₹24 = **₹30** | **₹19** |
| ₹500/hr | ₹25 + 20% of ₹475 = **₹120** | **₹380** |

A 2-hour booking bills the flat fee **twice** (owner decision: "per 1 hour").

**The server is the authority on money.** The wizard shows the number; the
worker recomputes it. Never let a client-computed fee reach a ledger row.

### 4.2 The ₹49 floor

`MIN_PRICE` exists because at ₹25 or below the flat fee eats the entire price and
the creator earns nothing — which people would rightly file as a bug. The wizard
refuses to advance below it and says why. The server validates it too; a client
check alone is not a rule.

---

## 5. Free shows — admin only

- The "This is a free show" control is visible ONLY to an admin
  (`ADMIN_UIDS`). `freeEntryAllowlistOnly` is **`true` in production** (verified
  on the live config 2026-09-05), so the gate is already armed — if a non-admin
  is seeing the control, find out WHY before changing the gate. Candidates: the
  account is in `FREE_ENTRY_ALLOWLIST`, or a surface that never asked
  (`/api/listings/mine → free_entry_allowed` is the per-user answer).
- **The token cap is gone.** When free is selected we do NOT ask what the creator
  will spend from their wallet. Remove: the step-1 "Token cap" field, the step-3
  line that quotes it, and the step-8 checklist item "Free-show token cap is set".

---

## 6. Wizard changes, step by step

**Step 1 — Type.** Free-show control admin-only; no token cap. Otherwise as is.

**Step 2 — Pitch.** Sub-categories are **driven by the step-1 kind**:
- `live_event` → §2.1 blips only.
- `consult` → §2.2 **and** §2.3, shown as two labelled groups. The blip the
  creator picks is what files the listing into "Find your people" or "Book their
  time" — that is the owner's answer to how a 1:1 gets sorted, so the group is
  **derived from the category**, never asked separately.

Also in step 2: **remove the Vibe tags entirely**; add the `media_mode` control;
**remove the "Ava reviews your copy" panel** — the AI check happens once, at the
end.

**Step 3 — Money.** Remove "Charged per". Say the price is per hour. Show the fee
breakdown live against whatever the creator has typed, plus a worked example.
Enforce the ₹49 floor.

**Step 4 — Time.** Show only what the chosen kind needs. Live event → schedule,
start time, seats/capacity. 1:1 → availability, reply time, max bookings per
person; **no "Seats (capacity)"** (a 1:1 has one seat and asking is confusing).

**Step 8 — Preview.** Three copy changes:
1. The checklist line must read as **not done yet** until the creator clicks —
   e.g. "AI check of your listing — not run yet". Today it reads "Ava has
   reviewed the copy", which sounds like a claim that it already happened.
2. Button: **"Review my details using AI"**. When it passes, say so plainly at
   the top — checked, looks good, ready to send.
3. Submit button: **"Submit for human review"**, with small text underneath:
   *Takes 24–48 hours. We'll email you once it passes.*

---

## 7. Design does not change

The owner's words: **"The design remains the same on web and mobile, the
structure is changing."** Same zine chrome, same colours, same type stack, same
card shapes. Nobody introduces a new visual language, a new component library, or
a new colour. Web changes obey the type rules in CLAUDE.md (no negative tracking
on bold or display); app changes obey the design guard (tokens only, Phosphor
icons only — `python3 tool/check_design_guard.py --check all` must stay green,
and **do not run `--update-baseline`**).

---

## 8. Rules every agent works under

1. **Commit through the wrapper, with explicit paths**, one issue per commit:
   `python3 scripts/git_safe_commit.py "[ISSUE] msg" path/one path/two`.
   Never `git add -A`, never bare `git commit`, never `git push` — the
   coordinator pushes.
2. **Stay inside your assigned files.** Four agents share this tree. If your
   change needs a file another agent owns, say so in your report instead of
   editing it.
3. **Verify before reporting.** Worker: `npx tsc --noEmit` in `worker/`. Web:
   `./node_modules/.bin/tsc --noEmit` in `web/`. App: `flutter analyze <files>`
   plus the design guard. A green deploy is not a green typecheck.
4. **Read production before asserting anything about a flag.** `DEFAULTS` in
   `config.ts` is the bottom layer; KV sits on top.
   `curl -s -H 'Cache-Control: no-cache' "https://api.avatok.ai/api/config?cb=$RANDOM"`.
5. **Do not deploy, do not trigger a build, do not write to production KV or D1.**
   The coordinator does that with the owner watching.
6. A flag the client reads but `config.ts` does not declare is a **fake flag** and
   can never be turned off. Declare it in `PlatformConfig` AND `DEFAULTS` in the
   same change.
