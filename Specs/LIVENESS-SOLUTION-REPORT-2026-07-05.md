# The Verification System — What We Built and When It Runs
### A plain-English report · 2026-07-05

---

## When does the check fire?

A person only meets this system in one situation: **they try to sell something.**

Signing up, chatting, calling — none of that asks for verification. But the moment they tap "Sell" or try to create a listing in the marketplace, the app quietly asks one question: *"Is this person already verified?"* It checks the answer saved on the phone first (instant), and if that says no, it double-checks with the server.

If they're already verified, nothing happens — they go straight into creating their listing and never see the check again. Verification is a one-time thing, forever.

If they're NOT verified, the verification flow opens. And even if someone found a way to skip the screen, it wouldn't matter — the server refuses to publish a listing from an unverified account. The app shows the friendly path; the server is the locked door.

## What the person sees (the new design, exactly as your mockup)

1. **Verify your phone** — they type their number and get a code by text. (If their phone is already confirmed from before, these first two steps are skipped automatically.)
2. **Enter the code** — the boxes fill themselves in as the SMS arrives. Wrong code shakes and lets them retry; there's a resend link with a real countdown.
3. **Fit your face in the oval** — the camera looks for one well-lit, level face and locks on automatically.
4. **Hold still — recording** — a short clip, a couple of seconds.
5. **Turn your head** — left, then right, with animated arrows. The phone itself confirms each turn.
6. **Read this aloud** — they pick a language (English, Spanish, French or German), get a random sentence, and read it out.
7. **Ava is checking your clips** — a progress screen driven by what's really happening (uploading, then the server checking).
8. **Accepted — you're in** — confetti, a "Verified" badge, and a button that takes them straight to creating their listing.

Every animation on every screen is tied to something real. Nothing is a fake progress bar. If something goes wrong — no signal, server busy, verification unavailable — they get an honest message and a retry button, never a dead screen.

## What happens behind the curtain

While the person does the steps, the phone itself does the first round of checking for free: is there exactly one face, are the eyes open, is the face uncovered, did the head really turn left and right. Retakes cost nothing because they never leave the phone.

When the take is good, the app shrinks everything down (small photos instead of huge ones — the whole upload is a few megabytes instead of nearly thirty) and sends it up. The server puts the job on a queue and checks, one by one: is this a live camera and not a photo of a screen; is it one real person; is the face uncovered; were the movements done; were the spoken words right; were the eyes open. Each check has a name and a plain-English reason, so if someone fails we can tell them exactly why — "We couldn't hear the phrase clearly," not just "failed."

**If they pass:** their account is marked verified forever, the evidence (a face photo, one profile shot, the clip) is kept for safety review, they get a "You're verified" notification, and the listing door opens.

**If they fail:** everything they uploaded is **deleted immediately**. We keep nothing from failed attempts. They can try again right away — as many times as they need (with a sensible daily cap so nobody can abuse it). And if they ever delete their account, all their verification evidence is erased at that moment — exactly what the screen promises.

## What we achieved (all of it is live right now)

The new animated design is in the app and wired end to end — including the phone and code screens from the final mockup, added today. The phone code is real (Firebase sends the SMS; the server records the confirmed number, blocks fake/VoIP numbers, and allows one phone per account).

The backend was rebuilt for scale and is **deployed**: the verification queue exists and is running, uploads are 20× smaller, failed evidence is deleted and passed evidence trimmed to the minimum, account deletion wipes everything, challenge sentences exist in four languages, and every attempt is tracked in PostHog so we can see pass rates, failure reasons and costs. All the switches are ON in production: the listing gate, the verification service, and the new V2 flow.

We also froze the blueprint for the next chapter — the **Trust Engine** (Specs/TRUST-ENGINE-ARCH.md): a bigger, cheaper, tamper-proof version of this system designed for a million checks a day, using AWS Rekognition for the heavy checking and no AI language models making decisions. That's designed and approved, but not built yet — today's system is what runs in production.

## The one thing left to do

Everything server-side is deployed and switched on. The only remaining step is yours:

**Run the Android build** (Actions → android.yml → Run workflow), install it, and try to create a listing with an unverified account. You should be greeted by the phone screen, and end at confetti.

One note for later: the phone-code step needs a small Firebase configuration (APNs key) before it works on **iPhone**. Android is ready now.

---
*Where things live: gate = `app/lib/features/identity/listing_liveness_gate.dart` · flow = `app/lib/features/identity/liveness_v2/` · server = `worker/src/routes/liveness.ts` · deployed worker version `6f37f645` · dashboards: PostHog annotations 96474/96478.*
