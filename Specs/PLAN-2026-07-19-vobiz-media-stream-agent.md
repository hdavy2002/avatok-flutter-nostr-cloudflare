# PLAN — Live AI Agent on Cell (Vobiz DID) Calls via Media Streams

**Status: NOT STARTED — handover document. Written 2026-07-19 so any AI/engineer can
take over cold.** Read the whole doc before touching code; the Context section is
the accumulated knowledge of a long build session.

## 0. Goal

Today an owner's `mode` setting ("agent" | "vm", `receptionist_settings.mode`,
[RECEPT-MODE-1]) only affects **AvaTOK→AvaTOK** calls: agent → Gemini Live
conversation, vm → zero-cost voicemail. **Cell calls forwarded to the Vobiz DID
always get the voicemail XML flow** (`worker/src/routes/pstn.ts`), because that lane
is webhook/XML-only. This project makes `mode = "agent"` work on cell calls too:
the caller on a real phone talks to the same Gemini Live "Ava".

## 1. Key discovery (verified in Vobiz docs, 2026-07-19)

Vobiz (Plivo-lineage) **supports bidirectional audio streaming over WebSocket** —
docs: `vobiz.ai/docs/audio-streams`, `/xml/stream`, `/xml/stream/initiate`,
`/xml/stream/stream-events`, `/xml/stream/play-audio`, `/xml/stream/clear-audio`,
runnable example `/examples/vobiz-bun-media-stream`.

- Answer XML: `<Stream bidirectional="true" keepCallAlive="true"
  statusCallbackUrl="…">wss://your-host/path</Stream>`.
  `keepCallAlive="true"` is REQUIRED or the call hangs up when XML ends.
- Vobiz connects to OUR `wss://` endpoint, sends JSON frames:
  `start` (has `streamId` + `start.mediaFormat`), then `media` events with
  base64 payloads of caller audio.
- **Formats line up PERFECTLY with Gemini Live — no resampling needed:**
  - Inbound (caller→us): set `<Stream contentType="audio/x-l16;rate=16000">` →
    L16 PCM16 @16kHz mono = exactly what Gemini Live consumes.
  - Outbound (us→caller): send `{event:"playAudio", streamId, media:{contentType:
    "audio/x-l16", sampleRate:24000, payload:<b64 raw mono, NO WAV header>}}` —
    L16 @24kHz = exactly what Gemini Live emits.
  - CAUTION from docs: `contentType` on `<Stream>` configures INBOUND only; do
    NOT use it to get 24k playback — declare 24000 on each playAudio.
- **Barge-in**: send `{event:"clearAudio", streamId}` to drop Vobiz's buffered
  playback instantly. `checkpoint`/`playedStream` events tell you when queued
  audio finished. `stop`/status callbacks (`connected`,`stopped`,`timeout`,
  `failed`) for lifecycle.

## 2. Existing architecture you must know (file map)

- `worker/src/routes/pstn.ts` — the Vobiz webhook lane. `handleAnswer` (≈line 154)
  resolves the OWNER from ForwardedFrom/expectation KV (`resolveOwner`), then
  returns voicemail XML (`<Play greeting><Record>`). Auth = shared secret as
  trailing path segment (`webhookSecret(env)`, `VOBIZ_WEBHOOK_SECRET`).
  **HARD RULE in its header: pstn.ts must NOT import engine modules** (the
  voicemail/engine service boundary). Keep it that way — see §3 design.
  Per-owner greeting already implemented via `lib/vm_greeting.ts` +
  `GET /api/pstn/greeting-owner/<uid>/<hash>`.
  Recording callback `handleRecordCb` fetches the WAV **with X-Auth-ID/X-Auth-Token
  headers** (unauthenticated fetch 401s), stores `voicemail/<owner>/<caller>/<id>.wav`
  in `BLOBS`, Whisper-transcribes, posts to the owner's INBOX DO, pushes.
- `worker/src/do/reception_room.ts` — the **Gemini Live bridge DO** (ReceptionRoom)
  used for in-app calls. It already does EVERYTHING the agent needs: opens Gemini
  Live over AI Gateway (model `RECEPTIONIST_MODEL` default
  `gemini-3.1-flash-live-preview`, key `RECEPTIONIST_GEMINI_API_KEY` fallback
  `GEMINI_API_KEY`), sends PCM16@16k in / receives PCM16@24k out, barge-in
  (`serverContent.interrupted` → client `{t:"flush"}`), end_call tool, CLOSING
  state ([AVA-CLOSING-STATE-1]: farewell detect → idle-nudge kill → 1.8s grace),
  server timers (wrap cue / close / hard from `receptWrapCueMs=120000` /
  `receptCloseMs=160000` / `receptHardCapMs=180000` KV numerics), per-utterance
  telemetry `ava_recept_dialog`, 2-way recording → R2 → inbox message + push,
  and **billing**: `chargeFeature(env, owner, "ava_receptionist_minute",
  \`${sid}:min${m}\`)` per started minute (now 5 tokens/min, free while
  `betaFreePremium`). Client transport = raw binary WS frames.
- `worker/src/routes/receptionist.ts` — `/api/receptionist/start` composes the
  system prompt (`composeReceptionistPrompt`, [AVA-INDIA-TUNE-1] 8-rule compact
  prompt + [RECEPT-MODE-1] per-owner mode routing), writes the init blob to KV
  `recept_rtc:<sid>` (TTL 300s), returns the WS URL. The DO reads the init blob
  on connect. Study the init blob shape here — the PSTN lane must produce the same.
- `worker/src/index.ts` (≈line 333-343) — WS upgrade routing for
  `/api/receptionist/rtc` → ReceptionRoom / ReceptionRoomCf by `engine` param.
- Config flags: declare new keys in BOTH the `PlatformConfig` interface AND
  `DEFAULTS` in `worker/src/routes/config.ts` (+ `numericKeys` if numeric) or the
  flag is FAKE and `flags.sh set` 400s. Flip via
  `ALLOW_PROD=1 scripts/flags.sh set <k>=<v>`. NEVER raw wrangler — use
  `scripts/cf.sh` / `scripts/flags.sh` (they read `.avatok-target`; prod needs
  `ALLOW_PROD=1`). Git: `scripts/git_safe_commit.py "msg" <paths>` +
  `git_safe_push.py <ISSUE-ID>`; one issue per commit; never `git push` directly.

## 3. Design (recommended)

New DO **`VobizAgentRoom`** (`worker/src/do/vobiz_agent_room.ts`) + new route file
**`worker/src/routes/pstn_agent.ts`**. Do NOT put engine logic in pstn.ts — the
service boundary survives because pstn.ts only emits a `<Stream>` XML pointing at
the agent route; all engine code lives in the new files.

Call flow:
1. `pstn.ts handleAnswer`: after `resolveOwner`, read the owner's
   `receptionist_settings.mode` (D1, already done there for greetings). If
   `mode === "agent"` AND config flag `pstnAgentEnabled === true` AND owner
   resolved (never for orphans):
   - create `sid` + write KV `pstn_agent:<sid>` = {owner_uid, caller_e164,
     call_uuid, ts} (TTL 300)
   - return `<Response><Stream bidirectional="true" keepCallAlive="true"
     contentType="audio/x-l16;rate=16000"
     statusCallbackUrl="https://api.avatok.ai/api/pstn/stream-cb/<secret>"
     >wss://api.avatok.ai/api/pstn-agent/stream/<secret>/<sid></Stream></Response>`
   - else fall through to the existing voicemail XML (UNCHANGED default).
2. `index.ts`: route `GET /api/pstn-agent/stream/<secret>/<sid>` with
   `Upgrade: websocket` → verify secret → `VOBIZ_AGENT_ROOM.idFromName(sid)`.
3. `pstn_agent.ts` (or the DO's fetch): load `pstn_agent:<sid>`, load owner
   settings (D1) + owner display name, compose the prompt with
   `composeReceptionistPrompt(s, {callerName: <from caller e164 reverse lookup
   via matchAvatokPhones if possible, else null>, activationMode: "rings",
   engine: "gemini", …})` — import from receptionist.ts is FINE here (new file,
   not pstn.ts).
4. `VobizAgentRoom`: adapt ReceptionRoom's Gemini bridge to the Vobiz frame
   protocol. Two options:
   a. (faster) copy ReceptionRoom and swap the client-transport layer;
   b. (cleaner) extract a shared GeminiLiveBridge lib both DOs use.
   Transport mapping:
   - Vobiz `start` → save `streamId`, verify `start.mediaFormat` is l16/16000.
   - Vobiz `media` → b64decode → forward to Gemini `realtimeInput` (same as
     ReceptionRoom.onClientMessage binary path).
   - Gemini PCM out (24k) → chunk (~100-200ms; do NOT send huge single payloads)
     → `playAudio` frames with `sampleRate: 24000`, payload = b64 RAW pcm (strip
     nothing — Gemini emits raw PCM; never add a WAV header).
   - Gemini `serverContent.interrupted` → send `{event:"clearAudio", streamId}`
     (replaces the in-app `{t:"flush"}`).
   - Ava farewell → existing CLOSING state logic → on finalize, close the WS
     (Vobiz ends the call because keepCallAlive stream finished).
   - `checkpoint` after each Ava turn; on `playedStream` you know audio drained
     (use for the goodbye grace instead of the fixed 1.8s if convenient).
   - Vobiz `stop` / socket close / status callback `stopped|failed|timeout` →
     finalize("caller_hangup").
5. Finalize: reuse ReceptionRoom's finalize wholesale — recording to R2, message
   to owner's InboxDO (kind voicemail/agent), push, `cfSummarize`-equivalent
   summary, **`ava_receptionist_minute` billing (5/min)**, telemetry
   (`ava_recept_*` with a new prop `transport: "vobiz"`).
6. Wrangler: add the DO binding + migration for `VobizAgentRoom` in
   `worker/wrangler.toml` (copy the ReceptionRoom stanza; new migration tag —
   check existing `[[migrations]]` blocks).
7. Config: `pstnAgentEnabled: boolean` (interface + DEFAULTS false → ships dark).
   Prove it flips: `ALLOW_PROD=1 scripts/flags.sh set pstnAgentEnabled=true`.

## 4. Gotchas / risks (learned the hard way — do not rediscover)

- **Vobiz caches `<Play>` URLs forever by URL string** — irrelevant to Stream, but
  if you touch greetings remember the `?v=etag` / hash-in-URL trick.
- **JSON+base64 adds ~33% bandwidth**; fine, but chunk playAudio sensibly.
- **Latency budget**: caller→Vobiz→CF edge→AI Gateway→Gemini and back. Test from
  an Indian cell; if RTT feels bad, check which CF colo the DO landed in
  (DO placement follows first request — the Vobiz WS origin).
- **Echo**: no client-side AEC on PSTN, but also no local loop — the phone
  network's own echo cancellation is normally sufficient. If Gemini barge-in
  self-triggers on Ava's own audio, you have an echo path — investigate Vobiz
  `audioTrack` settings (stream only `inbound` track for STT).
- **Gemini credits**: prod key `RECEPTIONIST_GEMINI_API_KEY`, Google project
  `avatok-avaglobal` (#7456307191, display name) — prepay credits were depleted
  on 2026-07-18; top up at ai.studio/projects or every agent call dies at connect.
- **`recept_rtc` vs `pstn_agent` KV**: don't reuse recept_rtc blindly — the
  in-app init blob carries client-specific fields (rtc_token, caps for UI). Make
  the PSTN init minimal and explicit.
- **Billing double-charge**: ReceptionRoom bills by sid; keep PSTN sids distinct
  (`pstn:<call_uuid>`-style) so idempotent `op_id`s never collide.
- **Caller identity**: `matchAvatokPhones` (routes/api.ts) maps E.164 → uid/name
  when the caller is an AvaTOK user; else greet generically. Never block on it.
- **Do NOT break the vm default**: agent XML only when flag+mode+owner all align;
  every error path must fall back to the existing voicemail XML (the lane's
  "never lose a call" guarantee — worst case is voicemail, never a dropped call).

## 5. Test plan

1. Deploy dark (`pstnAgentEnabled=false`) — verify voicemail lane unchanged.
2. Set owner mode=agent for ONE test account; flip flag on. Call the DID from a
   real cell: expect Gemini greeting <2s, natural conversation, barge-in works
   (talk over her → she stops), goodbye → call ends ~2s later.
3. Verify in PostHog: `ava_recept_dialog` rows with `transport:"vobiz"`,
   `ava_recept_billed` minutes, recording + inbox message + push delivered.
4. Kill-switch drill: flip `pstnAgentEnabled=false` mid-testing → next call gets
   voicemail. Status-callback failure path: point statusCallbackUrl wrong → call
   still ends cleanly via socket close.
5. Load sanity: two concurrent DID calls (two DOs) — no cross-talk.

## 6. Effort estimate

- Worker code: ~1-2 focused sessions (the Gemini bridge already exists; this is
  mostly a transport adapter + wiring + wrangler migration).
- No app changes required (PSTN is server-side only).
- Vobiz account: confirm audio-streams are enabled for the DID/account tier.

## 7. Where the history lives

Graphiti group `proj_avaflutterapp` — episodes from 2026-07-18/19 cover: engine
flags, zero-cost VM mode, CLOSING state, 8-rule prompt, mode field, billing.
PostHog project 139917 (eu.posthog.com) — all `ava_recept_*` telemetry.
Related specs: PLAN-2026-07-19-gemini-live-india-finetune.md (prompt/orchestration
rules — the Vobiz agent must inherit ALL of it, it's the same DO logic).
