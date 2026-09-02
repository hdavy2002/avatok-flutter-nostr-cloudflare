#!/usr/bin/env python3
"""
seed_listings.py — generate ONE SQL file of demo listing data so the listing
card + details page can be judged against real, fully-populated rows.

Plain python3. No pip deps. Does NOT touch any database itself — it only
WRITES a .sql file. The lead applies it by hand via:

    scripts/cf.sh worker d1 execute DB_META --remote --file=<out.sql>

Schemas this was written against (read, not guessed):
  worker/migrations/listings.sql                         (listings, reviews,
                                                            creator_profiles,
                                                            listing_promotions)
  worker/migrations/2026-07-18-listings-taxonomy-columns.sql (vertical, attrs,
                                                            video_url, cat_version,
                                                            playbook_version,
                                                            template_version,
                                                            proposed_category)
  worker/migrations/2026-08-31-listings-section.sql       (section)
  worker/migrations/2026-09-02-listings-content.sql       (blurb, slug,
                                                            schedule_mode,
                                                            recurrence_days/time,
                                                            timezone, billing_unit,
                                                            free_entry,
                                                            max_per_booking,
                                                            response_time_min,
                                                            vibe_tags, credential)
  worker/migrations/2026-09-02-listing-slots.sql           (listing_slots)
  worker/migrations/2026-09-02-reviews-trust.sql           (verified_attendee,
                                                            creator_reply(_at),
                                                            helpful_count,
                                                            photo_keys, review_helpful)
  worker/migrations/2026-09-02-creator-stats.sql           (creator_stats,
                                                            listing_highlights,
                                                            listing_questions)
  worker/migrations/phase8_verse.sql                       (reviews.reply/reply_at
                                                            — legacy columns the
                                                            reviews route dual-writes
                                                            alongside creator_reply)
  worker/migrations/cfnative.sql                           (users)

  worker/src/routes/listings.ts                            (createListing INSERT,
                                                            normFields, encodeAttrs,
                                                            commercialPolicyError,
                                                            contentAttrsError,
                                                            CARD_SELECT, KINDS,
                                                            SCHEDULE_MODES,
                                                            BILLING_UNITS, VIBE_TAGS)
  worker/src/lib/listing_section.ts                        (sectionFor — kind
                                                            'ai_agent' -> section
                                                            'ai_voice_agents')
  worker/src/routes/reviews.ts                              (dual-write of
                                                            reply/reply_at +
                                                            creator_reply(_at))

IMPORTANT — the "AI kind" gap (read this before assuming seed-ai-1 is API-reachable):
  `worker/src/routes/listings.ts:69` KINDS = {live_event, consult, sell, buy,
  social}. There is NO 'ai_agent' (or 'agent*') value a caller can POST through
  createListing today — it is rejected with 400 "kind must be
  live_event|consult|sell|buy|social" before anything else runs. The
  agent_instructions/agent_lang/agent_voice_persona columns and the
  `sectionFor()` rule that maps kind 'ai_agent' -> section 'ai_voice_agents'
  both exist and are wired to be READ, but nothing in the shipped API can WRITE
  that kind. This script writes kind='ai_agent' directly via raw SQL (bypassing
  the API entirely, which is exactly what a seed script is for), so the seeded
  row will render if the card/page code branches on kind/section, but note for
  the owner: a REAL creator cannot produce this row through the app or web
  today. That gap is a product decision, not something this script can or
  should paper over.

USAGE
  python3 scripts/seed_listings.py --creator-uid <uid> --out /tmp/seed.sql
  python3 scripts/seed_listings.py --creator-uid <uid> --out /tmp/seed.sql --prefix seed- --handle <handle>
  python3 scripts/seed_listings.py --creator-uid <uid> --check
  python3 scripts/seed_listings.py --wipe --out /tmp/wipe.sql [--prefix seed-]

IDEMPOTENT BY CONSTRUCTION
  - Every id is deterministic: <prefix>live-1, <prefix>live-recurring-1,
    <prefix>consult-1, <prefix>ai-1, <prefix>free-1, plus <prefix>user-1..8 for
    review authors, <prefix>review-<listing>-<n>, <prefix>slot-<n>,
    <prefix>promo-<n>, <prefix>highlight-<n>.
  - The very first statements in the (non---wipe) output are
    `DELETE ... WHERE id LIKE '<prefix>%'` / the matching FK-column LIKE
    against every table this script writes, so re-running the script and
    re-applying the file REPLACES rather than duplicates.
  - Every subsequent write is `INSERT OR REPLACE` (or `INSERT OR IGNORE` +
    conditional `UPDATE` for creator_profiles, which must never clobber a real
    creator's existing bio).
"""

import argparse
import json
import sys
import time
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# SQL helpers — no sqlite3 module needed; this only ever WRITES a .sql text
# file, it never opens a database connection.
# ---------------------------------------------------------------------------

def esc(s):
    """SQLite/D1 single-quote string literal escaping."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def num(n):
    if n is None:
        return "NULL"
    return str(n)


def js(obj):
    """JSON-encode a python object into a SQL string literal, or NULL."""
    if obj is None:
        return "NULL"
    return esc(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def boolint(b):
    return "1" if b else "0"


# ---------------------------------------------------------------------------
# Statement collector — tracks tables touched for --check.
# ---------------------------------------------------------------------------

@dataclass
class Builder:
    statements: list = field(default_factory=list)
    tables: set = field(default_factory=set)

    def add(self, table, sql):
        self.tables.add(table)
        self.statements.append(sql.strip().rstrip(";") + ";")

    def raw(self, sql):
        """A statement not attributable to one table (e.g. a comment)."""
        self.statements.append(sql)


# ---------------------------------------------------------------------------
# Constants mirrored from worker/src/routes/listings.ts — kept in sync by hand
# since this script has no way to import TypeScript. If the server-side sets
# change, update these too.
# ---------------------------------------------------------------------------

VALID_SCHEDULE_MODES = {"fixed_date", "recurring", "on_request", "always_on"}
VALID_BILLING_UNITS = {"session", "minute", "10min", "chat", "night", "game"}
VALID_VIBE_TAGS = {
    "safe_space", "cam_optional", "listener_first", "savage",
    "beginner_ok", "queer_friendly", "women_only",
}
COMMERCIAL_REFUND_WINDOWS = {0, 12, 24, 48}
COMMERCIAL_BOOKING_NOTICE_HOURS = {1, 2, 6, 24}

DAY_MS = 24 * 60 * 60 * 1000
HOUR_MS = 60 * 60 * 1000
MIN_MS = 60 * 1000

# IST is UTC+5:30, fixed offset (India does not observe DST).
IST_OFFSET_MS = (5 * 60 + 30) * MIN_MS


def ist_epoch_ms(days_from_now, hour, minute, now_ms):
    """Epoch ms (UTC) for `hour:minute` IST, `days_from_now` days after the UTC
    calendar day of `now_ms`. Good enough for demo data — not a full tz lib."""
    day_start_utc = (now_ms // DAY_MS) * DAY_MS
    target_utc_midnight = day_start_utc + days_from_now * DAY_MS
    # hour:minute IST expressed as UTC: subtract the IST offset.
    return target_utc_midnight + hour * HOUR_MS + minute * MIN_MS - IST_OFFSET_MS


# ---------------------------------------------------------------------------
# Content blocks (attrs JSON) — Hinglish copy per spec §5: slang is garnish,
# the fact stays plain; regional flavour is pride not punchline; no real
# people are named anywhere below.
# ---------------------------------------------------------------------------

def house_rules_music():
    return [
        {"heading": "Mic on to sing", "body": "Jab tumhari baari aaye, mic unmute karo — warna line miss ho jayegi."},
        {"heading": "Ek gaana, sabka mauka", "body": "Har singer ko ek full song — dobara turn tab hi jab list khatam ho."},
        {"heading": "Requests welcome", "body": "Chat mein gaana maango, but the host picks the order — patience rakho."},
        {"heading": "Recording ON", "body": "Session record hota hai replay ke liye — bolna mat chaho toh camera off rakho."},
        {"heading": "No spam links", "body": "Chat sirf gaane aur requests ke liye — links/ads bhejne pe turant remove."},
        {"heading": "Respect the stage", "body": "Achha ya bura, sabko suno — booing allowed nahi, yeh adda hai, judgment nahi."},
    ]


def house_rules_intro_music():
    return "Ek chhota sa jam hai, dilse gaate hain — thodi tehzeeb, bahut masti."


def how_it_works_live():
    return [
        {"label": "JOIN", "body": "Link 15 min pehle aayega — waiting room mein aake apna mic/cam check kar lo."},
        {"label": "SING", "body": "Baari aane pe host bulayega — apna favourite antra ready rakho."},
        {"label": "WIN", "body": "Sabse zyada vaah-vaahi paane wale ko agla slot pehle milta hai."},
    ]


def what_you_get_music():
    return [
        "90 minute ka live open-mic jam, host ke saath",
        "Apna gaana perform karne ka pakka slot",
        "Session replay 7 din tak dekhne ko milega",
        "Beginners ke liye tips seedha chat mein",
    ]


def who_for_music():
    return ["Ghar ke bathroom singers", "Wapis stage pe aana chahte ho", "Bas suno, chill karo"]


def not_for_music():
    return ["Professional audition dhoondh rahe ho", "Judgment se dar lagta hai"]


def faq_music():
    return [
        {"q": "Mujhe gaana nahi aata, phir bhi aa sakta hoon?", "a": "Bilkul — listen-only mode hai, bas mic band rakhna. Vibe lene ke liye sabka swagat hai."},
        {"q": "Recording milegi kya?", "a": "Haan, session ka replay 7 din ke liye available rahega — link email pe aayega."},
        {"q": "Refund kaise hoga agar main nahi aa paaya?", "a": "48 ghante pehle cancel karo toh full refund, uske baad token hold rahega."},
        {"q": "Kya harmonium/instrument chahiye?", "a": "Nahi, sirf apni awaaz aur thoda confidence — baaki hum sambhal lenge."},
    ]


def join_requirements_music():
    return {"mic": True, "cam": False, "listen_only": True, "recording": True, "replay_days": 7}


def house_rules_qa():
    return [
        {"heading": "Documents ready rakho", "body": "ITR, Form 16 ya jo bhi discuss karna hai, PDF mein pehle se scan karke rakho."},
        {"heading": "45 min ki call", "body": "Time seedha bachat aur planning pe jaata hai — chhoti baatein baad mein."},
        {"heading": "No legal advice", "body": "Yeh tax/finance guidance hai, court-level legal opinion nahi — uske liye lawyer chahiye."},
        {"heading": "Reschedule allowed", "body": "24 ghante pehle bata do, naya slot mil jayega — last-minute cancel pe charge lagega."},
        {"heading": "Privacy pakka", "body": "Tumhare numbers kisi aur ke saath share nahi hote — session sirf tumhare liye hai."},
    ]


def house_rules_intro_qa():
    return "Financial planning ho ya tax ka jhanjhat — seedhi baat, koi jargon nahi."


def sample_qa_finance():
    return [
        {"q": "Section 80C mein kitna bachaa sakta hoon?", "a": "Abhi ke rules mein ₹1.5 lakh tak — PPF, ELSS, insurance sab mila ke."},
        {"q": "Freelance income pe tax kaise file karein?", "a": "Presumptive taxation (44ADA) se kaafi kaam aasan ho jaata hai — session mein dikhata hoon."},
        {"q": "Old vs new tax regime — kaunsa better hai?", "a": "Depends on deductions — apni salary slip lao, live calculate karke dikhaunga."},
    ]


def prep_instructions_qa():
    return "Pichle saal ka Form 16/ITR aur current salary slip PDF mein ready rakhna — session usi pe based hoga."


def credential_qa():
    return "CA · 8 yrs"


def can_do_ai():
    return [
        "Astro chart padhke career/relationship guidance dena",
        "Daily panchang aur shubh muhurat batana",
        "Hindi + English dono mein baat karna",
    ]


def cant_do_ai():
    return [
        "Medical ya legal advice dena",
        "Guaranteed future predictions karna",
        "Paisa/lottery number batana",
    ]


def sample_chat_ai():
    return [
        {"who": "User", "line": "Mera career kab better hoga?"},
        {"who": "Agent", "line": "Tumhari Saturn dasha 2027 mein khatam ho rahi hai — uske baad growth strong dikh rahi hai."},
        {"who": "User", "line": "Aaj ka din kaisa hai?"},
        {"who": "Agent", "line": "Subah 11 se 1 tak kaam ke liye shubh hai — important calls usi window mein karo."},
    ]


def house_rules_free():
    return [
        {"heading": "FREE hai, seat pakki karo", "body": "Entry free hai but seat limited — no-show pe agli baar priority kat jaayegi."},
        {"heading": "Time pe aana", "body": "Session 2 din baad 21:00 IST shuru — 10 min late aane pe entry mushkil ho sakti hai."},
        {"heading": "Respect sabka", "body": "Yeh open jam hai — trolling ya spam turant remove ki wajah banega."},
        {"heading": "Recording hoga", "body": "Highlights baad mein platform pe share ho sakte hain — camera on rehna optional hai."},
        {"heading": "Ek profile, ek seat", "body": "Multiple accounts se seat block karna allowed nahi — fair rahega sabke liye."},
        {"heading": "Feedback do", "body": "Session ke baad ek review chhod do — agla batch aur behtar banega."},
    ]


def house_rules_intro_free():
    return "Bilkul free entry — bas seat waste mat karna, kisi aur ka mauka ban sakta tha."


def faq_free():
    return [
        {"q": "Yeh sach mein free hai?", "a": "Haan, entry pe koi charge nahi — host ne cap already token se hold kar rakha hai."},
        {"q": "Seat kaise pakki karoon?", "a": "RESERVE FREE button dabao — instant confirm ho jaata hai, koi payment nahi maanga jaata."},
        {"q": "Kya limited seats hain?", "a": "Haan, 40 seats total — full hote hi waitlist khul jaayegi."},
        {"q": "Replay milega?", "a": "Haan, session ke highlights baad mein listing page pe daale jaayenge."},
    ]


def what_you_get_free():
    return [
        "90 minute ka free live jam session",
        "Open mic slot — chahe toh gaao, chahe suno",
        "Beginner-friendly, zero pressure vibe",
        "Session highlights baad mein listing pe milenge",
    ]


def who_for_free():
    return ["Bina kharcha kiye try karna chahte ho", "Community vibe pasand hai"]


def not_for_free():
    return ["Guaranteed 1:1 attention chahiye"]


REVIEW_BODIES_MUSIC = [
    "Bhai session mast tha, host ne sabko chance diya gaane ka. Full paisa vasool!",
    "Pehli baar mic pe gaaya, itna comfortable mahaul tha ki dar hi nahi laga.",
    "Timing thodi late shuru hui but baaki sab smooth tha. Dobara aaunga.",
    "Host ka energy zabardast hai — Bihar wali josh dikhi poore session mein.",
    "Replay link time pe mil gaya, quality bhi acchi thi.",
    "Beginner ke liye perfect jagah — koi judge nahi karta yahan.",
    "Thoda aur time chahiye tha per session, warna sab top notch.",
    "Sound thoda garbled tha beech mein but host ne turant fix kar diya.",
]

REVIEW_BODIES_QA = [
    "CA saab ne 15 min mein wahi cheez samjha di jo mahino se confuse thi.",
    "Bahut clear advice mila, seedha kaam ki baat — time waste nahi hua.",
    "Documents pehle se maangna acchi baat hai, session focused raha.",
    "Thoda rushed laga end mein, but overall solid guidance.",
    "Old vs new regime wala doubt clear ho gaya, dhanyavaad!",
    "Professional aur punctual — exactly jo chahiye tha.",
    "Reschedule bhi bina jhanjhat ke ho gaya, achha experience raha.",
    "Follow-up questions ka bhi jawab mil gaya chat mein baad mein.",
]

REVIEW_BODIES_FREE = [
    "Free hoke bhi itna organized session — respect!",
    "Seat mil gayi turant, koi payment jhanjhat nahi.",
    "Full ho gaya jaldi, agli baar early aana padega.",
    "Vibe achi thi, host bahut warmly welcome karta hai.",
    "Thoda crowded laga but overall maza aaya.",
    "Highlights milna promise ke mutabik hue, thank you!",
    "Ekdum first-timer friendly, koi pressure nahi tha.",
    "Free session mein bhi quality compromise nahi hui.",
]


# ---------------------------------------------------------------------------
# Main generator
# ---------------------------------------------------------------------------

def build(args, now_ms):
    b = Builder()
    p = args.prefix
    creator = args.creator_uid
    handle = args.handle or f"{p}creator"

    # -----------------------------------------------------------------
    # 0. WIPE FIRST — idempotency. Every table this script ever writes to,
    #    scoped by the deterministic prefix. Order doesn't matter for
    #    correctness here (no FK enforcement in D1/SQLite unless declared
    #    AND pragma'd on, and this schema declares none), but children are
    #    deleted before parents for readability.
    # -----------------------------------------------------------------
    b.raw(f"-- === WIPE: everything under id/handle prefix '{p}' ===")
    b.add("review_helpful", f"DELETE FROM review_helpful WHERE review_id LIKE '{p}%'")
    b.add("reviews", f"DELETE FROM reviews WHERE id LIKE '{p}%'")
    b.add("listing_questions", f"DELETE FROM listing_questions WHERE id LIKE '{p}%'")
    b.add("listing_highlights", f"DELETE FROM listing_highlights WHERE id LIKE '{p}%'")
    b.add("listing_slots", f"DELETE FROM listing_slots WHERE id LIKE '{p}%'")
    b.add("listing_promotions", f"DELETE FROM listing_promotions WHERE id LIKE '{p}%'")
    b.add("listings", f"DELETE FROM listings WHERE id LIKE '{p}%'")
    b.add("listings_fts", f"DELETE FROM listings_fts WHERE listing_id LIKE '{p}%'")
    b.add("users", f"DELETE FROM users WHERE uid LIKE '{p}%'")
    # NOTE — creator_stats and creator_profiles are deliberately NEVER deleted
    # here, on --wipe or otherwise. Their primary key is the REAL creator_id
    # the caller passed via --creator-uid, not a seed-prefixed id, so a LIKE
    # sweep can't scope to "only what this script created" the way it can for
    # listings/reviews/users. creator_profiles is upserted with a bio ONLY
    # when one wasn't already there (see below); creator_stats is a fully
    # derived/cached row this script overwrites with INSERT OR REPLACE on
    # every apply, which is idempotent on its own — a delete-then-insert would
    # only add a window where the row briefly doesn't exist for no benefit,
    # and on --wipe it would erase a real creator's cached stats table with no
    # way to regenerate them from this script.

    if args.wipe:
        return b

    # -----------------------------------------------------------------
    # 1. Seed review-author users (seed-user-1..8). Only the columns with
    #    NOT NULL constraints (created_at, updated_at) plus identity fields;
    #    every other NOT NULL column on `users` carries a DEFAULT
    #    (retention_track, legal_hold, free_number_used,
    #    phone_discoverable, email_discoverable, who_can_add — verified
    #    against worker/migrations/2026-07-10-identity-gating.sql,
    #    avatok_number_free_tier.sql, avatok_numbers.sql). No FK/Clerk
    #    constraint blocks this: `uid` is just a TEXT PRIMARY KEY here, and
    #    'seed-user-N' cannot collide with a real Clerk id shape (Clerk ids
    #    look like 'user_xxx', never 'seed-user-N').
    # -----------------------------------------------------------------
    AUTHOR_NAMES = [
        "Priya S.", "Rahul K.", "Ananya G.", "Vikram T.",
        "Sneha P.", "Arjun M.", "Divya R.", "Karan B.",
    ]
    for i, name in enumerate(AUTHOR_NAMES, start=1):
        uid = f"{p}user-{i}"
        b.add("users", f"""
INSERT OR REPLACE INTO users (uid, handle, display_name, created_at, updated_at)
VALUES ({esc(uid)}, {esc(f"{p}user{i}")}, {esc(name)}, {num(now_ms)}, {num(now_ms)})
""")

    # -----------------------------------------------------------------
    # 2. creator_profiles — INSERT OR IGNORE (never clobber a real bio),
    #    then a conditional UPDATE that only fires when bio IS NULL.
    # -----------------------------------------------------------------
    bio = ("Live jams, seedha 1:1 tax guidance aur ek astro AI agent — sab ek hi"
           " creator ke channel pe. Har session dilse, timing pe.")
    b.add("creator_profiles", f"""
INSERT OR IGNORE INTO creator_profiles (user_id, bio, follower_count, updated_at)
VALUES ({esc(creator)}, {esc(bio)}, 300, {num(now_ms)})
""")
    b.add("creator_profiles", f"""
UPDATE creator_profiles SET bio = {esc(bio)}, follower_count = 300, updated_at = {num(now_ms)}
WHERE user_id = {esc(creator)} AND bio IS NULL
""")

    # -----------------------------------------------------------------
    # 3. creator_stats — one row per creator (PK creator_id), safe to
    #    INSERT OR REPLACE since it is fully derived/cached data anyway
    #    (per the migration's own header: "filled by a worker cron or an
    #    on-write refresh... nothing computes this on request").
    # -----------------------------------------------------------------
    b.add("creator_stats", f"""
INSERT OR REPLACE INTO creator_stats
  (creator_id, shows_hosted, hours_live, on_time_pct, cancel_rate, comeback_pct,
   avg_response_min, sessions_done, sold_out_count, first_session_at, last_session_at, updated_at)
VALUES
  ({esc(creator)}, 120, 210.0, 97.0, 1.5, 96.0, 9, 600, 4,
   {num(now_ms - 200 * DAY_MS)}, {num(now_ms - 1 * DAY_MS)}, {num(now_ms)})
""")

    listings = []  # collect (id, kind, title, description, category) for review/fts helpers

    # ===================================================================
    # LISTING 1 — seed-live-1 : live_event, fixed_date, paid, full content
    # ===================================================================
    lid = f"{p}live-1"
    starts_at = ist_epoch_ms(3, 21, 0, now_ms)
    attrs1 = {
        "commercial_refund_window_hours": 48,
        "content_how_it_works": how_it_works_live(),
        "content_house_rules": house_rules_music(),
        "content_house_rules_intro": house_rules_intro_music(),
        "content_join_lead_minutes": 15,
        "content_what_you_get": what_you_get_music(),
        "content_who_for": who_for_music(),
        "content_not_for": not_for_music(),
        "content_faq": faq_music(),
        "join_requirements": join_requirements_music(),
    }
    cover1 = [
        {"type": "image", "url": "https://images.avatok.ai/seed/live-1-cover-1.jpg"},
        {"type": "image", "url": "https://images.avatok.ai/seed/live-1-cover-2.jpg"},
        {"type": "image", "url": "https://images.avatok.ai/seed/live-1-cover-3.jpg"},
    ]
    listings.append((lid, "live_event", "Andaz Apna Apna — Open Mic Jam", "Gaana suna do, dil jeet lo. Ek ghante ki live jam, sabke liye khula stage.", "music"))
    b.add("listings", f"""
INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential)
VALUES
  ({esc(lid)}, {esc(creator)}, 'live_event',
   'Andaz Apna Apna — Open Mic Jam',
   'Gaana suna do, dil jeet lo. Ek ghante ki live jam, sabke liye khula stage — beginners se lekar bathroom-singers tak.',
   'music', 49, 'INR', 'IN', 0, {js(["recorded"])}, {js(cover1)},
   {num(starts_at)}, 90, 60, 'published', 0, 4.8, 8, {num(now_ms)}, {num(now_ms)},
   'commerce', {js(attrs1)}, 'https://www.youtube.com/watch?v=seedlive1', 1, 1, 1,
   'live_streaming', {esc(f"{p}open-mic-jam")}, {esc("90 min ka live jam — apna gaana suna do, dil jeet lo")},
   'fixed_date', NULL, NULL, 'Asia/Kolkata', 'session', 0, 4, NULL, {js(["beginner_ok"])}, NULL)
""")
    b.add("listing_promotions", f"""
INSERT OR REPLACE INTO listing_promotions (id, listing_id, kind, pct_off, code, max_uses, used, ends_at)
VALUES ({esc(f"{p}promo-1")}, {esc(lid)}, 'early_bird', 20, NULL, 20, 3, {num(starts_at - 24 * HOUR_MS)})
""")
    b.add("listing_highlights", f"""
INSERT OR REPLACE INTO listing_highlights (id, listing_id, session_id, kind, r2_key, thumb_key, duration_s, sort, created_at)
VALUES ({esc(f"{p}highlight-1")}, {esc(lid)}, NULL, 'clip', 'seed/highlights/live-1-clip-1.mp4', 'seed/highlights/live-1-clip-1-thumb.jpg', 24, 0, {num(now_ms)})
""")

    # ===================================================================
    # LISTING 2 — seed-live-recurring-1 : live_event, recurring, paid
    # ===================================================================
    lid2 = f"{p}live-recurring-1"
    attrs2 = {
        "commercial_refund_window_hours": 24,
        "content_how_it_works": how_it_works_live(),
        "content_house_rules": house_rules_music(),
        "content_house_rules_intro": house_rules_intro_music(),
        "content_join_lead_minutes": 10,
        "content_what_you_get": what_you_get_music()[:3] + ["Har hafte 3 baar naya jam"],
        "content_who_for": who_for_music(),
        "content_not_for": not_for_music(),
        "content_faq": faq_music(),
        "join_requirements": join_requirements_music(),
    }
    next_occurrence = ist_epoch_ms(1, 18, 0, now_ms)
    listings.append((lid2, "live_event", "Roz Shaam Ka Riyaz", "Mon/Wed/Fri shaam ko chhota riyaz session — mehfil chhoti, maza poora.", "music"))
    b.add("listings", f"""
INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential)
VALUES
  ({esc(lid2)}, {esc(creator)}, 'live_event',
   'Roz Shaam Ka Riyaz',
   'Mon/Wed/Fri shaam ko chhota riyaz session — mehfil chhoti, maza poora. Regular aane walon ke liye best.',
   'music', 19, 'INR', 'IN', 0, NULL, {js(cover1[:2])},
   {num(next_occurrence)}, 30, 20, 'published', 0, 4.7, 8, {num(now_ms)}, {num(now_ms)},
   'commerce', {js(attrs2)}, NULL, 1, 1, 1,
   'live_streaming', {esc(f"{p}roz-shaam-riyaz")}, {esc("Mon/Wed/Fri shaam 6 baje — chhota riyaz, poora maza")},
   'recurring', {js([1, 3, 5])}, {esc("18:00")}, 'Asia/Kolkata', 'session', 0, 4, NULL, {js(["beginner_ok"])}, NULL)
""")

    # ===================================================================
    # LISTING 3 — seed-consult-1 : consult, fixed_date, CA finance 1:1
    # ===================================================================
    lid3 = f"{p}consult-1"
    attrs3 = {
        "commercial_cancellation_window_hours": 24,
        "commercial_reschedule_allowed": True,
        "commercial_booking_notice_hours": 6,
        "commercial_preparation_instructions": prep_instructions_qa(),
        "commercial_no_show_policy": "session_charged",
        "content_how_it_works": [
            {"label": "BOOK", "body": "Slot chuno jo tumhare time se match kare — instant confirm hoga."},
            {"label": "PREPARE", "body": "Documents pehle se ready rakho jo prep instructions mein bataye gaye hain."},
            {"label": "TALK", "body": "45 min ki 1:1 call — seedhi baat, action items ke saath khatam."},
        ],
        "content_house_rules": house_rules_qa(),
        "content_house_rules_intro": house_rules_intro_qa(),
        "content_what_you_get": [
            "45 min ki 1:1 video consultation",
            "Personalized tax-saving action plan",
            "Follow-up chat 48 ghante tak",
        ],
        "content_who_for": ["Freelancers aur salaried dono", "ITR filing mein confuse ho"],
        "content_not_for": ["Company-level audit chahiye"],
        "content_faq": faq_music()[:0] + [
            {"q": "Kitne din pehle book karoon?", "a": "Kam se kam 6 ghante pehle — slot list mein jo khula hai wahi book hoga."},
            {"q": "Reschedule ho sakta hai?", "a": "Haan, 24 ghante pehle bata do, naya slot mil jayega."},
            {"q": "No-show pe kya hota hai?", "a": "Session amount charge ho jayega — CA ka time bhi valuable hai."},
        ],
        "content_sample_qa": sample_qa_finance(),
    }
    listings.append((lid3, "consult", "Tax Bachao, Tension Bhagao", "CA ke saath 1:1 — ITR, 80C, freelance tax, sab seedha samjho.", "business"))
    b.add("listings", f"""
INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential)
VALUES
  ({esc(lid3)}, {esc(creator)}, 'consult',
   'Tax Bachao, Tension Bhagao',
   'CA ke saath 1:1 — ITR filing, Section 80C, freelance tax, sab kuch seedhi Hinglish mein samjho.',
   'business', 349, 'INR', 'IN', 0, NULL, NULL,
   {num(ist_epoch_ms(1, 11, 0, now_ms))}, 45, 1, 'published', 0, 4.9, 8, {num(now_ms)}, {num(now_ms)},
   'commerce', {js(attrs3)}, NULL, 1, 1, 1,
   'consulting', {esc(f"{p}tax-bachao-tension-bhagao")}, {esc("CA ke saath 1:1 — ITR, 80C, freelance tax, seedha samjho")},
   'fixed_date', NULL, NULL, 'Asia/Kolkata', NULL, 0, 1, 10, NULL, {esc(credential_qa())})
""")
    # 6 listing_slots over the next 7 days, capacity 1 (calendar 1:1 grain).
    slot_hours = [11, 15, 17, 11, 14, 16]
    for i, hr in enumerate(slot_hours, start=1):
        day_offset = 1 + (i - 1) // 2  # spreads across ~4 days within a week
        starts = ist_epoch_ms(day_offset, hr, 0, now_ms)
        ends = starts + 45 * MIN_MS
        b.add("listing_slots", f"""
INSERT OR REPLACE INTO listing_slots (id, listing_id, starts_at, ends_at, label, capacity, booked_count, status, created_at, updated_at)
VALUES ({esc(f"{p}slot-{i}")}, {esc(lid3)}, {num(starts)}, {num(ends)}, NULL, 1, 0, 'open', {num(now_ms)}, {num(now_ms)})
""")

    # ===================================================================
    # LISTING 4 — seed-ai-1 : AI voice agent, always_on, billed per 10min
    # ===================================================================
    lid4 = f"{p}ai-1"
    attrs4 = {
        "content_can_do": can_do_ai(),
        "content_cant_do": cant_do_ai(),
        "content_sample_chat": sample_chat_ai(),
    }
    listings.append((lid4, "ai_agent", "Astro Agent — Grah Gyaan 24x7", "Apna kundli lekar aao, AI agent seedha career/relationship guidance dega.", "astrologers"))
    b.add("listings", f"""
INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   agent_instructions, agent_lang, agent_voice_persona,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential)
VALUES
  ({esc(lid4)}, {esc(creator)}, 'ai_agent',
   'Astro Agent — Grah Gyaan 24x7',
   'Apna kundli lekar aao — yeh AI agent seedha career, relationship aur muhurat pe guidance dega, Hindi ya English mein, jab chaho.',
   'astrologers', 19, 'INR', 'IN', 0, {js(["ai"])}, NULL,
   NULL, NULL, NULL, 'published', 0, 4.6, 8, {num(now_ms)}, {num(now_ms)},
   {esc("Vedic astrology ke hisaab se career, relationship aur daily muhurat guidance do. Hindi-Latin (Hinglish) mein baat karo, seedha aur garam-josh. Kabhi medical/legal advice ya guaranteed prediction mat do.")},
   'hi', {esc("Warm desi astrologer — thoda mazaakiya, hamesha encouraging")},
   'commerce', {js(attrs4)}, NULL, 1, 1, 1,
   'ai_voice_agents', {esc(f"{p}astro-agent-grah-gyaan")}, {esc("AI astro agent — 24x7, apni kundli lekar seedha baat karo")},
   'always_on', NULL, NULL, 'Asia/Kolkata', '10min', 0, 4, 1, {js(["beginner_ok"])}, NULL)
""")
    b.add("listing_highlights", f"""
INSERT OR REPLACE INTO listing_highlights (id, listing_id, session_id, kind, r2_key, thumb_key, duration_s, sort, created_at)
VALUES ({esc(f"{p}highlight-2")}, {esc(lid4)}, NULL, 'voice', 'seed/highlights/ai-1-sample-voice.mp3', NULL, 28, 0, {num(now_ms)})
""")

    # ===================================================================
    # LISTING 5 — seed-free-1 : live_event, free_entry, full content
    # ===================================================================
    lid5 = f"{p}free-1"
    starts_at5 = ist_epoch_ms(2, 21, 0, now_ms)
    attrs5 = {
        "commercial_refund_window_hours": 0,
        "content_free_cap_tokens": 500,
        "content_how_it_works": how_it_works_live(),
        "content_house_rules": house_rules_free(),
        "content_house_rules_intro": house_rules_intro_free(),
        "content_join_lead_minutes": 10,
        "content_what_you_get": what_you_get_free(),
        "content_who_for": who_for_free(),
        "content_not_for": not_for_free(),
        "content_faq": faq_free(),
        "join_requirements": join_requirements_music(),
    }
    listings.append((lid5, "live_event", "Sabke Liye Free Jam — Try Karo!", "Bilkul free entry — bas seat pakki karo, gaane ka mauka mat chhodo.", "music"))
    b.add("listings", f"""
INSERT OR REPLACE INTO listings
  (id, creator_id, kind, title, description, category, price, currency_display, country,
   adults_only, badges, cover_media, starts_at, duration_min, capacity, status, joined_count,
   rating_avg, rating_count, created_at, updated_at,
   vertical, attrs, video_url, cat_version, playbook_version, template_version,
   section, slug, blurb, schedule_mode, recurrence_days, recurrence_time, timezone,
   billing_unit, free_entry, max_per_booking, response_time_min, vibe_tags, credential)
VALUES
  ({esc(lid5)}, {esc(creator)}, 'live_event',
   'Sabke Liye Free Jam — Try Karo!',
   'Bilkul free entry — bas seat pakki karo, gaane ya sunne ka mauka mat chhodo. Naye logon ke liye best shuruaat.',
   'music', 0, 'INR', 'IN', 0, {js(["recorded"])}, {js(cover1)},
   {num(starts_at5)}, 90, 40, 'published', 0, 4.9, 8, {num(now_ms)}, {num(now_ms)},
   'commerce', {js(attrs5)}, 'https://www.youtube.com/watch?v=seedfree1', 1, 1, 1,
   'live_streaming', {esc(f"{p}sabke-liye-free-jam")}, {esc("Bilkul FREE entry — seat pakki karo, mauka mat chhodo")},
   'fixed_date', NULL, NULL, 'Asia/Kolkata', 'session', 1, 4, NULL, {js(["beginner_ok", "safe_space"])}, NULL)
""")

    # -----------------------------------------------------------------
    # 4. Reviews — 8 per PAID listing (live-1, consult-1, ai-1; NOT the
    #    recurring one and NOT the free one, per the task's "8 reviews per
    #    paid listing"), mixed verified/unverified, 2 with creator_reply,
    #    helpful_count varied, ratings averaging ~4.8 with a real histogram
    #    (not all 5s): pattern per listing = [5,5,4,5,5,3,5,4] -> avg 4.5..;
    #    we vary slightly per listing to land each listing's own average
    #    near what's stored on listings.rating_avg above.
    # -----------------------------------------------------------------
    review_sets = [
        (lid, REVIEW_BODIES_MUSIC, [5, 5, 5, 4, 5, 5, 4, 5]),               # avg 4.75 ~ stored 4.8
        (lid3, REVIEW_BODIES_QA, [5, 5, 5, 5, 4, 5, 5, 5]),                 # avg 4.875 ~ stored 4.9
        (lid4, REVIEW_BODIES_MUSIC[:0] + [
            "Career ka jo sawaal poocha, jawab bilkul point pe tha.",
            "Hindi mein baat karta hai, bahut aasan lagta hai samajhna.",
            "Muhurat wali baat sahi nikli, time pe kaam ho gaya.",
            "Thoda robotic lagta hai kabhi kabhi, but info kaam ki hai.",
            "24x7 available hona sabse bada plus point hai.",
            "Sample voice suna, ekdum desi astrologer jaisa tone hai.",
            "Ek baar jawab thoda generic tha, but overall achha experience.",
            "10 min ka billing fair lagta hai, zyada der nahi bola.",
        ], [5, 5, 5, 4, 5, 5, 3, 5]),                                       # avg 4.625 ~ stored 4.6
    ]
    for listing_id, bodies, ratings in review_sets:
        for i in range(8):
            n = i + 1
            author = f"{p}user-{n}"
            rid = f"{p}review-{listing_id}-{n}"
            verified = 1 if n % 2 == 1 else 0  # alternate verified/unverified
            has_reply = n in (1, 2)
            reply = "Dhanyavaad! Agli baar aur maza aayega — milte hain." if has_reply else None
            helpful = (n * 3) % 11  # deterministic small spread 0-10
            created = now_ms - (8 - n) * DAY_MS
            b.add("reviews", f"""
INSERT OR REPLACE INTO reviews
  (id, listing_id, creator_id, author_id, rating, body, created_at,
   verified_attendee, creator_reply, creator_reply_at, helpful_count, photo_keys, reply, reply_at)
VALUES
  ({esc(rid)}, {esc(listing_id)}, {esc(creator)}, {esc(author)}, {num(ratings[i])}, {esc(bodies[i])}, {num(created)},
   {num(verified)}, {esc(reply)}, {num(created + HOUR_MS) if has_reply else "NULL"}, {num(helpful)}, NULL,
   {esc(reply)}, {num(created + HOUR_MS) if has_reply else "NULL"})
""")
        # Keep listings.rating_avg/rating_count in sync with the reviews just
        # inserted for this listing (mirrors what the live review-write route
        # does at listings.ts around line 2543 — computed from the table, not
        # hand-typed, so the card and the reviews list can never disagree).
        avg = round(sum(ratings) / len(ratings), 2)
        b.add("listings", f"""
UPDATE listings SET rating_avg = {num(avg)}, rating_count = {num(len(ratings))}, updated_at = {num(now_ms)}
WHERE id = {esc(listing_id)}
""")

    # -----------------------------------------------------------------
    # 5. listings_fts — the marketplace search index. Rows are REPLACED on
    #    publish per the base migration's own comment, so a plain re-insert
    #    (after the wipe at the top deleted the old ones) is correct.
    # -----------------------------------------------------------------
    for lid_, kind_, title_, desc_, cat_ in listings:
        b.add("listings_fts", f"""
INSERT INTO listings_fts (listing_id, title, description, creator_name, category)
VALUES ({esc(lid_)}, {esc(title_)}, {esc(desc_)}, {esc(handle)}, {esc(cat_)})
""")

    return b


def render(builder: Builder) -> str:
    lines = [
        "-- Generated by scripts/seed_listings.py — DO NOT hand-edit.",
        "-- Idempotent: safe to re-run this same file any number of times.",
        "PRAGMA defer_foreign_keys = TRUE;",
        "",
    ]
    lines.extend(builder.statements)
    lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--creator-uid", help="Clerk uid to own every seeded listing (required unless --wipe)")
    ap.add_argument("--out", help="Path to write the generated .sql file")
    ap.add_argument("--prefix", default="seed-", help="Deterministic id prefix (default: seed-)")
    ap.add_argument("--handle", help="Creator handle, used only in the FTS creator_name column (default: <prefix>creator)")
    ap.add_argument("--wipe", action="store_true", help="Emit ONLY the DELETE statements for this prefix, then exit")
    ap.add_argument("--check", action="store_true", help="Don't write a file — print statement count + tables touched")
    args = ap.parse_args()

    if not args.wipe and not args.creator_uid:
        print("error: --creator-uid is required unless --wipe is given", file=sys.stderr)
        sys.exit(2)
    # --wipe still needs SOME creator_uid value for the creator_stats DELETE
    # scoping comment above; if omitted, skip that one statement rather than
    # guessing a uid.
    if args.wipe and not args.creator_uid:
        args.creator_uid = "__no_creator_uid_given__"

    if not args.prefix.endswith("-"):
        print("warning: --prefix should normally end with '-' (e.g. 'seed-')", file=sys.stderr)

    now_ms = int(time.time() * 1000)
    builder = build(args, now_ms)
    sql_text = render(builder)

    if args.check:
        print(f"statements: {len(builder.statements)}")
        print(f"tables touched: {', '.join(sorted(builder.tables))}")
        return

    if not args.out:
        print("error: --out is required (unless --check)", file=sys.stderr)
        sys.exit(2)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(sql_text)
    print(f"wrote {args.out} ({len(builder.statements)} statements, tables: {', '.join(sorted(builder.tables))})")


if __name__ == "__main__":
    main()
