# Call screens — master plan

**Date:** 2026-08-01
**Supersedes:** the scope sections of `PLAN-DECLINE-VS-RECEPTIONIST-2026-08-01.md`
(its *diagnosis* is still valid and still referenced below)
**Companion:** `FEATURE-LIST-CALL-SCREENS-2026-08-01.md` (the 42-item inventory)
**Status:** PLAN. Decisions D1–D13 are my recommended defaults, taken because the
owner asked for the most logical answer rather than another round of questions.
Any of them can be overturned with one line.

---

# PART 1 — OWNER RULINGS (2026-08-01)

| # | Ruling |
|---|---|
| **R1** | **Video is REMOVED.** No video toggle, no mid-call video, no `config.video` mutation. The 6th control slot is freed. |
| **R2** | **Add call is AUDIO CONFERENCE ONLY.** Adding a person converts the call to an audio conference. Never video. |

**What R1 buys us.** Section B6 of the feature list is deleted outright. The 41
`config.video` reads in `call_session.dart` stay exactly as they are — immutable
for the life of the call, which is what every one of them already assumes. This
removes the single largest source of risk in the whole design, and it removes it
for free. No renegotiation, no mid-call camera permission, no consent model, no
audit of 41 branches.

**Control grid is now 5 + End call:** Mute · Keypad · Audio · Add call · Pause.

---

# PART 2 — DECISIONS (the questions, answered)

## D1. Voice Mail is an OUTCOME, not a button

**Decision:** delete the Voice Mail button. Voicemail becomes automatic.

**Why.** No phone on earth asks the *callee* to press "voicemail". Voicemail is
what happens *to the caller* when nobody takes the call. Making it a button was
always modelling it from the wrong side.

The rule:

> When the callee's ring leg ends without an answer — declined, timed out, or
> receptionist unavailable — **and** the receptionist did not take the call, the
> caller is offered "Leave a voice message".

The Phase 3 work built today is **not wasted**. The recording flow, the upload,
and the delivery as a normal audio message all stay. Only the trigger moves: from
a callee button to a server-decided outcome. That is strictly better, because the
server already owns the outcome — this puts voicemail on the same authority as
every other disposition instead of beside it.

**Gate:** `voicemailEnabled` flag, plus a per-user "let callers leave me voice
messages" setting.

## D2. Quick replies attach to Decline — and never delay it

**Decision:** keep quick replies. Remove the Message button. After a decline
commits, show the callee a **non-blocking strip for ~6 seconds**: *"Send <Name> a
message?"* with the reply chips.

**Why.** The whole point of the realtime-decline work is that Decline is
instantaneous. Any UI that sits *between* the tap and the disconnect fights that.
So the message step moves to *after* the call is already gone — the caller has
been dropped, and the reply arrives a moment later as a chat message. The callee
loses nothing; the caller's call still dies instantly.

This is the only ordering that satisfies both goals at once.

**Do not** show the strip when the action was Report Spam or Block — replying to
someone you just reported is incoherent.

## D3. Keypad = DTMF only, and hidden on app-to-app calls

**Decision:** the keypad sends DTMF tones. It does **not** dial. Remove the green
call button from that sheet. Show the Keypad control **only on PSTN/DID calls**;
on AvaTOK-to-AvaTOK calls it is hidden.

**Why.** DTMF exists to talk to phone menus — "press 1 for sales". An
AvaTOK-to-AvaTOK call has no menu to talk to, so the keypad is dead weight there.
And the green button in the mock is dialer boilerplate: dialling a new number
mid-call is *exactly* Add call, so having both is two doors to one room, which is
how the two-Decline-buttons bug happened in the first place.

**Freed slot on app-to-app calls** — leave it empty rather than inventing a
control to fill it.

## D4. Contacts stays inside Add call

**Decision:** no separate Contacts button. Contacts opens only via Add call, and
the panel title is always **"Add to call"**.

**Why.** During a live call there is exactly one reason to open contacts: to add
someone. A standalone Contacts button invites the user to wander off mid-call,
and then we owe them a whole browsing experience layered over an active session.
The design as drawn is right — I was wrong to flag the missing button as a gap.

The return-to-call banner still ships, because the picker is full-screen and the
user must always be one tap from the conversation.

## D5. Add call migrates on ANSWER, not on dial ⭐

**Decision:** when you tap a contact, the current call **stays peer-to-peer** and
the third person is rung **out of band**. Only when they **answer** do all three
move to the audio conference.

**Why this is the important one.** The obvious implementation — move to the
conference first, then ring — puts the existing, working, healthy call at risk
for a person who may never pick up. Most add-call attempts fail: no answer, busy,
declined. Under the obvious design, every one of those failures has already
degraded a call that was fine.

Ringing out of band means:

- If they **don't answer** → nothing happened. The P2P call was never touched.
  There is no "migrate back", because there was no migrate.
- If they **answer** → one migration, at the exact moment it is justified.

This turns the risky path into the rare path.

**Cost:** a brief audio gap at the moment of the switch. Budget **≤800 ms**, and
cover it with a short local tone plus "Joining <Name>…". Measure it; if it
exceeds 800 ms in the field, that is a release blocker.

## D6. Maximum 3 participants in v1

**Decision:** you + 2. The LiveKit room is capped at 3 for calls created by Add
call, not 25.

**Why.** Three is the phone-shaped expectation, it is the smallest thing that
proves the migration works, and it bounds the cost of a feature whose billing we
have not yet modelled. Raising the cap later is a number change, not a redesign.
Shipping at 25 first and discovering a problem is not recoverable in the same way.

## D7. The original peer is TOLD, not ASKED

**Decision:** no consent prompt. Mandatory disclosure instead — the peer's screen
shows the third avatar and *"Davy is adding <Name>"*, plus a short join tone when
they arrive.

**Why.** A consent dialog mid-conversation is unanswerable: you are talking, your
phone is at your ear, and a modal is demanding a decision about something that
has not happened yet. Every conference phone in existence discloses rather than
asks.

But privacy is real, and the thing that protects it is **knowing**, not
approving. The peer sees who joined and when, and can leave. Silent third-party
addition would be indefensible; this is not that.

## D8. No call waiting in v1

**Decision:** a second incoming call while you are on a call does **not** ring.
It goes straight to the receptionist if enabled, otherwise to a missed call.

**Why.** Call waiting needs a *held incoming leg* — a state the frozen multi-leg
model does not have. Adding it means new leg states, new commands, new
authorization, and a second ring surface competing with a live call. That is the
exact shape of the bug class we just spent this session eliminating. It is a
separate project and it should be one.

The receptionist makes this a genuinely good outcome rather than a compromise:
the caller gets Ava, not silence.

## D9. Anyone can leave; nobody can remove

**Decision:** no "remove participant" in v1. Each person can end their own leg.

**Why.** Removal needs a permission model — who may eject whom, and what the
ejected person is told. That is a moderation feature. For a 3-person call between
people who know each other, the social protocol ("I'll drop off") is sufficient.

## D10. If the host leaves, the call ends

**Decision:** when the person who initiated the call hangs up, the conference
ends for everyone, with *"<Name> ended the call"*.

**Why.** The conference is anchored to the initiator's session and billed to
them. Letting the other two continue means an active, billable conference whose
owner has left — and no defined answer to who pays or who can end it. Host-leaves
ends it is the honest, cheap rule. Host transfer is a real feature and can come
later if it is ever wanted.

## D11. Only the adder hears ringback

**Decision:** during the out-of-band ring, ringback is audible **only** to the
person adding. The original peer hears nothing and sees the UI change.

**Why.** Pushing a ringing tone into someone's ear mid-sentence is unpleasant and
serves no purpose — they are not the one waiting.

## D12. The added person is told what they are joining

**Decision:** their incoming screen reads *"<Name> is calling"* with the subtitle
**"Adding you to a call with <Peer>"**.

**Why.** Answering into a conversation you did not know was in progress, with a
person you did not expect, is a genuine unpleasant surprise. One line removes it
entirely.

## D13. Portrait-lock the call screens

**Decision:** lock Incoming and On Call to portrait.

**Why.** The grid is a fixed three-column layout; landscape would need a second
design that nobody has drawn. Every phone dialer is portrait-locked.

---

# PART 3 — REMAINING CORRECTNESS WORK (unchanged, still the priority)

None of Part 2 should ship before this. These are the outstanding items from
`REPORT-REALTIME-DECLINE` and `PLAN-DECLINE-VS-RECEPTIONIST`, still open:

### P0-a. `decline` and `receptionist` become separate commands
Not one command with a route flag. `call.decline` terminates the caller leg;
`call.route_to_receptionist` **preserves** it. They share infrastructure —
envelope, epoch CAS, idempotency, audit — and **no business semantics**. This is
what makes the caller stop seeing "Declined" when the callee chose Ava.

Failure of the receptionist must terminate as `receptionist_failed`, never
through `declined`. *The caller was not declined. A service failed.*

### P0-b. Remove the caller's autonomous ring-timeout authority
**The single most important fix left.** Today the caller starts Ava when its own
local ring timer expires. That is why a fast decline still loses sometimes —
we are racing the caller's clock instead of obeying the server.

> The caller may REQUEST or DISPLAY. It must not DECIDE.

Making decline faster only makes it *usually* win. This makes it *always* win.

### P0-c. One incoming-action coordinator
Native CallKit, branded Flutter screen, notification action, timeout callback and
the plugin's `ended` callback all enter through one function. The surface becomes
telemetry (`interaction_source`) and never selects behaviour. This is the fix for
"the top Decline behaves differently from the bottom one" — that bug is
duplicated *interaction ownership*, not duplicated cleanup.

### P0-d. Deterministic ring-surface teardown
Call-derived notification id (`stableHash("incoming_call:$callId")`, not the
global `8005`), exact plugin call UUID for `endCall`, never "end all calls".

### P1. Release gate 3 is still only half-closed
No live old-client → new-worker smoke test, because staging D1 is missing the
`avatok_numbers` migration and `/api/me` 500s. **Apply that migration to staging**
— it is blocking the only environment where compatibility can be proven.

---

# PART 4 — THE APP ICON

## What I found

**The icon is correct and it did ship.** Provenance:

- `232ebe06` committed the new icon (cyan disc, serif A, white ring) at all six
  densities plus foreground and round variants.
- Build **30690875915** = run **#471** = **versionCode 10471**, built from
  `d3f29ded`. `232ebe06` is an ancestor of `d3f29ded` — verified with
  `git merge-base --is-ancestor`.
- Prod KV `latestAppBuild = 10471` — the update flag was bumped correctly.
- Nothing in CI regenerates icons: there is no `flutter_launcher_icons` package,
  and `postcreate.py` only adds the `roundIcon` manifest attribute.

So the pipeline did its job. **The phone is the remaining variable**, and it is
one of two things:

1. **The phone is still on an older build.** Check: AvaTOK → About. If it does
   not say **10471**, the update was never installed and the old icon is correct
   for the build that is running.
2. **It installed 10471 but the launcher cached the old icon.** Android launchers
   cache icons aggressively and often do not refresh on in-place update. A reboot
   settles it.

I could not resolve which from telemetry — **no PostHog MCP is connected in this
session**, so I could not read `$app_build` for the device. That check is
normally mandatory before diagnosing anything device-shaped, and I am flagging
that I could not do it rather than guessing past it.

## The real bug I did find

**The working tree had been reverted to the OLD icon.** All 15 PNGs were sitting
modified-but-uncommitted, with the pre-`232ebe06` content and **filesystem
timestamps of Jul 31 15:43** — i.e. old files restored *with their original
mtimes*, which a plain `git checkout` does not do.

That matters twice over:

- The **next** build would have silently shipped the old icon again, and it would
  have looked like the same bug recurring.
- The mtime preservation suggests a file-copy or sync process wrote over the
  tree. The repo moved out of iCloud on 2026-07-31 precisely because iCloud was
  corrupting it. **Worth watching for other reverted files.**

**Restored** — the tree now matches `HEAD` and is clean.

## Recommended guard

CI should fail if the committed icon hash does not match the icon generated from
`design/app-logo2.png`. A silently reverted binary asset is invisible in a diff;
a hash check makes it loud.

---

# PART 5 — BUILD ORDER

| Wave | Contents | Risk |
|---|---|---|
| **1** | P0-a … P0-d. Separate commands, kill the caller's timeout authority, one coordinator, deterministic teardown. | Medium — but this is the bug class |
| **2** | Incoming screen final: 4 controls, Report Spam sheet with 2 rows, post-decline quick-reply strip (D2), voicemail as an outcome (D1) | Low |
| **3** | On Call self-contained: Pause + hold overlay, DTMF keypad on PSTN only (D3), equaliser, toasts, portrait lock | Low |
| **4** | **Add call** — out-of-band ring, migrate on answer (D5), 3-person cap (D6), disclosure (D7), contacts panel, return-to-call banner | High |
| **5** | Staging D1 migration → close release gate 3 | Low |

Wave 4 does not travel with anything else. If a conference migration breaks a
call, that must be the only change in the build.

**Deleted from the plan entirely:** video toggle (R1).
