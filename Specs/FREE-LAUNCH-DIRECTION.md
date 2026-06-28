# Free Launch Direction — AvaTOK (owner-locked 2026-06-28)

**Goal:** ship a focused, **all-free** product to attract users. Surface ONLY the
core communication features below; **hide everything else** behind flags. This is
the direction for the NEXT session to execute toward live production.

> Status: DISCUSSED + LOCKED with owner. No code written in this session beyond
> this doc. Prior LiveKit work (free-SFU-on-Cloud `0d836f3`, region router
> `ce626db`) is **superseded for this launch** by Cloudflare SFU group audio —
> keep that code dormant behind flags, do NOT delete (paid/video may return).

---

## 1. The locked free feature set (the ONLY things users see at launch)

1. **Messaging** — core text/media/voice-notes/etc. Keep. (incl. safety shield —
   Guardian stays ON, it's a trust differentiator and free.)
2. **1:1 calls** — **P2P, keep video** (P2P video costs us nothing). Cloudflare
   TURN/STUN. Unlimited. **Unchanged.** Do NOT route through an SFU.
3. **Group AUDIO calls** — **audio-only, max 32, NO user time limit**, on
   **Cloudflare Realtime SFU + Cloudflare TURN/STUN/ICE**, with **active-speaker
   forwarding**. **No video** (bandwidth hog). **Move OFF LiveKit.**
4. **Free phone number + dialpad** — P2P calls; AI receptionist can pick up.
   Transport unchanged (P2P + CF TURN/STUN).
5. **AI receptionist** — Gemini Live. Keep. (Flip `receptionistEnabled` ON.)
6. **Basic free Ava chat** — keep a **capped** free Ava assistant on the free
   AI key (Gemma/free Gemini). NO premium add-ons (no web search, no file
   analysis, no image gen).

**Billing:** **all free, no paywalls.** Set `betaFreePremium` ON / `billingEnabled`
OFF. Hide Subscribe/upgrade/wallet-topup UI. Reversible later.

---

## 2. Media architecture decisions (LOCKED)

### Group audio → Cloudflare Realtime SFU (NEW build)
- **Audio-only**, **32-participant** cap, **no user-facing time limit**.
- **Active-speaker selection**: each client pulls only the top ~3–6 loudest
  talkers, NOT all 31. (CF Realtime is pull-based/programmable — natural fit.)
  This is THE key to good 32-person audio + tiny bandwidth.
- Transport: Cloudflare Realtime SFU; NAT via Cloudflare TURN/STUN/ICE
  (`TURN_KEY_ID`/`TURN_KEY_API_TOKEN`, already wired via `mintIceServers`).
- **Replace** the LiveKit room/JWT path in `conference.ts` for the GROUP path with
  CF Realtime's session/track API (different model: sessions + tracks, not
  rooms + JWT). Keep plan-gating/telemetry scaffolding; drop the `conf_min` daily
  cap (free = no limit). Set telemetry `provider = "cloudflare_sfu"`.
- **Ops backstops (not user-facing):** empty-room/idle timeout, zombie-call
  cleanup, sane max duration (~12–24h) to kill stuck calls, bandwidth alert +
  global kill switch (`conferenceEnabled`).

### 1:1 + dialpad → stay P2P (NO SFU)
- An SFU does **not** improve 1:1 audio — it forwards the same Opus packets through
  an extra hop (more latency, a failure point, zero quality gain). Keep P2P.
- **Audio-quality levers instead of topology:** Opus **FEC** on, bitrate **~32–48
  kbps** for voice, **DTX** on; ensure **AEC + noise suppression + AGC** and a
  tuned jitter buffer. Reliable Cloudflare TURN for fallback. (These are the real
  quality wins — and free.)
- Cross-continent stability already comes from CF TURN's nearest-edge relay; no
  SFU needed for 1:1.

### AI receptionist → Gemini Live, unchanged.

---

## 3. Flags — set for launch (`worker/src/routes/config.ts` / KV `platform_config`)

**ON / keep:**
- `conferenceEnabled` = true (repurposed: audio-only CF SFU group calls)
- `numberFeatureEnabled` = true
- `ringbackEnabled` = true
- `guardianEnabled` = true (safety shield — free, trust driver)
- `aiEnabled` = true + `companionEnabled` = true (basic free Ava chat)
- `receptionistEnabled` = **true** (currently default OFF — flip ON via KV)

**OFF / hide for launch:**
- `billingEnabled` = false, `betaFreePremium` = true (no paywalls)
- `liveEnabled`, `consultEnabled` (marketplace / paid consulting)
- `avavoiceEnabled`, `avavisionEnabled` (agent builders)
- `translationEnabled`, `translationGroupEnabled` (Gemini-Live cost)
- `avaAffiliateEnabled`, `affiliateAssetKitEnabled`
- `webSearchEnabled`, `fileAnalysisEnabled`, `generativeEnabled` (premium AI cost)
- `brainEnabled`, `verseEnabled` (secondary; revisit later)
- `teamIvrEnabled` (already off)

**Client:** hide nav/entry points for every hidden feature above (don't just
server-gate — remove the UI so the app looks focused). Hide Subscribe/upgrade,
wallet top-up, marketplace tabs, AvaVoice/AvaVision/Consult/Translate entries.

---

## 4. What survives untouched (transport-agnostic)
PostHog telemetry + the conference dashboard (id 779066), the safety pipeline,
messaging/search/contacts. Only update telemetry `provider` to `cloudflare_sfu`
for the new group path.

---

## 5. Next-session task list (execution)
1. Build Cloudflare Realtime SFU group-audio path (worker session/track API +
   client), audio-only, 32 cap, active-speaker pull, CF TURN. Remove LiveKit from
   the group path; drop `conf_min` cap for free; keep telemetry (`provider=
   cloudflare_sfu`).
2. Add ops backstops + bandwidth alert + verify against CF Realtime 1,000 GB/mo
   free tier.
3. Tune 1:1/dialpad Opus (FEC + ~32–48 kbps + DTX) and confirm AEC/NS/AGC on.
4. Flip flags per §3; hide all non-launch UI in the client.
5. Set `betaFreePremium` ON / `billingEnabled` OFF; remove paywall UI.
6. Flip `receptionistEnabled` ON; smoke-test Gemini Live receptionist.
7. Regression pass: 1:1 (audio+video), group audio (cross-region, 32), number +
   dialpad + receptionist pickup, basic Ava chat.

## 6. Open / revisit later (parked, not launch)
- Paid tiers, larger/longer group calls, **group VIDEO**, marketplace, AvaVoice/
  Vision, translation, premium AI. LiveKit self-host + region router stay in repo,
  dormant, for if paid/video returns.
