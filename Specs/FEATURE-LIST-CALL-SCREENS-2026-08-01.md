# Call screens — complete feature list from `design/icoming5`

**Date:** 2026-08-01
**Source:** `design/icoming5/Incoming Call.dc.html` + `design/icoming5/On Call.dc.html`
**Status:** INVENTORY ONLY — nothing here is implemented yet.
**Decisions live in `PLAN-CALL-SCREENS-2026-08-01.md`** — owner rulings R1/R2 and
decisions D1–D13 answer every open question below. Read that for what we are
actually building; this file is the raw inventory it was derived from.

> **OWNER RULING R1 (2026-08-01): VIDEO IS REMOVED.** Section B6 is void.
> **OWNER RULING R2: Add call is AUDIO CONFERENCE ONLY.**
> **R3: keypad stays visible on ALL calls** (IVR is coming) — supersedes D3 below.
> **R4: the quick-reply menu stays open until dismissed**, with an ✕ exit icon —
> no auto-dismiss timer. **R5: up to 25 participants**, not 3.
>
> ⚠️ **AUDIT 2026-08-01 — DO NOT BUILD ADD CALL FROM THIS FILE.** A codebase
> audit found release blockers, including a live authorization hole
> (cross-user call control is NOT closed — the client never moved onto the
> secure endpoint). See PART 7 and the corrected 18-wave build order in PART 8
> of `PLAN-CALL-SCREENS-2026-08-01.md`.

Status key:
**[BUILT]** exists and works · **[PARTIAL]** exists but needs change ·
**[NEW]** does not exist · **[HARD]** new *and* architecturally significant

---

# A. INCOMING CALL SCREEN

Reduced from 7 controls to **4**. `Message`, `Voice Mail` and the standalone
`Block` button are **gone from the main screen**.

## A1. Identity display
| # | Feature | Status |
|---|---|---|
| 1 | Caller photo, circular, animated gradient ring | **[BUILT]** today |
| 2 | Rotating conic gradient + ripple wave animation | **[NEW]** cosmetic |
| 3 | "<Name> is calling" with animated `...` | **[PARTIAL]** name works, dots new |
| 4 | Subtitle "This is an AvaTOK to AvaTOK call" | **[BUILT]** |
| 5 | ~~"Call cost: Free" chip~~ | **REMOVED** in this design |

## A2. The four actions
| # | Feature | Status |
|---|---|---|
| 6 | **Report Spam** → opens a sheet (no longer a direct action) | **[PARTIAL]** |
| 7 | **Receptionist** → Ava takes the call **immediately** | **[PARTIAL]** |
| 8 | **Decline** → caller's call drops immediately | **[PARTIAL]** |
| 9 | **Accept** | **[BUILT]** |

## A3. Report Spam sheet — TWO options
| # | Feature | Status |
|---|---|---|
| 10 | Sheet: "Report spam — The call ends and <Name> is reported" | **[NEW]** |
| 11 | Option A: **Report spam** (report only, no block) | **[BUILT]** server-side |
| 12 | Option B: **Report spam and block user** | **[BUILT]** server-side |

> Today this is an `AlertDialog` with Cancel / Report only / Report & block.
> The design wants a bottom sheet with two rows. Same two outcomes — the API and
> the `alsoBlock` flag already exist and need no change. **UI-only.**

## A4. Quick replies — ORPHANED
| # | Feature | Status |
|---|---|---|
| 13 | Quick-reply sheet markup still present in the design file | **ORPHANED** |

> The sheet is defined in the design (7 canned replies) but **no button opens
> it** — `openSheet` is never called. `Message` was removed from the screen.
> **DECISION NEEDED:** delete quick replies entirely, or reach them another way?
> I built the server side today (`/api/call/quick-reply`, server-owned catalog),
> so it works — it just has no entry point in this design.

## A5. Removed — confirm intentional
| Feature | Was | Now |
|---|---|---|
| **Message / quick reply button** | on screen | **gone** |
| **Voice Mail button** | on screen | **gone** |
| **Block** as its own button | on screen | **now only inside the spam sheet** |
| Call-cost chip | on screen | **gone** |

> Phase 3 voicemail work I did today (callee's Voice Mail → caller records →
> lands as a normal audio message) now has **no way to be triggered**. Tell me if
> voicemail is dropped, or moved somewhere else.

---

# B. ON CALL SCREEN

## B1. Call status display
| # | Feature | Status |
|---|---|---|
| 14 | Peer photo, circular, animated gradient ring | **[BUILT]** |
| 15 | Live call timer `MM:SS` | **[BUILT]** |
| 16 | Animated equaliser bars beside the timer | **[NEW]** cosmetic |
| 17 | **Second avatar appears beside the first while adding a call**, with its own ripple + "Ringing <name>…" | **[NEW]** |

## B2. The controls — now FIVE + End call (video removed, R1)
| # | Feature | Status |
|---|---|---|
| 18 | **Mute / Unmute** — toggles, label and colour change | **[BUILT]** |
| 19 | **Keypad** — DTMF, ALL calls (R3) | **[PARTIAL]** see B3 |
| 20 | **Audio** (speaker toggle) | **[BUILT]** |
| 21 | **Add call** — audio conference only (R2) | **[HARD]** see B5 |
| 22 | ~~**Video**~~ | **REMOVED — owner ruling R1** |
| 23 | **Pause** (user-initiated hold) | **[PARTIAL]** see B4 |
| 24 | **End call** | **[BUILT]** |

## B3. Keypad sheet
| # | Feature | Status |
|---|---|---|
| 25 | 12-key grid with letters (ABC/DEF/…) | **[NEW]** |
| 26 | Dialed-digits display, capped at 14 chars | **[NEW]** |
| 27 | Green call button in the sheet (`dialCall`) | **[NEW]** |

> **AMBIGUITY:** on a live call a keypad normally sends **DTMF tones** (for IVR
> menus — "press 1 for sales"). But this design has a **green CALL button**,
> which implies *dialling a new number*, not sending tones. Which is it? If
> dialling, it is a second "Add call" entry point and inherits everything in B5.

## B4. Pause / hold
| # | Feature | Status |
|---|---|---|
| 28 | Full-screen overlay "Call is on hold / <Name> can't hear you right now" | **[NEW]** |
| 29 | "Get back" button to resume | **[NEW]** |
| 30 | User-initiated hold | **[PARTIAL]** |

> There IS a hold mechanism (`CALL-FOCUS-1`) but it is **involuntary** — it fires
> when another app steals audio focus. The design wants **deliberate** hold.
> Needs: tell the peer they are on hold, actually stop transmitting, and a
> defined behaviour if BOTH sides hold.

## B5. ⚠️ ADD CALL — architecturally significant
| # | Feature | Status |
|---|---|---|
| 31 | Contact picker titled **"Add to call"** | **[NEW]** |
| 32 | Tap a contact → they start ringing **while the current call continues** | **[HARD]** |
| 33 | Second ringing avatar shown next to the current peer | **[NEW]** |
| 34 | Timeout → "<Name> is not available — They didn't pick up, you're still on your call with <Peer>" + "Back to call" | **[NEW]** |
| 35 | **Return-to-call banner** while browsing contacts: "On call with <Name> · MM:SS / Tap to return to the call" | **[NEW]** |

### Why this is not a small feature

A 1:1 AvaTOK call is **peer-to-peer WebRTC through the CallRoom Durable Object,
which has a hard 2-peer cap**. That cap is load-bearing and is documented in
`CLAUDE.md` as *"do NOT raise the cap"* — it is what makes glare handling,
reconnect-grace and duplicate-session detection work.

Adding a third person is therefore **not** "allow a third socket". It is a
**mid-call migration from peer-to-peer to a conference server**.

> ⚠️ **CORRECTED 2026-08-01 — the paragraph below was wrong when written.**
> **LiveKit was REMOVED on 2026-07-24.** `worker/src/routes/conference.ts` is now
> a tombstone that returns a typed failure so old clients know to update. The
> real conference is Cloudflare-native: `worker/src/routes/groupcall.ts` +
> `worker/src/do/group_call_room.ts` +
> `app/lib/features/conference/cloudflare_conference_controller.dart`, flagged
> `cloudflareConferenceEnabled`, capped at 25.
>
> And the audit found it is **not** reusable as-is: join tickets are replayable,
> the "6 of 25" audio limit is a cap rather than a selection, conference billing
> does not exist, and the client cannot do the silent warm-up the migration
> depends on. See PART 7 of `PLAN-CALL-SCREENS-2026-08-01.md`.

<s>The good news: **the conference infrastructure already exists** —
`worker/src/routes/conference.ts` and `app/lib/features/conference/` (LiveKit,
≤25 participants, behind `conferenceEnabled` / `livekitConferenceEnabled`). It is
used today for *group* calls that start as conferences.</s>

What does not exist is the **transition**: an established P2P call becoming a
conference without dropping audio. Open questions I need answered before
building:

- Does the existing call **continue** during the migration, or is a brief audio
  gap acceptable?
- If the third person **declines or doesn't answer**, does the original call stay
  P2P (cheaper, better quality) or stay on the conference server?
- Does the **original peer** need to consent, or even be told, that someone is
  being added?
- What is the **maximum**? The conference cap is 25, but a phone-style "add call"
  usually implies 3–5.
- **Billing** — a conference is a different cost model to P2P.

## ~~B6. VIDEO~~ — **DELETED (owner ruling R1, 2026-08-01)**

**Video is removed from the design.** No toggle, no mid-call conversion.
`config.video` stays immutable for the life of the call, which is what all 41
read sites already assume. Nothing below is being built — it is kept only to
record what the ruling saved us from.

<details>
<summary>Original analysis (void)</summary>

| # | Feature | Status |
|---|---|---|
| 36 | Video toggle converts the live audio call to video | **VOID** |
| 37 | Button shows active state when video is on | **VOID** |

### Why this was not a small feature

`config.video` is read **41 times** in `call_session.dart` and is treated as
**fixed for the whole life of the call**. It is decided at dial time and several
*outcome* paths branch on it — including receptionist and voicemail eligibility
(`if (!config.video …)`).

Turning it into something that changes mid-call means:

- **WebRTC renegotiation** — adding a video track to a live peer connection, a
  fresh offer/answer through the CallRoom DO.
- **Camera permission** requested *mid-call*, and a defined behaviour if refused.
- Auditing all 41 branches — several assume video-ness never changes.
- **Consent**: does the other side have to accept becoming a video call, or does
  their camera just turn on? (Strong privacy expectation — my assumption is it
  must be a request they accept, but confirm.)
- One-way video (I show, you don't) — allowed or not?
- Bandwidth/cost, and what happens when it fails.

</details>

## B7. Contacts panel
| # | Feature | Status |
|---|---|---|
| 38 | Full-screen contacts list over the call | **[NEW]** |
| 39 | Rows: avatar w/ initials + colour, name, subtitle | **[NEW]** |
| 40 | Subtitle shows the channel: "Avatok · Free call" / "Mobile" / "Work" | **[NEW]** |
| 41 | Panel title switches "Add to call" ↔ "Contacts" | **[NEW]** |

> **NOTE:** there is a `contacts` view and a `contacts()` handler in the design's
> code, but in `icoming5` **no button calls it** — the sixth slot is `Pause`.
> Contacts existed as a button in the earlier `incoming3` design and was
> replaced. So today Contacts is reachable **only** via "Add call".
>
> You said you were interested in Contacts, so please confirm: is Contacts meant
> to have its own button (making seven controls), or is browsing contacts *only*
> for adding someone to the call?

## B8. Feedback
| # | Feature | Status |
|---|---|---|
| 42 | Toast confirmations for every action | **[NEW]** |

---

# C. THINGS THE DESIGN DOES NOT COVER

Not criticism — just gaps I would otherwise have to invent:

1. **Incoming call while already on a call** — the design shows adding someone
   *out*, never a third party calling *in*. Is there call waiting?
2. **The added person's incoming screen** — do they see "Davy is calling" or
   "Davy is adding you to a call with Arti"?
3. **Who can hear whom** during add-call ringing — can the original peer hear the
   ringback?
4. **Removing** a participant once added.
5. **Leaving** a 3-way call — does it end for everyone, or continue without you?
6. **Video + conference together** — is a 3-way video call in scope?
7. **Receptionist / voicemail entry points** now that those buttons are gone.
8. **Landscape / small screens** — the On Call grid is a fixed 330px, three
   columns.

---

# D. MY RECOMMENDED BUILD ORDER

**Wave 1 — no architectural risk, immediate visible value**
Incoming screen rebuild (4 controls, spam sheet with 2 options), Receptionist
goes to Ava immediately, Decline drops the call. This is the frozen
decline-vs-receptionist work already planned.

**Wave 2 — self-contained On Call additions**
Mute/Audio/End are done. Add: keypad sheet, Pause with the hold overlay, the
contacts panel, the return-to-call banner, timer equaliser, toasts.

**Wave 3 — Add call** (needs the B5 questions answered)

**Wave 4 — Video toggle** (needs the B6 questions answered)

Waves 3 and 4 are each a genuine project. I would not bundle either into a
release that also carries the decline/receptionist fixes — if something breaks,
you want to know which change did it.

---

# E. OPEN QUESTIONS — ALL ANSWERED

Answered in `PLAN-CALL-SCREENS-2026-08-01.md`. Summary:

| Question | Answer | Where |
|---|---|---|
| Message / quick-reply — dropped or moved? | **Moved.** Button removed; menu opens *after* the decline commits and **stays open until dismissed** via an ✕ icon (R4). Implemented as a post-call courtesy message, not a call command — see audit finding F | D2 / R4 |
| Voice Mail — dropped or moved? | **Moved.** No longer a callee button — it becomes an automatic *outcome* offered to the caller when nobody takes the call | D1 |
| Keypad — DTMF or dial? | **DTMF only, visible on ALL calls** (R3 — IVR is coming). Green dial button still removed. **Feasibility unproven:** Cloudflare's SFU documents Opus and G.711, not RFC 4733 telephone-event | R3 |
| Contacts — own button? | **No.** Reachable only via Add call, as drawn | D4 |
| Add call — max participants? | **25** (R5), via a live switch to the Cloudflare SFU | R5 |
| Add call — peer consent? | **Told, not asked.** Disclosure + join tone, no modal | D7 |
| Add call — if they don't answer? | **Nothing happens.** Ring out-of-band, migrate to conference only *on answer* | D5 |
| Video — consent model? | **Void — video removed** | R1 |
| Call waiting? | **No** in v1 — second caller goes to receptionist | D8 |
| Removing a participant? | **No** in v1 — anyone may leave, nobody may remove | D9 |
| Leaving a call? | **Call continues.** Hosting transfers to the longest-present eligible participant; **billing does NOT transfer** — the initiator stays the sponsor. Automatic billing transfer is deferred as an abuse vector | D10 |
| Added person's screen? | *"Adding you to a call with \<Peer\>"* | D12 |
| Ringback during add? | **Adder only** | D11 |
| Landscape? | **Portrait-locked** | D13 |
