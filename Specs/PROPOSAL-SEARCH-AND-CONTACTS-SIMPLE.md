# Search, Contacts & Presence — the final plan

*Plain-English plan. No tech background needed.*

## The big idea (your understanding, confirmed — with one nuance)

- For **finding people and searching**, the **online copy is the source of truth**, and what's
  on your phone is a fast local **cache** (a copy). We search the local cache first only to
  feel instant, then check online to be complete.
- One nuance for **your actual chat messages**: those stay **device-first** — your phone (plus
  your backup) is the real home for your messages, and the server is more of a relay and a
  searchable copy, not a place that keeps everything forever. So: *online is the source of
  truth for "who's on the network" and for search; your device + backup are the real home for
  your message history.*

---

## 1. Finding people (contacts) — **always online**

When you search for someone by name, handle, or even a description like *"designer"*, we
check the AvaTOK network **live**. If they're on AvaTOK, they appear instantly with an
**Add** button — even if they're not saved on your phone yet. This is the behaviour you had
before, restored and a little smarter (it now matches bios too). Always online, so it's the
same on every device.

## 2. Searching your messages — **local first, then online**

1. **Instantly:** we search what's already on the device in your hand (works with no internet).
2. **A moment later:** we also check online and fill in anything that device is missing —
   older chats, or messages that only landed on your other devices.

Fast first, complete second — and the same on phone, Mac, and PC.

---

## 3. Keeping contacts fresh — a quiet background sync (two-way, incremental)

People join and leave the network, and you add new contacts. So the app keeps the local
contact list and the online list gently in step in the background:

- **Online → your phone:** as people join AvaTOK (or go offline), the app quietly learns
  about it and updates your local list — so your contacts always reflect who's actually on
  the network.
- **Your phone → online:** when you add a new contact, that's recorded online too.
- **Only the changes move, never the whole list.** It's incremental — just "what changed
  since last time" — so it's fast and uses almost no data or battery. Fast and furious.

---

## 4. The "Contacts" menu + presence dots

- **Rename "Invite friends" to "Contacts."** It becomes the place to see and manage everyone,
  with invite still available inside it.
- Each person gets a small **status dot** so you can tell at a glance who's reachable:

  | Dot | Meaning | On hover it says |
  |-----|---------|------------------|
  | 🟢 Green | Online / active right now | "Online" |
  | 🟡 Yellow | Away — hasn't used AvaTOK for a few hours | "Active 3 hours ago" (the real time) |
  | 🔴 Red | Phone is off / unreachable | "Phone off" |
  | ⚪ Grey | Not on AvaTOK yet | "Invite to AvaTOK" |

  Hovering (or long-pressing on a phone) any dot shows what it means in words, and the yellow
  one shows **how long** since they were last active (e.g. "since 3 hours").

  *(Note: you wrote green for "offline" — I've used the common convention where green = online.
  Tell me if you'd like the colours flipped.)*

---

## 5. The realtime question (important clarification)

You're right that we need realtime for the live status dots — but **Cloudflare already gives
us that, and we're already using it.** The same always-on connection that powers your live
"online" and "typing…" indicators is exactly what drives the green/yellow/red dots. **No new
realtime company (like Inngest) is needed** for presence.

- **Live status (the dots):** uses Cloudflare's realtime rail we already have. Instant.
- **The quiet background contact sync:** this is a light, occasional job (not realtime). We
  can run it on Cloudflare's built-in scheduler/queues. If you ever want a dedicated workflow
  tool like Inngest for bigger background jobs later, we can — but it's optional and not
  required here.

So: keep one platform (Cloudflare), no extra realtime vendor, less cost and complexity.

---

## 6. How each person's data stays separate (and easy to delete)

Picture the online search as **one big filing cabinet for everyone**, where each person has
their **own private, labelled drawer**. When you search, we only ever open **your** drawer —
nobody can see anyone else's.

- **Isolation:** you only ever get your own data back.
- **Deletion is one move:** deleting a user = **throw out their whole drawer.** Nothing left
  behind — important for "delete my account" and for safety/legal removal requests.

This "one cabinet, private drawers" approach is how Cloudflare AI Search is actually built to
work (one shared search, kept private per person by a strict label). Today the code mistakenly
tries to give each user a **separate** search engine, which won't scale — we'll switch to the
drawers model. Same privacy for the user; it just actually scales and makes deletes clean.

---

## 7. One shared search powers three things

1. **ChatAva's memory** — recalling what you've talked about.
2. **Finding people on AvaTOK** — always online, instant add.
3. **Searching across all your chats** — local first, then online.

All from **one** private-per-person search, not three half-built ones.

## 8. Privacy rules (unchanged)

- Only what you've allowed goes into the online drawer (your AvaBrain consent switches).
- Private / on-device-only chats stay on the device and are **never** copied online.
- Online search stays premium, as agreed. Even free users still get instant on-device message
  search, always-online people search, and the live status dots.

---

## What's already done vs. still to build

**Already built (this work, not yet committed/deployed):**
- Instant on-device message search across all chats.
- People search now also matches bios.
- The "deleted message" hide/undo with cross-device sync groundwork.

**Still to build:**
- The "online second" half of message search (read from the per-person online search).
- The two-way incremental contact sync.
- Rename "Invite friends" → "Contacts" + the green/yellow/red status dots with hover text.
- Switch the online search to the "one cabinet, private drawers" model (per-person folder +
  delete-by-folder). *Heads-up: part of this lives in a file another developer is mid-edit on,
  so we'll take it cleanly once they're done.*

## 9. Multiple devices writing at once — will it corrupt the database?

Short answer: **no, and we don't need a separate queue service to keep it safe.** Here's why,
in plain terms.

**The database can't get scrambled by two devices at once.** Every user already has a single
private "coordinator" on the server (one per person) that all of their devices talk to, and it
handles **one change at a time, in order**. The main database behaves the same way — it
processes writes one by one and never ends up half-written or broken. So two phones saving at
the same moment can't corrupt anything; the system simply does them one after another.

**The real multi-device question isn't corruption — it's "who wins."** Example: you mute a chat
on your phone, then unmute it on your Mac a second later. We just need to make sure the *older*
action doesn't overwrite the *newer* one. We handle that with one simple rule:

- **Every change carries a timestamp, and the newest change wins.**
- Some changes only ever **move forward** (like "I've read up to here" — it never goes
  backward), so a stale device can't undo a fresh update.

That's lightweight, reliable, and built-in — **no queue needed** for safety.

**When is a queue actually useful?** For heavy bursts and retries — sending one message out to
many people, analytics, big background jobs. You already use Cloudflare's queues there, and
we'll keep using them for that. But a queue is the wrong tool for "stop devices corrupting the
DB," because the database already guarantees that.

**Bottom line:** no new queue vendor for safety. Keep each user's changes flowing through their
existing per-user coordinator, stamp every change with a time so "newest wins," and reserve
queues for heavy background work — exactly the setup you already have.

## In one sentence

People-search is always online and instant; message-search is on-device first then online so
it's fast and complete on every device; a quiet incremental sync keeps your contact list and
live green/yellow/red status dots up to date using the realtime rail Cloudflare already gives
us; and everyone's data lives in its own private drawer in one shared search, so it stays
isolated and deletes in a single move.
