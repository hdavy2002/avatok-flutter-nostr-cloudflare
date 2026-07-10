# What we did, in plain English — 10 July 2026

**Status: built, switched OFF.** Nothing has changed for any user yet. The gate turns on
when you flip `identityGatingEnabled` — and there are three things to do first (bottom of
this page).

**No build was triggered.** You'll need to run one from the Actions tab to test the app.

---

## The problem you started with

You were paying Firebase for an SMS text message every time someone signed up. You wanted to
stop paying, but still know who your users were.

## Where we ended up

We stopped paying **and** stopped asking for phone numbers at all.

The reasoning:

- A phone number doesn't prove much. In the US, UK, Canada and ~60 other countries, anyone
  can buy a prepaid SIM with cash and no ID.
- Even where numbers *are* tied to a real ID, **you can't look anyone up.** No private
  company can, anywhere. Only law enforcement can ask a phone company who owns a number.
- So you were paying for something that mostly didn't work.

**What replaced it:** a quick video check of the person's face — done once, at the moment
they first try to post something in public.

## The new rules

| When | What happens |
|---|---|
| Someone signs up | Nothing. Email + password, or Google. That's it. |
| Someone just watches and reads | Nothing, ever. |
| They **post publicly for the first time** | Consent screen, then a camera check. Seconds. |
| 90 days later | Asked once more. |
| They want to withdraw money | Full ID check — **separate project, not built.** |

"Posting publicly" now means all of: a post, a marketplace listing, going live, **messaging
someone you've never messaged before**, posting in a group, and uploading a public photo.

**Messaging people you already talk to is not affected.** That was deliberate and slightly
fiddly — the check had to be placed after the server works out whether you two have spoken
before, otherwise it would have gated every private conversation in the app.

## Why the camera comes *later*, not at signup

1. **Fewer people quit.** Nobody abandons signup over a camera they never see.
2. **It's a stronger deterrent.** A camera check weeks earlier, during a signup someone has
   forgotten, puts nobody off. A camera check *immediately before* they post something
   illegal does. It lands at the moment of intent.

---

## Three things we found on the way

### 1. A real security hole. It was open. It's now closed.

The app had **four** ways to mark a user "verified." You use one (Didit). The other three
were old code — still switched on, still wired to the same switch.

Someone could have marked themselves verified **without ever showing their face.** That
would have made the whole gate decorative.

Those routes now refuse and report. If anyone tries them, an alarm event fires
(`legacy_liveness_route_called`). **It should always read zero.**

### 2. We were deleting evidence we're required to keep

If someone posts child abuse material and gets reported, the law generally says you must
**preserve** it for the authorities. Your code **deleted** it — and deleted it again if the
user then asked to delete their account.

Now: a reported account gets a "legal hold." Deletion refuses. If the system can't tell
whether a hold exists, it refuses anyway. Keeping data an extra day is fixable; destroying
evidence isn't.

### 3. Your CSAM scanning is not running

Separate project, as you said — but you should know the state of it. **No images on AvaTok
are currently checked for child abuse material.** The code is there and it's decent, but the
list of known-bad image fingerprints was never loaded, so every check quietly passes. If it
ever did find something, it would log an error rather than report it, because the reporting
address isn't configured.

The nudity detector works. That's a different thing and won't catch this.

---

## What's built

**Server:**

- The gate, switched off, covering all seven public actions.
- The old bypass routes closed (410 + alarm).
- Deletion and evidence-purge now respect legal holds; CSAM detection sets one.
- Consent recorded before any camera opens — the server refuses a camera session without it,
  so a broken or hacked app can't skip the screen.
- Detailed PostHog tracking, every event stamped with the user's email.

**App:**

- New consent screen (tick-box + state of residence) before the camera.
- New reusable gate that shows consent → camera → retries what you were doing.
- Onboarding: **no phone step, no camera step.** Straight in.
- Identity screen: the "Phone" row is gone; "Video verified" replaces it.
- `firebase_auth` removed from the app entirely. Eight files deleted.
- The personal phone number in Profile **stays**, but it's now a plain text box. No SMS, no
  verification, and the screen says so. It's contact info, not a trust signal.

**Fast2SMS never existed** — it was only ever in the spec. Nothing to remove.

---

## Two legal things, and one is urgent

I'm not a lawyer. This needs one before launch. But:

**Illinois has a biometric law with teeth (BIPA).** It applies to Illinois residents wherever
your company is registered. It's the only such law that lets *individuals sue you directly* —
$1,000 to $5,000 per violation. It's what cost Facebook $650 million. Being a US company makes
this *more* relevant, not less.

It requires two things before you scan a face:

1. **An explicit tick-box** naming what's collected and how long you keep it. ✅ **Built.**
2. **A retention schedule published on your website**, which your code then follows.
   ⚠️ **Does not exist. The consent screen already promises users it does.**

That second one is the urgent item. Right now the app makes a promise your website doesn't
keep.

**On keeping videos 1.6 years:** built, with one safety rule. If we don't *know* someone's
home state, we delete their video anyway. A phone's location tells you where the phone is,
not where the person lives — an Illinois resident on holiday in Florida is still protected by
Illinois law. Guessing wrong toward "keep the video" is a lawsuit. Guessing wrong the other
way costs a video you'd almost certainly never use.

---

## Your existing users

**Nothing changes for them.** They're all marked as already verified so nobody is interrupted.

**We record honestly that they never did a check.** The database says `grandfathered`, not
`didit`. If police ever ask, the system must not claim a face check happened when it didn't.

**Renewals are spread out.** If everyone were marked verified today, in exactly 90 days your
entire user base would hit the camera on the same morning. Each person gets a slightly
different start date instead, so renewals trickle in over two months.

**The honest consequence:** for the first 30–90 days the camera check applies only to *new*
users. Anyone already on AvaTok — including anyone already there who shouldn't be — is trusted
without ever showing their face. That's the price of not disturbing your users, and it fixes
itself as the window runs out.

---

## What this design does NOT do

**It doesn't stop a banned person coming back.**

The camera proves *a real live human is there*. It doesn't say *which* human, and it can't
recognise someone you've already thrown out. Someone banned for child abuse material can
make a new email, pass a fresh camera check, and be back in minutes.

The fix would be keeping banned people's faces on file and checking new faces against them.
You removed that deliberately — storing banned faces forever was the single largest legal
risk in the design. That's a reasonable trade. But it *is* a trade, and it's written into the
spec as an accepted gap, not something we forgot.

---

## Before you turn it on — three blockers

1. **Run the backfill migration first.** `worker/migrations/2026-07-10-identity-gating-backfill.sql`.
   Flip the flag before this and every existing user gets gated at once.
2. **Publish the retention schedule on your website.** BIPA requires it, and the app already
   promises it.
3. **Build the 584-day deletion sweep.** The table exists; nothing fills or empties it yet.
   Until then, deletion drops the video for everyone, and nothing is retained for a lawful
   request — the opposite of what you asked for.

Also worth doing, not blocking: get Didit's price above 500 checks/month, and add the spend
alarm. "500 free/month" is a cap, not a free tier, and with 90-day renewals it's up to four
checks per active user per year. Fine at MVP. Not fine after a growth push.

---

## What to test, as a user

⚠️ **Two caveats before you build.**

**First:** the gate is OFF. Nothing below happens until you flip `identityGatingEnabled` on
staging. Test with it off first — the app should behave exactly as it does today, minus the
phone screens.

**Second, and please read this one:** I could not compile or run anything. This project has
no local build tools, so 20+ files across the app and worker were edited without a compiler
checking them. I removed eight files and every reference I could find to them, and swept for
dangling imports — but **expect the first build to surface missing-import or unused-import
errors.** That's normal for a change this size and quick to fix. Send me the build log.

**With the gate OFF (do this first):**

- Sign up fresh. You should see **no phone screen** and **no camera**. Straight in.
- Open Profile. The personal phone box should still be there, with no "verify" button and no
  SMS. It should say we don't verify it.
- Open the Identity screen. The "Phone" row should be gone. "Video verified" should be there.
- Post something, create a listing, message someone, upload a photo. **Everything should work
  exactly as before.** If anything is blocked, that's a bug — the flag is off.

**Then flip `identityGatingEnabled` on staging:**

- Try to create a marketplace listing. You should get the consent screen, then the camera.
- **Untick the box.** The "Verify with camera" button must stay greyed out.
- **Close the consent screen.** You should be returned politely, and **no camera should have
  opened.** Nothing was recorded.
- Accept, pass the check, and post. Then post again — you should **not** be asked twice.
- Message someone you've **already** messaged. **No interruption.** This is the one most
  likely to be wrong; tell me if it gates you.
- Message someone brand new. You should be gated.
- Open the app as an existing (pre-migration) user. You should notice **nothing at all**.

**Report back anything that:** asks for a phone number, asks for the camera twice, gates a
conversation with an existing contact, or lets you post publicly without the check.
