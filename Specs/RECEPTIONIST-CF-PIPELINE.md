# Ava Receptionist — Cloudflare-native engine (separate, switchable)

**Status:** built 2026-06-29, dark by default (`receptionistUseCf = false`).

A **second, independent** receptionist engine that runs entirely on Workers AI, so you
can A/B it against Gemini Live for cost and quality. The Gemini engine
(`worker/src/do/reception_room.ts`) is **not modified** — this is a parallel path.
Switch with one KV flag; the **same Flutter client** is used for both.

## Why

Gemini Live costs ~$0.04/min (audio in+out + summary). This engine replaces that with
**Deepgram/Whisper STT → Llama LLM → Aura-2 TTS** on Workers AI, far cheaper, fully inside
Cloudflare. No voice cloning (deferred): Ava uses one fixed warm female Aura-2 voice
(`asteria`). Cap unchanged: soft wrap-up 55s, hard end 70s (~1 min).

## Architecture — two engines, one client

```
                       /api/receptionist/start  (reads receptionistUseCf)
                                 │
        useCf=false ────────────┴──────────── useCf=true
        rtc_url …                              rtc_url …&engine=cf
            │                                       │
   /api/receptionist/rtc (index.ts routes by ?engine=)
            │                                       │
   env.RECEPTION_ROOM                       env.RECEPTION_ROOM_CF
   ReceptionRoom (Gemini, UNCHANGED)        ReceptionRoomCf (Workers AI)  ← NEW
```

- **Same client contract** both ways: PCM16 16k in / PCM16 24k out + JSON control
  (`flush`/`softcap`/`error`/`ended`). No app change. The app just connects to the
  `rtc_url` that `/start` returns; the only difference is a `&engine=cf` query param,
  which `index.ts` uses to pick the DO.
- **New, separate Durable Object** `ReceptionRoomCf` (`do/reception_room_cf.ts`),
  binding `RECEPTION_ROOM_CF`, migration `v10`. Self-contained: its own finalize /
  recording / inbox-delivery / summary, so it never touches the Gemini code.

## Files

| File | Change |
|------|--------|
| `do/reception_room_cf.ts` | **NEW** — the CF engine DO (STT→LLM→TTS, endpointing, finalize, telemetry). |
| `routes/config.ts` | new flag `receptionistUseCf` (default false). |
| `routes/receptionist.ts` | `/start` reads the flag → sets `engine`/`cf_voice`/`model` in the init blob, appends `&engine=cf` to `rtc_url`, relaxes the Gemini-key gate for CF. |
| `index.ts` | exports `ReceptionRoomCf`; WS route forwards to `RECEPTION_ROOM_CF` when `?engine=cf`. |
| `types.ts` | `RECEPTION_ROOM_CF` binding. |
| `wrangler.toml` | `RECEPTION_ROOM_CF` binding + migration `v10` (prod **and** staging). |
| `do/reception_room.ts` (Gemini) | **untouched.** |

## CF engine behavior (turn-based, full-duplex with barge-in)

Greet (1 LLM turn → TTS) → caller PCM endpointed on 900ms trailing silence →
STT → append history → LLM → TTS → client. **Barge-in:** while Ava is speaking the mic
keeps being monitored; ~300ms of sustained caller speech (`CF_BARGE_BYTES`) interrupts
her — we stop her audio, send `{t:"flush"}` so the client drops its playback buffer, and
seed the interruption as the next turn. This reuses the **same** continuous-mic + flush
contract the Gemini bridge already uses on the same client, so no app change; it relies on
the client's on-device echo cancellation (already required by Gemini) so Ava's own voice
doesn't self-trigger. LLM appends a silent `<END_CALL>` marker after goodbye; soft cap
nudges a wrap-up turn; hard cap (70s) + 10s idle force-finalize. Same transcript /
2-way WAV recording / inbox card / push / caller-ack as Gemini. Summary via Workers AI LLM.

## Models (env-overridable)

| Role | Default | Env override |
|------|---------|--------------|
| STT  | `@cf/openai/whisper-large-v3-turbo` | `RECEPT_CF_STT_MODEL` |
| LLM  | `@cf/meta/llama-3.1-8b-instruct-fast` | `RECEPT_CF_LLM_MODEL` |
| TTS  | `@cf/deepgram/aura-2-en` (voice `asteria`) | `RECEPT_CF_TTS_MODEL` |

## Cost telemetry

Emits the **same** `ava_recept_cost` PostHog event as Gemini, tagged `engine:"cf"`, plus
raw usage (`stt_seconds`, `llm_tok_in/out`, `tts_chars`, `tts_seconds`) and `est_usd`.
Dashboard (PostHog id 780081) compares the engines. Note: the Gemini path is unchanged,
so its events carry `model:"gemini-3.1-flash-live-preview"` (and no `engine` prop) — split
the dashboard by **`model`** for a clean labeled Gemini-vs-CF comparison, or by `engine`
where CF = `cf` and Gemini = `(none)`. Rate defaults env-tunable
(`RECEPT_CF_STT_USD_MIN`, `RECEPT_CF_LLM_IN_USD_M`, `RECEPT_CF_LLM_OUT_USD_M`,
`RECEPT_CF_TTS_USD_MIN`).

## ⚠️ Verify on first live deploy (cannot be unit-tested)

1. **Aura returns PCM, not MP3.** `cfSpeak` requests `encoding:"linear16", sample_rate:24000`
   so bytes play on the existing client. Confirm the Workers AI Aura wrapper honors these
   (the #1 risk — MP3 = client plays noise). `ttsToPcm` strips a WAV header if present.
2. **STT input shape** `{ audio: Array.from(wav) }` and transcript field for the chosen model.
3. **LLM usage shape** (`out.usage.{prompt,completion}_tokens`, reply at `out.response`).
4. **Turn latency** STT+LLM+TTS sequential (~1–2s) — measure `ava_recept_first_audio`.

## Switch / test

1. Deploy (CI). 2. KV `receptionistUseCf:false` → baseline Gemini call. 3. KV
`receptionistUseCf:true` → next missed call answered by the CF engine, same app. 4. Compare
`ava_recept_cost` on the dashboard. Flip back to `false` to revert instantly — no redeploy.

> Not a CF *Realtime* (WebRTC) build. This engine keeps the current WebSocket client and
> is full-duplex **with barge-in** (the caller can interrupt Ava), reusing the Gemini
> bridge's continuous-mic + `{t:"flush"}` contract — so echo cancellation stays on-device
> (same dependency the Gemini path already has). A future CF Realtime/WebRTC build would
> move echo cancellation + NAT traversal (ICE/STUN/TURN) into the platform, but requires
> the RealtimeKit SDK in the app (a client change).
