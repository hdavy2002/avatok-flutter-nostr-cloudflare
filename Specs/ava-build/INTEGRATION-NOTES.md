# Ava In-Chat — Integration Notes (append-only)

Cross-phase coordination log for the multi-agent Ava build. **Every phase appends
its own block at the bottom; never edit another phase's entry.** Phase 11
(Integration & Release) reads this top-to-bottom, reconciles everything, then makes
the single commit + push. Nobody else runs git.

## Append format (one block per phase)

```
## Phase N — <name> — <date>
- files: <created/edited paths>
- stubs/assumptions: <anything not real yet, uncertain versions, TODOs>
- needs from integration: <what Phase 11 must reconcile / verify>
- questions: <blocking ambiguities for the owner or other phases, if any>
```

If a contract you depend on is missing or ambiguous, append a **questions** line
here and proceed against a local stub rather than editing another phase's file.

---

## Phase 0 — Foundations & Contracts — 2026-06-17

- **files created:**
  - `app/lib/core/ava_contracts.dart` — `AvaKind` (ava/ava_private/ava_status),
    `AvaScope` (thread / to:<uid>), `AvaApi` route-path constants.
  - `app/lib/core/ava_bootstrap.dart` — `AvaBootstrap.init()` (empty extension points).
  - `app/lib/core/paid_feature.dart` — `kMinTopUpUsd = 5`, `PaidBadge`, `PaidFeature`,
    `AvaWalletHook` (interface + empty-wallet stub; real wiring is a later phase).
  - `app/lib/features/settings/settings_registry.dart` — `SettingsSection` +
    `SettingsSectionRegistry.register()/sections`.
  - `app/lib/features/settings/sections/README.md` — placement note for phase sections.
  - `worker/src/lib/ava_kinds.ts` — `AvaKind`, `MessageScope` (`thread` | `to:${string}`),
    `scopeAudience()`, `AvaBody` + `AvaStatusBody` body shapes.
  - `Specs/ava-build/INTEGRATION-NOTES.md` — this file.
- **files edited (additive):**
  - `app/lib/core/feature_flags.dart` — added `kFocusModeDefault`,
    `kWebSearchEnabledDefault`, `kFileAnalysisEnabledDefault`, `kOpenChatUncappedDefault`,
    `kDailyAvaTurnLimit = 25`, `kGuardianEnabledDefault`, `kCompanionEnabledDefault`,
    `kGenerativeEnabledDefault`. **No `aiEnabled` flag** — runtime "is Ava on for this
    user" is derived from `AvaAiStore` (documented in the file's comment).
  - `app/lib/core/app_registry.dart` — added `AppRegistry.focusMode` (avatok, avawallet,
    avapayout, avaidentity). Additive; no entries changed.
  - `app/lib/main.dart` — `await AvaBootstrap.init()` (guarded, non-blocking) before
    `RemoteConfig.start()`.
  - `app/lib/features/settings/settings_screen.dart` — imports `settings_registry.dart`;
    renders `SettingsSectionRegistry.sections` after the existing inline sections
    (Account type / Ava AI / AvaBrain / Backup / Danger zone all unchanged).
  - `app/lib/features/avatok/chat_thread.dart` — renders `ava`/`ava_private` as a
    **lilac** (`Zine.lilac`) left-aligned bubble with an `AVA` / `AVA · PRIVATE` label;
    renders `ava_status` as an inline italic "Ava is working…" lilac chip
    (`_avaStatusChip`). Both `_onDm` and `_onGroupMsg` now recognise the three Ava
    kinds as `special` envelopes. Added `_avaWakeWord` + nullable `onSummonAva` hook in
    `_send` (commented `Phase 3 fills this` — **no behavior implemented**).
  - `worker/src/routes/config.ts` — added kill-switches `aiEnabled`, `focusMode`,
    `webSearchEnabled`, `fileAnalysisEnabled`, `openChatUncapped`, `guardianEnabled`,
    `companionEnabled`, `generativeEnabled` (booleans) + `dailyAvaTurnLimit` (number,
    default 25; `putConfig` numeric-key validation extended).
  - `worker/src/do/inbox.ts` — `append()` accepts optional `scope: 'thread' | to:<uid>`;
    added nullable `audience TEXT` column (guarded `ALTER TABLE` in ctor, swallows
    duplicate-column on already-migrated DOs); `audience` echoed on the `msg` frame +
    in `syncPayload` SELECT. Added `avaStatus()` transient helper + `/ava_status` route
    (broadcast only, **never persisted**). Backward compatible: default kind `text`,
    default scope `thread` (NULL audience).
  - `worker/src/types.ts` — `Env` gained `AVA_AGENT`, `BACKUP` (DurableObjectNamespace),
    `BACKUP_R2` (R2Bucket), `STRATA_URL?` (string). Part of the bindings contract.
  - `worker/wrangler.toml` — added DO bindings `AVA_AGENT` (class `AvaAgentDO`) +
    `BACKUP` (class `BackupDO`), R2 bucket `BACKUP_R2` = `avatok-backup`, var
    `STRATA_URL = ""`, and `[[migrations]] tag = "v6"` for the two new SQLite DO
    classes — in BOTH the prod and `[env.staging]` sections (staging bucket =
    `avatok-backup-staging`). All existing bindings/migrations untouched.
  - `worker/src/index.ts` — registered the new routes (`POST /api/ava/gemini`,
    `POST /api/ava/thread/turn`, `POST /api/ava/guardian/scan`, `POST /api/ava/image`,
    `/api/ava/tools/*`, `GET/PUT /api/backup` + `GET /api/backup/status`) and added
    `export { AvaAgentDO } from "./do/ava_agent"` / `export { BackupDO } from "./do/backup"`.

- **CORRECTION (master plan said `api.ts`):** the worker router is **`worker/src/index.ts`**,
  NOT `worker/src/api.ts`. Routing is path-equality dispatch inside
  `dispatch(req, env, ctx)` in index.ts (`worker/src/routes/api.ts` is a *handlers*
  module imported as `* as api`, not the router). All Ava route registration + DO
  exports were done in index.ts. Master-plan §1 / §4 / PHASE-00 references to "api.ts"
  should be read as **index.ts**.

- **stubs/assumptions:**
  - **The worker will NOT typecheck / `wrangler deploy` until later phases land.**
    index.ts now imports `./routes/ava_gemini` (P2), `./routes/ava_thread` (P3),
    `./routes/ava_tools` (P5), `./routes/ava_guardian` (P8), `./routes/ava_image` (P9),
    `./routes/backup` (P10), and DO classes `./do/ava_agent` (P3) + `./do/backup` (P10).
    Those files **do not exist yet** — this is intentional per the brief (register routes
    now so phases just drop in the named handler). **Expected & accepted.** Phase 11 must
    confirm every one of these modules exists with the exact exported names before deploy:
    - `ava_gemini.ts` → `avaGemini(req, env)`
    - `ava_thread.ts` → `avaThreadTurn(req, env)`
    - `ava_tools.ts` → `avaTools(req, env, subpath)`  (note the 3rd arg = path after `/api/ava/tools/`)
    - `ava_guardian.ts` → `avaGuardianScan(req, env)`
    - `ava_image.ts` → `avaImage(req, env)`
    - `backup.ts` → `backupGet(req, env)`, `backupPut(req, env)`, `backupStatus(req, env)`
    - `do/ava_agent.ts` → `export class AvaAgentDO` (SQLite-backed; matches v6 migration)
    - `do/backup.ts` → `export class BackupDO` (SQLite-backed; matches v6 migration)
  - **pubspec.yaml unchanged.** On-device FTS5 + vector groundwork is ALREADY present:
    `drift ^2.16.0` + `sqlite3_flutter_libs ^0.5.18` (the latter bundles SQLite with FTS5
    on every device). `http ^1.2.0` is present (covers Strata SSE/HTTP); `dio` was NOT
    added (http already in use — adding dio would be a redundant second client). The
    on-device **vector** extension (sqlite-vec / ZVEC binding) and the **on-device
    embedder runtime** (LiteRT/ONNX) are **deferred to Phase 4** to pick + pin a current
    version against the real integration, rather than guessing a version here and pinning
    the tree to a wrong one. P4: add the vector + embedder deps then.
  - `STRATA_URL` is an empty placeholder in both envs — set to the real self-host origin
    before P5; P5's tool routes should 503 while it is empty.
  - `BACKUP_R2` buckets (`avatok-backup`, `avatok-backup-staging`) are **not provisioned**
    yet (`wrangler r2 bucket create …`) — P10 (or Phase 11 pre-deploy) creates them.
  - `AvaWalletHook` defaults to an empty-wallet stub (every premium tap → top-up sheet);
    the real wallet wiring + live top-up flow is a later phase. The stub's top-up sheet
    button currently pops `false` (TODO marked in-file).
  - chat_thread Ava rendering keys off the `special`/envelope-`t` mechanism. **Transport
    wiring of the live `ava`/`ava_private`/`ava_status` WS frames → `_Msg` is owned by
    Phase 3** (the agent loop posts them). Phase 0 made the *rendering* generic + taught
    the DM/group envelope parsers to recognise the kinds; if P3 delivers Ava turns via a
    different frame path (e.g. a transient `type:'ava_status'` socket frame rather than a
    persisted envelope), P3 maps it into a `_Msg(special: 'ava_status', extra: {label})`.

- **needs from integration (Phase 11):**
  - Confirm all 8 worker modules/classes above exist with the exact names; only then will
    the worker typecheck + deploy. Run the v6 migration on prod + staging.
  - Create the `avatok-backup` / `avatok-backup-staging` R2 buckets.
  - Verify the Flutter tree compiles once all phase files exist (no local toolchain here;
    CI/Phase 11 validates).

---

## Phase 1 — Menu Focus Mode + Paid Gating UI — 2026-06-17

- **files created:**
  - `app/lib/shell/focus_mode.dart` — `FocusMode` helper: a per-account on/off bool
    persisted via `DiskCache` (key `focus_mode`, auto-scoped under
    `cache/<AccountScope.id>/`), exposed as a `ValueNotifier<bool> FocusMode.enabled`
    seeded with `kFocusModeDefault` (Phase 0 flag). API: `load()` (re-reads for the
    current account; cheap, idempotent, reflects account switch), `set(bool)`
    (updates the notifier synchronously then persists), `toggle()`, `isLoaded`.
  - `app/lib/features/settings/sections/focus_section.dart` — `registerFocusSection()`
    registers a `SettingsSection` (id `focus_mode`, title "Focus mode", order 5) with a
    Zine `ZineToggle` bound to `FocusMode.enabled`/`FocusMode.set`. Calls `FocusMode.load()`
    in initState so the toggle reflects the current account's stored value.
- **files edited (additive, all OWNED):**
  - `app/lib/shell/ava_sidebar.dart` — wrapped `build()` in a
    `ValueListenableBuilder<bool>(valueListenable: FocusMode.enabled)` so the drawer
    rebuilds the instant the Settings toggle flips. When focus is ON the APPS list is
    sourced from `AppRegistry.focusMode` (avatok/avawallet/avapayout/avaidentity) and the
    explore/verse/library featured tiles are hidden; when OFF behaviour is byte-for-byte
    as before (`AppRegistry.standard`, featured tiles shown). `initState` now calls
    `FocusMode.load()`. Added `_paidAppIds = {avachat, avavoice, avavision}` and a
    `PaidBadge` on those rows in `_appRow` (badge only — the row still navigates; see
    assumption below). No registry entries removed; hidden tier untouched.
  - `app/lib/shell/ava_shell.dart` — `_load()` now `await FocusMode.load()` before
    `setState` so the menu paints the correct mode without a default-then-correct flicker
    for accounts whose stored value differs from `kFocusModeDefault`. Added the import.
- **sanctioned bootstrap append:**
  - `app/lib/core/ava_bootstrap.dart` — added `import '../features/settings/sections/focus_section.dart';`
    and `registerFocusSection();` inside `AvaBootstrap.init()`. This is the only shared-file
    edit (the file's comments invite exactly this registration). Idempotent (registry is
    keyed by section id).
- **stubs/assumptions:**
  - **`PaidFeature` (the action-wrapper) is NOT used in the sidebar — by design.** Sidebar
    rows are *navigation* entries, and `PaidFeature` runs its action only after a successful
    `AvaWalletHook.canSpend()` (the Phase-0 stub always returns false → it would open the
    top-up sheet instead of opening the app, breaking navigation). So premium menu rows get
    a visible `PaidBadge` (avachat/avavoice/avavision) and the real `PaidFeature` spend-gate
    belongs at each feature's point-of-use — owned by P6 (companion/voice) and P9
    (generative). Phase 11: confirm those phases wrap their actual premium actions in
    `PaidFeature`; nothing for P11 to wire on the menu side.
  - Focus mode default is ON (`kFocusModeDefault = true`, Phase 0). On a fresh account the
    menu starts focused (AvaTOK + wallet/payout/identity); users widen it via Settings →
    Focus mode. If the owner wants the menu to start full, flip the Phase-0 flag (not a P1
    file).
  - In focus mode, wallet/payout/identity appear in BOTH the APPS list (from
    `AppRegistry.focusMode`) and the collapsible ACCOUNT section. Harmless duplication;
    Wallet stays reachable as required. Left as-is to honour the Phase-0 `focusMode` set
    verbatim. If undesired, a later tweak can subtract the ACCOUNT-section ids from the
    focus APPS list (P1-owned file, easy follow-up).
- **needs from integration (Phase 11):**
  - No cross-phase wiring required. Only OWNED FILES + the one sanctioned `ava_bootstrap.dart`
    append changed. Verify compile in CI once all phases land.

---

## Phase 3 — In-Thread Ava Spine — 2026-06-17

- **files created:**
  - `worker/src/do/ava_agent.ts` — `export class AvaAgentDO` (SQLite-backed, matches
    wrangler v6 migration). Per-user agent runtime. Ops (Worker→DO fetch only):
    - `POST /turn {conv, uid, text, private?}` — posts the working chip, reads a bounded
      recent window from the caller's InboxDO (`/sync`) + a rolling `thread_summary`
      (its own SQLite table), wraps all thread/summary/RAG/user text as quoted UNTRUSTED
      data, calls Gemma (`@cf/google/gemma-4-26b-a4b-it`), llama-guard-checks the output
      (regenerate once → safe refusal), then posts the answer via `/post`.
    - `POST /post {conv, uid, text, private?, source?, media_ref?, meta?}` — the GENERIC
      "post an Ava message into a conversation" op. Fans out a `kind:'ava'` envelope to
      every member's InboxDO; for `private:true` writes ONLY `uid`'s InboxDO as
      `kind:'ava_private'`, `scope:'to:<uid>'` (never the other party). This is what
      P6/P8/P9 reach via the exported helper below.
  - `worker/src/routes/ava_thread.ts` — `export async function avaThreadTurn(req, env)`
    (matches the `index.ts` import/route exactly). Dual-auth via `requireUser`; validates
    `{conv? | to?, text, private?}`; resolves the conv (`conv` as-is, or `to`=peer uid →
    `dmConvId`); forwards to the caller's `AvaAgentDO /turn`; returns fast (answer is
    async via InboxDO). Also exports the downstream helper `postAvaMessage(...)` (below).
  - `app/lib/features/ava/ava_turn_controller.dart` — `AvaTurnController.I.summon({convKey,
    text, privateReply})`. Resolves the local `convKey` ('1:<peerUid>' | 'g:<gid>') to the
    server conv id via `serverConvFromKey(convKey, AccountScope.id)` and POSTs to
    `AvaApi.threadTurn` (URL built from `kApiBase` origin + the Phase-0 path). In-flight
    guard per conv. Does NOT render — the worker posts the chip + answer back through the
    InboxDO and the existing (frozen) chat pipeline renders them.
  - `app/lib/features/ava/ava_invoke.dart` — the `@ava` parse/handler. `AvaInvoke.parse()`
    detects the wake word + a private modifier (`@ava!` / `@ava private` / `@ava (private)`).
    `AvaInvoke.makeHandler(convKey)` returns a `Future<void> Function(String text)` to assign
    to the composer's `onSummonAva`. `AvaInvoke.handle(convKey, text)` runs a turn.

- **DOWNSTREAM helper for P6 / P8 / P9 (the "post Ava message into conversation X" API):**
  ```ts
  // worker/src/routes/ava_thread.ts
  export async function postAvaMessage(env: Env, args: {
    ownerUid: string;   // user whose AvaAgentDO authors the post (recipient for private)
    conv: string;       // server conv id: dm_<lo>__<hi> or g_<uuid>
    text: string;
    private?: boolean;  // true → ava_private to ownerUid ONLY (never the other party)
    source?: string;    // 'guardian' | 'image' | 'companion' | 'delegate' | 'tool' | 'chat'
    media_ref?: string; // image gen attaches this
    meta?: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }>
  ```
  P8 Guardian: `postAvaMessage(env, {ownerUid: childUid, conv, text: warning, private: true,
  source: 'guardian'})`. P9 image: `postAvaMessage(env, {ownerUid, conv, text, media_ref,
  source: 'image'})`. P6 companion can also just call `POST /api/ava/thread/turn`.

- **COMPOSER WIRING — DEFERRED (one line, for the chat-screen owner / Phase 11):**
  `chat_thread.dart` is FROZEN and exposes `onSummonAva` as a field on the private STATE
  (`_ChatThreadScreenState`), with no public accessor and no GlobalKey at any of the 9+
  `ChatThreadScreen(...)` construction sites (inbox/search/community/new_group/chat_list/
  creator_channel/listing_detail/consult). There is NO single owned wiring point, so Phase 3
  did NOT edit any non-owned file. **The minimal wiring is ONE line inside the state's
  `_setupDm`/`_setupGroup` (right after `_convKey` is assigned), or in `initState`:**
  ```dart
  // in chat_thread.dart, after _convKey is set (frozen file — owner/P11 to add):
  onSummonAva = AvaInvoke.makeHandler(_convKey!);
  // (import '../ava/ava_invoke.dart';)
  ```
  Everything else is in place: `_send` already invokes `onSummonAva!(t)` on `@ava`, and the
  controller + handler are complete. Until this one line lands, `@ava` is a no-op (sends as a
  normal text message), exactly as in Phase 0.

- **stubs/assumptions / TODOs:**
  - **TODO(P2):** `AvaAgentDO` calls Gemma directly and runs llama-guard inline (mirrors
    `do/conversation.ts`), marked `// TODO(P2): route through ai_gate`. Once
    `/api/ava/gemini` + `lib/ai_gate.ts` ship, route generation through the gate (it owns
    moderation + the daily cap / `dailyAvaTurnLimit`). The per-turn cap is NOT enforced yet.
  - **TODO(P4):** `brainSearch()` is a no-op stub returning `[]` (retrieval/RAG is empty
    until Phase 4's `brain.search` tool exists), marked `// TODO(P4)`.
  - **Working chip delivery (important for P11/SyncHub owner):** the chip is the transient
    `ava_status` kind. The InboxDO `/ava_status` op broadcasts WITHOUT persisting, but the
    client live multiplexer `app/lib/sync/sync_hub.dart` `_handle` switch only routes
    `msg/receipt/read/storage` frames — it does NOT route a top-level `type:'ava_status'`
    frame into the thread. It DOES route normal `msg` frames whose `body` is an
    `{t:'ava_status'}` envelope (the FROZEN `chat_thread.dart` renders that as the chip).
    So `AvaAgentDO.postStatus()` does BOTH: (a) fires the transient `/ava_status` broadcast
    (architecturally correct, currently a no-op render), AND (b) appends a normal `msg`
    carrying the `{t:'ava_status', phase:'start'|'end', status_id}` envelope so the chip
    renders today. The `phase:'end'` envelope is posted when the answer lands. **Cleaner
    follow-up (optional, NOT required for acceptance):** add one `case 'ava_status':` to
    `sync_hub.dart`'s `_handle` to forward the transient frame, then drop the persisted-chip
    fallback in `postStatus`. `sync_hub.dart` is not a Phase-3 owned file, so left as-is.
  - DM convs: `AvaAgentDO.members()` derives `dm_<lo>__<hi>` membership directly (so a turn
    in a brand-new 1:1 with no `conversation_members` rows still fans out). Groups read
    `conversation_members` from `DB_META`.
  - `sender:'ava'` is used as the message sender for all Ava posts (the InboxDO treats it as
    an incoming message for fan-out; `chat_thread` renders by envelope `t`, not sender).

- **needs from integration (Phase 11):**
  - Add the ONE composer-wiring line above to `chat_thread.dart` (or via GlobalKey at the
    construction sites) so `@ava` is live. Without it the feature is inert but harmless.
  - `AvaAgentDO` + `avaThreadTurn` exist with the exact names `index.ts` imports/exports —
    confirmed. The v6 migration (Phase 0) covers `AvaAgentDO`'s SQLite.
  - When P2 lands, replace the direct-Gemma + inline-guard block with the ai_gate call and
    wire the daily cap. When P4 lands, implement `brainSearch()`.

---

## Phase 2 — BYO-AI Worker Proxy + Moderation Gate — 2026-06-17

- **files created:**
  - `worker/src/routes/ava_gemini.ts` — `export async function avaGemini(req, env)`
    (matches the exact name `index.ts` routes `POST /api/ava/gemini` to). Dual-auth via
    `requireUser`; body `{message, context?, mode?, history?}`. **Tier resolution:** if the
    request carries a BYO Gemini key (header `X-Ava-Gemini-Key`, or body `key`) → tier
    `byo`, calls the **Google Gemini REST API** (`generativelanguage.googleapis.com/v1beta/
    models/<model>:generateContent`, `x-goog-api-key`, default model `gemini-2.5-flash`,
    `mode` may override to any `gemini-*`), full features, **no daily cap**. Else tier
    `ourkeys` → cheap **Workers-AI Gemma** (`@cf/google/gemma-4-26b-a4b-it`, matches
    P3/agent.ts/conversation.ts), daily-capped. BOTH tiers route through `runGated()` →
    moderation always applies. Returns `{answer, blocked?, reason?, remaining?, tier?}`
    (503 only when `aiEnabled` is off). The BYO key is **used per-request and NEVER stored**.
  - `worker/src/lib/ai_gate.ts` — the gate. Exported API (P3 can call these directly):
    - `isSafe(env, text): Promise<boolean>` — llama-guard (`@cf/meta/llama-guard-3-8b`);
      fails OPEN on classifier error, CLOSED on a confident "unsafe" (mirrors
      conversation.ts / ava_agent.ts).
    - `guardInput(env, text): Promise<{ok, reason?}>` / `guardOutput(env, text): Promise<{ok, reason?}>`.
    - `intentGate(userText): {needsModel, cannedReply?}` — cheap deterministic "does this
      turn need the model?" (trivial acks/empties get a free canned reply, no spend, no cap).
    - `enforceQuota(env, uid, tier, {premium?, commit?}): Promise<{allowed, reason?, remaining?, limit?}>`
      — BYO + premium (`openChatUncapped`) bypass; our-keys free tier checked (and, with
      `commit:true`, incremented) against `dailyAvaTurnLimit` (config.ts).
    - `webSearchAllowed(env, tier, premium?)` / `fileAnalysisAllowed(env, tier, premium?)`
      — gated by the `webSearchEnabled` / `fileAnalysisEnabled` config flags (premium-only;
      both default OFF). These are **availability checks only** — the actual web-search /
      file-analysis TOOLS are not built here (P5 tool layer). Until then a caller can treat
      `false` as "premium required / not available".
    - `runGated(env, {uid, tier, premium?, userText, generate, skipQuota?}): Promise<{answer, blocked?, reason?, remaining?}>`
      — the all-in-one wrapper: kill-switch (`aiEnabled`) → intent gate → input guard →
      quota → `generate()` → output guard (regenerate once → safe refusal). `generate(steer?)`
      is the caller's model closure, so the gate is **model-agnostic** (BYO/our-keys/P3 Gemma
      all plug in). `reason` ∈ `ai_disabled | daily_cap | input_unsafe | output_unsafe`.
  - `worker/src/lib/ai_quota.ts` — `check(env, uid, limit)` / `increment(env, uid, limit)`
    returning `{used, limit, remaining, exceeded}`. **Quota store choice = KV (`env.TOKENS`)**,
    one key per uid per UTC day (`ava_turns:<uid>:<YYYY-MM-DD>`) with a ~2-day TTL so
    counters self-evict — no table, no migration, no cleanup cron. A daily cap doesn't need
    strict atomicity (any race undercounts in the user's favour). If a hard race-free cap is
    ever needed, swap the body for a `DB_META ava_turns(uid, day, count)` UPSERT — the
    signatures stay identical.
  - `app/lib/core/ava_ai_client.dart` — `AvaAiClient.I.ask({message, context?, mode?, history?})`
    → `Future<AvaAnswer>`. ALWAYS calls the Worker (`AvaApi.gemini`), **never Google
    directly**. Reads the BYO key from `AvaAiStore` and sends it per-request over TLS in the
    `X-Ava-Gemini-Key` header (not the body) via the app's authed helper
    (`ApiAuth.postJsonH` — NIP-98 + optional Clerk bearer, same path as every other call).
    `AvaAnswer` = `{answer, blocked, reason?, remaining?, tier?}` (+ `hitDailyCap`).

- **files edited:** none. **`ava_bootstrap.dart` append was NOT needed** — `AvaAiClient` is a
  request-driven singleton with no init/registration step (the BYO key is read live from the
  existing `AvaAiStore` on each call). No git ops; only OWNED FILES created.

- **THE P3 ONE-LINE SWAP (for Phase 11 — do NOT edit P3's file mid-stream):**
  `worker/src/do/ava_agent.ts` currently calls Gemma directly + runs llama-guard inline
  (the `// TODO(P2): route through ai_gate` block in `turn()`, lines ~250-258). To route it
  through the gate, replace that generate+safe block with a single `runGated` call that hands
  its existing `generate(...)` as the closure:
  ```ts
  // top of ava_agent.ts:
  import { runGated } from "../lib/ai_gate";
  // inside turn(), replacing the generate + safe(...) regenerate block:
  const gated = await runGated(this.env, {
    uid, tier: "ourkeys", userText,
    generate: (steer) => this.generate(summary, window, steer ? `${userText}\n\n(${steer})` : userText, snippets),
  });
  let answer = gated.answer;
  ```
  This gives AvaAgentDO the SAME moderation (in+out, regenerate-once) it has now PLUS the
  daily cap + intent gate + `aiEnabled` kill-switch, with no behaviour regression. (P3's
  per-turn cap TODO is then satisfied.) Tier is `"ourkeys"` because the in-thread DO has no
  BYO key today; when P7's server-side key store lands it can pass `tier:"byo"` + the key.

- **KEY-TRANSPORT DECISION + the P7 note (important):**
  - Implemented **per-request transport**: the client sends its BYO key on each call over
    TLS; the Worker uses it and NEVER persists it. Simplest + most private; nothing to
    leak/rotate server-side.
  - **P7 / offline auto-reply will need a STORED key.** Server-initiated turns (delegate
    auto-reply, offline guardian/companion) have no live client request carrying the key, so
    they CANNOT use the BYO path as built. **P7 must add an opt-in, encrypted, per-uid,
    revocable server-side key store** (AES-GCM in a DO or a `DB_META` secrets table, keyed by
    a Worker secret) and feed it into `runGated({tier:"byo", ...})` for background turns.
    NOT built here — flagged for P7. Until then, server-initiated turns fall back to the
    capped our-keys tier (`tier:"ourkeys"`), which is fine.

- **stubs/assumptions:**
  - `web search` / `file analysis` are **gating helpers only** (`webSearchAllowed` /
    `fileAnalysisAllowed`) — the real tools belong to P5. Both flags default OFF, so today
    these always return `false` ("premium required / not available"). No no-op tool was
    stubbed into the generate path (it would just be dead weight); P5 wires the actual tools
    and can consult these helpers for the premium gate.
  - BYO model default `gemini-2.5-flash`; `mode` may pass any `gemini-*` id. our-keys model
    fixed to `@cf/google/gemma-4-26b-a4b-it` (matches the rest of the worker). If the owner
    prefers a different/cheaper Gemma or Gemini Flash variant, change the two consts at the
    top of `ava_gemini.ts` — no other file depends on the model ids.
  - `runGated` returns 200 (not an error code) for `daily_cap` / `*_unsafe` blocks with a
    friendly `answer` so the chat UI can just render the bubble; only `ai_disabled` → 503.
  - The intent gate's ack regex is intentionally conservative — anything beyond a one-word
    ack/emoji goes to the model. P5 can extend `intentGate` for tool intent.

- **needs from integration (Phase 11):**
  - Confirm `avaGemini` is the exact export `index.ts` imports for `POST /api/ava/gemini` —
    confirmed (`export async function avaGemini(req, env)`).
  - Apply the P3 one-line swap above to `worker/src/do/ava_agent.ts` (replaces its inline
    Gemma+guard, adds the daily cap). Safe, additive, no behaviour regression.
  - No new bindings/migrations: the quota store reuses the existing `TOKENS` KV; the BYO path
    uses the client's key (no `GEMINI_API_KEY` needed for BYO; our-keys uses `env.AI`).
  - Verify the Flutter tree compiles once all phases land (no local toolchain here).

---

## Phase 4 — Two-Lane Memory — 2026-06-17

- **files created:**
  - `app/lib/core/ava_memory/embedder.dart` — `AvaEmbedder` interface (`embed`,
    `ensureReady`, `isReady`), `kAvaEmbedDim = 256`, `AvaEmbedModel` (bgeSmall default
    ~40 MB / embeddingGemma opt-in), `AvaModelStore` (download-on-first-use: account-
    AGNOSTIC `…/ava_models/<file>` dir, streamed HTTP GET via dart:io, in-flight guard),
    and `defaultEmbedder` = `_HashingEmbedder` (the only inference that ships — see stub
    note). No new dependency.
  - `app/lib/core/ava_memory/local_index.dart` — `AvaLocalIndex` (free on-device lane).
    Creates `ava_fts` (FTS5 virtual table, `porter unicode61`, prefix 2/3), `ava_vectors`
    (256-D Float32 LE BLOB per message), `ava_index_state` (lazy-index bookkeeping) via
    raw `customStatement` on the EXISTING drift connection (`Db.I`) — db.dart is FROZEN,
    so no edit to its `@DriftDatabase`. `searchKeyword` (FTS5, `-bm25` ranked) →
    `searchVector` (brute-force cosine in Dart, no native vector engine). `indexMessage`
    (lazy, skips trivia: <3 chars / emoji-only / receipts; FTS immediate, vector only if
    embedder ready) + `backfill(convKey?, limit)` from the drift `messages` table.
  - `app/lib/core/ava_memory/ava_memory.dart` — DEFINES the `AvaMemory` interface (P0 only
    reserved the name) + `MemoryHit {messageId, convKey, score, snippet, lane}`. Router
    `AvaMemoryRouter` (singleton `AvaMemory.I`): `search(query, {convKey, topK=5,
    onDeviceOnly=false, allowServer=false})` runs the LOCAL lane (keyword→vector) always,
    adds the SERVER lane only when `allowServer && !onDeviceOnly && consent`, de-dups by
    messageId (local wins), top-k by score. `index(...)` / `backfill(...)` are on-device
    only. Server lane (`AvaServerLane` / `HttpServerLane`, folded into THIS file to stay
    within owned files) calls the existing `POST /api/brain/chat` and maps `sources` →
    `MemoryHit(lane:'server')`; gated by `BrainConsent.isOn('avatok_messages')`.
    `registerAvaMemory()` is the bootstrap entry (touches the router + wakes the embedder).
  - `worker/src/lib/ava_memory.ts` — `export async function brainSearch(env, uid, query,
    topK=5): Promise<BrainHit[]>` — uid-scoped Vectorize query mirroring `user_brain.ts`
    `rawMatches`/`vectorRecall` (same `@cf/baai/bge-small-en-v1.5` embed model + `BRAIN_
    EMBED_MODEL` override, HARD `filter:{uid}` tenant isolation, `returnMetadata`). Never
    throws (→ `[]`). Also `export async function brainSearchLines(...)→string[]` — the
    flattened context-line variant that is the drop-in for P3's stub (returns `string[]`).
    INTERNAL lib, NOT a route (index.ts is frozen and registered no memory route). Does
    NOT touch `user_brain.ts` / `brain.ts`.

- **sanctioned shared edits (the two handed to P4):**
  - `app/pubspec.yaml` — resolved P0's deferred vector+embedder deps: **added ZERO new
    packages** (documented inline). FTS5 = already bundled (`sqlite3_flutter_libs`);
    vectors = BLOB + brute-force cosine on the existing sqlite (no sqlite-vec/ObjectBox/
    ZVEC); embedder inference = stubbed (no native ML runtime dep, would be un-buildable
    headless). See the rationale comment block under the drift deps.
  - `app/lib/core/ava_bootstrap.dart` — added `import 'ava_memory/ava_memory.dart';` and a
    single `registerAvaMemory();` (fire-and-forget) inside `AvaBootstrap.init()`. Idempotent.

- **THE AvaMemory CLIENT API (for P3 spine + P5 tools):**
  ```dart
  final hits = await AvaMemory.I.search(query,
      convKey: convKey,            // optional: restrict to one conversation
      topK: 5,
      onDeviceOnly: false,         // true → local lane ONLY (private/secret chats)
      allowServer: false);         // true → also query the premium server lane (consent-gated)
  await AvaMemory.I.index(messageId: id, convKey: k, payload: envelopeJson, createdAt: sec);
  await AvaMemory.I.backfill(convKey: k);   // lazy bulk index from the drift messages table
  // MemoryHit = { messageId, convKey, score, snippet, lane('local'|'server') }
  ```

- **THE P3 ONE-LINE SWAP (for Phase 11 — do NOT edit P3's file mid-stream):**
  `worker/src/do/ava_agent.ts` has a no-op `private async brainSearch(_uid, _query):
  Promise<string[]> { return []; }` (the `// TODO(P4)` block, ~line 202), called as
  `const snippets = await this.brainSearch(uid, userText);`. Replace the stub body with a
  call to this phase's worker export:
  ```ts
  // top of ava_agent.ts:
  import { brainSearchLines } from "../lib/ava_memory";
  // replace the stub body:
  private async brainSearch(uid: string, query: string): Promise<string[]> {
    return brainSearchLines(this.env, uid, query, 5);
  }
  ```
  `brainSearchLines` returns `string[]` so the call site + the `snippets` plumbing are
  unchanged — pure additive RAG. (If P2's `runGated` swap also lands, retrieval still feeds
  `generate(...)` exactly as today.)

- **THE P5 TOOL-REGISTRATION NOTE (P4 does NOT own ToolRegistry — intended wiring):**
  P5 should register a `brain.search` AvaTool that, when invoked:
    • CLIENT side → `await AvaMemory.I.search(args.query, convKey: args.convKey,
      topK: args.topK ?? 5, onDeviceOnly: <conv is private>, allowServer: <premium>)`.
      Pass `onDeviceOnly:true` for any conversation the user has marked on-device-only so
      its content is never sent to the server lane.
    • WORKER side → `await brainSearch(env, uid, args.query, args.topK ?? 5)` from
      `worker/src/lib/ava_memory.ts` (already uid-scoped; the route's `requireUser` supplies
      `uid`, so a user can only search their own memory).

- **stubs/assumptions:**
  - **Embedder inference is STUBBED.** `defaultEmbedder` is a deterministic 256-D L2-
    normalised hashing embedder (lexical, NOT semantic). Reason: a real on-device model
    runtime (LiteRT/ONNX/GGUF) can't be compiled/verified headless and pinning an un-
    buildable native ML dep would break the APK build. The vector PATH is fully structured
    and exercisable (FTS5 keyword search carries real recall today; vector search degrades
    gracefully to lexical-ish similarity, never crashes). Enabling real semantic search is a
    one-class change: implement `AvaEmbedder` over a native runtime and point
    `defaultEmbedder` at it — the 256-D contract, BLOB store, download flow, and `AvaModelStore`
    are already in place.
  - **Model download URLs are placeholders** (`https://blossom.avatok.ai/models/<file>`).
    The HTTP download path in `AvaModelStore.ensureDownloaded` is real but unused while the
    hashing stub is the default; confirm the real model host before wiring a native runtime.
  - **Server (premium) lane reuses `/api/brain/chat`** rather than adding a client route —
    it already runs uid-scoped Vectorize RAG and returns tappable `sources`. The dedicated
    pure-retrieval function is the worker `brainSearch()` for SERVER-SIDE callers (P3/P5).
  - **Privacy:** on-device-only / private conversations are never embedded for or queried
    against the server lane (router enforces `onDeviceOnly`); separately, AvaBrain consent
    (`avatok_dms` = on-device only, opt-in; `avatok_messages` gates server indexing) means
    such content is structurally absent from Vectorize. Caller MUST pass `onDeviceOnly:true`
    for secret chats (the router can't know a conv's privacy without that hint or a consent
    lookup; P5/P6 supply it at the call site).
  - **db.dart NOT edited.** The `ava_fts`/`ava_vectors`/`ava_index_state` objects are created
    via raw SQL on the same drift connection with `IF NOT EXISTS`, so they coexist with
    drift's own migrations (drift's `schemaVersion` is unaware of them — intentional; they
    are auxiliary, not drift-managed). They live in the per-account `avatok_<scope>.sqlite`,
    so per-account scoping is automatic.

- **needs from integration (Phase 11):**
  - Apply the P3 one-line `brainSearch` swap above to `worker/src/do/ava_agent.ts`.
  - Confirm P5 registers the `brain.search` AvaTool wired to `AvaMemory.I.search` (client) /
    `brainSearch` (worker) as noted.
  - Wire indexing into the message pipeline (optional, perf-only): call
    `AvaMemory.I.index(...)` (or `backfill`) when a thread opens / a message arrives so the
    on-device index is populated. SyncHub (`app/lib/sync/sync_hub.dart`) is the natural place
    but is NOT a P4-owned file, so left for the chat-pipeline owner / P11; until then
    `AvaMemory.I.backfill(convKey)` (callable on demand, e.g. from the spine before a search)
    builds the index lazily from the existing drift `messages` rows. Search still works the
    moment any rows are indexed.
  - No new pubspec deps, bindings, migrations, or routes. Verify Flutter + Worker compile
    once all phases land (no local toolchain here).

---

## Phase 5 — Tool Layer (Strata + Broker + MCP connect) — 2026-06-17

- **files created:**
  - `app/lib/core/ava_tools/ava_tool.dart` — DEFINES `AvaTool` (Phase 0 only
    reserved the name) + `AvaToolContext` + `ToolRegistry`. See the API block below.
    The registry holds ONLY the small core set; the long tail is Strata-discovered.
  - `app/lib/core/ava_tools/core_tools.dart` — the 5 always-on core tools +
    `registerCoreTools()`. `brain.search` is REAL (wired to P4 `AvaMemory.I.search`);
    `image.generate` is a P9 SHIM; `translate`/`schedule`/`send_to` are documented
    STUBS (no backing client service exists yet — see below). All free-bundled
    (`paid:false`) except `image.generate` (`paid:true`).
  - `app/lib/core/ava_tools/strata_client.dart` — `StrataClient.I`, the client
    wrapper for the progressive-disclosure funnel through the Worker
    (`/api/ava/tools/...`): `discoverCategories` → `getCategoryActions` →
    `getActionDetails` → `executeAction`, plus `handleAuthFailure` and the
    connection store (`connections`/`saveConnection`/`disconnect`). NEVER pulls a
    full catalog; loads one action's schema right before use. Surfaces the Worker
    503 (STRATA_URL empty) as `isUnavailable(...)`.
  - `app/lib/features/ava_tools/mcp_connect_screen.dart` — `McpConnectScreen`:
    lists a small curated connect catalog (`kMcpProviders`), connects via
    `handleAuthFailure` → opens the OAuth URL (`url_launcher`, external app),
    shows connected/disconnect state. Subscription connectors carry a `PaidBadge`
    and their CONNECT action is wrapped in `PaidFeature`; free-bundled connectors
    connect ungated. Shows a "coming soon" card while the layer is unconfigured.
  - `app/lib/features/settings/sections/tools_section.dart` — `registerToolsSection()`
    registers a `SettingsSection` (id `ava_tools`, "Tools & connectors", order 30)
    that opens `McpConnectScreen`.
  - `worker/src/routes/ava_tools.ts` — `export async function avaTools(req, env, subpath)`
    (EXACT name/signature Phase 0 wired; 3rd arg = path after `/api/ava/tools/`).
    Dual-auth `requireUser`; **503 "tools unavailable" (reason `strata_unconfigured`)
    while `STRATA_URL` is empty** (every op gated by this). Proxies the 5 Strata ops
    (`discover_categories`, `get_category_actions`, `get_action_details`,
    `execute_action`, `handle_auth_failure`) to `${STRATA_URL}/mcp/<op>`; manages a
    per-user OAuth token store; enforces free-vs-subscription **only before
    `execute_action`** (discovery is always free).

- **sanctioned bootstrap append (the ONE shared-file edit):**
  - `app/lib/core/ava_bootstrap.dart` — added imports for `tools_section.dart` +
    `ava_tools/core_tools.dart`, and inside `init()` added `registerCoreTools();`
    + `registerToolsSection();`. Idempotent (registries key by name/id). No other
    non-owned file touched. No git ops.

- **THE AvaTool / ToolRegistry API (for P3 spine + P6/P9 callers):**
  ```dart
  abstract class AvaTool {
    String get name; String get description; String get whenToUse;
    bool get paid; Map<String,Object?> get parameters;
    Future<Map<String,Object?>> invoke(Map<String,Object?> args, {required AvaToolContext ctx});
  }
  class AvaToolContext { final String? convKey; final bool private; final bool premium; }
  // ToolRegistry: register(t) / unregister(name) / tools / names / byName(name) /
  //   manifest()  → the compact [{name,description,when,parameters,paid?}] list
  //   handed to the model as the always-resident tool surface (KEEP SMALL).
  ```
  The spine builds `AvaToolContext(convKey, private: <on-device-only conv>,
  premium: <entitled>)` at the call site so each tool routes correctly (notably
  `brain.search` passes `onDeviceOnly: ctx.private` → private content never hits
  the server lane). Long-tail tools are NOT in the registry — call `StrataClient.I`.

- **which core tools are REAL vs STUBBED (and why):**
  - `brain.search` — **REAL.** Wired to P4: `AvaMemory.I.search(query, convKey,
    topK, onDeviceOnly: ctx.private, allowServer: !ctx.private && ctx.premium)`.
    Worker-side equivalent is `brainSearch(env, uid, query, topK)` from
    `worker/src/lib/ava_memory.ts` (the in-thread DO uses that via P4's swap).
  - `image.generate` — **SHIM → P9.** `paid:true`. Returns `{status:'coming_soon',
    route:'/api/ava/image', note, prompt}`. **P9 contract:** P9 owns
    `POST /api/ava/image` (`AvaApi.image`) which generates async + presents the
    result in-thread as an `ava` message with a `media_ref` (via `postAvaMessage`).
    To make the tool live, P9 replaces the shim body with a call to that route and
    wraps the UI invocation in `PaidFeature` (the tool already declares `paid:true`).
  - `translate` — **STUB.** The app has only the live VOICE-translation overlay
    (`features/translation/`), no text-translate client call. Returns
    `{status:'inline', note}` so the model translates inline. Wire to a
    `/api/translate/text` (or equivalent) when one exists.
  - `schedule` — **STUB.** AvaCalendar/AvaBooking exist server-side
    (`worker/src/routes/calendar.ts`, gcal sync) but expose no client "create a
    calendar_block" op. Returns `{status:'not_wired', note}`. Wire to a calendar
    create endpoint when exposed.
  - `send_to` — **STUB.** Send-on-behalf is sensitive; posting is owned by the
    spine (`postAvaMessage` server-side / the normal send path). Returns
    `{status:'needs_confirm', note}` — must NOT auto-send. The confirm-before-send
    UX belongs to P6 (companion) / P7 (delegate).

- **OAuth token storage choice (per-user, encrypted, scoped):**
  - Stored in **D1 `DB_META.ava_tool_tokens`** — `(user_id, provider, token_enc,
    connected_at)`, PK `(user_id, provider)`. Tokens are **AES-GCM encrypted at
    rest** using the SAME crypto shape as `cal/gcal.ts` (`enc`/`dec`, IV-prefixed,
    base64). Key material = **`STRATA_TOKEN_KEY`** (read via `(env as any)` since
    it's not yet in the `Env` type — see needs-from-integration), falling back to
    `GCAL_TOKEN_KEY`, then a dev constant. The table is **self-creating**
    (`CREATE TABLE IF NOT EXISTS` on first use) so **no migration is required**
    (mirrors P4's self-creating on-device index). Tokens are scoped by `user_id`
    (the verified Clerk `sub`) — never shared across accounts. `connections/save`
    writes; `connections` (GET) lists provider names only (never tokens);
    `DELETE connections/<provider>` revokes.

- **free-bundled vs subscription enforcement:**
  - Worker `FREE_BUNDLED = {brain, translate, schedule, send_to}` (AvaVerse-native,
    no per-call SaaS cost). The check runs **only before `execute_action`**; the
    target provider is read from `args.provider|server|connector`. Unknown providers
    default to **PAID** (fail-safe). A non-entitled paid execute returns **402**
    `{reason:'paid_tool'}` → the client (`StrataClient.executeAction` →
    `StrataResult.paymentRequired`) routes to the `PaidFeature` top-up sheet. The
    connect UI mirrors the same split (PaidBadge + PaidFeature on subscription
    connectors).

- **stubs/assumptions:**
  - **`isEntitled(env, uid)` returns `false`** (stub) — the real wallet/subscription
    authority is the wallet phase. So paid MCP connectors are gated OFF server-side
    today; combined with the client `PaidFeature` (Phase-0 stub wallet = empty), the
    UX is the top-up sheet, not a dead end. Wallet phase replaces the body; signature
    stable.
  - **Strata request shape is encapsulated** in `callStrata` (`POST
    ${STRATA_URL}/mcp/<op>` with headers `x-strata-user` + optional
    `x-strata-provider-token`, body `{op,args,user}`). This is a reasonable MCP-gateway
    contract but the EXACT self-hosted Strata wire format may differ — confirm against
    the deployed Strata and adjust `callStrata` + the response field names
    (`categories|results|items`, `actions`, `auth_url`) in `strata_client.dart` only.
  - **Curated connect catalog** (`kMcpProviders`: gmail/gdrive/gcalendar/github/notion)
    is a placeholder list of connect targets — Strata discovers individual ACTIONS on
    demand, so this only drives the connect UI. Tune to the real Strata registry.
  - **OAuth callback handler not built here.** `handle_auth_failure` returns the auth
    URL; the user authorises in the browser; the token must be recorded via
    `connections/save` (or a server-side OAuth callback Strata/the Worker runs). The
    self-host Strata deployment owns the redirect/callback wiring; `connections/save`
    is the documented hook to persist whatever token comes back.

- **needs from integration (Phase 11):**
  - Confirm `avaTools` is the exact export `index.ts` imports for `/api/ava/tools/*`
    — confirmed (`export async function avaTools(req, env, subpath)`).
  - **Set `STRATA_URL`** to the real self-hosted Strata origin (both prod + staging)
    — until then the route 503s by design.
  - **Add `STRATA_TOKEN_KEY?: string` to `worker/src/types.ts` Env** + set the secret
    (`wrangler secret put STRATA_TOKEN_KEY`), or accept the `GCAL_TOKEN_KEY` fallback.
    Read today via `(env as any)` to avoid editing the frozen P0 `types.ts`.
  - The `ava_tool_tokens` D1 table self-creates on first use — no migration needed,
    but Phase 11 may prefer to add it to the schema for visibility.
  - P9 must replace the `image.generate` shim body with the real `/api/ava/image`
    call + wrap the UI invocation in `PaidFeature` (tool already `paid:true`).
  - Verify Flutter + Worker compile once all phases land (no local toolchain here).

---

## Phase 10 — Backup & Sync — 2026-06-17

- **files created:**
  - `worker/src/do/backup.ts` — `export class BackupDO` (SQLite-backed, matches
    wrangler v6). Per-user backup MANIFEST authority (one DO per uid). Tables:
    `meta(latest, next, updated_at)` (monotonic version pointer) + `chunks(version,
    idx, r2_key, bytes, sha256)`. Ops (Worker→DO fetch only): `manifest` (latest
    manifest + nextVersion), `bump` (reserve the next monotonic version), `put-manifest`
    (commit a fully-uploaded version, advance `latest`, return `staleKeys` of
    superseded R2 objects to GC). The DO holds METADATA only — the encrypted bytes
    live in R2.
  - `worker/src/routes/backup.ts` — `backupGet`, `backupPut`, `backupStatus` (the
    EXACT names `index.ts` routes `GET /api/backup`, `PUT /api/backup`, `GET
    /api/backup/status` to — all three confirmed wired in index.ts, incl. the PUT).
    Dual-auth `requireUser`; uid scopes everything (R2 key `backup/<uid>/<version>/<idx>`,
    DO keyed by uid). PUT reserves a version → puts the blob in `env.BACKUP_R2` →
    commits the manifest → best-effort `BACKUP_R2.delete(staleKeys)`. GET streams the
    latest blob back with `x-backup-version/-sha256/-bytes/-updated` headers
    (`cache-control: no-store`). Single-blob fast path + multi-chunk concat fallback.
  - `app/lib/features/ava_backup/backup_service.dart` — `BackupService.I`. Exports the
    on-device SQLite (`<appSupport>/avatok_<scope>.sqlite`, mirrors core/db.dart
    `_open()`) as the export blob, **client-side AES-256-GCM encrypts** it, and ships
    it: `syncToR2()`/`restoreFromR2()`/`r2Status()` (premium R2 lane via the Worker)
    and `backupToDrive()`/`restoreFromDrive()` (free Drive lane via `DriveClient`).
  - `app/lib/features/ava_backup/drive_client.dart` — `DriveClient.I`. REAL Google
    Drive v3 REST against the user's own **appDataFolder** (find-by-name → multipart
    create on first backup → media `PATCH` update thereafter → `alt=media` download).
    Drive STORAGE, not Docs. OAuth token acquisition is STUBBED (see below).
  - `app/lib/features/settings/sections/backup_sync_section.dart` —
    `registerBackupSyncSection()` registers a `SettingsSection` (id `backup_sync`,
    "Backup & sync", order 40). Two Zine cards: a FREE Drive backup/restore card and a
    PAID "Cross-device sync" card whose Sync/Restore actions are wrapped in `PaidFeature`
    with a `PaidBadge`. Separate from the existing email-export backup (untouched).

- **sanctioned bootstrap append (the ONE shared-file edit):**
  - `app/lib/core/ava_bootstrap.dart` — added `import
    '../features/settings/sections/backup_sync_section.dart';` and
    `registerBackupSyncSection();` inside `init()`. Idempotent (registry keys by id).
    No other non-owned file touched. No git ops.

- **ENCRYPTION SCHEME (zero-knowledge — neither AvaTok/R2 nor Google/Drive can read it):**
  - AES-256-GCM (package `cryptography ^2.7.0`, already in pubspec — NO new dep).
  - Key = PBKDF2-HMAC-SHA256, 200k iters, 256-bit, derived from a per-account random
    256-bit passphrase generated on first use and stored ONLY in
    `FlutterSecureStorage`, account-scoped via `scopedKey('ava_backup_passphrase')`.
    The passphrase NEVER leaves the device.
  - Blob wire format: `magic "AVBK1\n" | salt(16) | nonce(12) | ciphertext | GCM-tag(16)`.
  - **Private / on-device-only chats are covered by construction**: the WHOLE SQLite
    export is encrypted before it leaves the device, so there is no plaintext upload
    path at all (R2 or Drive). The Worker `sha256`-checks the opaque ciphertext only.
  - **CROSS-DEVICE caveat (Phase 11 / product note):** the passphrase is on-device +
    account-scoped, so a SECOND device on the SAME account generates a DIFFERENT
    passphrase and therefore cannot decrypt the first device's blob as-is. For true
    cross-device R2 restore the passphrase must be shared across the account's devices
    — recommended follow-up: derive it from a server-issued per-account key wrap, or
    sync it through the existing per-account secure channel. Single-device backup/restore
    (uninstall→reinstall on the same device with Keychain/EncryptedSharedPrefs intact,
    or Drive on the same device) works today. Flagged for Phase 11 / the wallet-or-keysync
    owner; the encrypt/upload/manifest plumbing is all real.

- **DRIVE OAUTH STATUS (stubbed acquisition, real everything-else):**
  - The Drive v3 upload/download/manifest logic is REAL and works against any valid
    `drive.appdata`-scoped OAuth access token. What is NOT wired is the consumer Google
    OAuth + Drive-scope consent flow (needs `google_sign_in`/a PKCE web flow + a real
    `client_id` + platform plumbing that can't be completed/verified headless).
  - `DriveClient.accessTokenProvider` is a STUB returning null → ops throw
    `DriveAuthRequired`, surfaced in the UI as "Connect Google Drive first to back up."
    TODO(drive-oauth): set `DriveClient.accessTokenProvider` to a fn returning a fresh
    `drive.appdata` token (scope `https://www.googleapis.com/auth/drive.appdata`). No
    `google_sign_in` dep was added (would need version-pinning + native config against
    the real integration; out of scope here).

- **PREMIUM-CHECK SPLIT (client + server):**
  - Client: the R2 Sync/Restore actions are wrapped in `PaidFeature` (Phase-0 stub
    wallet = empty → tap routes to the top-up sheet today).
  - Server: `backupPut` additionally calls `isEntitled(env, uid)` (mirrors
    `routes/ava_tools.ts` — STUB returning `false` until the wallet phase; non-entitled
    → 402 `{reason:'paid_sync'}`, which the client maps to the top-up sheet).
  - `backupGet`/`backupStatus` are intentionally NOT premium-gated, so a LAPSED account
    can still pull its own last backup to restore (never strand a user's own data).
  - Google Drive backup is FREE/ungated (separate lane, no `PaidFeature`).

- **needs from integration (Phase 11):**
  - Confirm `backupGet`/`backupPut`/`backupStatus` + `BackupDO` exist with the exact
    names index.ts imports/exports — confirmed (all three route fns + `export class
    BackupDO`). The PUT route IS wired in index.ts (line `if (p === "/api/backup" &&
    req.method === "PUT") return await backupPut(req, env);`).
  - **Create the R2 buckets** `avatok-backup` (prod) + `avatok-backup-staging` (staging)
    — `wrangler r2 bucket create …` — they are still NOT provisioned (Phase 0 noted this;
    `env.BACKUP_R2` binding already exists in wrangler.toml + types.ts). Until created,
    PUT/GET to R2 will 500.
  - Run the v6 migration (Phase 0) on prod + staging so `BackupDO`'s SQLite exists.
  - Wire real Drive consumer OAuth (`DriveClient.accessTokenProvider`) to light up the
    free Drive lane (works against an injected token today).
  - Resolve the cross-device passphrase-sharing caveat above before marketing R2 sync as
    multi-device.
  - When the wallet phase lands, replace `isEntitled` in `routes/backup.ts` with a real
    balance/subscription check (signature is stable).
  - No new pubspec deps, bindings, migrations, or routes added by P10. Verify Flutter +
    Worker compile once all phases land (no local toolchain here).

---

## Phase 6 — Companion / Blank Ava Chat + Voice — 2026-06-17

- **files created:**
  - `app/lib/features/ava_companion/persona.dart` — `AvaPersona` (id/name/tagline/glyph/
    systemPrompt/adultOnly) + `AvaPersonas` (blank `Just chat`, brainstorm, language,
    **roleplay (adultOnly)**) + `AvaPersonaStore` (last-used persona, per-account via
    `DiskCache`, key `ava_companion_persona`). Each persona is just a system-prompt preset;
    a shared `_kAvaBase` keeps Ava feminine/safe. **Persona storage is client-side only**
    (no worker route — `index.ts` frozen; see "backend wished for" below).
  - `app/lib/features/ava_companion/companion_thread.dart` — `CompanionThreadScreen`: a
    free-form user↔Ava chat. Drives turns through **`AvaAiClient.ask` → `POST /api/ava/gemini`
    (P2)**, sending `persona.systemPrompt` as `context` and the running turn list as
    `history`. Renders Ava in lilac feminine bubbles (user = lime), an "Ava is thinking…"
    chip while busy, and a per-bubble **"Listen"** affordance when voice is on. NOT an
    InboxDO thread (no other participant) so it never posts an `ava` envelope.
  - `app/lib/features/ava_companion/companion_home.dart` — `CompanionHome`: persona picker.
    Roleplay tile carries an `18+` chip and is **age-gated** (see below); a locked tap opens
    a "verify in AvaIdentity" sheet. `kRoleplayMinLadderLevel = 2`.
  - `app/lib/features/settings/sections/voice_section.dart` — `registerVoiceSection()`
    (`SettingsSection` id `ava_voice`, "Ava voice", order 25). Premium toggle: ENABLE is
    wrapped in `PaidFeature` (Phase-0 stub wallet = empty → tap routes to the top-up sheet);
    DISABLE is free. Per-account pref `AvaVoicePref` (`DiskCache`, key `ava_voice_enabled`,
    default OFF, `ValueNotifier`). Also defines `AvaVoice` — the on-demand synthesis hook
    (deferred; see below).
- **files edited (OWNED):**
  - `app/lib/features/avatok/chat_list.dart` — added the **"New Ava chat"** affordances
    (additive, existing behaviour untouched): a "Chat with Ava" item at the TOP of the
    `_openNewChatMenu` bottom sheet, AND a lilac sparkle action button in the appbar (before
    search). Both call `_openAvaChat()` → pushes `CompanionHome`. Added one import.
- **sanctioned bootstrap append (the ONE shared-file edit):**
  - `app/lib/core/ava_bootstrap.dart` — added `import
    '../features/settings/sections/voice_section.dart';` and `registerVoiceSection();` in
    `init()`. Idempotent (registry keys by id). No other non-owned file touched. No git ops.

- **HOW THE COMPANION ROUTES THROUGH EXISTING ENDPOINTS (no new worker route):**
  - The companion chat uses **P2 `POST /api/ava/gemini`** via `AvaAiClient.ask(message,
    context: persona.systemPrompt, history)`. This is the right fit for a one-on-one
    user↔Ava chat: it's stateless, multi-turn (history), carries a persona system prompt
    (`context`), and ALWAYS runs through the server-side moderation gate (`runGated` →
    llama-guard in+out + the daily cap). So **every persona turn, including roleplay, goes
    through the moderated gate** — satisfying the "companion turns route through the gated
    path" requirement.
  - The OTHER documented posting path — `AvaTurnController.summon` / `postAvaMessage`
    (P3 `POST /api/ava/thread/turn`) — is for posting Ava INTO a real shared conversation
    (fans out an `ava`/`ava_private` envelope to members' InboxDOs). It was NOT used here
    because a companion chat has no second participant / InboxDO. It remains available if a
    future product decision wants the companion chat persisted as a real conversation.
  - `worker/src/index.ts` UNCHANGED. No `worker/src/routes/ava_companion.ts` created.

- **AGE-GATE — exact check used:**
  - Accessor: **`LadderApi` (`app/lib/features/identity/ladder_api.dart`)** —
    `cachedLevel()` for instant paint, `level()` for the server-truth refresh. There is **no
    client-side birth-date / explicit `isAdult` field** in the codebase (searched
    `app/lib/**`; `identity_screen.dart`/`profile_screen.dart` have none). The strongest
    available "verified" signal is the Trust Ladder: L0 visitor → L1 member → **L2 verified
    human (liveness)** → L3 KYC. Roleplay requires **level ≥ 2** (`kRoleplayMinLadderLevel`
    in `companion_home.dart`).
  - **Caveat for Phase 11 / owner:** L2 proves *verified human*, not *verified ≥18*. If a
    true age signal is wanted, add a birth-year/age field to the identity ladder (server +
    `LadderState`) and gate on that instead — `kRoleplayMinLadderLevel` / the
    `_isVerifiedAdult` getter is the single change point. llama-guard server-side moderation
    still applies to every roleplay turn regardless, so the gate is defence-in-depth.

- **VOICE — reuse vs deferred (decision):**
  - **Deferred synthesis (documented), preference shipped.** The brief said reuse
    `worker/src/routes/agent_tts.ts` (`/api/agent/tts`) "if it fits" — **it does NOT fit.**
    That route synthesises a whole `agent_conversations` TRANSCRIPT keyed by
    `conversation_id` (Deepgram Aura-2), and a free-form companion chat has no
    agent_conversation row / conversation_id. Voicing arbitrary companion text would require
    EITHER a new route OR extending `/api/agent/tts` to accept raw text — both are worker
    changes the Phase 6 brief forbids (`index.ts` frozen; "don't add a worker route").
  - So Phase 6 ships: the per-account premium **preference** (`AvaVoicePref`, paid-gated via
    `PaidFeature`) + the on-demand **"Listen"** UI + audio playback (audioplayers, already in
    pubspec). Synthesis is a single injected hook **`AvaVoice.synthesizer`** (default null →
    "Listen" shows a friendly "voice is coming soon" notice instead of failing).
  - **Wiring Phase 11 / the voice owner needs to do:** add a text→speech path that returns
    audio for arbitrary text (the brief names **ElevenLabs**; agent_tts uses Deepgram, so a
    new `/api/ava/voice` ElevenLabs route OR a raw-text mode on `/api/agent/tts` is needed —
    that's a worker change, intentionally NOT done here), then set
    `AvaVoice.synthesizer = (text) async => <local audio file path>`. No client UI change
    needed after that — the "Listen" button lights up automatically.

- **PERSONA STORAGE — backend wished for (but not built):**
  - Personas live client-side (`AvaPersonas` consts + `AvaPersonaStore` per-account
    selection). The brief allowed reusing the AgentDO persona system *without adding routes* —
    but there is no existing route to read/write a companion persona without `index.ts`
    edits, so server-side persona storage was **declined** to respect the freeze. If durable,
    cross-device personas are wanted later, persist the selection in the existing per-account
    backup/sync (P10) or add a persona field to a future route. No data-model change today.

- **stubs/assumptions:**
  - The companion chat is **free** (text); only voice is premium — matches the brief and
    Phase 1's note that the real `PaidFeature` spend-gate for voice belongs to P6 (done here
    on the voice ENABLE action).
  - History sent to the proxy excludes the local intro line + any gate-blocked turn, and
    sends prior turns as `history` with the current turn as `message` (matches
    `AvaAiClient.ask` contract).
  - `AvaAiClient` already returns friendly `blocked` answers (moderation/cap) as 200s, so the
    UI just renders the bubble; a blocked Ava turn is excluded from subsequent `history`.

- **needs from integration (Phase 11):**
  - No cross-phase wiring required for the text companion to work — it uses the already-built
    P2 `/api/ava/gemini` (confirm `avaGemini` is deployed, per P2's note).
  - To light up voice: provide an arbitrary-text TTS path (ElevenLabs `/api/ava/voice` or a
    raw-text mode on `/api/agent/tts`) and set `AvaVoice.synthesizer`. Worker-side change is
    deliberately deferred (frozen `index.ts`).
  - Optional: replace the L2 ladder age-gate with a real ≥18 signal if/when the ladder gains
    a birth-year field (single change point: `kRoleplayMinLadderLevel` / `_isVerifiedAdult`).
  - Only OWNED FILES + the one sanctioned `ava_bootstrap.dart` append changed.
    `chat_thread.dart` NOT edited. No new pubspec deps, bindings, migrations, or routes.
    Verify Flutter compiles once all phases land (no local toolchain here).

---

## Phase 7 — Delegate: Monitor + Auto-reply + Push — 2026-06-17

- **files created:**
  - `worker/src/routes/ava_delegate.ts` — the delegate engine. Exports:
    - `delegateScan(env, { conv, message, members, senderUid })` → the
      post-fanout entry point (P11 wires it into messaging.ts — see hooks below).
    - `getDelegatePrefs(env, uid, conv)` / `setDelegatePrefs(env, uid, conv,
      {monitor?, alertMentions?})` — read/write the self-creating D1 prefs table.
    - `delegateHandler(req, env)` — the public route handler (GET reads prefs for
      a conv or lists all; POST writes), READY for the Phase-11 `/api/ava/delegate`
      route. Dual-auth via `requireUser`; a user can only touch their OWN prefs.
    - `parseMentions(text)` / `hasAnyMention(text)` — the cheap classifier gate
      (pure string `@mention` scan; supports `@handle`, `@uid`, `@all`/`@everyone`).
  - `app/lib/features/ava_delegate/delegate_settings.dart` — `DelegateSettingsSheet`
    (per-chat modal: "Alert me on all mentions" [free toggle] + "Monitor & reply
    on my behalf" [premium, enable wrapped in `PaidFeature`]) + `DelegatePrefsClient.I`
    (talks to `/api/ava/delegate`; degrades to a per-account `DiskCache` mirror when
    the route is not yet live, flag `serverLive`) + `DelegatePrefs` model.
  - `app/lib/features/settings/sections/delegate_section.dart` —
    `registerDelegateSection()` (SettingsSection id `ava_delegate`, "Ava delegate",
    order 27) explaining the feature + account-wide DEFAULTS (`DelegateDefaults`:
    alert-on-mention default ON [free]; reply-on-my-behalf default OFF [premium,
    `PaidFeature`-gated]) persisted per-account via `DiskCache`.
- **sanctioned bootstrap append (the ONE shared-file edit):**
  - `app/lib/core/ava_bootstrap.dart` — added `import
    '../features/settings/sections/delegate_section.dart';` + `registerDelegateSection();`
    in `init()`. Idempotent (registry keys by id). No other non-owned file touched.

- **THE TWO PHASE-11 HOOKS (exact wiring — `index.ts`/`messaging.ts` are FROZEN):**
  1. **messaging.ts post-fanout call.** In `worker/src/routes/messaging.ts`
     `sendMsg(...)`, AFTER the fan-out (the `recipients.length <= FANOUT_SYNC_MAX`
     parallel block / the Q_PUSH `fanout` enqueue) and BEFORE `return json({ id:
     mine.id, conv, created_at: created });`, add (mirrors the existing best-effort
     brain-feed block right above it):
     ```ts
     // top of messaging.ts:
     import { delegateScan } from "./ava_delegate";
     // after the fan-out, before the final return (best-effort, never blocks):
     void delegateScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid });
     ```
     `payload` is the exact object messaging.ts already built
     (`{ conv, sender, kind, body, media_ref, client_id, created_at }`); `mem` is its
     resolved member list; `ctx.uid` is the sender. `delegateScan` self-gates (returns
     immediately when there's no `@mention`), so non-monitored chats add only one
     cheap string scan — ZERO model cost.
  2. **`/api/ava/delegate` route.** `index.ts` is frozen and registered NO delegate
     route, so P11 adds ONE dispatch line in `dispatch(req, env, ctx)`:
     ```ts
     import { delegateHandler } from "./routes/ava_delegate";
     if (p === "/api/ava/delegate") return await delegateHandler(req, env);
     ```
     This lights up `DelegatePrefsClient` (client per-chat read/write); until it lands
     the client transparently uses its on-device cache (`serverLive=false`).

- **PRESENCE / "OFFLINE" HEURISTIC (documented):** presence is owned by each user's
  `InboxDO` ("a socket is open" — `do/inbox.ts`). The InboxDO is FROZEN and has no
  read-only presence route, so `isOffline(env, uid)` POSTs the InboxDO's transient
  `/event` op with a benign `{type:'ava_presence_probe'}` frame (NO client renders
  it, NOTHING persists) and reads the returned `{ live }`: `live:true` ⇒ a socket is
  open ⇒ ONLINE ⇒ not offline. A probe ERROR ⇒ "unknown" ⇒ treated as NOT offline
  (conservative: never auto-reply when unsure). Approximation caveats: it can't tell
  a backgrounded-but-socket-open app from an active one, nor see recency. **Cleaner
  follow-up (optional):** `messaging.ts` already gets each member's `live` flag back
  from `appendTo`; P11 could pass those into `delegateScan` (e.g. a `liveByUid` map)
  so no extra probe round-trip is needed — `isOffline` would then just read the map.

- **PREFS TABLE SCHEMA (self-creating D1 `DB_META`, no migration — mirrors P5's
  `ava_tool_tokens` self-create):**
  ```sql
  CREATE TABLE IF NOT EXISTS ava_delegate_prefs (
    uid            TEXT NOT NULL,
    conv           TEXT NOT NULL,
    monitor        INTEGER NOT NULL DEFAULT 0,   -- 1 → Ava may auto-reply on this user's behalf here
    alert_mentions INTEGER NOT NULL DEFAULT 0,   -- 1 → push on every @mention here
    updated_at     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (uid, conv)
  );
  ```
  Created on first use (guarded once-per-isolate). P11 may add it to the schema for
  visibility, but no migration is required.

- **DISCLOSURE + COST DISCIPLINE (acceptance):**
  - Auto-reply is ALWAYS disclosed: `disclose(name, reply)` forces the posted text to
    `"Ava — for <name>: …"` (and strips any model-emitted duplicate prefix). Posted
    via P3 `postAvaMessage(env, {ownerUid: <monitored user>, conv, text, private:false,
    source:'delegate', meta:{delegate_for, delegate_for_name}})` → fans out as a normal
    `kind:'ava'` lilac bubble every participant sees. Never authored as the user.
  - The model is touched ONLY after the cheap gates all pass: (1) string `@mention`
    scan, (2) it's a group (≥2 others), (3) the mentioned member has a pref row with
    `monitor`/`alert_mentions` set, (4) for the reply path, the member is OFFLINE. A
    non-monitored chat never reaches `runGated`/the model → ZERO cost.
  - Reply generation routes through P2's `runGated` (our-keys Gemma, llama-guard
    in+out, regenerate-once) with `skipQuota:true` (server-initiated — must not burn
    the monitored user's daily cap). The triggering message is wrapped as quoted
    UNTRUSTED data (prompt-injection defense); the reply is a short neutral
    "they'll respond when back" holding message (no commitments / no answering for them).
  - Premium gating: enabling `monitor` (per-chat sheet + the account default) is
    wrapped in `PaidFeature`; `alert_mentions` is free.

- **PERSISTENT "Ava is active in this chat" INDICATOR — DEFERRED (one line, for the
  chat-screen owner / Phase 11):** `chat_thread.dart` is FROZEN with no owned overlay
  slot, so Phase 7 did NOT edit it. The data is available client-side via
  `DelegatePrefsClient.I.get(serverConv)` (`monitor==true` ⇒ show a small lilac "Ava is
  watching" chip in the chat app-bar) — wire it where the chat screen builds its
  header, or surface it server-side as an `ava_status`-style banner. The per-chat
  toggle sheet (`DelegateSettingsSheet.show(context, conv: serverConv, chatLabel: …)`)
  is the entry point a chat-screen "Ava" menu item opens; that menu hook also belongs
  to the (frozen) chat screen / P11.

- **stubs/assumptions:**
  - **No server-side BYO key (P2's flag).** Server-initiated delegate turns have no
    live client request carrying a Gemini key, so they use the capped our-keys tier
    (`tier:"ourkeys"`, `skipQuota:true`). When P2's stored-key path lands they can pass
    `tier:"byo"` + the key (and, for richer thread context, route through AvaAgentDO
    `/turn` instead of the local `callReasoner` — left as a documented upgrade).
  - **Mention resolution is member-scoped.** `@handle`/`@uid` only match against the
    conversation's own members (one chunked `users` read), so a mention can't target a
    non-member. `@all`/`@everyone` ⇒ every other member is "mentioned".
  - **1:1 chats are skipped** for the auto-reply path (a DM mention is just talking to
    the one other person; P3's `@ava` self-summon covers 1:1). Delegate only acts in
    groups (≥2 others).
  - **`DelegateDefaults` are a client convenience only** (seed values for new chats);
    the authoritative per-chat prefs live server-side. Phase 7 does NOT auto-apply the
    defaults to a chat — the per-chat sheet is where a user opts a specific chat in
    (the defaults can be read by a future "first time you open a chat" hook).

- **needs from integration (Phase 11):**
  - Wire the TWO hooks above (the `messaging.ts` `delegateScan` call + the
    `/api/ava/delegate` route → `delegateHandler`). Both are additive one-liners.
  - The `ava_delegate_prefs` D1 table self-creates — no migration needed.
  - Optionally pass per-member `live` flags from `messaging.ts` into `delegateScan` to
    drop the presence-probe round-trip (see presence note).
  - Optionally add the "Ava is active in this chat" indicator + the chat-menu entry
    point that opens `DelegateSettingsSheet` (chat_thread.dart is frozen — owner/P11).
  - When P2's server-side BYO key store lands, upgrade `generateDelegateReply` to
    `tier:"byo"` and/or route through AvaAgentDO `/turn`.
  - Only OWNED FILES + the one sanctioned `ava_bootstrap.dart` append changed.
    `messaging.ts`/`index.ts`/`chat_thread.dart` NOT edited. No new bindings/migrations.
    No git ops. Verify Flutter + Worker compile once all phases land.

---

## Phase 8 — Guardian (Safety) — 2026-06-17

- **files created:**
  - `worker/src/routes/ava_guardian.ts` — the safety engine. Exports:
    - `avaGuardianScan(req, env)` — the public route handler (EXACT name `index.ts`
      already routes `POST /api/ava/guardian/scan` → confirmed wired in Phase 0).
      Dual-auth via `requireUser`; uid is always the verified caller, never the body.
      One endpoint, several body modes: `{conv, message|text, members?, sender?}` →
      scan a message NOW (protects the CALLER); `{media_ref}` → deepfake/AI-image
      check; `{prefs:{conv, secureChat?, deepMonitor?}}` → set per-chat prefs
      (enabling `deepMonitor` is the PREMIUM gate → 402 `{reason:'paid_guardian'}`
      when not entitled); `{get_prefs:{conv}}` → read prefs; `{digest:true,
      windowDays?}` → the caller's parent digest; `{link_child:{child_uid}}` →
      record a parent↔child link.
    - `guardianScan(env, { conv, message, members, senderUid })` — the post-fanout
      entry point Phase 11 wires into messaging.ts (see hook below). Self-gates on
      cheap heuristics → near-zero cost for clean messages.
    - `getGuardianPrefs` / `setGuardianPrefs` / `linkChild` / `buildParentDigest`
      / `runParentDigests` / `checkMedia` — the supporting API.
  - `app/lib/features/ava_guardian/guardian_settings.dart` — `GuardianSettingsSheet`
    (per-chat modal: FREE "Secure-chat mode" + PREMIUM "Always-on deep monitoring"
    whose enable is wrapped in `PaidFeature`) + `GuardianPrefsClient.I` (talks to
    `/api/ava/guardian/scan` via the `{prefs}`/`{get_prefs}` body modes; degrades to
    a per-account `DiskCache` mirror on failure, flag `serverLive`; reverts the
    optimistic deep-monitor flip on a 402) + `GuardianPrefs` model + per-account
    `GuardianDisplayPrefs` (warning-display preference).
  - `app/lib/features/ava_guardian/guardian_warning.dart` — the PRIVATE warning UI
    affordance: `GuardianWarningInfo` (parses the `ava_private` body `meta`
    `{guardian, category, severity}`), `GuardianWarningCard` (a prominent tappable
    card a host chat surface can OPT to show above/below the private bubble), and
    `GuardianWarningSheet` (detail + Block/Report/Dismiss callbacks the host wires to
    existing flows). Purely presentational/callback-driven — it does NOT edit or
    touch the chat pipeline (the frozen `chat_thread.dart` already renders the
    `ava_private` lilac bubble; this is the richer additive layer).
  - `app/lib/features/settings/sections/guardian_section.dart` —
    `registerGuardianSection()` (SettingsSection id `ava_guardian`, "Guardian /
    safety", order 28). Free scam/spam-shield assurance row + warning-display toggle,
    premium always-on-deep-monitoring DEFAULT (PaidFeature), and a PARENT-ONLY weekly
    safety-digest opt-in (shown only when `AccountKindStore` → `AccountKind.parent`).
    Also `GuardianParentDigest.fetchNow()` (in-app `{digest:true}` fetch).
- **sanctioned bootstrap append (the ONE shared-file edit):**
  - `app/lib/core/ava_bootstrap.dart` — added `import
    '../features/settings/sections/guardian_section.dart';` + `registerGuardianSection();`
    in `init()`. Idempotent (registry keys by id). No other non-owned file touched.

- **THE PHASE-11 messaging.ts HOOK (exact wiring — `messaging.ts` is FROZEN):**
  In `worker/src/routes/messaging.ts` `sendMsg(...)`, AFTER the fan-out and the
  best-effort `Q_BRAIN` brain-feed block (lines ~151-166), BEFORE `return json({ id:
  mine.id, conv, created_at: created });`, add (mirrors the P7 delegate hook right
  beside it — they can share the same spot):
  ```ts
  // top of messaging.ts:
  import { guardianScan } from "./ava_guardian";
  // after the fan-out, before the final return (best-effort, never blocks):
  void guardianScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid });
  ```
  `payload` is the exact object messaging.ts already built
  (`{ conv, sender, kind, body, media_ref, client_id, created_at }`); `mem` is its
  resolved member list; `ctx.uid` is the sender. `guardianScan` runs the FREE cheap
  string heuristics first and short-circuits when nothing fires, so a clean message
  adds only a string scan + (for premium-protected recipients only) at most one
  llama-guard call. The route itself is already wired (no `index.ts` change needed).

- **CLASSIFIER GATE + FREE vs PREMIUM split (acceptance):**
  - CHEAP GATE FIRST: `cheapScan(text)` is pure regex heuristics (scam/financial-lure
    patterns, spam patterns, and grooming/luring lexical signals — secrecy,
    move-off-platform, meet-request, age-probe, intimacy). NO model call. A heuristic
    hit (and only then) escalates to the heavier classifier `isSafe` (P2 ai_gate.ts,
    `@cf/meta/llama-guard-3-8b`).
  - FREE: the basic scam/spam flag + the resulting PRIVATE warning are always-on and
    free (evaluated for every recipient via the cheap gate).
  - PREMIUM: "always-on deep monitoring" = running llama-guard on EVERY message even
    with NO heuristic hit. Gated by `isEntitled(env, uid)` (STUB → `false`, mirrors
    `ava_tools.ts`/`backup.ts`; the wallet phase replaces the body, signature stable).
    A CHILD is protected under their PARENT's entitlement (if the parent is entitled,
    the child gets deep monitoring — parent-paid family protection).

- **GROOMING/SCAM → PRIVATE WARNING (airtight, verified):**
  - The PROTECTED users are the RECIPIENTS of a message (those at risk from the
    sender), never the sender. On a confident signal, `warnPrivately` calls P3's
    `postAvaMessage(env, {ownerUid: <at-risk recipient>, conv, text, private:true,
    source:'guardian', meta:{guardian, category, severity}})`.
  - **Verified it never fans out to the other party:** `postAvaMessage` →
    AvaAgentDO `/post` → `postAva` with `private:true` does `kind:'ava_private'`,
    `scope:'to:<uid>'`, and `appendTo(uid, payload)` for the ONE recipient only — the
    `else` fan-out branch (writing every member's InboxDO) is taken ONLY when
    `private` is false. The other participant's InboxDO is never written. The frozen
    `chat_thread.dart` renders `ava_private` as a lilac "AVA · PRIVATE" bubble.

- **DEEPFAKE / AI-IMAGE DETECTION — structure REAL, score STUBBED (documented):**
  - The pipeline is real: `checkMedia(env, mediaRef)` → `fetchMediaBytes` (tries an
    R2 `MEDIA` bucket binding if present, else a plain fetch for absolute URLs) →
    `detectSynthetic(env, bytes)` → `DeepfakeResult {checked, score, label, stub}`.
    A `likely_synthetic` score ≥ `DEEPFAKE_FLAG_THRESHOLD` (0.7) raises a `deepfake`
    flag + private warning, identical to the scam/grooming path.
  - **`detectSynthetic` is the STUB**: there is NO first-party synthetic-image
    detector in the Workers-AI catalog today (llama-guard is text-only; the image
    models are caption/embed/gen, not authenticity classifiers), so it returns
    `{label:'not_checked', score:0, stub:true}` — it deliberately does NOT raise
    false alarms. TODO + documented model choices are in-file (`detectSynthetic`):
    (1) a Workers-AI synthetic-detection model if/when one appears; (2) an external
    detector (Hive / Sightengine / Reality Defender) behind a Worker secret; (3) a
    self-hosted ONNX classifier (EfficientNet/ViT on DFDC / FaceForensics++) via
    `STRATA_URL` or a sidecar. Wiring it = replacing that one function body; the
    pipeline + flag-raising stays.
  - The media R2 binding is read via `(env as any).MEDIA` (not in the `Env` type as a
    named bucket here) so this doesn't require a types.ts edit; a miss = "not checked".

- **PARENT DIGEST — builder REAL, delivery is a documented push HOOK:**
  - Parent↔child linkage: there is **no existing parent/child link table** in the
    worker (searched — only `admin_tools.dart` client-side `AccountKind` + UI-only
    parent tools). So Phase 8 records the relationship in a SELF-CREATING D1 table
    `ava_parent_links(parent_uid, child_uid, created_at)` (no migration; mirrors P5
    `ava_tool_tokens` / P7 `ava_delegate_prefs`). `linkChild(env, parentUid,
    childUid)` writes it (exposed via the route's `{link_child}` mode). **Phase 11
    note:** when the real custodial registration/tenancy flow lands (server
    `account_kind` = `parent`, the "Add child account" parent tool), have it call
    `linkChild` (or write that table) so digests cover real children. Until then the
    digest is correct but only sees links recorded via `{link_child}`.
  - `buildParentDigest(env, parentUid, windowDays=7)` is REAL: aggregates the
    `ava_guardian_flags` log (every flag Guardian raises is recorded there) per linked
    child over the window into `{total, byCategory, highSeverity, recent[], summary}`.
  - **Delivery is a HOOK**: `runParentDigests(env)` (intended for a weekly cron — Phase
    11 may add a scheduled handler) builds each parent's digest and `deliverDigest`
    enqueues `env.Q_PUSH.send({kind:'notify', to:parentUid, fromName:'Ava Guardian',
    preview:summary})` (reuses the existing push path, mirrors P7). A richer channel
    (email via the consumers' BREVO path, or an in-app digest card consuming
    `GuardianParentDigest.fetchNow()`) can replace `deliverDigest`'s body later. A
    parent can also pull their digest on demand via the route's `{digest:true}` mode.

- **SELF-CREATING D1 TABLES (no migration; guarded once-per-isolate):**
  ```sql
  ava_guardian_prefs (uid, conv, secure_chat, deep_monitor, updated_at, PK(uid,conv))
  ava_guardian_flags (id, uid, conv, peer, category, severity, detail, created_at)
                      + INDEX (uid, created_at)
  ava_parent_links   (parent_uid, child_uid, created_at, PK(parent_uid,child_uid))
  ```
  Created via one `DB_META.batch([...])` on first use. Phase 11 may add them to the
  schema for visibility, but no migration is required.

- **classifier model used:** the cheap gate is pure regex (no model). The escalation
  + premium deep-monitor classifier is `@cf/meta/llama-guard-3-8b` via P2's
  `isSafe(env, text)` (fails OPEN on classifier error, CLOSED on a confident
  "unsafe" — inherited from ai_gate). The deepfake detector model is UNCHOSEN/stubbed
  (see above). Guardian honours the `guardianEnabled` config kill-switch (default ON).

- **stubs/assumptions:**
  - `isEntitled` STUB → `false` until the wallet phase (so always-on deep monitoring
    is OFF server-side today; the client `PaidFeature` shows the top-up sheet, never a
    dead end). Basic scam/spam + the private warning are free and live.
  - `detectSynthetic` STUB (no false alarms) — documented above.
  - The cheap heuristic lexicons are intentionally conservative and not exhaustive —
    they are the cost pre-filter, not the final word; llama-guard is the escalation.
  - The scan endpoint, when called by a client to scan a message, models the CALLER as
    the protected recipient (`members=[sender, caller]`) so a user scanning their own
    chat gets warned about the other party — never the reverse.
  - The "show prominent warning card" affordance (`GuardianWarningCard`) is additive and
    NOT auto-injected into `chat_thread.dart` (frozen). A host chat surface can render
    it from a guardian `ava_private` message's `meta`; until a screen opts in, the
    private lilac bubble (already rendered) is the warning. Optional Phase-11 polish.

- **needs from integration (Phase 11):**
  - Wire the ONE `messaging.ts` `guardianScan` hook above (additive one-liner; can sit
    beside the P7 `delegateScan` call). The route is already wired in `index.ts`.
  - The 3 D1 tables self-create — no migration needed.
  - Replace `isEntitled` with the real wallet/subscription check when that phase lands
    (signature stable).
  - Wire a real deepfake detector into `detectSynthetic` (pick a model from the
    documented options; the pipeline + flag-raising already work).
  - Add a weekly scheduled handler (cron) calling `runParentDigests(env)` for digest
    delivery, and/or have the real custodial flow call `linkChild` so digests cover
    real children. Optionally upgrade delivery from push to email/in-app.
  - Optionally render `GuardianWarningCard` from guardian `ava_private` messages where
    the (frozen) chat screen builds its message list, and add a chat "Ava → Guardian"
    menu item that opens `GuardianSettingsSheet.show(context, conv: serverConv)`.
  - Only OWNED FILES + the one sanctioned `ava_bootstrap.dart` append changed.
    `messaging.ts`/`index.ts`/`chat_thread.dart` NOT edited. No new bindings/migrations.
    No git ops. Verify Flutter + Worker compile once all phases land.

---

## Phase 9 — Generative (Image gen, async in-thread) — 2026-06-17

- **files created:**
  - `worker/src/routes/ava_image.ts` — `export async function avaImage(req, env)`
    (the EXACT name `index.ts` routes `POST /api/ava/image` to — confirmed). Dual-auth
    via `requireUser`. Body `{conv, prompt, edit?:{media_ref}}`. Flow:
    (1) kill-switches `generativeEnabled`/`aiEnabled` → 503;
    (2) MANDATORY prompt moderation via P2 `guardInput` (llama-guard) — a disallowed
    prompt (deepfake/abuse/minors) is REFUSED with `{ok:false, blocked:true,
    reason:'input_unsafe'}` BEFORE any generation or chip;
    (3) immediately posts the transient "Ava is generating an image…" **chip** into
    `conv` (the SAME mechanism P3's private `postStatus` uses: a `/ava_status`
    broadcast on each member's InboxDO PLUS a persisted `{t:'ava_status',phase:'start',
    status_id}` envelope so the FROZEN `chat_thread.dart` renders the chip today);
    (4) returns FAST `{ok, status_id, async:true}` while the heavy work runs detached;
    (5) generates with Gemini **Nano Banana 2 = `gemini-3.1-flash-image-preview`** (same
    REST shape as `routes/affiliate_assets.ts`); (6) uploads + (7) posts the final `ava`
    image message into `conv` via P3's `postAvaMessage(env,{ownerUid,conv,text,media_ref,
    source:'image'})`, then closes the chip (`phase:'end'`).
  - `app/lib/features/ava_generative/image_request.dart` — `ImageRequestSheet`
    (`.show(context, convKey:, chatLabel:, editMediaRef:)`): a Zine bottom-sheet composer
    whose Generate button is wrapped in **`PaidFeature`** (`costCoins:
    kImageGenCostCoins = 20`). On kickoff it calls `requestAvaImage(...)`, closes, and
    shows an "Ava is generating… it will appear in the chat" snackbar — the chip + image
    arrive through the existing chat pipeline. Supports EDIT mode when `editMediaRef` is
    passed ("make it blue").
  - `app/lib/features/ava_generative/image_tool.dart` — `ImageGenerateToolReal` (the REAL
    `image.generate` `AvaTool`, `paid:true`) + `requestAvaImage({convKey, prompt,
    editMediaRef})` (resolves `convKey`→server conv via `serverConvFromKey`, forwards the
    BYO key on `X-Ava-Gemini-Key`, POSTs `AvaApi.image`) + `registerImageTool()`.
    `invoke` only KICKS OFF (returns `{status:'generating'}`) — the image is async
    in-thread, never returned as bytes.

- **sanctioned bootstrap append (the ONE shared-file edit):**
  - `app/lib/core/ava_bootstrap.dart` — added `import '../features/ava_generative/
    image_tool.dart';` and `registerImageTool();` inside `init()`, placed AFTER
    `registerCoreTools()`. Idempotent. No other non-owned file touched. No git ops.

- **HOW THE REAL TOOL SUPERSEDES P5's SHIM:** P5 registered an `image.generate`
  coming-soon shim in `core/ava_tools/core_tools.dart` (NOT edited by P9). `ToolRegistry`
  keys by `name` and `register(...)` REPLACES by name, so `registerImageTool()` running
  after `registerCoreTools()` overwrites the shim with `ImageGenerateToolReal` — the live
  tool wins with zero edit to core_tools.dart (exactly the hand-off P5's note predicted).

- **MODEL + KEY SOURCE:** model `gemini-3.1-flash-image-preview` (Nano Banana 2), Google
  Gemini REST `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
  with `responseModalities:["IMAGE"]`. **Key:** the SERVER key `env.GEMINI_API_KEY`
  (already in `Env`, used by translate + affiliate) is preferred; if unset it falls back
  to the caller's **BYO key** on header `X-Ava-Gemini-Key` (P2 convention; per-request,
  never stored). NEITHER present → 503 `no_gemini_key` (no chip posted). No new
  binding/secret — ensure `GEMINI_API_KEY` is set on prod + staging for the server path.

- **UPLOAD / STORAGE PATH:** the PNG is stored in the PUBLIC blob bucket `env.BLOBS` under
  the SAME content-addressed layout as `/upload/public`: `u/<uid>/public/<sha256>`, served
  by `blossom.avatok.ai` + `/cdn-cgi/image/...` CDN — so the Avatar/image widgets render
  the `media_ref` (blossom URL) with zero new infra. A `user_media` row is registered
  (`visibility:'public', moderation_status:'live', category:'image', source_kind:'sent',
  original_app:'avatok'`) so it joins the universal storage pool. (Did NOT use
  `BACKUP_R2`; BLOBS is the public-image bucket, matching the affiliate pipeline.) The row
  is written directly and does NOT enqueue the Workers-AI public-image scan
  (`Q_MODERATION`) that `/upload/public` runs — the prompt llama-guard is the enforced
  gate; a follow-up could enqueue `Q_MODERATION` on the new `r2_key`.

- **ASYNC MECHANISM (the signature move):** chip posted synchronously, then
  generate→upload→post runs as a DETACHED promise (`void fulfil(...)`). `avaImage`'s
  router signature is `(req, env)` — **no `ExecutionContext` is passed by `index.ts`** — so
  `ctx.waitUntil` is unavailable; the detached promise is the pragmatic equivalent (the
  Worker keeps it alive long enough for one image gen). If Phase 11 wants hard-guaranteed
  completion, change the `index.ts` call site to pass `ctx`/`exec` + `exec.waitUntil(
  fulfil(...))` — but that edits the frozen `index.ts`, so NOT done here. The chat keeps
  working throughout; the image lands as an `ava` bubble when ready.

- **stubs/assumptions:**
  - **Wallet metering is point-of-use UI only.** `ImageRequestSheet` wraps the kickoff in
    `PaidFeature(costCoins:20)`; the Phase-0 stub wallet returns false → surfaces the
    top-up sheet (as designed). The route does NOT debit the wallet (no server-side Ava
    wallet-spend authority wired yet). Wallet phase: add a server debit in `avaImage`
    (before the chip) or rely on the client gate.
  - **Chip member fan-out is replicated locally** in `ava_image.ts` (`membersOf` mirrors
    `AvaAgentDO.members()`; `appendTo`/`statusBroadcast` mirror the DO helpers) because the
    AvaAgentDO exposes only `/turn` and `/post` (its `postStatus` is private) — P9 does NOT
    edit P3's DO. The persisted-`ava_status`-envelope matches P3's FROZEN-client workaround,
    so the chip renders identically.
  - **Edit is REAL + cheap:** `{edit:{media_ref}}` fetches the existing public image and
    passes it inline so the model edits rather than generates fresh. Stickers/memes work as
    plain prompts. Output re-uploaded under a fresh content hash (dedup-safe).
  - **`postAvaMessage` author = the requesting user (`ownerUid: ctx.uid`)**, non-private —
    a generated image is shared content, fanned out to all conv members.

- **needs from integration (Phase 11):**
  - Confirm `avaImage(req, env)` matches the `index.ts` import/route — confirmed.
  - Ensure `GEMINI_API_KEY` is set on prod + staging (server path); else 503 unless the
    caller supplies a BYO key.
  - Provide a chat entry point to open `ImageRequestSheet.show(context, convKey: …)` (a
    "+"/Ava attachment action, or the `image.generate` tool-call path) — `chat_thread.dart`
    is frozen so P9 did not add the launcher; the tool + sheet are ready.
  - Optional: enqueue `Q_MODERATION` on the generated `r2_key`; add a server wallet debit
    when the wallet phase lands.
  - Only OWNED FILES + the one sanctioned `ava_bootstrap.dart` append changed.
    `chat_thread.dart`/`index.ts`/`core_tools.dart`/`ava_agent.ts` NOT edited. No new
    bindings/migrations. No git ops. Verify Flutter + Worker compile once all phases land.

---

## Phase 11 — Integration & Verification applied — 2026-06-17

Cross-phase wiring + verification only (no feature work, no git). Edited the
previously-frozen hot files now (Phase 11 owns the merge). Every documented hook
applied; worker typecheck is clean.

- **EDITS APPLIED (file → hook):**
  1. `app/lib/features/avatok/chat_thread.dart` (P3 composer wiring):
     - added `import '../ava/ava_invoke.dart';`
     - `onSummonAva = AvaInvoke.makeHandler(_convKey!);` right after `_convKey` is set
       in BOTH `_setupDm` (1:1) and `_setupGroup` (group). `@ava` is now LIVE (the
       existing `_send` already calls `onSummonAva!(t)` on the wake word). Handler
       signature matches (`Future<void> Function(String)`).
  2. `worker/src/do/ava_agent.ts` (P2 gate + P4 RAG swaps):
     - added `import { runGated } from "../lib/ai_gate";` and
       `import { brainSearchLines } from "../lib/ava_memory";`.
     - `turn()`: replaced the inline Gemma generate + `safe()` regenerate block with a
       single `runGated(this.env, { uid, tier:"ourkeys", userText, generate })` call
       (kill-switch + intent gate + daily cap + in/out moderation; behavior-preserving,
       adds the cap that P3's TODO wanted). Empty answer (only on `ai_disabled`) falls
       back to a friendly unavailable message.
     - `brainSearch()`: replaced the no-op `return []` stub with
       `return brainSearchLines(this.env, uid, query, 5);` (uid-scoped Vectorize RAG).
     - The old private `safe()` method + module `GUARD` const are now unused but left
       in place (harmless; tsconfig has no `noUnusedLocals`, and unused private methods
       aren't flagged). Not deleted to keep the diff minimal/reversible.
  3. `worker/src/types.ts` (P5 Env key): added `STRATA_TOKEN_KEY?: string;` to `Env`
     (P5 read it via `(env as any)`; now typed for visibility).
  4. `worker/src/routes/messaging.ts` (P7 + P8 pipeline hooks):
     - added `import { delegateScan } from "./ava_delegate";` +
       `import { guardianScan } from "./ava_guardian";`.
     - after the brain-feed block, before the final `return json(...)` in `sendMsg`:
       `void delegateScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid });`
       `void guardianScan(env, { conv, message: payload, members: mem, senderUid: ctx.uid });`
       Mapped the notes' placeholders to the REAL locals: `payload` (the fanned-out
       `{conv,sender,kind,body,media_ref,client_id,created_at}`), `mem` (resolved member
       list), `ctx.uid` (sender). Both run detached (no `ctx.waitUntil` in the route
       signature) + self-gate on cheap string heuristics → zero cost on clean messages.
  5. `worker/src/index.ts` (P7 route — a documented hook NOT in my enumerated list, so
     applied per "apply any OTHER hook the notes list"):
     - added `import { delegateHandler } from "./routes/ava_delegate";` and the dispatch
       line `if (p === "/api/ava/delegate") return await delegateHandler(req, env);`
       (beside the other Ava routes). Lights up `DelegatePrefsClient` (was cache-only).
     - **P10 backup PUT confirmed already wired** in index.ts
       (`if (p === "/api/backup" && req.method === "PUT") return await backupPut(req, env);`)
       — no edit needed (matches P10's note).

- **DELIBERATELY NOT APPLIED (with reasoning):**
  - **`case 'ava_status':` in `sync_hub.dart`** — P3's note says the working chip ALREADY
    renders today via the PERSISTED `{t:'ava_status'}` `msg` envelope (`postStatus` posts
    both the transient broadcast AND a persisted `msg`), and explicitly labels the
    `case 'ava_status':` an OPTIONAL cleaner follow-up "NOT required for acceptance." The
    transient `/ava_status` broadcast frame has a different shape than a `msg` frame, so
    routing it through `_ingestMsg` would double-handle/mis-parse. Per the brief ("only add
    this if the note says it's needed — don't double-handle"), left as-is. Chip works today.

- **WORKER TYPECHECK:** `npx tsc --noEmit -p tsconfig.json` → **CLEAN (0 errors)** after one
  integration fix:
  - `worker/src/routes/ava_gemini.ts:103` (a P2 file) failed `env.AI.run` overload
    resolution because its dynamically-built `messages` array was annotated
    `Array<{role: string; content: string}>` (loses the literal `role` union the
    Workers-AI types require). Every other call in the worker uses inline array literals
    (which infer literally). Minimal behavior-preserving fix: cast at the call site
    (`{ messages: messages as any, ... }`), matching the worker's existing `as any`
    convention. No logic change. This was the ONLY type error across the whole worker
    once all phase files were present.

- **PRIVACY INVARIANT SPOT-CHECK (passed):** a private (`ava_private` / `to:<uid>`) path
  only ever writes the ONE recipient's InboxDO. Verified `postAvaMessage` (ava_thread.ts)
  → AvaAgentDO `/post` → `postAva`: `private:true` takes the `appendTo(uid, payload)`
  branch with `kind:'ava_private'`, `scope:'to:<uid>'` and NEVER the `else` fan-out branch
  (which writes every member). Guardian warnings (`source:'guardian', private:true`) and
  private chat replies therefore never reach the other party. Airtight.

- **FLUTTER (no local toolchain — grep/inspection only):** `flutter` not run (per project
  memory; CI builds the APK). Verified by inspection: `ava_invoke.dart` +
  `ava_turn_controller.dart` exist; `AvaInvoke.makeHandler(String)` matches the assigned
  `onSummonAva` field type; `serverConvFromKey` (the controller's dependency) is defined in
  `core/config.dart` and already imported in chat_thread.dart. The one new import added to
  chat_thread.dart resolves. Client-side risks I could NOT compile-verify: the full
  AvaBootstrap registration chain and the ava_generative/companion/guardian widget trees —
  these are owned-file additions validated only by CI.

- **UNRESOLVED RISKS / DEPLOY-TIME TODOs (carried from phase notes — NONE blocks typecheck,
  all are runtime/provisioning):**
  - **R2 buckets** `avatok-backup` (prod) + `avatok-backup-staging` (staging) are NOT
    provisioned — `wrangler r2 bucket create …` before backup PUT/GET works (else 500).
  - **v6 migration** (the `AvaAgentDO` + `BackupDO` SQLite classes) must run on prod +
    staging.
  - **`STRATA_URL`** is empty in both envs → `/api/ava/tools/*` 503s by design until the
    self-hosted Strata origin is set; **`STRATA_TOKEN_KEY`** secret should be set (falls
    back to `GCAL_TOKEN_KEY`).
  - **`GEMINI_API_KEY`** must be set on prod + staging for the P9 image server path (else
    503 unless a BYO key is supplied).
  - **`isEntitled` STUB → false** in `ava_tools.ts` / `backup.ts` / `ava_guardian.ts`
    (premium tools, R2 sync, deep monitoring all gated OFF server-side until the wallet
    phase replaces it; client `PaidFeature` shows the top-up sheet, never a dead end).
  - **`detectSynthetic` STUB** (deepfake/AI-image) returns not-checked (no false alarms);
    pick a detector model when available.
  - **Embedder inference STUBBED** (on-device): hashing embedder ships; FTS5 keyword recall
    is real; real semantic vectors need a native ML runtime + the real model-download host.
  - **Cross-device backup key**: the R2 backup passphrase is per-device/per-account in
    secure storage — a 2nd device on the same account can't decrypt the 1st device's blob
    until passphrase-sharing (server key-wrap) is added. Single-device backup/restore works.
  - **Drive OAuth** (`DriveClient.accessTokenProvider`) is a null stub → free Drive lane
    needs a real `drive.appdata` token wired.
  - **Optional follow-ups** (not required): weekly cron → `runParentDigests(env)` for
    guardian parent digests; `linkChild` called by the real custodial flow; server wallet
    debit in `avaImage`; the `case 'ava_status':` SyncHub cleanup.

- **PROPOSED COMMIT** (the human runs git — NOT done here):
  - one-liner: `feat(ava): in-chat Ava AI — spine, BYO gate, memory, tools, companion,
    delegate, guardian, image gen + backup (Phases 0–11)`
  - high-level contents: the ~74 uncommitted files for Phases 0–10 (contracts/registries,
    focus mode + paid gating, BYO-AI proxy + moderation gate, in-thread spine + AvaAgentDO,
    two-lane memory, tool layer, companion/voice, delegate, guardian, generative image,
    backup/sync) PLUS this Phase 11 integration wiring: the `@ava` composer hook, the
    ava_agent gate+RAG swaps, the messaging.ts delegate/guardian scans, the `/api/ava/delegate`
    route, the `STRATA_TOKEN_KEY` Env field, and the one ava_gemini typecheck fix.
