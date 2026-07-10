# AvaTOK Identity Gate — What we built, and what to test

**Date:** 10 July 2026 · **Status:** LIVE on production, gate switched ON

---

## Part 1 — What we achieved

### The original problem

- You paid Firebase for an SMS text message every time someone signed up.
- You wanted to stop paying, but still know who your users were.

### What we found out

- **A phone number proves almost nothing.** In the US, UK, Canada and ~60 other
  countries, anyone can buy a prepaid SIM with cash and no ID.
- **You can never look anyone up.** No private company can, in any country. Only police
  can ask a phone company who owns a number.
- So you were paying for something that mostly didn't work.

### What we built instead

- **Phone verification is gone completely.** Firebase SMS removed. SMS cost is now zero.
- **Signup is now just email + password, or Google.** No phone screen. No camera. Instant.
- **The camera check happens later** — the first time someone tries to do something
  *public*. Not at signup.
- **Once every 90 days**, they're asked again.

### What counts as "public"

The check fires on the first of any of these:

- Creating a post
- Creating a marketplace listing
- Going live
- **Messaging someone you've never messaged before**
- Posting in a group
- Uploading a photo to a public place

**Messaging people you already talk to is never blocked.** That was fiddly to get right —
the check had to sit *after* the server works out whether you two have spoken before.

### Why the camera comes later, not at signup

- **Fewer people quit.** Nobody abandons signup over a camera they never see.
- **It deters better.** A camera check weeks earlier, during a signup someone has
  forgotten, puts nobody off. A camera check *right before* they post something illegal
  does. Friction belongs at the moment of intent.

### Three serious things we found and fixed

**1. A security hole that was wide open.**
Your app had four different ways to mark someone "verified". You use one (Didit). The
other three were old code, still switched on, still wired to the same switch. Someone
could have marked themselves verified **without ever showing their face**. Now closed —
those routes refuse and raise an alarm.

**2. We were deleting evidence we're legally required to keep.**
If someone posted child abuse material and got reported, your code deleted it — and
deleted it again if they then deleted their account. Now a reported account gets a "legal
hold" and deletion refuses. If the system can't tell whether a hold exists, it refuses
anyway.

**3. A bug that would have locked out every user.**
Our first version stored the verification record in a database table that **does not
exist on production**. Caught it by checking the live database before running anything.
Had it shipped, the moment the gate switched on, every user would have been permanently
blocked from posting.

### The legal side

- **Illinois has a biometric law (BIPA) with real teeth.** It applies to Illinois
  residents wherever your company is registered, and it lets *individuals sue you
  directly* — $1,000–$5,000 per violation. It cost Facebook $650 million.
- We built what it requires:
  - A tick-box, never pre-ticked, before the camera opens, naming what's collected and
    how long you keep it.
  - **A published retention schedule** at `avatok.ai/biometric-retention`, live now,
    linked from the consent screen, the privacy policy, and both site footers.
- **Face videos are kept 256 days after account deletion** — except for people in
  Illinois and Texas, **and anyone whose home state we don't know**, whose video is
  destroyed immediately. When unsure, we delete. A phone's location tells you where the
  phone is, not where the person lives.

### Your existing users

- All 18 were **grandfathered** — nobody is interrupted.
- The database honestly records they never did a check (`grandfathered`, not `didit`). If
  police ever ask, the system must not claim a check happened when it didn't.
- Their renewal dates are **spread across days 36–88**, so they don't all hit the camera
  on the same morning.
- **Honest consequence:** for the next ~36–88 days the camera check only applies to *new*
  users. Anyone already on AvaTOK — including anyone who shouldn't be — is trusted
  without ever showing their face. That's the price of not disturbing your users. It
  fixes itself as the window runs out.

### What this does NOT do

- **It does not stop a banned person coming back.** The camera proves *a real live human
  is there*. It does not say *which* human, and it can't recognise someone you've already
  thrown out. Banned → new email → fresh camera check → back in, in minutes.
- Closing that would mean keeping banned people's faces on file. You removed that
  deliberately — it was the single biggest legal risk in the design. Reasonable trade,
  but it *is* a trade.

### What is live right now

| Thing | Status |
|---|---|
| Worker + background jobs | Deployed to production |
| Database | Migrated, all 18 users grandfathered |
| The gate (`identityGatingEnabled`) | **ON** |
| Old bypass routes | Closed (return "410 Gone") |
| Retention schedule webpage | Live |
| Android APK | Built |

---

## Part 2 — What YOU need to test

> ### ⚠️ Read this first
> **Do not let anyone sign up a NEW account on the OLD app.**
> The gate is on. The old app has no consent screen, so a new user gets an error with no
> way forward. Existing accounts are fine. Install the new APK first.

> **If anything goes badly wrong, this switches it all off instantly:**
> ```
> ALLOW_PROD=1 AVATOK_TARGET=prod scripts/flags.sh set identityGatingEnabled=false
> ```

---

### Test 1 — Signing up should be fast and empty

1. Install the new APK. Create a **brand new** account.
2. ✅ You should see **no phone number screen**.
3. ✅ You should see **no camera**.
4. ✅ You should land in the app immediately after email/Google.

**Fail if:** anything asks for a phone number or opens a camera during signup.

---

### Test 2 — Just looking around should never interrupt you

1. On that new account, browse. Scroll the feed. Watch things. Read listings.
2. ✅ Nothing should ever stop you.

**Fail if:** you're gated for merely looking.

---

### Test 3 — The gate itself (the important one)

1. Still on the brand-new account, try to **create a marketplace listing**.
2. ✅ A screen appears: *"Quick check before you post"*.
3. ✅ It explains two things: proving you're real, and keeping AvaTOK safe.
4. ✅ There's a **state of residence** dropdown, and a **tick-box**.
5. ✅ The tick-box is **NOT already ticked**.
6. ✅ There's a link: *"Read our biometric retention schedule"*.

**Fail if:** the box is pre-ticked, or the screen doesn't appear at all.

---

### Test 4 — Declining must be safe

1. On that consent screen, **don't tick the box.**
2. ✅ The "Verify with camera" button should stay **greyed out**.
3. Now tick the box but **don't pick a state**.
4. ✅ Button should still be greyed out.
5. Close the screen with the ✕ or "Not now".
6. ✅ You go back. **No camera should ever have opened.**
7. ✅ You should not be able to create the listing.

**Fail if:** the camera opens at any point here. Nothing may be captured without consent.

---

### Test 5 — The retention link works

1. On the consent screen, tap **"Read our biometric retention schedule"**.
2. ✅ Your browser opens `avatok.ai/biometric-retention`.
3. ✅ The page loads (not a 404) and says **256 days**.

**Fail if:** it 404s. That's a legal problem, not a cosmetic one.

---

### Test 6 — Passing the check

1. Tick the box, pick a state, tap **Verify with camera**.
2. Complete the Didit camera check.
3. ✅ You're returned to the app and can now create the listing.
4. Now try to **create a post**. Then **go live**. Then **upload a photo**.
5. ✅ **You should NOT be asked again.** One pass unlocks everything.

**Fail if:** you're asked to verify twice.

---

### Test 7 — Messaging (the one most likely to be wrong)

1. Message someone you have **already messaged before**.
2. ✅ **No interruption at all.** This must never be gated.
3. Now message someone **completely new** who you've never messaged.
4. ✅ On an unverified account, this *should* be gated.

**Fail if:** an existing conversation gets gated. That's the bug I'd most expect.

---

### Test 8 — Existing users see nothing

1. Log in as one of your existing accounts (one from before today).
2. ✅ Everything works exactly as before. **No camera. No consent screen. No phone screen.**
3. Post something. Create a listing.
4. ✅ Straight through.

**Fail if:** an existing user is asked to verify. They were grandfathered; they shouldn't be.

---

### Test 9 — The Profile phone box

1. Go to Profile.
2. ✅ The **personal phone number box is still there**.
3. ✅ There is **no "verify" button** and **no SMS**.
4. ✅ It says we don't verify it.

**Fail if:** any SMS is sent. That's money leaving your account.

---

### Test 10 — Identity screen

1. Open the Identity screen.
2. ✅ The **"Phone" row is gone**.
3. ✅ There is a **"Video verified"** row with a tick.

---

## What to watch in PostHog while testing

| Event | What it means |
|---|---|
| `legacy_liveness_route_called` | **Must stay at ZERO.** Anything else means an old app is hitting the closed security hole. |
| `identity_gate_hit` | The gate blocked someone. Normal. |
| `identity_gate_passed` | The gate let someone through. Normal. |
| `identity_gate_error` | Database trouble. The gate blocks when unsure, so this rejects real users. Investigate. |
| `liveness_consent_declined` | People refusing to give a face scan. Worth knowing honestly. |

---

## Report back

Tell me if anything:

- Asks you for a phone number
- Asks for the camera **twice**
- Blocks a conversation with someone you already talk to
- Lets you post publicly **without** the check
- Opens the camera **before** you ticked the box
- Shows a 404 on the retention schedule link

---

## Still outstanding (not blocking your testing)

1. **A lawyer should read the retention rules** before you have real scale. BIPA lets
   individuals sue directly.
2. **Ask Didit what a check costs above 500/month.** "500 free/month" is a cap, not a free
   tier. With 90-day renewals that's up to 4 checks per active user per year. Fine at 18
   users. Not fine after a growth push.
3. **CSAM scanning is still switched off** — a separate project, but nothing on AvaTOK is
   currently checked for child abuse material.
4. **Ban evasion is not prevented.** See above.
