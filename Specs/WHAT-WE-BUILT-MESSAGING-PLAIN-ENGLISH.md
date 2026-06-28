# What we just built for chat — in plain English

**Date:** 28 June 2026

## The problem we set out to fix

Messages felt slow to send and receive. The old way worked like a post office that, for
every single message, had to walk down the hall and personally drop a copy into each
recipient's individual mailbox before it could tell you "sent." In a group, that's a lot of
walking — so you waited. On top of that, your chats were only really kept inside those
individual mailboxes, which isn't a great long-term home.

## The idea

Hand the **delivering** of messages to a company that does exactly that, brilliantly and
instantly, worldwide: **Ably**. And keep our own system (Cloudflare) doing what it's best
at — **safety checks, keeping every message safely stored forever, and powering AI search**.

Think of it as: Ably is the super-fast courier; Cloudflare is the safe, permanent filing
cabinet and the librarian.

## What changed, step by step

1. **A permanent home for every chat (the filing cabinet).** Every message is now copied
   into long-term storage (R2) the moment it's sent. Nothing gets lost, and this same store
   becomes the memory that AI search reads from. This runs quietly in the background — it
   never slows down sending.

2. **Instant delivery (the fast courier).** Instead of dropping a copy in each person's
   mailbox before saying "sent," we now hand the message to Ably once, and Ably delivers it
   to everyone instantly. The slow part is moved off to the side so you never wait for it.
   Result: sending feels immediate, even in groups.

3. **Better notifications.** Because the fast courier now handles live delivery, the
   "ping" that wakes a phone when it's asleep became more important. We fixed it so those
   alerts again show **who** messaged and a **preview** of what they said — not a blank
   "New message." (This was a real bug we caught and corrected along the way.)

4. **Never run out of history.** When you open a chat, the newest messages appear instantly,
   and as you scroll up, older history is pulled from the permanent store — going back as far
   as you like. Everyone keeps their full history.

5. **The fun stuff (new bells & whistles).** We added the plumbing for:
   - **Reactions** on individual messages that everyone sees live (and that stick around).
   - **Floating emoji bursts** — tap and a 🎉 floats up everyone's screen, great for group moments.
   - **Live "who's here" counts** — see how many people are currently in a busy group chat.

6. **Tidying up.** Personal things like "which messages you've read," "messages you deleted
   just for yourself," and your "call history" now have a cleaner home, so the old mailbox
   system can eventually retire.

## Important: this is built but not switched on yet

Everything is written and saved, but deliberately **turned off** ("dark") so nothing changes
for users until we choose to flip it on, carefully, a few people at a time. To go live, the
team needs to deploy it and turn on three switches. Until then, the app behaves exactly as
before — zero risk.

This work is **saved locally but not pushed** to the shared build system, per the project's
rules (pushing triggers a build, which we only do on request).

## How we'll know it's working

A new live dashboard — **"AvaTOK — Ably Transport + R2 Archive"** — tracks the things that
matter: how fast messages send, which delivery path they took, how many reactions and bursts
people use, whether anything is erroring, and overall how many people are using the app and
chatting each day. So once it's switched on, we'll see the speed-up and catch any problems
early.

## Scope (agreed up front)

- **Phones first** (iOS and Android). Desktop keeps working the old way for now.
- **Everyone keeps their full chat history.** Paid members additionally get instant
  restore across devices and a longer "live" window.
- **Safety is untouched.** Every message still passes through our safety and child-protection
  checks before it goes out — that was never up for negotiation.

## What's left

The "engine" for the new reactions, emoji bursts, live counts, and infinite history is all in
place. The remaining work is the visible on-screen polish — wiring those into the chat screen's
buttons and animations — plus deploying and switching it on.
