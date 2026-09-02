# SPEC 2026-09-02 — What a buyer needs to see before he pays, per listing type, in our vibe

Companion to `Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md` (the data
model and sequence). This file answers one question from the **customer's
seat**: *"Why should I trust this stranger with ₹149 of my wallet?"* — and then
says how each answer shows up on the card and the page, for each listing type,
in the site's voice.

Audience: Indian Gen-Z, Hinglish, desi + Gen-Z slang, trucker-art energy,
regional pride (UP, Bihar, Punjab, Bengal, Gujarat…). Voice is in §5. Rule
zero: **every badge is earned from data. Nothing is faked to look full.**
A fake ✓ is the fastest way to lose this audience.

---

## 1. The trust ladder — what actually makes a Gen-Z buyer press BOOK

In the order a buyer's eye checks it. Each row says where the data comes from.
"Derived" = computed, never a form field.

| # | Buyer's question | What we show | Source |
|---|---|---|---|
| 1 | Is this a real person? | **✓ Verified** (KYC), **phone-verified**, AvaTOK number, "on avaTOK since Mar 2026" | `kyc_verified`, `users.created_at`, `avatok_numbers` |
| 2 | Has he done this before? | **Shows hosted**, **hours live**, **regulars** (followers), **first show / veteran** | derived from `commercial_sessions`, `creator_follows` |
| 3 | Does he show up? | **On-time %**, **cancel rate**, **"never cancelled"** badge | derived from sessions vs `starts_at`; cancellations |
| 4 | Do people come back? | **Come-back %** ("♡ 96% wapas aate hain") | derived: repeat buyers / total buyers |
| 5 | What do people say? | Stars + count, **rating histogram**, **reviews with body**, **"Verified attendee"** flag, **host reply**, **helpful votes**, **photos**, newest-first | `reviews` + new columns (§4) |
| 6 | Who else is going? | **"12 booked in last 24h"**, **seats left**, **watching now**, **"2 people you follow booked"** | derived |
| 7 | What exactly do I get? | **What you get** (3–5 bullets), **who it's for / not for**, duration, group size, language, recording included?, replay window | new `attrs` (§4) |
| 8 | What does it cost, really? | **Price breakdown** (price · early-bird · promo · platform fee shown as ₹0 to buyer), **billing unit**, "no hidden charges" | existing + `billing_unit` |
| 9 | Can I get my money back? | **Refund window**, **cancel window**, reschedule allowed, **"paisa escrow mein, session khatam tak"** (the AvaTOK guarantee) | commercial policy attrs (exist) |
| 10 | Is it safe? | **18+**, **Safe space / women-only / cam optional**, "your real number is never shown", **Report** and **Block** on every page | `adults_only`, `vibe_tags`, number masking |
| 11 | Can I preview it? | **Trailer video**, **3 highlight clips** from past sessions, **sample voice** (AI), **sample Q&A** (consult) | `video_url` + new `listing_highlights` (§4) |
| 12 | When and how do I join? | Countdown, **my timezone + host's**, "link 15 min pehle", device needs (mic / cam / just listen), **add to calendar**, WhatsApp reminder opt-in | `timezone`, `content_join_lead_minutes`, new `join_requirements` |
| 13 | Will I miss it? | **Early-bird ends in…**, **seats left bar**, **"last 3 shows sold out"** | derived |
| 14 | Any questions? | **FAQ** (3–6, pre-filled per category), **Ask the host** (text message, rate-limited) | new `content_faq` attrs |
| 15 | Can I share it? | Share card, **QR**, **WhatsApp share** as the first button, copy link | exists (`/l/`, OG) |

The single most important addition is row 5's **"Verified attendee"**. A review
from someone who actually held an entitlement is the whole difference between
our reviews and Instagram comments.

---

## 2. Card anatomy — per listing type

All cards share the frame from the bazaar comp (photo band, status pill, stub
row, title·price, blurb, 2 chips, host line, bottom-right cadence). What differs
is what goes in the slots. **The type decides the slot contents; the creator
never picks chips.**

### 2.1 Live show (1 : many, ticketed)

- **Pill:** `FRI 9 PM` · `LIVE · 340 DEKH RAHE` · `TONIGHT` · `SOLD OUT` · `NEW`
- **Stubs:** category · language
- **Chip 1:** regulars (`♡ 300 REGULARS`) → else shows hosted (`✓ 120 SHOWS`) → else `PEHLA SHOW` (first show — honest, and Gen-Z likes being early)
- **Chip 2:** `★ 4.9 · 620` → else seats left when ≤ 20% (`🔥 8 SEATS BAAKI`) → else early-bird (`EARLY BIRD −20%`)
- **Bottom-right:** `90 MIN`
- **Buttons:** `BOOK NOW` · `DETAILS`
- **Hover/long-press:** trailer autoplays muted if `video_url`

### 2.2 1 : 1 consult (calendar slots)

- **Pill:** `NEXT MON 11 AM` (earliest open slot) · `AVAILABLE NOW` · `ON REQUEST` · `FULL THIS WEEK`
- **Stubs:** specialty (`TAX & MONEY`) · language
- **Chip 1:** `⚡ 10 MIN RESPONSE` → else `✓ 600 SESSIONS` → else `NEW EXPERT`
- **Chip 2:** `★ 4.9 · 210` → else `♡ 96% WAPAS AATE HAIN` → else `NEVER CANCELLED`
- **Bottom-right:** `45 MIN` or `₹19 / 10 MIN` when `billing_unit=10min`
- **Buttons:** `BOOK SLOT` · `DETAILS` (the calendar icon replaces BOOK NOW)
- **Extra line under host:** credential one-liner if present (`CA · 8 YRS`) — new `credential` field, shown only after KYC

### 2.3 AI voice agent (always on)

- **Pill:** `ALWAYS ON` · `24/7` — plus a tiny pulsing dot; **never** a time
- **Stubs:** persona type (`AI CLONE` / `STUDY BUDDY` / `BESTIE`) · language
- **Chip 1:** `⚡ INSTANT` (always, it's true) → `🧠 YAAD RAKHTA HAI` when memory on
- **Chip 2:** `♡ 12K CHATS` → else `★ 4.7 · 90` → else `NAYA AGENT`
- **Bottom-right:** `PER 10 MIN` / `PER CHAT` / `PER NIGHT`
- **Buttons:** `▶ SUNO` (30-sec sample voice, inline) · `TALK NOW`
- **Host line:** `Riya Dutta AI` with an **AI badge**, never a KYC ✓ on the agent — the ✓ belongs to the human creator behind it, shown on the page

### 2.4 Free session (creator pays)

- **Pill:** normal time pill; add a **`FREE` ribbon** across the photo corner in the marigold stripe
- **Chip 1:** `🎟 40 SPOTS BAAKI` (cap-derived) → `FULL`
- **Chip 2:** `♡ 300 REGULARS` → `★` → `PEHLA SHOW`
- **Buttons:** `RESERVE · FREE` · `DETAILS`
- Free cards **never** show a price in the title

### 2.5 Group room / adda (1 : few, recurring)

- **Pill:** `DAILY 6 PM` · `MATCH DAYS` · `MORNINGS 7 AM` (recurrence-derived)
- **Chip 1:** `✓ 1.2K TALKS` → `LISTENER FIRST`/`SAFE SPACE` (vibe tag)
- **Chip 2:** `★` → `♡ COME BACK %`
- **Bottom-right:** `20 MIN` · `PER NIGHT`

---

## 3. Details page anatomy — per listing type

Shared spine (comp order): hero → title block → sticky booking box → how it
works → meet the host → house rules → reviews → promises → browse more.
Type-specific sections are inserted where marked. **Empty section = hidden.**

### 3.1 Live show

1. **Hero:** gallery + trailer; if live, the **player itself** with viewer count and a `JOIN · ₹49` overlay (mid-stream buy path already works)
2. **Title block:** title · blurb · host line (✓, regulars, shows hosted) · ★ · language · duration · group size
3. **Booking box:** countdown · seats bar (`52 / 60 booked`) · qty (≤ `max_per_booking`) · early-bird timer · price breakdown · `BOOK NOW` · "link 15 min pehle" · timezone pair
4. **What you get / Who it's for** — new
5. **How it works** (JOIN / SING / WIN)
6. **Highlights** — 3 clips from past sessions — new
7. **Meet the host** — bio, stats grid (shows · hours live · on-time % · come-back %), other listings
8. **House rules**
9. **Reviews** — histogram, verified-attendee filter, host replies, photos
10. **FAQ** — new
11. **Promises band** — refund/cancel/escrow/number-masking, trucker-plate style
12. **Past sessions** — dates, attendance, "sold out" marks — new, derived
13. **Share** — WhatsApp first, QR, copy

### 3.2 1 : 1 consult (**not in the comp — designed here**)

1. **Hero:** creator portrait large, intro video; no gallery grid
2. **Title block:** specialty · credential line · languages · ★ · **response time** · sessions done
3. **Booking box:** **slot picker** (7-day strip → times in buyer's zone), duration options if multiple, `BOOK ₹349` · "reschedule free till X" · booking notice ("book 12h ahead")
4. **What we'll cover / Bring with you** (prep instructions, exists) — shown high
5. **Sample Q&A** — 3 Q→A pairs the expert wrote — new
6. **Meet the expert** — bio, stats (sessions · on-time · come-back · avg rating), **"Ask a question first"** (free text, 1 per user per listing)
7. **Reviews** — verified-attendee only by default
8. **FAQ** · **Promises band** · Share

No seat quantity, no recurring-dot calendar, no house rules unless filled.

### 3.3 AI voice agent (**not in the comp — designed here**)

1. **Hero:** persona art, **▶ 30-sec sample voice** front and centre, `ALWAYS ON` dot
2. **Title block:** persona name · **AI badge** · "made by Riya Dutta ✓" (human, KYC) · languages · `PER 10 MIN`
3. **Booking box:** `TALK NOW` · `CHAT NOW` · balance shown (`₹120 in wallet ≈ 60 min`) · "billed per minute, stop anytime" · memory toggle explanation
4. **What she can do / can't do** — 3 + 3 bullets (honesty band; Gen-Z sniff out over-promising) — new
5. **Sample conversation** — 4-line transcript — new
6. **Meet the creator** — the human's stats + other agents
7. **Reviews** (chat count replaces attendee count)
8. **Safety band** — "AI, not a human", 18+ if set, data/memory policy
9. Share

### 3.4 Free session

Same as 3.1 with: `FREE` ribbon on hero, booking box says `RESERVE MY SPOT ·
FREE` + `40 spots baaki`, price breakdown replaced by **"Host is paying for
this one — say thanks by showing up"** (no-show shaming lite: a reserved seat
that never joins reduces the buyer's future free-reservation priority).

---

## 4. Data this needs beyond the main spec

### 4.1 `reviews` — make them trustworthy

```sql
-- worker/migrations/2026-09-02-reviews-trust.sql
ALTER TABLE reviews ADD COLUMN verified_attendee INTEGER NOT NULL DEFAULT 0; -- set from entitlement at write time
ALTER TABLE reviews ADD COLUMN creator_reply TEXT;
ALTER TABLE reviews ADD COLUMN creator_reply_at INTEGER;
ALTER TABLE reviews ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN photo_keys TEXT;                             -- JSON, ≤3 R2 keys
CREATE TABLE IF NOT EXISTS review_helpful (review_id TEXT, user_id TEXT, created_at INTEGER, PRIMARY KEY(review_id,user_id));
```

Only holders of a finished entitlement can review; the flag is computed
server-side, never posted by the client.

### 4.2 `creator_stats` — derived, cached

A worker cron (or on-write refresh) fills one row per creator:
`shows_hosted, hours_live, on_time_pct, cancel_rate, comeback_pct,
avg_response_min, sessions_done, last_sold_out_count, first_session_at`.
Cards and pages read this row; nothing computes on request.

### 4.3 New `attrs` keys (details page only)

| key | shape | limit |
|---|---|---|
| `content_what_you_get` | string[] | 3–5, ≤ 80 each |
| `content_who_for` / `content_not_for` | string[] | ≤ 3 each, ≤ 80 |
| `content_faq` | `[{q,a}]` | 3–6; q ≤ 120, a ≤ 300 |
| `content_sample_qa` | `[{q,a}]` | consult, ≤ 3 |
| `content_sample_chat` | `[{who,line}]` | AI, ≤ 6 lines |
| `content_can_do` / `content_cant_do` | string[] | AI, 3 each |
| `join_requirements` | `{mic,cam,listen_only,replay_days,recording}` | — |
| `credential` | string | consult, ≤ 40, shown only when KYC ✓ |

### 4.4 `listing_highlights`

`(id, listing_id, session_id, r2_key, thumb_key, duration_s, sort, created_at)`
— ≤ 3 per listing, cut by the creator from a recorded session or uploaded.
Also serves the AI **sample voice** (`duration_s ≤ 30`, `kind='voice'`).

### 4.5 "Ask the host" — the pre-purchase question

One text question per user per listing, routed to the creator's inbox, answer
shown to the asker only; creator can promote a Q→A pair into `content_faq`
with one tap. Rate-limited; no links; no numbers (masking rule).

### 4.6 Signals we deliberately do NOT show

- Buyer names or avatars on "who's going" — first names + count only, opt-in.
- Revenue, price history, or "creator earns ₹X".
- Raw review count on the card if `< 3` — show `NEW` instead of `★ 5.0 · 1`.

---

## 5. Voice and vibe — one dictionary, not sprinkled strings

All user-facing copy for cards, pills, chips, CTAs, empty states and badges
lives in **one file per surface** (`web/src/lib/copy.ts`,
`app/lib/core/copy.dart`) so the voice is consistent and editable in one place.
Hinglish in Latin script. Rules:

- **Slang is garnish, not the sentence.** The fact stays plain (`8 seats left`),
  the flavour rides on it (`8 SEATS BAAKI 🔥`). A buyer must never have to
  decode a joke to learn the price.
- **Regional = pride, never punchline.** UP/Bihar/Punjab/Bengal flavour comes
  from creator-chosen **vibe and language tags** (`BHOJPURI`, `PATNA WALA`,
  `LUCKNOWI TEHZEEB`) and from copy that celebrates, not mocks. No stereotypes
  in platform copy; creators own their own jokes inside their listing.
- **Trucker-art motifs** carry the trust layer: the promises band is a number
  plate (`HORN OK · PAISA SAFE`), the guarantee is a `PAKKA` stamp, the
  house-rules box is a painted board, sold-out is a `FULL HO GAYA` stencil.
- **Badge names** (earned, data-backed):
  `PEHLA SHOW` (first show) · `PAKKA HOST` (on-time ≥ 95%, ≥ 10 shows) ·
  `WAPSI KING/QUEEN` (come-back ≥ 80%) · `BAWAAL` (sold out ≥ 3) ·
  `SEEDHI BAAT` (≥ 50 verified reviews, ≥ 4.7) · `JALDI JAWAB` (response ≤ 15 min).
- **CTA labels:** `BOOK NOW` · `BOOK SLOT` · `TALK NOW` · `RESERVE · FREE` ·
  `▶ SUNO` · `SHARE ON WHATSAPP`. Keep the verb English; flavour goes in the
  micro-copy under it (`link 15 min pehle aayega`).
- **Empty states** stay honest and warm: `Abhi koi review nahi — pehla tum
  likho?` never a fake 5.0.
- **Numbers, money, time are always plain** (`₹149`, `FRI 9 PM IST`).

---

## 6. Where this plugs into the main sequence

| Main-spec step | Add from this file |
|---|---|
| 1 Server fields | §4.1 reviews migration, §4.3 attrs + validator, `credential`, `creator_stats` table |
| 2 Seed | seed reviews (verified + unverified), highlights, FAQ, sample voice for the AI row |
| 4 Cards | §2 per-type slot rules, badges from `creator_stats`, `FREE` ribbon, `▶ SUNO` |
| 5 Page | §3 four layouts, hide-when-empty, promises band, share block |
| 6 Form | steps for what-you-get / who-for / FAQ / sample Q&A / can-can't / highlights, all pre-filled per category |
| 7 Free lane | no-show priority rule (§3.4) |
| new 5b `[LIST-REVIEW-2]` | verified-attendee gating, host reply, helpful votes, photos |
| new 5c `[LIST-ASK-1]` | Ask the host |
| new 4b `[LIST-STATS-1]` | `creator_stats` refresh + badge rules |

Success values: a seeded live listing renders every row of §1 that has data;
a review posted by a non-attendee is rejected with 403; a badge appears only
when its rule is met and disappears when it is not.
