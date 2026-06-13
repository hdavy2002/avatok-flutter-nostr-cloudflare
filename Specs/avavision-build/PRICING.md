# AvaVision — Phase 0 Pricing & Engine Spike

**Owner deliverable. Numbers below are what Phase 1 hard-codes.** Throwaway spike lives in
`./spike/`. No product files touched. No commit. — 2026-06-13

> **Coin economics (from `worker/src/routes/avavoice.ts`):** `CREATOR_PAYS_RATE_PER_HOUR = 500`
> coins = $5/hr ⇒ **1 coin = $0.01**. `MIN_RATE_PER_HOUR = 100` coins ($1/hr) is the AvaVoice
> user-pays floor. `FEE_RATE = 0.5` (50/50). `perMin(rate)=ceil(rate/60)`. The **platform pays
> Google** for tokens out of its **50% share** (user-pays) or out of the **flat $5/hr** (creator-pays),
> so the platform's share — not the gross — must beat the token cost.

---

## 1. Verified token rates (ai.google.dev pricing, paid tier, June 2026)

**Live coach — `gemini-3.1-flash-live-preview`** (the model AvaVoice already uses with
`vision_enabled`; "audio-to-audio, multimodal awareness"):

| Direction | text | audio | image / video |
|---|---|---|---|
| **Input**  | $0.75 /M | **$3.00 /M** (≈ $0.005/min) | **$1.00 /M** (≈ $0.002/min) |
| **Output** | $4.50 /M | **$12.00 /M** (≈ $0.018/min) | — |

**Snapshot analyst — `gemini-3-flash-preview`** (Agentic Vision, code execution on):

| Direction | text / image / video | audio |
|---|---|---|
| **Input**  | **$0.50 /M** | $1.00 /M |
| **Output (incl. thinking)** | **$3.00 /M** | — |

Per the proposal §2.1 the on-the-wire token rates are: audio in **32 tok/s**, video in **≈100 tok/s
at `MEDIA_RESOLUTION_LOW`** (66 tok/frame), audio out ≈32 tok/s while the coach is speaking.

---

## 2. $/hr — voice-only vs voice + 1 fps LOW-res video

Model: mic open the whole hour, video the whole hour, coach **talks `T`% of the hour** (the only big
unknown). Two independent methods agree within ~25%; we set policy on the **conservative (token)**
column.

| Coach talk-time | Voice-only (token) | **Voice + video (token)** | Δ video | Voice+video (Google $/min) |
|---|---|---|---|---|
| 30% (mostly watching) | $0.77 | **$1.13** | +$0.36 | $0.74 |
| 50% (typical) | $1.05 | **$1.41** | +$0.36 | $0.96 |
| 70% (chatty coach) | $1.32 | **$1.68** | +$0.36 | $1.18 |

**Conclusions**
- **Voice-only ≈ $0.8–1.3/hr; voice + video ≈ $1.1–1.7/hr.**
- **The video layer adds a flat ≈ $0.36/hr** (1 fps LOW-res video input). It is the *small* cost; the
  dominant driver is **output audio** (the coach's voice at $12/M).
- **Worst realistic case (70% talk, voice+video) ≈ $1.55–1.68/hr.** Use **$1.60/hr** as the safety
  number for floor-setting.

---

## 3. Snapshot ("Analyze my form") cost + working model string

- **Working model string:** `gemini-3-flash-preview` (the master file's suggested default
  `gemini-3-flash` is an alias; the **exact id on the pricing page + AI Studio is
  `gemini-3-flash-preview`**). Phase 1 default for `AVAVISION_SNAPSHOT_MODEL` → **`gemini-3-flash-preview`**.
  Confirm against the live key at deploy (it is a preview id and may roll to GA `gemini-3-flash`).
- **Cost per snapshot:** one hi-res frame (~1k img tokens) + prompt + the code-execution loop's
  intermediate crops/annotations (a few extra image+text tokens) ≈ **6k input / 3.5k output tokens**
  → **≈ $0.014 floor, budget $0.02–0.05** all-in (code-execution can append several images).
- **Latency:** higher than the stream (Think→Act→Observe loop), expect **~5–15 s** — it is a
  deliberate "moment", not a per-frame call. (Exact figure: read the spike's on-page USAGE/elapsed
  panel against the live key; the spike posts a real 960×720 frame.)

---

## 4. Recommended platform minimum rate (user-pays)

Constraint: **platform's 50% share ≥ worst-case session token cost** so no user-pays listing loses
money. Worst case ≈ **$1.60/hr = 160 coins**, so `rate/2 ≥ 160 ⇒ rate ≥ 320`.

> ### ➡ `AVAVISION_MIN_RATE_PER_HOUR = 300` coins/hr  ($3/hr)  — recommended floor
> Platform share at the floor = 150 coins ($1.50/hr), covering the **typical** worst case with a thin
> buffer. Set **320** instead if you want to cover the 70%-talk + snapshot tail with positive margin.
> Either way it is **3×** AvaVoice's `MIN_RATE_PER_HOUR = 100`.

**⚠️ Flag for the owner:** AvaVoice's existing **100-coin ($1/hr) floor is itself marginal-to-underwater**
for a chatty agent (voice-only can reach ~$1.3/hr while the platform share is only $0.50/hr). AvaVision
deliberately does **not** inherit that floor — it sets its own higher one. This is a *new constant*,
`AVAVISION_MIN_RATE_PER_HOUR`, **not** a change to AvaVoice's value (rule 4: additive, don't touch AvaVoice).

---

## 5. Recommended `free_snapshots_per_session` (fair-use cap)

Snapshots are **bundled** (Q-AV1: no separate fee). They erode the *thin* user-pays margin faster than
the *fat* creator-pays one, so the cap is the safety valve.

- At ~$0.03–0.05/snapshot, **5 snapshots ≈ $0.15–0.25** — small vs a creator-pays $5/hr session, but
  meaningful against a user-pays session's ~$0.10–0.50/hr platform margin.

> ### ➡ Template default `free_snapshots_per_session = 3`  (recommended range **2–6**)
> 3 is plenty for a 5–10 min session ("Analyze my form" is a deliberate tap, not spam). Premium /
> higher-rate listings may set up to 6. Enforce with a **D1 counter column** (`snapshot_calls` on
> `avavision_sessions`) checked against the template value — **no Durable Object, no token bucket**
> (per MASTER §3). Past the cap, disable the button; never surprise-charge.

---

## 6. Does creator-pays $5/hr flat (500 coins) still cover voice + video?

**YES — comfortably.** Cost of a voice+video session is **$1.1–1.7/hr** incl. a handful of snapshots;
the flat creator charge is **$5/hr**. Margin ≈ **$3.3–3.9/hr**. **No price change needed** — keep
**$5/hr flat, vision bundled** (Q-AV3 holds). Even a 70%-talk session with 6 snapshots (≈$1.9/hr) stays
well under $5. Re-flag only if real measured talk-time pushes a session materially above ~$3/hr, which
the rates above make implausible.

---

## 7. Engine reality (for Phases 3, 4, 5)

Stack is **free + on-device only** (MASTER rule 7, proposal §2.6). Spike loads via CDN, no build step:

- **Pose (launch engine, all platforms incl. iOS): MoveNet via TF.js.** Model:
  `@tensorflow-models/pose-detection` MoveNet **SinglePose.Lightning** (17 keypoints), TFLite/TF.js
  from the tfhub/`tfjs-models` CDN. This is the iOS-safe pose answer — **MediaPipe Pose is NOT shipped
  for iOS**, so MoveNet is the cross-platform default. (Resolved §2.6 / Q-AV6.)
- **MediaPipe Tasks (web `@mediapipe/tasks-vision`, Android Tasks):** pose_landmarker (33-pt, the
  Android/Web richer upgrade), face_landmarker, hand_landmarker, gesture_recognizer, object_detector,
  image classifier, segmentation — all load from `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision` + the
  Google `mediapipe-models` storage bucket. The spike exercises **pose_landmarker_lite** end-to-end.
- **iOS gaps to remember:** MediaPipe `pose`, `face_landmark`, `holistic`, `segmentation` are **not on
  iOS** → templates needing them are Android/Web-only; **pose on iOS = MoveNet**. Hand / gesture /
  object / face-detect / image-class are cross-platform incl. iOS.
- **Video to Live is locked** to `MEDIA_RESOLUTION_LOW`, ~1 fps in the minted token — clients can't
  raise it. The MediaPipe/MoveNet overlay + geometry score is the precision layer and is **never
  streamed** (free).

> The spike (`./spike/index.html`) drives the camera, draws a MoveNet/MediaPipe skeleton + a live
> knee-angle score, opens the Live WS with a LOW-res 1 fps + mic stream, and posts one snapshot — run
> it with a manually-minted ephemeral token to read live USAGE numbers against the figures above.

---

## 8. Numbers Phase 1 must hard-code (summary)

| Constant | Value | Note |
|---|---|---|
| `AVAVISION_MIN_RATE_PER_HOUR` | **300** coins/hr ($3) | new constant; 3× AvaVoice; 320 for extra safety |
| `free_snapshots_per_session` (template default) | **3** | range 2–6; D1 counter, no DO |
| `AVAVISION_SNAPSHOT_MODEL` | **`gemini-3-flash-preview`** | code execution on; verify vs live key |
| Live model | `gemini-3.1-flash-live-preview` | env-overridable; voice fallback `gemini-live-2.5-flash-native-audio` |
| `CREATOR_PAYS_RATE_PER_HOUR` | **500** (unchanged) | $5/hr flat covers voice+video — no change |
| Video config in token | `MEDIA_RESOLUTION_LOW`, ~1 fps | server-locked, do not expose to client |

**Sources:** [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
proposal `Specs/AVAVISION-PROPOSAL.md` §2/§4 · `worker/src/routes/avavoice.ts` (coin/rate constants).
