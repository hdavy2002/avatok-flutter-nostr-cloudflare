# AI Messenger Batch — Handover Spec (2026-07-03)

**Status:** APPROVED by owner (Davy) 2026-07-03. Ready for implementation.
**Audience:** This spec is written for an implementing AI agent. Follow it LITERALLY.
Where it says "do X", do exactly X. Where a decision is marked LOCKED, do not
revisit it, do not "improve" it, do not substitute your own judgment.

---

## 0. MANDATORY RULES FOR THE IMPLEMENTING AI — READ BEFORE ANYTHING ELSE

1. **Read `CLAUDE.md` at the repo root first.** All of its rules apply. The ones
   that bite hardest are repeated here because they are violated most often:
   - **NO local builds.** Never run `flutter build`, `flutter analyze`, `npm build`,
     `tsc`, or any compile/verify step. They WILL fail on this machine. Builds run
     in GitHub Actions only.
   - **NO pushing.** Commit locally only. A `pre-push` hook blocks pushes; do not
     bypass it, do not use `--no-verify`, do not touch the hook.
   - **ALL commits go through the wrapper with EXPLICIT paths:**
     `python3 scripts/git_safe_commit.py "[ISSUE-ID] message" path/one path/two`
     Never `git add`/`git commit` directly. Never the no-paths form (other agents
     share this tree). One issue per commit; message starts with the issue ID.
   - **Per-account scoping is MANDATORY** for every new piece of Flutter local
     state: use `scopedKey(...)`/`readScoped(...)` from
     `app/lib/core/account_storage.dart` or a per-account subdir via
     `AccountScope.id`. A raw global SharedPreferences/secure-storage key is a bug.
   - **Graphiti:** every read/write uses `group_id="proj_avaflutterapp"` explicitly.
     Pull context at start; `add_memory` a summary episode after each stream lands.
   - **Telemetry:** every stream MUST emit PostHog events that include the user's
     email (test user `hdavy2005@gmail.com`) so issues can be traced. Add events —
     never remove existing ones. Event names are specified per stream below.
2. **Use multiple sub-agents in parallel.** The 7 streams below are designed to be
   independent. Spawn one sub-agent per stream (A–G). Dependencies you MUST respect:
   - Stream F (auto-responder) depends on Stream B's read-receipt-suppression
     mechanic (§B4). Build B first, or build F's responder but leave receipt logic
     until B4 merges.
   - Stream G's scam detection is consumed by Stream B's Safety Shield button.
     Agree the `/api/safety/score` contract (§G4) before either starts UI work.
   - Everything else is fully parallel. Do NOT let agents touch the same file;
     the file ownership table in §9 assigns files to streams.
3. **Kill switches.** Every new feature is gated by a flag in
   `worker/src/routes/config.ts` (served by `/api/config`), defaulting per §8.
   The Flutter side must check the flag and hide the feature entirely when off.
4. **When unsure, stop and ask the owner.** Do not invent behavior. Every screen,
   cap, and default you need is written down here.

---

## 1. LOCKED OWNER DECISIONS (2026-07-03)

| # | Decision | Value |
|---|----------|-------|
| D1 | Agent-to-agent negotiation language | Always **English** internally (canonical). Translation happens only at the edges (what each user sees/hears). |
| D2 | Marketplace voice file | **Buyer-only** (re-confirmed; the 2026-07-01 buyer-only rule STANDS). ONE TTS render per deal, in the **buyer's language**. Seller gets the TEXT deal card translated into the **seller's language**. NO seller audio. |
| D3 | Agent language source | Per-**user** Marketplace Agent setting is the default; per-listing `agent_lang` remains as an optional **override** (listing wins if set). |
| D4 | Voice-output default (older 2026-07-02 decision "transcript + dub on demand") | **SUPERSEDED** by D2: always render the buyer's voice file (existing behavior), now in buyer's language. |
| D5 | Video upload cap | Client compresses to **720p H.264**, hard cap **64 MB** (client + server enforced). |
| D6 | AI ingest of media | **Never ingest video/audio bytes** into AI search/AvaBrain. Index metadata only: title, caption, filename, mime, duration, sender. |
| D7 | GIF provider | **Tenor** (Google API key, secret `TENOR_API_KEY`). |
| D8 | Stranger gate scope | DMs **and** group-adds by non-contacts (invite card instead of silent join). |
| D9 | Auto-responder v1 | Canned reply + optional **brief AI conversation mode**, capped at **3 exchanges per contact per day**, with an away **digest** when the user returns. |
| D10 | Extra AI batch | ALL FOUR: group catch-up summary, per-member group translation, smart replies + inline translate, scam detection for Safety Shield. |
| D11 | Monetization | Everything ships free for now; language/AI features will be gated under subscription later. Do NOT build billing gates now, but keep each feature behind its own config flag so gating is trivial later. |

Cost note (owner-acknowledged): D2 means 1 TTS render + ~2 text translations per
deal. Translation uses the same OpenRouter/Gemini text path — cheap relative to TTS.

---

## 2. STREAM A — Marketplace Agent settings + English-canonical negotiation

### A1. New settings page: Account & Settings > Settings > **Marketplace Agent**
Flutter: new file `app/lib/features/settings/marketplace_agent_settings_page.dart`,
registered in the existing settings list screen (find the Settings menu builder in
`app/lib/features/settings/` — add a tile "Marketplace Agent" with a storefront icon).
Fields (all persisted server-side, mirrored in scoped local cache):
- **Agent name** — text, default `"<first name>'s Agent"`, max 30 chars.
- **Default language** — dropdown of the languages already supported by the app's
  translation path (start with: English, Spanish, Hindi, French, German, Portuguese,
  Arabic, Chinese (Simplified), Japanese, Russian, Indonesian, Urdu, Bengali,
  Swahili, Turkish, Vietnamese). Store as BCP-47 code (`es`, `hi`, …). Default `en`.
- **Voice** — reuse the existing 30-voice Gemini picker widget (see the receptionist
  voice picker in `app/lib/features/` — same widget, same voice list). Default: current
  stock (`Aoede` buyer / `Charon` seller behavior preserved when unset).
- **Tone** — segmented: Friendly / Professional / Brief. Maps to a style hint string.
- **Negotiation guardrails:** floor price toggle + "never go below X% of asking"
  slider (50–100%, default 80%); "Ask me before committing to a deal" toggle
  (default OFF — when ON, agent ends with "I'll confirm with my owner" and the deal
  card is marked `pending_owner_approval` instead of `agreed`).
- **Auto-respond** toggle + **quiet hours** (two time pickers) — during quiet hours the
  agent replies with a deferral line instead of negotiating.
- **Digest preference** — segmented: Every exchange / Summary only (default Summary).

### A2. Storage — D1 migration
New table in the main D1 (`avatok-db`), migration file under `worker/migrations/`:
```sql
CREATE TABLE IF NOT EXISTS marketplace_agent_settings (
  user_id TEXT PRIMARY KEY,
  agent_name TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  voice TEXT,
  tone TEXT NOT NULL DEFAULT 'friendly',
  floor_pct INTEGER NOT NULL DEFAULT 80,
  ask_before_commit INTEGER NOT NULL DEFAULT 0,
  auto_respond INTEGER NOT NULL DEFAULT 1,
  quiet_start TEXT, quiet_end TEXT,
  digest TEXT NOT NULL DEFAULT 'summary',
  updated_at INTEGER NOT NULL
);
```
Apply via the existing REST-API migration method (see memory/rulebook — wrangler d1
migrations from CI or REST; do NOT attempt local wrangler without the /tmp install).

### A3. API routes (`worker/src/routes/marketplace.ts` or new
`worker/src/routes/agent_settings.ts`, mounted in `worker/src/index.ts`):
- `GET /api/marketplace/agent-settings` → row for auth user (defaults if none).
- `PUT /api/marketplace/agent-settings` → upsert; validate lang against allowlist,
  floor_pct 50–100, name length ≤30.

### A4. Negotiation becomes English-canonical (edit `worker/src/routes/marketplace.ts`)
Current behavior (line ~389): transcript is generated in `agentLang` = the SELLER's
listing language. CHANGE to:
1. Resolve `buyerLang` = buyer's `marketplace_agent_settings.lang` (default `en`).
   Resolve `sellerLang` = listing `agent_lang` if set, else seller's settings lang,
   else `en` (D3 order).
2. The negotiation prompt ALWAYS instructs: "Write the transcript in English."
   Remove the `Write the transcript text in ${agentLang}` instruction.
3. After the negotiation completes, produce localized artifacts:
   - `transcript_en` (canonical, stored as today in the deal record).
   - If `buyerLang != 'en'`: translate the transcript + the bubble/summary text to
     `buyerLang` (one LLM call: "Translate this negotiation transcript to <lang>,
     keep the Speaker: prefixes"). The BUYER's deal card + transcript shown in-app
     use `buyerLang`.
   - If `sellerLang != 'en'`: translate bubble/summary + transcript to `sellerLang`
     for the SELLER's text card.
   - Cache: store translations inside the deal envelope (`transcript_i18n: {es: [...]}`)
     so re-opens never re-translate.
4. The `mkt-audio` queue message now carries `lang` (=buyerLang) and the
   **buyer-language transcript** (not English, unless buyer is `en`). The consumer
   (`consumers/src/mkt_audio.ts`) and the PartyDO `render-tts` handler must TTS the
   transcript it is given verbatim — Gemini 2.5 Flash TTS speaks the language of the
   text; add to the script preamble: "Speak in <language name>." Buyer speaker uses
   the buyer's chosen `voice` (fall back Aoede); Seller speaker uses the listing's
   persona/style hint as today (fall back Charon).
5. Agent name + tone: inject the buyer's/seller's agent names and tone hints into the
   negotiation prompt ("Buyer agent is called <name>, tone: <tone>").
6. Guardrails: floor_pct applies to the SELLER side (never agree below floor% of
   asking). `ask_before_commit` per A1. Quiet hours: reject `POST /api/marketplace/agent-call`
   (or equivalent start route) with a friendly deferral card when seller agent is quiet.
7. Delivery stays exactly as today otherwise: buyer-only voice card (D2), two-message
   flow, daily cap 10, category spoken-length caps (apply the cap to the ENGLISH
   canonical transcript before translation so both language versions stay short).

### A5. Telemetry (PostHog, include email): `mkt_agent_settings_saved`
(props: lang, tone, floor_pct, ask_before_commit), `mkt_negotiation_translated`
(props: buyer_lang, seller_lang, chars), plus keep every existing mkt_* event.

### A6. Issue IDs: `[MKT-LANG-1]` migration+routes, `[MKT-LANG-2]` settings page,
`[MKT-LANG-3]` English-canonical negotiation + translation, `[MKT-LANG-4]` consumer
lang-aware TTS, `[MKT-LANG-5]` telemetry+flag. Flag: `marketplaceAgentSettingsEnabled`
(default ON) and `mktI18nNegotiationEnabled` (default ON).

---

## 3. STREAM B — Stranger safety gate (message requests)

### B1. Concept
A DM from a sender who is NOT in the recipient's contacts arrives as a **message
request**. Until the recipient taps **Accept** (or replies — implicit accept):
- NO read receipt is sent (sender sees delivered ✓✓ grey, never blue).
- NO typing indicator is emitted to that thread.
- NO media auto-download; images blurred with tap-to-reveal; NO link previews.
- The thread shows a bottom action bar instead of the composer:
  **[Safety shield] [Block] [Report spam] [Accept]** — message list scrollable above.

### B2. State
Thread-level `accept_state` for the recipient: `pending | accepted | blocked`.
Store it where thread metadata already lives (InboxDO-local SQLite `threads`/conv
table — inspect `worker/src/do/inbox.ts` for the conv table and add a column via
DO migration pattern used there). Default for existing threads: `accepted`
(migration must not lock existing users out of their threads). New thread from
non-contact → `pending`. "Contact" check: reuse the existing contacts table/service
the app already has (see `app/lib/features/contacts/`).

### B3. Read-receipt suppression (server side, InboxDO)
Find where read/`seen` events are recorded and fanned out in the InboxDO / messaging
routes (`worker/src/routes/messaging.ts`, `worker/src/do/inbox.ts` — grep `read`,
`seen`, `receipt`). Rule: if the recipient's `accept_state` for the conv is
`pending`, DROP the read-receipt fan-out to the sender (still record locally so
unread counts work). On Accept, do NOT retroactively send old read receipts —
receipts flow only for messages read after acceptance.

### B4. Client (Flutter)
- Thread screen: when `accept_state == pending`, replace composer with the action
  bar (new widget `app/lib/features/messaging/widgets/stranger_gate_bar.dart`).
- **Accept** → `POST /api/conversations/accept {conv}` → composer restored.
- **Block** → existing block endpoint (find it; if missing, add
  `POST /api/conversations/block`). Thread hidden.
- **Report spam** → `POST /api/safety/report {conv, last_n: 10}` — server copies the
  last 10 envelopes into a `spam_reports` D1 table for review, then blocks.
- **Safety shield** → calls Stream G's `/api/safety/score` and shows the result
  banner (§G4); if score ≥ 0.8 show a red "Likely scam" banner with one-tap Block.
- Replying while pending = implicit Accept (fire accept before send).
- Chat LIST: pending threads grouped under a "Message requests (N)" collapsed
  section at the top, like WhatsApp/Signal.

### B5. Group-adds by non-contacts (D8)
When a non-contact adds the user to a group: membership row is created in state
`invited` (D1 `conversation_members` — the group system is server-backed since
2026-06-28, see `worker/src/routes/` group routes). The user gets an **invite card**
thread entry: group name, adder, member count, **[Join] [Decline] [Block adder]**.
No group messages are delivered (and no notifications fire) until Join. Worker
enforces: fan-out skips `invited` members.

### B6. Telemetry: `stranger_gate_shown`, `stranger_gate_accept`,
`stranger_gate_block`, `stranger_gate_report`, `group_invite_shown/joined/declined`.
Flag: `strangerGateEnabled` (default ON). Issues: `[SAFE-GATE-1]` state+receipt
suppression, `[SAFE-GATE-2]` action bar UI + accept/block/report routes,
`[SAFE-GATE-3]` message-requests section, `[SAFE-GATE-4]` group invite cards,
`[SAFE-GATE-5]` telemetry+flag.

---

## 4. STREAM C — Link previews + inline YouTube

### C1. Server-side unfurl (privacy rule: recipient device NEVER fetches the URL)
New route `GET /api/unfurl?url=<encoded>` in a new `worker/src/routes/unfurl.ts`:
- Auth required. Validate scheme http/https; deny private IPs/localhost (SSRF guard:
  reject literal IPs, `*.local`, and non-80/443 ports).
- Fetch with 5s timeout, max 512 KB read, UA string of a normal browser.
- Parse `og:title`, `og:description`, `og:image`, `og:site_name`, `<title>` fallback.
- Special-case YouTube (`youtube.com/watch`, `youtu.be/…`, `youtube.com/shorts`):
  return `{type:"youtube", video_id, title, thumb}` using YouTube oEmbed
  (`https://www.youtube.com/oembed?url=...&format=json` — no API key needed).
- Instagram: try oEmbed-less OG fetch; if blocked, return `{type:"link"}` with
  whatever was parsed (best-effort per owner decision).
- Cache result in KV, key `unfurl:<sha256(url)>`, TTL 7 days. Cache failures 1h.
- The SENDER's client calls unfurl at compose time and embeds the preview data
  INSIDE the message envelope (`preview:{...}`) so recipients render from the
  envelope — zero recipient fetches, zero IP leak.

### C2. Flutter rendering
- New widget `app/lib/features/messaging/widgets/link_preview_card.dart`:
  image top, title bold, description 2-line ellipsis, domain footer. Tapping a
  plain link card opens the in-app browser/external browser as the app does today.
- YouTube card: thumbnail + play button → replaces card in-bubble with an inline
  player (`youtube_player_iframe` package — add to `pubspec.yaml`; CI builds it).
  Expand icon → full-screen landscape route; on exit `Navigator.pop` back to the
  thread at the same scroll position. Player pauses when the bubble scrolls
  offscreen.
- STRANGER GATE INTERACTION: while `accept_state == pending`, do NOT render preview
  cards (raw URL text only) — per §B1.
- Context menu: preview bubbles use the SAME long-press/right-click menu as other
  bubbles (forward / copy / delete / react). Verify the existing message context
  menu wraps the new bubble types; do not fork the menu.

### C3. Telemetry: `unfurl_requested` (props: type, cached), `yt_inline_play`,
`yt_fullscreen`. Flag: `linkPreviewsEnabled` (default ON).
Issues: `[PREVIEW-1]` unfurl route+KV, `[PREVIEW-2]` compose-time embed,
`[PREVIEW-3]` preview card + YouTube inline player, `[PREVIEW-4]` telemetry+flag.

---

## 5. STREAM D — Video policy

- Client: on video pick, compress to 720p H.264 (use `video_compress` package or
  the app's existing media pipeline if one exists — CHECK `app/lib/` media send
  code first; do not add a duplicate pipeline). After compression, if size > 64 MB
  → reject with snackbar: "Videos are limited to 64 MB (about 3–5 minutes). Trim
  it and try again."
- Server: every upload path that accepts video (`/upload/public` and the private
  media upload — grep `worker/src/routes/` for upload handlers) enforces a 64 MB
  content-length cap for video mime types → 413 with the same message.
- AI search / AvaBrain ingestion (D6): find the ingestion pipeline (grep for
  AvaBrain/ingest in `worker/`); ensure video/audio branches index ONLY
  {title, caption, filename, mime, duration_s, sender, ts} and never bytes or
  transcripts. Add a code comment: "OWNER RULE 2026-07-03: media bytes are never
  ingested (cost)."
- Telemetry: `video_upload_compressed` (props: in_bytes, out_bytes, duration_s),
  `video_upload_rejected` (props: bytes). Flag: none needed (policy, not feature).
- Issues: `[VIDPOL-1]` client compress+cap, `[VIDPOL-2]` server cap,
  `[VIDPOL-3]` metadata-only ingest guard.

---

## 6. STREAM E — WhatsApp-parity input bar + emoji/GIF/sticker panel

Target UX = the WhatsApp screenshot the owner supplied (2026-07-03):
input row = [emoji icon][expanding text field][attach 📎][camera]; green round
mic button right (morphs to send when text non-empty). Tapping the emoji icon
opens a KEYBOARD-HEIGHT panel under the input with:
- Segmented top control: **Emoji | GIF | Sticker**, search icon left, backspace right.
- Emoji tab: "Recents" row then categorized grid (Smileys & People, Animals, Food,
  Activities, Travel, Objects, Symbols, Flags), category icon bar at bottom,
  text search. Use the `emoji_picker_flutter` package as the base if suitable,
  otherwise build the grid; either way the LOOK must match the screenshot layout.
- GIF tab: Tenor. New Worker proxy route `GET /api/gif/search?q=&pos=` and
  `GET /api/gif/trending` (proxy so the Tenor key stays server-side — secret
  `TENOR_API_KEY`, owner will provision; code must degrade gracefully to a
  "GIFs unavailable" state if unset). Grid of autoplaying muted previews; tap
  sends as a media message (send the Tenor mp4/gif URL through the normal media
  pipeline — download server-side and store to R2 like a normal media upload so
  recipients don't hit Tenor).
- Sticker tab: v1 ships 2–3 built-in packs (webp assets under
  `app/assets/stickers/`); sticker messages are a media message with
  `kind:"sticker"` rendering at fixed 160dp without a bubble.
- Recents (emoji + GIF + sticker) are per-account: store via
  `scopedKey('picker_recents')` — MANDATORY scoping.
- REMOVE the current mini emoji strip / small pull-out on the left of the input.
- The panel must swap smoothly with the OS keyboard (same height, no jank):
  measure keyboard height like WhatsApp does (persist last known height, scoped).
- Telemetry: `picker_opened` (tab), `gif_sent`, `sticker_sent`.
  Flag: `richInputEnabled` (default ON). Issues: `[INPUT-1]` new input bar,
  `[INPUT-2]` emoji tab, `[INPUT-3]` Tenor proxy + GIF tab, `[INPUT-4]` sticker
  tab + assets, `[INPUT-5]` telemetry+flag+remove old strip.

---

## 7. STREAM F — Auto-responder ("Ava replies while you're away")

### F1. Settings page: Settings > **Auto-Responder**
New `app/lib/features/settings/auto_responder_settings_page.dart`:
- Master toggle.
- Mode presets: Travelling / Busy / Sleeping / Driving / Custom — each preset has a
  short default message, editable, ≤200 chars. (Travelling default: "Hey — Davy is
  travelling and offline right now. I've noted your message; he hasn't read it yet
  and will see it when he's back.")
- Audience: Known contacts only (default) / Everyone except blocked. NEVER
  auto-reply to `pending` (stranger-gate) threads regardless of audience.
- Duration: Until I turn it off / For N hours (1/4/8/24) / Daily schedule
  (start–end time pickers).
- Conversation depth: "Reply once per contact" (default) / "Let Ava chat briefly"
  → AI mode, hard cap **3 auto-exchanges per contact per day** (D9).
- Reply in sender's language: toggle, default ON (detect from the incoming message;
  translation via the same text path as Stream A).
- Urgent escalation: toggle, default ON — if the incoming text contains urgency
  (LLM classification in AI mode; keyword list "urgent|emergency|asap|911" in
  canned mode), send the user a high-priority push even in away mode.
- Away digest: on disable (or schedule end), Ava posts a self-thread digest:
  "While you were away I replied to N people: …" with per-contact one-liners.

### F2. Server mechanics
- Settings stored in D1 table `auto_responder_settings` (same shape pattern as A2)
  + mirrored to KV for fast read on the hot message path.
- Hook point: where an incoming DM is appended to the recipient's InboxDO and
  push is dispatched (messaging routes / notify path). If recipient's responder is
  active and audience matches and caps not hit → enqueue `auto-reply` job
  (new queue consumer in `consumers/src/`, pattern-copy `mkt_audio.ts` structure) →
  consumer generates the reply (canned string, or AI mode: short LLM call with the
  last ≤6 messages of context and the persona "You are <agent name>, <owner>'s
  assistant; be brief; never invent commitments") → appends to the thread as the
  RECIPIENT's message with envelope marker `auto:true` and visible prefix
  "🤖 <agent name> (auto-reply): ".
- **Read-receipt rule:** the auto-reply must NOT mark the sender's messages read.
  Blue ticks fire only when the human opens the thread (this reuses §B3 plumbing —
  the auto-responder path simply never records `seen`).
- **Loop protection (CRITICAL):** never auto-reply to a message whose envelope has
  `auto:true`; plus the 3/contact/day cap; plus a global 50 auto-replies/day/user
  circuit breaker.
- Counters: per-account KV keys `arsp:<uid>:<peer>:<yyyymmdd>` with 48h TTL.

### F3. Telemetry: `autoresponder_enabled` (mode, ai_mode), `autoreply_sent`
(ai_mode, lang, capped), `autoresponder_digest` (replies, contacts),
`autoreply_urgent_escalation`. Flag: `autoResponderEnabled` (default ON).
Issues: `[AUTOREP-1]` settings page+table+routes, `[AUTOREP-2]` hot-path hook +
queue consumer, `[AUTOREP-3]` AI conversation mode + caps + loop protection,
`[AUTOREP-4]` digest + urgent escalation, `[AUTOREP-5]` telemetry+flag.

---

## 8. STREAM G — AI in chats (batch of 4) + kill-switch table

### G1. Group catch-up summary
Button "What did I miss?" appears in a group thread's header/menu when unread > 25
messages. `POST /api/ai/catchup {conv, since_seq}` → Worker pulls the unread
envelopes from the caller's own InboxDO (server-readable arch — allowed), text-only
(skip media bodies per D6), LLM-summarizes to ≤6 bullets with sender attribution,
returns; client shows as a dismissible card pinned above the unread divider. Do not
store the summary server-side. Respect AvaBrain per-app guardrail toggle: if the
user has the messaging guardrail OFF, hide the button.
Telemetry: `ai_catchup_used` (msg_count). Issues: `[GROUP-AI-1]`.

### G2. Per-member group translation (the global differentiator)
Setting per group per user: "Translate this group for me" toggle + language
(defaults to Stream A's user language). When ON, message fetch/delivery for that
member attaches a translation: translate on FETCH in the Worker, cache in KV keyed
`tr:<msg_id>:<lang>` (immutable messages → cache forever, 30-day TTL). Bubble shows
translated text with a small "translated · show original" toggle. Sender side
unchanged; typing stays in the sender's language. Voice notes are NOT translated
(v1). Cost control: only translate messages actually fetched by an opted-in member;
flag `groupTranslationEnabled` default **OFF** until cost is observed.
Telemetry: `group_translate_enabled` (lang), `group_translate_msgs` (count, cached_pct).
Issues: `[GROUP-AI-2]` worker translate-on-fetch+cache, `[GROUP-AI-3]` client toggle+bubble UI.

### G3. Smart replies + inline translate (DMs)
- Smart replies: after an incoming DM, client asks `POST /api/ai/smart-replies`
  {last ≤4 messages} → 3 short suggestions rendered as chips above the input
  (tap = insert, not auto-send). Debounce: only when thread is open and foreground.
  Guardrail-gated like G1. Flag `smartRepliesEnabled` default ON.
- Inline translate: context-menu item "Translate" on any text bubble →
  `POST /api/ai/translate {text, to}` (to = user's Stream-A language) → show below
  original in the bubble. Cache in the local drift message cache (scoped).
Telemetry: `smart_reply_used`, `inline_translate_used` (lang).
Issues: `[GROUP-AI-4]` smart replies, `[GROUP-AI-5]` inline translate.

### G4. Scam detection → Safety Shield (contract with Stream B)
`POST /api/safety/score {conv}` → Worker takes the stranger thread's messages
(≤ first 20), runs a cheap classification prompt ("score 0–1 phishing/scam/spam
likelihood + one-line reason; look for: payment redirection, crypto, urgency,
impersonation, link mismatch"), returns `{score, reason}`. Cache per conv+msg-count
in KV. Called by the Safety Shield button (§B4) and AUTO-called once when a
stranger thread first renders if `scamAutoScanEnabled` (default ON) — score ≥ 0.8
shows the red banner unprompted. Never auto-block; the user decides.
Telemetry: `safety_score_shown` (score_bucket, auto), `safety_shield_tapped`.
Issues: `[GROUP-AI-6]`.

### Kill-switch summary (`worker/src/routes/config.ts` + client checks)
| Flag | Default |
|---|---|
| marketplaceAgentSettingsEnabled | ON |
| mktI18nNegotiationEnabled | ON |
| strangerGateEnabled | ON |
| linkPreviewsEnabled | ON |
| richInputEnabled | ON |
| autoResponderEnabled | ON |
| groupTranslationEnabled | **OFF** (cost watch) |
| smartRepliesEnabled | ON |
| scamAutoScanEnabled | ON |

---

## 9. FILE OWNERSHIP (one stream per file — agents must not cross)

| Files | Stream |
|---|---|
| `worker/src/routes/marketplace.ts`, `consumers/src/mkt_audio.ts`, `worker/src/routes/agent_settings.ts` (new), `app/lib/features/settings/marketplace_agent_settings_page.dart` (new) | A |
| `worker/src/do/inbox.ts` (accept_state + receipt suppression §B3 ONLY), `app/lib/features/messaging/widgets/stranger_gate_bar.dart` (new), group invite handling | B |
| `worker/src/routes/unfurl.ts` (new), `app/lib/features/messaging/widgets/link_preview_card.dart` (new) | C |
| upload routes (cap), media send pipeline (compress), ingestion guard | D |
| input bar + picker widgets (new files under `app/lib/features/messaging/widgets/`), `worker/src/routes/gif.ts` (new) | E |
| `consumers/src/auto_reply.ts` (new), `app/lib/features/settings/auto_responder_settings_page.dart` (new), notify-path hook | F |
| `worker/src/routes/ai_chat.ts` (new: catchup/smart-replies/translate/safety), client AI widgets | G |
| `worker/src/routes/config.ts` (flags) | SHARED — each stream adds ONLY its own flag lines; commit flag changes separately to avoid conflicts |
| `worker/src/index.ts` (route mounting) | SHARED — same rule |

Streams B and F both touch the receipt/notify path: F is BLOCKED BY `[SAFE-GATE-1]`.

## 10. Acceptance checklist (verify before calling a stream done)
- A: Spanish buyer + Hindi seller → buyer sees Spanish card + Spanish voice note;
  seller sees Hindi text card; deal record holds English canonical transcript.
- B: stranger DM → no blue ticks until Accept; Accept restores composer; Report
  writes spam_reports row; non-contact group add → invite card, no messages leak.
- C: sending a URL renders OG card for recipient with zero recipient-side fetch;
  YouTube plays inline, fullscreen round-trips back to the thread.
- D: 100 MB source video compresses or rejects; Worker 413s an oversized video;
  ingestion stores metadata only.
- E: old emoji strip gone; panel matches screenshot layout; Tenor GIF sends as R2
  media; recents survive account switch WITHOUT leaking across accounts.
- F: away mode replies once (or ≤3 in AI mode) with 🤖 prefix, sender never gets
  blue ticks until the human opens; two auto-responders never loop; digest posts.
- G: catchup ≤6 bullets; group translation only when toggled + flag ON; smart-reply
  chips insert without sending; scam score ≥0.8 shows red banner on a test thread.
- ALL: every event carries the user email; commit per issue via git_safe_commit
  with explicit paths; NOTHING pushed; Graphiti episode written per stream.

---
---

# ADDENDUM 2026-07-03 (same day) — Streams H, I, J

Owner approved three more streams. Same rules (§0) apply. These are additional
parallel sub-agents; the file-ownership additions are in §14.

## 11. ADDITIONAL LOCKED DECISIONS

| # | Decision | Value |
|---|----------|-------|
| D12 | Liveness gate placement | **Hard gate at account creation** (signup). Handle-first L0 GUEST browsing is preserved — guests can claim a handle and browse; the moment they create a real account (AccountGate email/password flow), the human check is MANDATORY before entering the app. |
| D13 | Existing users | **Immediately on next app open**: unverified existing users get a full-screen, non-dismissible redirect to the liveness check. No grace period. |
| D14 | Liveness provider | **Rekognition** is the default (existing `/api/id/session` + Amplify Face Liveness path). Workers AI provider stays as flag-gated fallback. |
| D15 | Evidence retention | **Store EVERYTHING** — clip/audit images, scores, IP, country, device — for BOTH pass and fail attempts, in R2 + D1, for a future admin dashboard. This REVERSES the old "delete on pass/fail" privacy design in `worker/src/routes/liveness.ts`. The "Why" popup includes one honest retention sentence (legal cover). |
| D16 | Forwarding | **Unlimited** forwarding for liveness-verified users (no WhatsApp-style 5-target cap). Forward sheet includes the user's GROUPS. Fan-out NEVER copies media — one content-addressed R2 object, N envelope references. |
| D17 | Auto-download | New setting Always / Wi-Fi only / Never. Default **Always** (preserves current behavior). Pending (stranger-gate) threads never auto-download regardless of setting. |

## 12. STREAM H — Liveness "human check" at onboarding

### H1. UI (Flutter) — new onboarding step + redirect screen
New `app/lib/features/identity/human_check_page.dart`, used in TWO places:
1. Inserted into the account-creation flow (find the AccountGate signup flow from
   the handle-first onboarding, `app/lib/` — the step runs AFTER credentials are
   created, BEFORE landing in the app).
2. As a full-screen non-dismissible route pushed on app open for existing
   unverified users (D13): check the ladder/verification status the app already
   fetches; if not liveness-verified and `livenessOnboardingGate` flag is ON →
   `Navigator.pushAndRemoveUntil` to this page. No back button, no skip.

Copy (owner-approved framing — friendly, anti-bot, NOT alarming):
- Title: **"Quick human check"**
- Body: "Let our AI check that you're a real person — futuristic AI bots keep
  trying to sign up! No AI agents allowed on AvaTOK. This takes about 15 seconds."
- Primary button: **"I'm human — start check"** → launches the existing
  Rekognition Amplify Face Liveness UI (the L2 flow already built; find its
  entry point under `app/lib/features/identity/` / wherever `/api/id/session`
  is called).
- Link: **"Why are we asking this?"** → bottom-sheet popup, copy:
  "AI spam bots can register accounts automatically, harvest people's data, and
  blast spam on autopilot. A quick video check proves there's a real human behind
  every AvaTOK account — so everyone you talk to here is a real person, and your
  inbox stays safe and trusted. Your verification video is stored securely and
  used only for safety review." (The last sentence is the D15 disclosure — do not
  remove it.)
- On PASS: success screen "You're verified human ✅" → continue into the app.
- On FAIL: friendly retry screen, shows attempts remaining (existing 3/24h budget
  is shared across providers — keep it).

### H2. Server — enforcement (bypass-proof) + evidence capture
- New flag `livenessOnboardingGate` in platform config (KV `platform_config`,
  same pattern as `listingLivenessGate`). Default **OFF**; owner flips ON after a
  staging device test. When ON:
  - The server marks accounts without a verified liveness/KYC proof as
    `liveness_required` and REJECTS (403 `liveness_required`) the spam-capable
    routes for them: message send, group create/join, forwarding, listing publish
    (reuse/extend the `requireKyc`/ladder helpers in `worker/src/authz.ts` +
    `worker/src/routes/ladder.ts` — the client gate alone is NOT the gate).
- Evidence capture — new D1 table (migration under `worker/migrations/`):
```sql
CREATE TABLE IF NOT EXISTS liveness_audit (
  id TEXT PRIMARY KEY,            -- session id
  uid TEXT NOT NULL,
  provider TEXT NOT NULL,         -- rekognition | workersai | stripe
  status TEXT NOT NULL,           -- passed | failed | abandoned
  confidence REAL,
  ip TEXT, country TEXT, city TEXT, colo TEXT, asn TEXT,
  device_model TEXT, os TEXT, app_version TEXT,
  r2_prefix TEXT,                 -- liveness/<uid>/<session>/
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liveness_audit_uid ON liveness_audit(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_liveness_audit_status ON liveness_audit(status, created_at);
```
- Populate at verify time (`worker/src/routes/id.ts` for Rekognition): IP from
  `CF-Connecting-IP`, country from `request.cf.country` / `CF-IPCountry`, city/
  colo/asn from `request.cf`; device/os/app version sent by the client in the
  verify call body. Fetch Rekognition AUDIT IMAGES from
  `GetFaceLivenessSessionResults` and store them in R2 under
  `liveness/<uid>/<session>/audit<i>.jpg`. Record a row for EVERY attempt —
  passed, failed, AND abandoned (a cron/TTL sweep marks 15-min-stale pending
  sessions `abandoned`).
- Workers AI provider (`worker/src/routes/liveness.ts`): CHANGE the
  delete-evidence behavior (D15) — on pass AND fail, move frames + clip to the
  same `liveness/<uid>/<session>/` R2 prefix instead of deleting, and write the
  audit row. Update the file-header comment to record the owner decision.
- Admin dashboard: NOT in this batch — the tables/prefixes above ARE the
  deliverable ("dashboard-ready").

### H3. Telemetry (rich — owner explicitly asked; include email + uid on every event)
`liveness_gate_shown` (source: signup|redirect), `liveness_why_opened`,
`liveness_started` (provider, attempt_n), `liveness_passed` (provider, confidence,
country, ip, device_model, os, app_version, duration_ms, attempt_n),
`liveness_failed` (same props + reason), `liveness_abandoned` (elapsed_ms),
`liveness_gate_blocked_action` (route — fired when the server 403s a
liveness_required user). Also PostHog person-properties update: set
`liveness_verified: true`, `liveness_country` on pass.

### H4. Issues: `[LIVE-GATE-1]` audit table + capture (id.ts), `[LIVE-GATE-2]`
Workers-AI retention change, `[LIVE-GATE-3]` human-check UI + popup + signup-flow
insertion, `[LIVE-GATE-4]` existing-user redirect, `[LIVE-GATE-5]` server-side
route enforcement, `[LIVE-GATE-6]` telemetry. Flag: `livenessOnboardingGate`
(default OFF → owner flips after staging test).

## 13. STREAM I — Unlimited forwarding + forward-to-groups

### I1. Behavior
- No forward-target cap anywhere (D16). Forwarding requires the sender to be
  liveness-verified (same server check as H2 — forwarding is a spam-capable route).
- Long-press / right-click any message (text, media, preview card, voice note) →
  **Forward** → forward sheet: search bar; sections **"Groups"** (the user's
  groups, with member counts) then **"Contacts"** / recent chats. Multi-select
  with checkmarks → single Send.
- Forwarded bubbles show a small "↪ Forwarded" label (like WhatsApp). Envelope
  carries `fwd:true` (and nothing about the original sender — privacy).

### I2. Fan-out mechanics (ZERO media duplication — owner requirement)
- Media messages already reference a content-addressed object (`media_ref` →
  one real R2 copy per the universal-storage rulebook). Forwarding MUST create
  new envelopes that point at the SAME `media_ref`/R2 key — never re-upload,
  never copy the object. Forwarding a photo to a 3,000-member group = the
  existing group fan-out path delivering 3,000 small envelope rows, all wired to
  ONE R2 object. Devices that already hold the bytes in the per-account media
  cache render instantly without re-downloading (existing local-first cache rule).
- Private/E2E DM media forwarded into a group: the bytes' encryption context may
  differ — CHECK how `MediaService.downloadAndDecrypt` keys media. If DM media is
  encrypted per-conversation, forwarding across contexts must go through a
  server-side re-reference that re-wraps ONLY the key material, not the payload;
  if that's not feasible in this codebase, v1 rule: forwarding re-uploads
  DECRYPTED-and-re-encrypted media ONLY for the cross-context case and the spec's
  no-copy rule applies to all same-context and public-media forwards. Document
  which branch was taken in the commit message.
- Rate safety (anti-abuse backstop even with liveness): server cap of 200
  forward TARGETS per user per hour (flag-tunable, KV counter). 429 with a
  friendly "Slow down" message.

### I3. Telemetry: `forward_opened` (msg_kind), `forward_sent` (n_targets,
n_groups, total_recipients, media_kind, cross_context: bool), `forward_rate_capped`.
Flag: `unlimitedForwardEnabled` (default ON). Issues: `[FWD-1]` forward sheet UI,
`[FWD-2]` no-copy fan-out + cross-context handling, `[FWD-3]` rate backstop +
liveness requirement, `[FWD-4]` telemetry.

## 14. STREAM J — Auto-download setting

- New page: Account & Settings > Settings > **Auto-download** (tile + page
  `app/lib/features/settings/auto_download_settings_page.dart`). Three radio
  options: **Download media automatically** (default) / **Download on Wi-Fi
  only** / **Do not download automatically**.
- Persist per-account: `scopedKey('auto_download_mode')` — MANDATORY scoping.
- Wiring (must work out of the box): find every call site where incoming media is
  fetched eagerly (grep `MediaService`, `downloadAndDecrypt`, avatar/media prefetch
  in the message list). Route them through one new helper
  `MediaAutoDownload.shouldAutoFetch()` that checks: (1) the mode, (2)
  connectivity via the `connectivity_plus` package (add to pubspec if absent —
  wifi vs cellular), (3) thread `accept_state` — `pending` NEVER auto-downloads
  (D17/§B1).
- When auto-download is skipped: bubble renders a blurred thumbnail placeholder
  with size label + download icon; tap = manual fetch (always allowed). Voice
  notes: small download button on the bubble. Once fetched, cached forever
  per the existing local-first rule.
- Telemetry: `auto_download_mode_set` (mode), `media_manual_download` (kind, bytes).
  Flag: none (setting, not feature). Issues: `[AUTODL-1]` settings page + helper,
  `[AUTODL-2]` call-site wiring + placeholder bubbles, `[AUTODL-3]` telemetry.

## 15. FILE-OWNERSHIP ADDITIONS (extends §9)

| Files | Stream |
|---|---|
| `worker/src/routes/id.ts`, `worker/src/routes/liveness.ts`, `worker/src/authz.ts` (liveness_required check), `app/lib/features/identity/human_check_page.dart` (new), signup-flow insertion | H |
| forward sheet + fan-out (messaging routes forward path, `app/lib/features/messaging/widgets/forward_sheet.dart` new) | I |
| `app/lib/features/settings/auto_download_settings_page.dart` (new), `MediaAutoDownload` helper (new), media fetch call sites | J |

Cross-stream: H's `liveness_required` server check is CONSUMED by I (forwarding)
and by the messaging send path — land `[LIVE-GATE-5]` before `[FWD-3]`.
Stream J touches media fetch call sites; Stream C renders preview cards — the
placeholder-bubble work in J must not modify C's `link_preview_card.dart`.

## 16. ACCEPTANCE ADDITIONS (extends §10)
- H: new signup cannot reach the app without passing liveness (flag ON); existing
  unverified user is redirected on open; `liveness_audit` row + R2 audit images
  exist for a pass AND a fail; popup shows the retention sentence; server 403s
  message-send for an unverified account even from a patched client.
- I: forward a photo to a 3,000-member group → exactly ONE R2 object for the
  photo (verify by key count under the media prefix), 3,000 envelopes; "Forwarded"
  label renders; 201st forward target within an hour → 429.
- J: mode=Never → incoming photo shows blurred placeholder, tap downloads;
  mode=Wi-Fi-only on cellular → same; mode=Always → current behavior; pending
  stranger thread never auto-downloads in ANY mode; setting does not leak across
  accounts on the same phone.

---
---

# ADDENDUM 2 (2026-07-03) — STREAM K: owner screenshot fixes & redesigns

Owner supplied 7 annotated screenshots. These are fixes/redesigns on EXISTING
features. Same rules (§0). Stream K can run as 4 parallel sub-agents:
K-a (dialpad + contacts), K-b (FCM), K-c (chat bubble redesign), K-d (marketplace
redesign). K-c overlaps files with Streams C/E/I (message bubbles / input /
forward) — if those streams are in flight, K-c lands FIRST and the others rebase
on the new bubble widgets, or coordinate via the file table; never concurrent
edits to the same widget file.

## K1. Dialpad — paste a copied number (pic 1) — `[FIX-DIAL-1]`
The dialpad (AvaPhone / dialpad tab) number display must support pasting:
- Long-press on the number display → system context menu with **Paste**.
- ALSO add a small paste icon button beside the display (discoverability), shown
  only when the clipboard contains something number-like.
- Sanitize on paste: strip spaces, dashes, dots, parentheses; keep leading `+`
  and digits; convert `00` prefix to `+`. Reject (snackbar "Not a phone number")
  if <4 digits after sanitizing.
- After paste the number renders in the display and the green dial button works
  immediately — no other taps needed.
- Telemetry: `dialpad_paste` (digits_len, had_plus).

## K2. Contact long-press menu (pic 2) — `[FIX-CONTACT-1]`
On ANY contact row (contacts list, chat list contact, dialpad favorites) a
long-press / right-click opens a context menu with:
- **Copy contact** — copies "Name — +number" (and handle if present) to clipboard.
- **Share contact** — system share sheet with a vCard (.vcf) built from the
  contact (name, AvaTOK number, handle).
- **Forward contact** — opens the Stream-I forward sheet, sending the app's
  existing contact-card message kind (groups keep full messaging incl. contact
  cards per the rulebook — reuse that envelope).
If a context menu already exists on some rows, EXTEND it; do not create a second
menu pattern. Telemetry: `contact_copied/shared/forwarded`.

## K3. FCM notifications regression (pic 3) — `[FIX-FCM-1..3]` (HIGH PRIORITY)
Symptom: owner previously received heads-up FCM notifications ("AvaMarketplace /
New message") that woke the phone and beeped; now nothing.
Known history (Graphiti/memory — READ THESE EPISODES FIRST):
- 2026-06-29: FCM `getToken` failed with `FIS_AUTH_ERROR` → 0 push tokens
  registered ("no device registered"); `push_register` telemetry was added; the
  Google Cloud project deletion/restore was involved.
- 2026-07-01: staging google-services.json client fix (147311d).
- 2026-07-01: transport flipped to `MSG_TRANSPORT=inbox` (Ably disabled) — verify
  the offline-push fan-out (`/api/notify` with fromName+preview, built 2026-06-28)
  still fires on the inbox transport path for EVERY offline recipient.
Work order:
1. `[FIX-FCM-1]` Diagnose: pull PostHog `push_register` events for
   `hdavy2005@gmail.com`; confirm whether a current FCM token exists for the
   owner's device + account. If FIS_AUTH_ERROR persists, fix the Firebase
   installation config (google-services.json / API key restrictions in project
   avatok-e19ef) — document root cause in the commit.
2. `[FIX-FCM-2]` Guarantee the three notification triggers server-side:
   (a) incoming DM/group message while recipient offline/backgrounded →
   FCM with sender name + preview; (b) missed call / "Ava took a message"
   (receptionist) → FCM "Missed call — Ava took a message from <name>";
   (c) Novu-driven notifications (the Novu integration) → ensure Novu's FCM
   provider integration is configured and firing, or route Novu events through
   our own /api/notify path — whichever is already closest to working; do NOT
   build a second parallel push system.
3. `[FIX-FCM-3]` Client: Android notification channel `messages` with
   IMPORTANCE_HIGH + sound + vibration (heads-up wake like the screenshot);
   channel `calls` for missed-call/receptionist. Verify a data-only message still
   posts a local notification when the app is killed (use
   FirebaseMessaging.onBackgroundMessage). Telemetry: `push_shown` (channel,
   type), `push_token_registered` (keep existing push_register events too).
Acceptance: with the app killed, sending the owner a DM from another account
produces a heads-up beep notification within seconds; a missed receptionist call
produces one too.

## K4. Chat bubble redesign — voice notes + media + files (pics 4 & 7) —
`[UI-BUBBLE-1..3]`
Owner complaints: (1) voice-note play icon too small; (2) bubbles leave a huge
right-side gutter (incoming bubbles stop ~60% width) AND media inside the bubble
has ANOTHER right gap → double-gutter, squeezed look. Required redesign, one
coherent modern spec:
- `[UI-BUBBLE-1]` Geometry: bubble max-width = 78% of thread width for BOTH
  incoming and outgoing (WhatsApp-like), symmetric horizontal thread padding
  (12dp each side). Text bubbles size to content up to the max.
- `[UI-BUBBLE-2]` Media bubbles (image/video): the media IS the bubble —
  edge-to-edge fill inside the rounded-corner clip, NO inner padding, no visible
  bubble chrome around the image except the rounded mask + timestamp/status
  overlaid bottom-right on a subtle gradient scrim. Aspect-fit within max 78%
  width × 320dp height (cover-crop very tall/wide sources). Video: same, with a
  center play glyph + duration chip. PDFs/files: full-width (of the bubble) row —
  file-type icon in a tinted rounded square, filename (1-line ellipsis), size +
  extension subtitle; no dead space to the right. Forwarded label (Stream I)
  overlays top-left on media.
- `[UI-BUBBLE-3]` Voice-note bubble: modern voice UI — LARGE circular play
  button (44dp min touch target), waveform bar (static bars are fine v1,
  progress-tinted while playing), duration right-aligned, playback speed chip
  (1x/1.5x/2x) after play starts. Same 78% width rule.
- Keep the zine design system (`app/lib/core/ui/zine*.dart`) as the styling
  source — new bubbles must be zine-styled, not a foreign design language.
- These widget changes are shared with Streams C (preview cards) and I
  (forwarded label): land K4 first (see stream ordering note above).
- Telemetry: none required beyond existing message events.

## K5. Marketplace cards + listing page redesign, WIRED (pics 5 & 6) —
`[UI-MKT-1..4]`
Owner: "modern, sexy" cards, everything wired to REAL data — no dummy numbers.
Existing backing (verify, reuse, extend): `listing_views` + stats endpoints and
listing reviews shipped 2026-06-11 (see Graphiti "Listing photos + creator
analytics"); reviews visible on the listing page already ("Reviews" section).
- `[UI-MKT-1]` Grid card redesign: photo top (rounded, edge-to-edge);
  **heart icon overlaid top-right of the photo** → toggles favorite (see MKT-3);
  price bold + currency; title 1-line; row of wired micro-stats with icons:
  ★ rating average + review count (from the reviews data), 👁 view count (from
  listing_views), country flag chip as today; optional "NEW" chip when the
  listing is <48h old, and seller avatar chip. Compact, modern spacing —
  zine-styled.
- `[UI-MKT-2]` Listing page redesign to match: photo gallery header
  (swipeable, page dots), heart overlay, title + price row, wired stats row
  (★ reviews / 👁 views / posted-ago), seller card, description, reviews
  section. REMOVE the "GROUP SESSION (NULL)" chip — that is the
  `market_type`/`social_sub` field rendering when null/irrelevant; the chip must
  render ONLY when the listing actually has a meaningful market/session type,
  and never print NULL. Fix the formatter, not just this instance (audit other
  chips on the page for null leakage).
- `[UI-MKT-3]` Favorites wiring: if a favorites/save endpoint exists, use it;
  if not, add `POST/DELETE /api/marketplace/favorites {listing_id}` +
  `GET /api/marketplace/favorites` (D1 table `listing_favorites(uid, listing_id,
  created_at)` PK(uid,listing_id)), heart state hydrated on fetch, and a
  "Favorites" filter chip on the marketplace home. Increment nothing on
  favorite; views keep using the existing listing_views tracking (fire it on
  listing-page open if not already).
- `[UI-MKT-4]` Ensure view counts, ratings, review counts on the CARD come from
  the listing list/query endpoint in ONE query (extend the SELECT with
  aggregates/joins) — do NOT issue N+1 per-card stat fetches.
- Telemetry: `listing_favorited/unfavorited`, `mkt_card_impression` (batched),
  keep existing listing_view events.

## K6. File-ownership additions (extends §9/§15)
| Files | Sub-stream |
|---|---|
| dialpad screen widget, contacts row context menu | K-a |
| push registration (Flutter), notify path (`worker`), Android channels, Novu integration config | K-b |
| message bubble widgets (voice/media/file), zine bubble styles | K-c |
| marketplace grid card + listing page widgets, `worker/src/routes/listings.ts` (stats aggregates, null-chip fix), favorites route/table | K-d |

## K7. Acceptance additions
- Pasting "+44 7951 039-396" into the dialpad shows +447951039396, dial works.
- Long-press a contact → Copy/Share/Forward all function (share produces a .vcf).
- App killed → incoming DM beeps + heads-up within seconds; missed receptionist
  call notifies; PostHog shows push_shown with the owner's email.
- Incoming and outgoing bubbles reach 78% width with symmetric gutters; an image
  fills its bubble edge-to-edge with zero inner right gap; voice note has a
  ≥44dp play button and waveform.
- Marketplace card shows real ★/review/view numbers (verify against D1),
  heart persists across restart, "GROUP SESSION (NULL)" is gone everywhere,
  card grid causes no N+1 queries.
