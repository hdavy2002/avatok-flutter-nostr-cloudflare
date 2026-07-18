# One Brain — AI Unification Inventory + Plan (DRAFT)

**Status:** DRAFT for discussion. Nothing built. Owner brief 2026-07-17: *"we need to unify
ai, so we can call it one brain… avabrain should be one ai that knows everything the user
did on our platform… tomorrow when we build something new, we can simply say, let avabrain
suck this data."*

**Part 1 is the inventory (what exists). Part 2 is the plan (what to do). Part 3 is the
part you may not like.**

---

# PART 1 — THE INVENTORY

## 1.1 Headline numbers

| | Count |
|---|---|
| Distinct AI **providers** | **6** — Cloudflare Workers AI, OpenRouter, Google direct, OpenAI direct, x.ai, CF REST AI-run |
| Distinct **model strings** | **31** |
| **Inference call sites** | **~62** |
| …that go through the official gateway `avaReason` | **14** |
| …that **bypass** it | **~48** |
| Distinct **memory stores** | **8**, across 3 lanes |
| User **data domains** that reach a brain today | **3 of 10** |

There is already a designated "ONE reasoning entry point" (`worker/src/lib/ava_reason.ts:36`).
**77% of our inference does not use it.** The unification you're asking for was decided once
already; it just never got enforced, and the tree has been drifting away from it since.

## 1.2 The reasoning plane — where the model calls actually are

**Through `avaReason` (14):** Guardian threat scan (`moderation.ts:274`), ChatAVA
(`ava_gemini.ts:162,186`), ai_chat util (`ai_chat.ts:45`), Copilot summarize/translate
(`ava_copilot.ts:174,223,282`), brain caption+extract (`consumers/brain.ts:220,306`),
image/text moderation (`consumers/moderation.ts:200,221,346`), auto-reply
(`consumers/auto_reply.ts:189,213`).

**Bypassing it (~48), grouped by how they escape:**

| Group | Sites | Worst offender |
|---|---|---|
| Raw fetch → OpenRouter | 9 | **`marketplace.ts:38 callSonnet`** — 5 call sites on Sonnet 4.6 (our priciest text path), **no telemetry, no cache, no fallback, silently returns `""` on any error** |
| Raw fetch → Google direct | ~17 | **`util.ts:79 geminiRun`** — fans out to 5 sites incl. the our-keys ChatAVA backend (`ava_agent.ts:453`), **zero telemetry, models hard-coded, no env override**. Largest untracked spend surface in the tree |
| Raw `env.AI.run` | 17 | every TTS/STT/embed/vision site; **none pass `aiRunOpts` (`lib/ai_gate.ts:73`)**, so they skip AI Gateway cost logging and caching entirely |
| Other providers | 5 | `consumers/brain.ts:474` OpenAI direct (no timeout); `lib/grok.ts` x.ai realtime + RAG |

**Notable individual findings:**

- **`genui_planner.ts:243` runs Claude Opus 4.8** — the most expensive model in the tree —
  with its own private telemetry schema, no KV cache, on output that is JSON and therefore
  highly cacheable.
- **`stt.ts:50` accepts a client-supplied `model` string with no allowlist.** A caller can
  name any OpenRouter model and bill it to us. That is a live cost/abuse hole, independent
  of this plan.
- **`ava_image.ts:143`** hard-codes its model with **no env override** — can't be swapped
  without a deploy.
- **`api.ts:619 openrouterVet`** has no timeout and sits in a registration path — a slow
  provider hangs signup.
- **Gemini Live token-mint sites** (`avavision`, `avavoice`, `ava_live`, `translate`,
  `receptionist`) hand an ephemeral token to the client and the inference happens
  **client-side**. `avaReason` structurally cannot see these, and there is **no server-side
  spend telemetry on the session at all**. This is a real architectural limit, not laziness.
- Four **parallel telemetry schemas** exist (`ava_reason_call`, `avaapps_model_fallback`,
  genui `LlmCall`, receptionist `ev`). None roll up together. **We cannot currently answer
  "what did AI cost us last month, by feature."**

## 1.3 The memory plane — 8 stores, 3 lanes

**Lane A — server (D1 `avatok-brain` + Vectorize):**
`brain_entities`, `brain_relationships`, `brain_facts`, `brain_daily_summaries`,
`brain_events`, `brain_vectors`, `brain_transcripts`, `brain_consent`
(`worker/migrations/brain.sql`, `brain_phase9.sql`). Vectorize `VECTOR_INDEX` holds four
id families (`:ent:`, `:lib:`, `:msg:`, `:vm:`), all `uid`-prefixed with a `uid` metadata
filter — **tenant isolation here is sound** (`user_brain.ts:80,107`).

**Lane B — client (per-account SQLite):** `AvaLocalIndex` FTS5 + 256-D vectors
(`local_index.dart:53`), `AvaOnDeviceRag` (`ava_ondevice_rag.dart:1`), `AvaProfileMemory`
4-layer profile (`ava_profile_memory.dart:10`). Router at `ava_memory.dart:201`.

**Lane C — third-party:** `RagService` (`rag_service.dart:18`) indexes files **and chat
text** into the *user's own Gemini File Search store* under their BYO key. **No
`BrainConsent` check anywhere in that file.** Plus `avachat_sessions` (D1 DB_META) and the
InboxDO `'brain'` conversation.

**Dead / broken stores:**
- **`brain_daily_summaries` has no writer.** Nothing on earth inserts into it. Both `ask`
  and `briefing` read it (`user_brain.ts:59`), so every briefing is permanently missing its
  "recent days" context. It has never worked.
- **`brain_relationships` is written but never read for answering** — only by `forget`
  (`user_brain.ts:232`). We build a graph and never traverse it.
- **`avachat_sessions` has no migration file** — created lazily by `ensureTable()`
  (`ava_chat_history.ts:27`). **This is the identical bug class to P1 in the listing plan**
  (the 8 orphan marketplace columns). Two independent instances of "schema that exists only
  in prod" is a pattern, not an accident.

## 1.4 The gap — what AvaBrain actually knows

Your brief lists what AvaBrain *should* know. Here is what it knows today:

| Domain | Ingested? | Evidence |
|---|---|---|
| Listings / marketplace | **YES** | `listings.ts:438,855,1114,1171`; `olx.ts:60,158` |
| Wallet | **YES** | `wallet.ts:300,391`; `payout.ts:151,205` |
| Attachments / files | **PARTIAL** | metadata always (`media.ts:67`); **content only if public AND consented AND premium** (`media.ts:598`) |
| **Chat messages** | **NO — built, dark** | `messaging.ts:632,635` gated on `brainEnabled` (`config.ts` default **false**) |
| **Voicemails** | **NO — built, dark** | full Whisper path at `brain.ts:415-443`, only reachable via the same dark gate |
| **Groups** | **NO — built, dark** | same gate |
| **Contacts** | **NO** | `contacts_backup.ts` — no producer exists |
| **Call history** | **NO** | `call_billing_routes.ts`, `telemetry_calls.ts`, `do/call_room.ts` — no producers |
| **Missed calls** | **NO** | `missedcall.ts` — no producer |
| **Dating / matrimony** | **NO** | no route files exist at all |

**3 of 10.** And the seven missing ones split into two very different problems:

- **Chat / voicemail / groups**: the pipeline is *fully built and deployed* and switched off
  by one flag. Turning it on is a flag flip — and a serious decision (§3.1).
- **Contacts / calls / missed calls**: no producer exists. This is the "let avabrain suck
  this data" work, and it's genuinely small per domain — `brainFact()` (`hooks.ts:110`)
  already exists and is used at 20 call sites.

## 1.5 Consent is broken in five ways

This is the part that worries me most, because it's the part with legal exposure.

1. **Two Settings toggles gate nothing.** `library` and `marketplace`
   (`brain_consent.dart:27-29`) are **checked by no code, client or server** — while
   `listings.ts:438` and `olx.ts:60` ingest marketplace data regardless. **A user who turns
   off "Marketplace" in Settings is still ingested.** That is a consent UI that lies.
2. **The "Messaging" toggle doesn't gate message ingestion.** `messaging`
   (`brain_consent.dart:26`) is only read by `ai_chat.ts:67`. The consumer's `capabilityFor`
   (`consumers/brain.ts:16-31`) checks `avatok_messages` — **a key that isn't displayed**.
3. **Guardrails fail OPEN.** `consumers/brain.ts:42` and `:281` both `catch { return true }`
   — a D1 blip ingests data the user opted out of. Already flagged on 2026-06-30
   (`INFRA-COST-CLARIFY-ANSWERS-2026-06-30.md:100`) and still live. Compare
   `lib/moderation.ts`, which fails open **deliberately and correctly** — failing open on a
   *safety classifier* is a product call; failing open on a *consent check* is a breach.
4. **`brainFact()` producers bypass consent entirely** (`hooks.ts:110`), relying on a
   `source_app` fallback. `listings.ts` passes `APP` and `api.ts:813` passes `"profile"` —
   **neither is a key in `kBrainCapabilities`, so they are literally unblockable.**
5. **Purge is incomplete.** `purgeBrain` (`consumers/brain.ts:538-546`) covers 7 DB_BRAIN
   tables + Vectorize but **misses `avachat_sessions`, the InboxDO `'brain'` conv, and the
   user's Gemini File Search store**. "Delete my AvaBrain data" leaves ChatAVA transcripts
   intact. Also `retro_delete` is itself gated on an env var (`brain.ts:109`) — if
   `BRAIN_RETRO_DELETE` is unset, **toggling a capability off leaves already-indexed vectors
   live forever.**

**Read 1, 4 and 5 together:** we have a consent UI with toggles that don't work, ingestion
paths that can't be blocked, and a delete that doesn't fully delete. Today that's survivable
because the big lane is dark. **The moment you flip `brainEnabled` to true, it stops being
survivable.** Fixing consent is not a phase of this plan — it is the entry price.

---

# PART 2 — THE PLAN

## 2.1 The shape: three planes, one contract each

"One brain" is really three unifications. They're separable and should ship in this order.

```
   ┌──────────────────────────────────────────────────┐
   │  GOVERNANCE PLANE   consent registry · purge ·   │
   │                     retention · audit            │
   └──────────────────────────────────────────────────┘
                          ▲          ▲
   ┌──────────────────────┴──┐  ┌────┴─────────────────┐
   │  REASONING PLANE        │  │  MEMORY PLANE        │
   │  one gateway: avaReason │  │  one brain: ingest → │
   │  every model call       │  │  store → recall      │
   └─────────────────────────┘  └──────────────────────┘
```

## 2.2 The Ingestion Contract — this is the bit you actually asked for

> *"tomorrow when we build something new, we can simply say, let avabrain suck this data."*

Today that sentence costs a developer: pick a queue, invent an event shape, guess a
capability key, hope purge covers it. That's why we have 3 of 10 domains — **the path of
least resistance is to not do it.**

Make it one function and one registry entry:

```ts
// worker/src/lib/brain_ingest.ts  (NEW — the ONLY way data enters the brain)
await brainIngest(env, {
  uid,
  domain: 'calls',              // must exist in the DOMAIN REGISTRY
  kind:   'call_completed',
  text:   'Call with Priya, 4m12s, outgoing',
  meta:   { peer, duration, direction },
  scope:  'public',             // 'public' = server-readable | 'private' = device-only
  ts,
});
```

And the registry — **one row per domain, and adding a domain is adding a row:**

```ts
// worker/src/lib/brain_domains.ts (NEW)
export const BRAIN_DOMAINS = {
  contacts:  { consent: 'contacts',  label: 'Contacts',      default: true,  scope: 'public'  },
  calls:     { consent: 'calls',     label: 'Call history',  default: true,  scope: 'public'  },
  voicemail: { consent: 'voicemail', label: 'Voicemails',    default: true,  scope: 'public'  },
  messages:  { consent: 'messages',  label: 'Chats',         default: true,  scope: 'public'  },
  listings:  { consent: 'listings',  label: 'Marketplace',   default: true,  scope: 'public'  },
  wallet:    { consent: 'wallet',    label: 'Wallet',        default: true,  scope: 'public'  },
  files:     { consent: 'files',     label: 'Files',         default: true,  scope: 'public'  },
  // dating: { ... }  ← tomorrow, this line IS the integration
} as const;
```

`brainIngest` then does, in one place, for every domain forever:

1. resolve `domain → consent key` from the registry (no more guessing, no more `APP`)
2. check consent — **fail CLOSED** (fixes defect 3)
3. reject unknown domains at the type level (fixes defect 4 — `APP`/`profile` stop compiling)
4. enforce `scope: 'private'` → never leaves the device (§3.2)
5. enqueue to `Q_BRAIN` with one canonical envelope
6. register the vector id in `brain_vectors` so **purge and retro-delete cover it automatically** (fixes defect 5)

The Settings UI generates itself from the registry — so **a toggle can never again exist
for a capability nothing checks**, and a capability can never exist without a toggle. The
two consent defects (1 and 2) become structurally impossible rather than fixed-and-then-
re-broken.

**Ship this before wiring any new domain.** Wiring seven domains onto the current
unblockable, unpurgeable path just multiplies the breach surface by seven.

## 2.3 The Reasoning Plane — one gateway

Target: **every** inference call goes through `avaReason`, which becomes the single place
that owns telemetry, cache, fallback, timeout, token cap, spend attribution and kill switch.

Three problems to solve:

1. **`avaReason` is chat-shaped.** 17 `env.AI.run` sites are TTS/STT/embed/vision and
   *cannot* route through it as written. → Widen it to a small set of task verbs:
   `reason` (today's behaviour) · `embed` · `transcribe` · `speak` · `see`. Same telemetry,
   same attribution, one entry point.
2. **Two copies exist** — `worker/src/lib/ava_reason.ts` and `consumers/src/ava_reason.ts`,
   already drifted (consumers has `bumpSpend`, lacks `timeoutMs`). → One shared module.
3. **Live-token sites can't be captured** — inference is client-side. → Accept it, and
   instead require every token mint to emit a session-open/close telemetry pair so spend is
   at least *attributable*, even if not *proxied*. Don't pretend this is solvable.

Migration order (highest value first):
1. `marketplace.ts callSonnet` → 5 sites, priciest text path, currently invisible. Also
   fixes the `""`-on-error trap the listing plan has to work around.
2. `util.ts geminiRun` → 5 sites incl. our-keys ChatAVA. Largest untracked spend.
3. `genui_planner.ts` Opus → add the KV cache it should always have had.
4. `env.AI.run` sites → after the verb widening.
5. Everything else.

**Enforcement, or this regresses within a month:** an ESLint rule banning
`fetch("https://openrouter.ai…")` / `generativelanguage.googleapis.com` / `env.AI.run`
outside `lib/ava_*`. The current state *is* what happens without it — we wrote "the ONE
reasoning entry point" in a docstring and then bypassed it 48 times.

## 2.4 The Memory Plane — one brain

- **Fix the dead furniture:** write `brain_daily_summaries` (a nightly rollup — it's read by
  every briefing and has never existed), or drop the table and the reads. Either is fine;
  the current state is the only bad one.
- **Read `brain_relationships` or delete it.** We build a graph and never traverse it.
- **Give `avachat_sessions` a real migration**, and put it under `purgeBrain`.
- **One recall API.** Today: `user_brain.ts` ops, `lib/ava_memory.ts`, `AvaLocalIndex`,
  `AvaOnDeviceRag`, `RagService` — five recall paths, three of which any given feature might
  pick. Collapse to `brainRecall(uid, query, {domains?, k})` that fans out to server +
  device lanes and merges, so a feature asks *once* and doesn't care where memory lives.
- **`RagService` (Lane C) needs a decision** — it ships user chat text to a third-party
  store with no consent check. Either bring it under the registry or cut it. It cannot stay
  as-is under a "one brain" story; it is a second, unaudited brain.

## 2.5 Phases

| Phase | Ships | Why this order |
|---|---|---|
| **B0 — Stop the bleeding** | consent fail-CLOSED; registry + `brainIngest`; Settings generated from registry; purge covers all 8 stores; `stt.ts` model allowlist | Entry price. Everything after this is safe to scale. |
| **B1 — One gateway** | shared `avaReason`, verb widening, migrate callSonnet + geminiRun, ESLint ban, unified `ava_reason_call` | Makes cost visible before we multiply it |
| **B2 — Wire the domains** | contacts, calls, missed calls via `brainIngest` (~1 call site each) | Cheap once B0 exists |
| **B3 — The dark lane** | `brainEnabled` decision (§3.1), messages/voicemail/groups | The big one. Needs §3.1 resolved. |
| **B4 — One recall** | `brainRecall`, daily summaries, relationships, RagService decision | Quality, not safety |

---

# PART 3 — THE PART YOU MAY NOT LIKE

## 3.1 "Knows everything the user did" collides with your own rulebook

`CLAUDE.md` states, as a standing rule: **"private/E2E content is read on-device only
regardless of toggle."** The Cloudflare-native pivot
(`Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`) made the server *able* to read messages — it
did not decide that it *should*, for everything, forever.

Flipping `brainEnabled` to true means **every chat message a user sends gets embedded and
stored server-side, indefinitely**. That is not a flag flip; it's a change to what AvaTOK
*is*. Consequences:

- **Play Store data-safety declaration** would need to change ("messages collected, linked
  to identity, used for personalisation") — you'd be declaring the opposite of what a
  private-messaging app usually declares.
- **The 90-day churn purge** (`brain.ts:558`) is the *only* retention limit. A message
  embedded today, from an active user, is retained forever.
- **Legal hold** — `Specs/SPEC-2026-07-10-whatsapp-verification.md` §12 already records an
  unresolved legal-hold bug. A permanent semantic index of all conversations is exactly the
  asset that makes legal hold expensive.
- **It's not reversible.** Flip it on, ingest six months of messages, then decide it was
  wrong — `retro_delete` is gated on an env var that may not be set, and purge misses three
  stores.

**Recommendation:** the "one brain" story does **not** require server-side ingestion of
message *content*. Two cheaper options that deliver ~90% of what you described:

- **(a) Metadata, not content.** "You spoke to Priya 12 times this month, mostly about the
  Bandra flat" needs *who/when/thread-topic*, not the message bodies. Most of your listed
  use cases (contacts, call history, missed calls, voicemails-as-events) are **already
  metadata-only** and carry a fraction of the risk.
- **(b) Content stays on-device.** The device lane already exists and works
  (`AvaLocalIndex`, FTS5 + vectors, per-account). Let the device index message content and
  answer content questions locally; the server brain holds public-domain data (listings,
  wallet, files, calls) and merges. `brainRecall` (§2.4) makes this invisible to the user —
  **it still feels like one brain.** That's the whole point of unifying recall.

That gives you the product ("Ava knows everything I did") without making AvaTOK a company
that keeps a permanent readable index of everyone's private conversations.

> **DECISION NEEDED (B-D1).** Is `brainEnabled: true` — full server-side message content
> ingestion — actually what you want? Or metadata-only + device-side content (my
> recommendation)? **Everything in B3 hangs on this, and it is a legal/product call, not an
> engineering one.**

## 3.2 The `scope` field is the mechanism

Note `brain_entities`/`brain_facts` already carry a `scope` column: `public` = server-derived,
`private` = client-synced DM-derived. **The distinction you need already exists in the
schema.** §2.2's `brainIngest` makes it load-bearing instead of decorative: `scope:'private'`
never leaves the device, and the registry declares the scope per domain. If you pick option
(b), that's most of the work already designed.

## 3.3 Open decisions

| # | Decision | Recommendation |
|---|---|---|
| **B-D1** | Server ingests message *content*, or metadata-only + device-side content? | **Metadata + device** |
| **B-D2** | `RagService` (chat text → user's Gemini store, no consent check) — bring under registry or cut? | **Cut**; it's a second brain |
| **B-D3** | `brain_relationships` — traverse it or drop it? | Drop for now; revisit with a real use case |
| **B-D4** | Retention for the brain beyond the 90-day churn purge? | Needs a real answer before B3 |
| **B-D5** | Do B0 consent fixes ship as their own release, ahead of everything? | **Yes** |

## 3.4 What I'd do first, if you only do one thing

**B0.** Not because it's exciting — because right now we have a consent UI with two toggles
that do nothing, ingestion paths that are structurally unblockable, and a delete button that
misses three stores. That's true *today*, with the big lane dark and 3 domains wired. The
unification you're asking for multiplies every one of those by seven and then turns the dark
lane on.

The registry in §2.2 is genuinely small — one file, one function, and it's the thing that
makes "let avabrain suck this data" a one-line change forever after. It's the right first
move on the merits, and it happens to also be the thing that keeps this shippable.
