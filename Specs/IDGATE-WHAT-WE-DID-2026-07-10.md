# What we did, in plain English — 10 July 2026

**Commit:** `296742d` on `main`. Pushed. **No build was triggered.**

---

## The problem you started with

You were paying Firebase for an SMS text message every time someone signed up. You wanted to
stop paying, but still know who your users were.

## Where we ended up

We stopped paying **and** stopped asking for phone numbers at all.

Here's the thinking that got us there:

- A phone number doesn't prove much. In the US, UK, Canada and about 60 other countries,
  anyone can buy a prepaid SIM with cash, no ID. So the number tells you nothing.
- Even where numbers *are* registered to a real ID, **you can't look anyone up.** No private
  company can. Only the police can ask a phone company who owns a number.
- So you were paying for something that mostly didn't work.

**What we replaced it with:** a quick video check of the person's face, done once, at the
moment they first try to post something in public.

## The new rules

| When | What happens |
|---|---|
| Someone signs up | Nothing. Email and password, or Google. That's it. |
| Someone just watches and reads | Nothing, ever. Never bothered. |
| Someone tries to **post publicly for the first time** | Camera check. Takes seconds. |
| 90 days later | Asked again, once. |
| Someone wants to withdraw money | Full ID check — **a separate project, not built yet.** |

"Posting publicly" means: a post, a marketplace listing, a comment, going live, messaging a
stranger, posting in a group, or uploading a public photo. Messaging your existing contacts
is **not** affected.

## Why the camera check comes *later*, not at signup

Two reasons, and the second one surprised us.

1. **Fewer people quit.** Nobody abandons signup over a camera they never see.
2. **It's a stronger deterrent.** A camera check weeks earlier, during a signup someone has
   forgotten about, doesn't put anyone off. A camera check *immediately before* they post
   something illegal does. It lands at the moment of intent — which is when a warning works.

---

## Three things we found along the way

### 1. A real security hole, now closed

The app had **four** different ways to mark a user as "verified." You only use one of them
(Didit). The other three were old code — but they were still switched on, and still connected
to the same "this person is verified" switch.

Meaning: someone could have marked themselves verified **without ever showing their face.**

That's now shut. If anyone tries those old routes, the server refuses and tells us about it.

### 2. Deleting evidence when we shouldn't

If someone posts child abuse material and gets reported, the law generally says you must
**keep** the evidence for the authorities. Your code was **deleting** it — including if the
user then asked to delete their account.

Now: any account under a report gets a "legal hold." Deletion refuses to run. If the system
can't tell whether a hold exists, it refuses anyway — because keeping data an extra day is
fixable, and destroying evidence isn't.

### 3. Your CSAM scanning isn't running

This one's bigger than this project, and you said you'd handle it separately, but you should
know: **no images on AvaTok are currently checked for child abuse material.** The code exists
and looks good, but it's switched off — the list of known-bad image fingerprints was never
loaded, so every check quietly passes. And if it ever did find something, it would log an
error rather than report it, because the reporting address isn't set.

The nudity detector works. That's a different thing and won't catch this.

---

## What's actually built right now

**Done (server side):**

- The camera-check gate exists, is switched **off**, and works for marketplace listings.
- The old bypass routes are closed.
- Deletion now respects legal holds.
- Consent is recorded before the camera opens (required by law — see below).
- Detailed tracking sent to PostHog so you can see exactly where people drop off.

**Not done yet (the app itself):**

- The consent screen the user sees.
- Turning the gate on for posts, comments, going live, DMs to strangers, group posts, uploads.
  **Right now only listings are gated.**
- Removing the old phone screens from the app.
- The "Video verified" badge.

**So there is nothing to test in the app yet.** That's the next piece of work.

---

## Two legal things you need to action

I'm not a lawyer and this needs a real one before launch. But two items are concrete:

**1. Illinois has a biometric law with teeth.** It's called BIPA. It applies to Illinois
residents no matter where your company is registered. It's the only such law that lets
*individuals sue you directly* — $1,000 to $5,000 per violation. It's what cost Facebook $650
million. Being a US company makes this *more* relevant, not less.

BIPA requires two things before you scan anyone's face:

- An explicit tick-box saying what you collect and how long you keep it. Not buried in the
  terms. Not pre-ticked. **The code now enforces this** — the camera won't open without it.
- **A retention schedule published on your website**, which your code then actually follows.
  ⚠️ **This does not exist yet. You need to write and publish it.**

**2. On keeping the videos for 1.6 years.** We built it, but with a safety rule: if we don't
*know* someone's home state, we delete their video anyway. Reason: a phone's location tells
you where the phone is, not where the person lives. An Illinois resident on holiday in Florida
is still protected by Illinois law. Guessing wrong in the direction of "keep the video" is a
lawsuit. Guessing wrong the other way costs you a video you'd almost certainly never use.

---

## What happens to your existing users

**Nothing.** They're all marked as already verified, so nobody gets interrupted.

Two details worth understanding:

**We record honestly that they never did a check.** The database says `grandfathered`, not
`didit`. If the police ever ask, we can't have the system claiming a face check happened when
it didn't.

**Their renewals are spread out.** If we'd marked everyone verified today, then in exactly 90
days your *entire user base* would hit the camera on the same morning. Instead each person is
given a slightly different start date, so renewals trickle in over two months.

**The honest consequence:** for the first 30–90 days, the camera check only applies to *new*
users. Anyone already on AvaTok — including anyone already there who shouldn't be — is trusted
without ever having shown their face. That's the price of not disturbing your existing users,
and it fixes itself as the window runs out.

---

## The thing this design does NOT do

**It doesn't stop a banned person coming back.**

The camera proves *a real live human is there*. It does not tell us *which* human, and it
can't recognise someone you've already thrown out. Someone banned for child abuse material
can make a new email, pass a fresh camera check, and be back in minutes.

The fix would be keeping a record of banned people's faces and checking new faces against it.
You removed that, deliberately, because storing banned people's faces forever is the single
biggest legal risk in the whole design.

That's a reasonable trade. But it *is* a trade, and it's written down in the spec as an
accepted gap — not something we forgot.

---

## What to do next

**Right now, nothing to test.** The app hasn't changed. The next piece of work is the Flutter
side, and after that you'd run a build and we'd test it properly.

**Three things only you can do:**

1. **Get a lawyer to read section 10 of the spec.** Specifically: is keeping face video for
   1.6 years after someone deletes their account defensible under BIPA's "delete it when
   you're done with it" rule?
2. **Write and publish the retention schedule on your website.** The code is already
   promising users it exists.
3. **Ask Didit what a liveness check costs above 500 per month.** "500 free/month" is a cap,
   not a free tier, and with 90-day renewals it's up to four checks per active user per year.
   Fine at MVP. Not fine the week after a growth push.

**When we do build the app side, here's what you'll test as a user:**

- Sign up fresh. You should see **no** phone screen and **no** camera. Straight in.
- Browse, watch, read. Nothing should ever interrupt you.
- Try to create a marketplace listing. The consent screen should appear, then the camera.
- Decline the consent box. You should be blocked politely, and **no camera should open.**
- Accept, pass the check, and post. Then post again — you should **not** be asked twice.
- Open the app as an existing user. You should notice absolutely nothing.
- Message an existing contact. No interruption.

Report back on anything that asks you for a phone number, asks for the camera twice, or lets
you post without the check.
