# Call screens — complete feature list from `design/icoming5`

**Date:** 2026-08-01
**Source:** `design/icoming5/Incoming Call.dc.html` + `design/icoming5/On Call.dc.html`
**Status:** INVENTORY ONLY — nothing here is implemented yet. Review and tell me
what is missing or wrong before I build.

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

## B2. The six controls
| # | Feature | Status |
|---|---|---|
| 18 | **Mute / Unmute** — toggles, label and colour change | **[BUILT]** |
| 19 | **Keypad** — DTMF sheet | **[PARTIAL]** see B3 |
| 20 | **Audio** (speaker toggle) | **[BUILT]** |
| 21 | **Add call** — add a person to the live call | **[HARD]** see B5 |
| 22 | **Video** — convert the live audio call to video | **[HARD]** see B6 |
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

The good news: **the conference infrastructure already exists** —
`worker/src/routes/conference.ts` and `app/lib/features/conference/` (LiveKit,
≤25 participants, behind `conferenceEnabled` / `livekitConferenceEnabled`). It is
used today for *group* calls that start as conferences.

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

## B6. ⚠️ VIDEO — architecturally significant
| # | Feature | Status |
|---|---|---|
| 36 | Video toggle converts the live audio call to video | **[HARD]** |
| 37 | Button shows active state when video is on | **[NEW]** |

### Why this is not a small feature

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

# E. WHAT I NEED FROM YOU

1. Are **Message/quick-reply** and **Voice Mail** dropped, or moved?
2. Keypad — **DTMF tones** into the live call, or **dial a new number**?
3. Should **Contacts** have its own button, or stay inside Add call?
4. Add call: does the original peer consent, what is the max, and what happens
   if the added person doesn't answer?
5. Video: does the other side have to **accept** becoming a video call?
6. Anything in section C you have an opinion on.
