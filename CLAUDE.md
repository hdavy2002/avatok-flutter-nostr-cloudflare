# avaTOK-2-Flutter

---

## 🚨 STAGING vs PRODUCTION — AI READ THIS FIRST (2026-07-09)

**The owner is not a developer and will never type a deploy command. You handle all
of this. He tells you WHICH environment in plain English; you do the rest.**

### RULE 1 — At the start of EVERY new session, ask with a widget

Before doing any real work in a fresh session (first substantive request — not for
pure chat or a one-line factual question), call **AskUserQuestion**:

> **header:** `Scope`
> **question:** "What are we working on in this session?"
> **options:** `Staging feature` · `Staging bug` · `Production feature` · `Production bug`
>
> (the tool always offers "Other" automatically, where he can type a custom issue)

Then **write the resulting environment into `.avatok-target`** (`staging` or `prod`)
and say so in one short line. That file is the single source of truth for the rest
of the session; `scripts/cf.sh` and `scripts/flags.sh` read it.

- Answer is *Other* / ambiguous → ask one follow-up, or default to **staging**.
- Anything production → say plainly that production is live, and confirm before
  each write.
- If the owner already stated the environment in his message, skip the widget and
  just write the file.

### RULE 2 — On any build request, ask TWO widget questions, then do it all

Any request to build, deploy, ship, release, or "push it up" starts with
AskUserQuestion — **never** infer the answer from `.avatok-target` or the branch.
A build is the moment a mistake reaches real users.

1. **`Environment`** — "Staging build or production build?" → `Staging` · `Production`
2. **`Format`** — "APK or AAB?" → `APK (Recommended)` · `AAB` · `Both`
   (APK is the standing default — owner decision 2026-07-04.)

Then do the whole thing yourself. Do **not** hand him commands:

```bash
# staging build  (staging code, staging backend)
gh workflow run android.yml --ref staging -f environment=staging -f artifact=apk -f play_track=none

# production build (main code, prod backend) — only on an explicit request
gh workflow run android.yml --ref main    -f environment=prod    -f artifact=apk -f play_track=none
```

#### 🚀 THE MAGIC WORD: **"ship it"**

The owner asked (2026-07-15) for one phrase that means *do the whole thing*. **"ship
it"** — or "ship a build", "ship to my phone" — is an EXPLICIT build request and is
the one case where you skip the two widget questions above, because the phrase
already answers them. Run exactly:

```bash
gh workflow run android.yml --ref main -f environment=prod -f artifact=both -f play_track=internal
```

**Then APPROVE the production gate yourself.** "ship it" means the whole thing;
leaving the run parked on the gate and telling him to go and click a button in
GitHub is exactly the hand-him-commands behaviour this section forbids. The
`gh` CLI is authenticated as `hdavy2002`, who is the required reviewer, so the
agent can approve. Discovered 2026-08-01 — before that, agents were stopping at
the gate and the owner was clicking Approve by hand for no reason.

```bash
RUN=<run id printed by the command above>
REPO=hdavy2002/avatok-flutter-nostr-cloudflare

# 1. Get the environment id and confirm you're allowed to approve.
gh api "repos/$REPO/actions/runs/$RUN/pending_deployments"
#    -> read .[0].environment.id and check .[0].current_user_can_approve == true

# 2. Approve. NOTE: must be piped as JSON via --input -.
#    `-f "environment_ids[]=123"` FAILS with 422 "not an integer" because -f
#    sends every value as a string and this endpoint wants a real int array.
echo '{"environment_ids":[<ENV_ID>],"state":"approved","comment":"<why>"}' \
  | gh api --method POST "repos/$REPO/actions/runs/$RUN/pending_deployments" --input -
```

**Only auto-approve when the owner actually said "ship it"** (or equivalent).
The gate is a real checkpoint — the magic word IS the approval. Never approve a
build he did not ask for, and never approve one you started speculatively.

**Before shipping, check whether a build is already queued for the same code.**
A build carries the SHA it was triggered from. If a run is already waiting and
`git diff --name-only <run-sha> HEAD -- app/` is EMPTY, the client code is
identical — approve that run instead of cancelling and burning another ~30
minutes. Only re-trigger when `app/` genuinely differs. Conversely, if a queued
run PREDATES a client fix, cancel it: approving it ships stale code to the
internal track.

CI does the rest with no further input:

1. builds the `.aab` **and** the side-loadable arm64 `.apk`
2. publishes the `.aab` to the Play **internal testing** track
3. sets `latestAppBuild` in prod KV to that build number
4. verifies the flag landed (cache-busted)

Then he opens AvaTOK, hits Update, and it updates. **Nothing is manual — he never
downloads an .aab and never touches the Play Console.** If you find yourself telling
him to upload something by hand, the automation has broken; fix it rather than
routing around it.

"ship it" ONLY means the internal track. Closed testing (`alpha`) is a different
request and needs Google review, so `latestAppBuild` is NOT auto-bumped there (a
build users can't download yet + an update prompt = a popup leading nowhere).

Still true: **never** trigger a build he didn't ask for. "ship it" is the ask.

`android.yml` has a **guard step**: prod must be built from `main`, staging from
`staging`. A mismatched dispatch fails fast instead of shipping the wrong code.

Builds are `workflow_dispatch` only. **Never trigger one unless the owner explicitly
asks** (see the Git protocol section below). Report back the run URL.

### How you actually do it (owner never sees these)

Never invoke `wrangler` / `npx wrangler` directly. Bare `wrangler deploy` and
`wrangler kv key put …` resolve the TOP-LEVEL `wrangler.toml` block — that is
**PRODUCTION**, silently, with live users on it. That was the root cause of
"staging flag work broke my prod testers." Everything goes through the wrapper,
which reads `.avatok-target` and **refuses prod unless `ALLOW_PROD=1`**:

```bash
scripts/cf.sh worker deploy       # obeys .avatok-target
scripts/cf.sh consumers deploy
scripts/cf.sh calls deploy

scripts/flags.sh set ringbackEnabled=true   # feature flags, same protection
scripts/flags.sh get / effective / unset / prune
```

`npm run deploy` in `worker/` and `consumers/` is **disabled on purpose** — it used
to deploy to prod. KV holds **overrides only**; `DEFAULTS` in
`worker/src/routes/config.ts` is the source of truth and readers layer it
underneath. Never re-materialize all flags into the blob (`{...DEFAULTS, ...current}`)
— that pins stale values forever and makes one flag flip rewrite all ~76.

**A flag the client reads but `config.ts` does not declare is a FAKE flag.** A
client-side `_b('someFlag', true)` compiles and looks like a working kill switch,
but `putConfig` rejects any key not in `DEFAULTS` (`unknown key`, 400) — so it can
never be flipped, and the client's fallback is its permanent value. `inAppUpdateEnabled`
shipped this way and was discovered on 2026-07-15: the documented brake on a feature
that auto-installs updates without user consent could not actually be pulled. When
you add a `RemoteConfig` getter, declare the key in the `PlatformConfig` interface
**and** in `DEFAULTS` in the same change (numbers also need a `numericKeys` entry;
booleans don't), then prove it: `ALLOW_PROD=1 scripts/flags.sh set <key>=false`
must not 400, and the cache-busted `/api/config` must reflect it.

Builds themselves are `workflow_dispatch` only and **you never trigger one unless
the owner explicitly asks** (see the Git protocol section below).

---

## 💰 THE UNIT IS A **TOKEN**, AND 1 TOKEN = **₹1** (owner decision 2026-08-05)

**Never write "coin" or "AvaCoin" again, and never print a `$` for a wallet
amount.** The word is **token**; the symbol is **₹**. India is the only market
for now — there are no international customers, and Wise/USD payouts are not in
use. `[TOKENS-INR-1]` renamed every capitalised `Coin`/`Coins` identifier and
switched every money formatter to `₹`.

**This was a relabel, not a revaluation.** No balance, price, ledger row or D1
column changed value, because the stored integer already WAS the rupee at both
ends of the pipe:

- money-in — `worker/src/routes/wallet.ts` INR rail: `tokens = round(paise/100)`
- money-out — `worker/src/routes/upi_payout.ts`: `gross_inr_paise = tokens * 100`

The display layer was the last holdout still calling that same integer a US cent
and printing `$`. It is near-parity anyway: at `cfg.usdInrRate = 96.4`, one US
cent is ₹0.964, so ₹1/token and $0.01/token differ by ~3.6%.

### What must NOT be renamed — and why each one bites

1. **Every lowercase `snake_case` form is frozen**: `amount_coins`, `gross_coins`,
   `price_coins`, `escrow_coins`, `balance_coins`, `held_coins`, `coins_per_usd`,
   `insufficient_avacoins`, Stripe `metadata[coins]`. These are the client↔server
   wire contract and D1 column names. Shipped clients keep sending and reading
   them forever; a rename is a silent break for every user who hasn't updated.
   The precedent for changing a client-visible one is `routes/call_translation.ts`
   — dual-emit `insufficient_tokens` **and** `error_legacy: insufficient_avacoins`
   for a release cycle, and accept both on the client.
2. **Five remote-config flag keys still end in `...Coins`**:
   `upiPayoutMinCoins`, `affiliateDailyEarnCapCoins`,
   `affiliateMonthlyEarnCapCoins`, `affiliatePerReferredCapCoins`,
   `affiliateMinQualifyingTopupCoins`. The key must match `DEFAULTS` in
   `routes/config.ts` **and** the override blob already sitting in prod KV.
   Rename one and the flag silently reverts to its default.
3. **`STORAGE_COINS_PER_GB` is a wrangler env binding**, not a variable.
4. **`PhosphorIcons.coins(...)` / `PhosphorIcons.handCoins(...)` are package
   symbols.** A blind coins→tokens sed produces `handTokens`, which does not
   exist — that is a compile error, and with no local Flutter toolchain you will
   only find it 40–80 minutes later in CI.
5. **Legacy `currency_display` values** `COINS`/`COIN`/`AVACOIN` are persisted in
   D1 `listings.currency_display`. `intent_theme.dart` must keep resolving them
   or those rows render as the literal string `COINS 2000`.

### Real US dollars that must KEEP their `$`

`micro_usd` cost accounting (`TOKEN_MICRO_USD`, `AI_TOKENS_PER_USD` — provider
invoices genuinely are USD), Google Play tier labels and `_usdFromCents` in
`wallet_screen.dart` (Play still bills the USD-defined SKU at its localised
rate — the app says so at `wallet_screen.dart:686`), `kMinTopUpUsd`,
`subscribe_screen.dart` plan prices, the USD branch of `wallet_statement.ts`,
and the multi-currency `_currencySymbol` map in `intent_theme.dart` (marketplace
listings are a separate, genuinely multi-currency unit).

### Four ways flags and deploys will lie to you (learned the hard way 2026-07-15)

**1. NEVER state an effective flag value from `config.ts`. Go and read prod.**
`DEFAULTS` in `config.ts` is only the bottom layer; KV overrides sit on top. On
2026-07-15 an agent read `avaSms: false` / `avaDialer: false` in DEFAULTS and told
the owner his shipped dialer and SMS features were off and his Play permissions
were unjustified — while prod KV had **both overridden to `true`** and real users
on them. The advice that followed (strip the permissions) would have deleted live
functionality. The DEFAULTS block tells you what happens when KV is silent; it
tells you *nothing* about production. Before any claim about a live flag:

```bash
ALLOW_PROD=1 scripts/flags.sh get          # raw KV overrides
curl -s -H 'Cache-Control: no-cache' "https://api.avatok.ai/api/config?cb=$RANDOM"
```

**2. `GET /api/config` is edge-cached for 60s — a plain curl will show you a stale
value right after a KV write.** `getConfig` sets `cache-control: public, max-age=60`.
Always cache-bust (`-H 'Cache-Control: no-cache'` **and** a random query param), or
you will "confirm" a write that hasn't landed, or think one failed when it worked.

**3. A worker deploy takes ~30–60s to reach every colo.** During that window probes
flap between the old and new version — the same cache-busted URL will return the new
value, then the old, then the new. That is propagation, **not** a failed deploy and
not a gradual-deployment split (check `wrangler deployments list` — a normal deploy
is one version at 100%). Wait a minute and re-probe several times before concluding
anything. An agent burned a chunk of a session chasing a phantom rollback here.

**0. A GREEN DEPLOY IS NOT A GREEN TYPECHECK. Run `npx tsc --noEmit` in
`worker/` BEFORE every `cf.sh worker deploy`.** Wrangler builds with esbuild,
which strips types without checking them, so a deploy succeeds on code that does
not compile. On 2026-08-01 a `track()` call went to prod with 3 args instead of
5; the props object landed in the `app_name` slot and the alert it powered would
have fired malformed — which, for an alert, is the same as not firing. Nothing
failed. Nothing warned. The deploy was green.

**4. COMMIT worker source BEFORE `cf.sh worker deploy`.** The tree is shared by
several agents. On 2026-07-15 an agent deployed an uncommitted `config.ts` edit;
another agent's deploy landed **49 seconds later** from a tree without that change
and silently reverted it in production. Deploying uncommitted code means the next
agent's deploy erases yours, and nothing records that it ever existed.

### Promotion to production is CODE + MIGRATIONS ONLY

Merge `staging` → `main`, then deploy with `ALLOW_PROD=1` and run any D1 migration
against prod as a deliberate step. **Never copy staging D1 rows, DO SQLite, R2
objects, or the KV flag blob into production** — staging data is throwaway and
copying the flag blob would wipe every real user's config. Prod flags are flipped
one at a time, when the owner says so.

If a task seems to require a production write and the owner has not explicitly said
"production", **stop and ask.**

---

## ⚠️ ARCHITECTURE PIVOT — NOSTR IS DEPRECATED (2026-06-09)

**The Nostr/relay/E2E-gift-wrap messaging design is NULLED going forward.** AvaVerse
is now a Cloudflare-native, **server-readable** architecture (per-user `InboxDO` with
hibernatable WebSocket + DO-local SQLite; server is router; device stays local-first).
Canonical: **`Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`** and handover
**`Specs/HANDOVER-2026-06-09-cloudflare-native-pivot.md`**. Where the Nostr "Engineering
rulebook" below or `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` conflict with the new arch,
**the new arch wins** (those files are pending rewrite). Do NOT re-introduce Nostr
(NIP-17/44/59, gift-wrap, keypairs, NIP-42/98, the relay Worker). Do NOT make a single
central D1 the high-write message store — messages live in DO-local SQLite per user.
Still valid: per-account scoping. NOTE (2026-06-10): the old "1:1-only calls" rule
was CHANGED in Phase 10 — group conferences ≤25 via Cloudflare Realtime are now allowed (see
the product rule below).

---

## Graphiti memory — CANONICAL group_id (READ THIS FIRST)

<!-- pre-push hook fallback marker — DO NOT REMOVE. The git pre-push hook greps
     CLAUDE.md for a quoted group id when ~/.graphiti-projects.tsv lacks an entry,
     so the auto-logged push episode lands in the right group. Keep the line below.
     group_id: "proj_avaflutterapp" -->

**This project's Graphiti group_id is `proj_avaflutterapp`. Always pass it explicitly on EVERY graphiti-memory call — both reads and writes. No exceptions.**

- Writes: `add_memory(..., group_id="proj_avaflutterapp")`
- Reads/searches: `search_memory_facts`, `search_nodes`, `get_episodes` → `group_ids: ["proj_avaflutterapp"]`

Rules:

- NEVER omit `group_id`. If you omit it, the Graphiti server falls back to its CLI
  default or **auto-generates a brand-new random group_id**, which silently scatters
  this project's data into a new empty partition. That is the root cause of "my
  graphiti is empty / new project name every session." Treat a missing group_id as a bug.
- NEVER use `personal` (or any other name) for this project. The account-wide preference
  "use group_id 'personal' if none specified" is OVERRIDDEN here — this project always
  uses `proj_avaflutterapp`.
- All existing project history (AvaTalk/AvaTok phases, backend, frontend, go-live items)
  already lives under `proj_avaflutterapp`. Do not create variant names like
  `avatok`, `avatok-2-flutter`, `avaflutterapp`, etc.

At the start of a task, pull context with `search_nodes`/`search_memory_facts` scoped to
`group_ids: ["proj_avaflutterapp"]`. When the user shares durable facts/decisions, save
them with `add_memory(group_id="proj_avaflutterapp")`.

---

## Observability toolset — PostHog (USE FOR DIAGNOSIS + BAKE INTO NEW CODE)

PostHog (project 139917, EU; key `phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5`,
host `https://eu.i.posthog.com`) is now the FULL observability stack, not just
product events. When diagnosing anything, query it via the **PostHog MCP** BEFORE
reading code and guessing. When building ANY new feature, wire these in from the start.

**Live products (enabled 2026-07-21):**
- **Error Tracking** — exception autocapture ON. Client uncaught → `$exception`
  (main.dart `FlutterError.onError`/`platformDispatcher.onError` →
  `Analytics.captureException`, scrubbed). Native Android/iOS + isolate crashes via
  `errorTrackingConfig` (needs posthog_flutter 5.x). Server: uncaught Worker
  route/queue error → `$exception` via `hooks.trackException` (index.ts fetch/queue).
  Dig with MCP `query-error-tracking-*`.
- **Session Replay** — ON, fully masked (text+images). App wrapped in `PostHogWidget`
  (main.dart); `sessionReplay=true`, sampleRate 0.2. Open a crash -> watch the replay.
- **Logs** — `AvaLog` non-info lines -> PostHog Logs via `Posthog().captureLog()`
  (analytics.dart sink). Filter by severity; correlate by tag/session/trace_id.
- **LLM Analytics** — receptionist LLM spend -> `$ai_generation`
  (reception_room_cf.ts): `$ai_model/$ai_provider/$ai_input_tokens/$ai_output_tokens/$ai_total_cost_usd/$ai_trace_id`.
- **UI performance** — `PerfMonitor` (perf_monitor.dart) -> `ui_frame_stats`
  (jank/freeze per screen); `ui_content_flash` (cache->network swaps); standardized
  `Analytics.uiInteraction()` + `Analytics.cacheEvent()` helpers. Dashboard
  "AvaTOK — App Health" (id 836684).

**Bake-in rules for NEW code (do these by default, like per-account scoping):**
- New async/network path -> failures go through `Analytics.captureException` (client)
  or `hooks.trackException` (worker). No silent `catch {}`.
- New LLM call -> emit `$ai_generation` (`$ai_*` schema) at the completion site
  (mirror reception_room_cf.ts). Wire the Gemini + vobiz lanes the same way.
- New screen/interaction latency -> `Analytics.uiInteraction(name, ms, ...)`, NOT a
  new bespoke `*_ms` event.
- New on-device cache -> `Analytics.cacheEvent(store, 'hit'|'miss'|'stale', renderMs: ...)`.
- Meaningful runtime decisions/failures -> `AvaLog` warn/error (auto-forwarded to
  Logs). Secrets stay out — scrubbing is `_scrub` (client) / `scrubServer` (worker) /
  the `beforeSend` hook.

**PENDING (gates several of the above):** `pubspec.lock` is stale at posthog_flutter
4.11 while pubspec pins ^5.30.0. Run `flutter pub get` -> 5.x, then a build — Logs,
Session Replay, native crash capture, and the `captureLog`/replay code only activate
after that. Alerts deferred (need a Slack/webhook dest, and Issues forming first).

---

## Code search (graphify-avatok-2-flutter)

This project has a graphify knowledge graph at `graphify-out/graph.json`. The
corresponding MCP server name is **`graphify-avatok-2-flutter`** — when answering structural
code questions about this project, call those tools
(`mcp__graphify-avatok-2-flutter__query_graph`, `mcp__graphify-avatok-2-flutter__get_neighbors`,
`mcp__graphify-avatok-2-flutter__get_node`, `mcp__graphify-avatok-2-flutter__shortest_path`).
Do NOT call any other `graphify-*` MCP — those belong to different projects.

Prefer graphify over grep for structural questions: "what calls X", "what imports Y",
architecture and call-flow questions, "find code related to Z". Stick with grep for
literal text / string search (TODOs, error messages, arbitrary tokens).

---

## Engineering rulebook (READ — applies to every app)

**AvaTOK product rule — RULE CHANGE 2026-06-10 (owner decision, Phase 10).**
Group conferences ARE allowed in AvaTalk groups, **≤25 participants, via Cloudflare Realtime**
(`worker/src/routes/groupcall.ts` + `app/lib/features/conference/`). Cloudflare is
the only real-time media provider: SFU, TURN, ICE delivery, and signalling all
stay Cloudflare-native. Cloudflare STUN is primary and Google Public STUN is the
owner-approved discovery-only fallback. 1:1 calls
stay P2P (CallRoom DO, **2-peer cap unchanged** — group conferences never touch
it; do NOT raise the cap). Group/conference CONSULTING still lives in AvaConsult.
Enforcement: group-thread call icons active only when `memberCount <= 25`
(otherwise greyed + a notice popup), the Worker rejects start/join for >25-member
groups, and the Cloudflare Realtime participant cap of 25 is the server-side backstop. All gated
by the `conferenceEnabled` kill switch (`routes/config.ts`). Group chats keep FULL
messaging (text, media, voice notes, stickers, polls, location, contact cards).

The full rulebook is **`Specs/AVATALK-CLOUDFLARE-RULEBOOK.md`** — read it before
building. It governs ALL AvaVerse apps. The two client rules that bite hardest:

1. **Per-account scoping is MANDATORY.** One phone is shared by a parent + each
   child account, so ALL per-user local state (secure storage, prefs, file caches)
   MUST be namespaced with `scopedKey(...)` / `readScoped(...)`
   (`app/lib/core/account_storage.dart`) or a per-account subdir using
   `AccountScope.id`. A raw global key = data leaking across accounts. Only
   device-level values (e.g. the Clerk client token) stay global. When adding ANY
   new store, scope it from the start.

2. **Image/media caching pipeline.** Public images (avatars, posts): upload to
   `/upload/public`, serve via Cloudflare
   `/cdn-cgi/image/format=avif,quality=60,width=N,fit=cover/<path>`, and cache
   on-device (`app/lib/core/avatar_cache.dart`; `Avatar` widget). Private DM media:
   cache the DECRYPTED bytes on-device per account (`MediaService.downloadAndDecrypt`
   → `…/media/<AccountScope.id>/<hash>`). Never re-download on reopen; load local-first.

3. **Universal storage, dedup display & AvaBrain consent.** ONE per-account storage
   pool shared by all apps (AvaLibrary/AvaStorage): 5 GB free, then AvaCoins/GB/month
   (default 20) from the AvaWallet; empty wallet over quota = read-only, NEVER delete.
   Files are content-addressed → ONE real copy; "add to folder" is a shortcut counted
   once; cache on-device + Cloudflare. AvaBrain is ON by default (opt-out): a master
   switch in the main Settings + per-app guardrail toggles (all default ON), each
   registered into the main Settings and checked by the ingestion pipeline; private/
   E2E content is read on-device only regardless of toggle. Full detail in the rulebook.

---

## Design-system guard — TWO AUTOMATED CHECKS (added 2026-08-05)

The 2026-08-04/05 cleanup folded ~1,600 legacy design-system references, ~1,900
Material icons and ~220 stray radii onto the token files. `tool/check_design_guard.py`
stops the next new screen re-introducing them:

1. **No raw colour literals under `app/lib`** — `Color(0x…)`, `Color.fromARGB/fromRGBO`,
   non-sentinel `Colors.<name>`, bare `0xAARRGGBB` ints and `'#rrggbb'` strings.
   Exempt: the three token files (`core/ui/avatok_dark.dart`, `messenger_theme.dart`,
   `bubble_theme.dart`), comments, and the sentinels `Colors.transparent/white/black`
   (they carry no design decision; tighten with `--strict-material`).
2. **No bare Material `Icons.*`** under `features/**` and `shell/**` — the app is on
   Phosphor: `PhosphorIcons.<name>(PhosphorIconsStyle.regular)`. The regex uses a
   negative lookbehind so `PhosphorIcons.` can't match; a naive `grep 'Icons\.'`
   reports ~1,855 phantom hits and has already misled someone.

```bash
python3 tool/check_design_guard.py --check colours   # check 1
python3 tool/check_design_guard.py --check icons     # check 2
python3 tool/check_design_guard.py --check all       # both
python3 tool/check_design_guard.py --check colours --list   # show every hit
```

Plain `python3`, no pub/npm deps, no Flutter toolchain — safe on this machine.
Wired into **`typecheck.yml`** (runs on every `pull_request` — the trigger that
actually catches drift) and **`verify.yml`** (on demand), both as a `design-guard`
job. Neither builds nor deploys anything, and **no `push:` trigger was added** —
adding one would break `scripts/git_safe_push.py` for everyone.

Both checks are **baselined** against `tool/design_guard_baseline.json` (colours:
218 pre-existing occurrences across 43 files; icons: 0), so they were green on day
one and fail ONLY on violations that are new.

> **When it fails, USE A TOKEN. Do NOT run `--update-baseline`.** The baseline is a
> record of leftover debt, not an allowlist; growing it undoes the cleanup one commit
> at a time. Reach for an `AD.*` token in `core/ui/avatok_dark.dart` (add one there if
> none fits), or `Msg.*`/`MsgColors.*`/`BubbleTheme`. For the rare value a token
> genuinely cannot hold (a native API that wants a literal hex string), use the inline
> `// design-guard: allow — <reason>` hatch; a reason is mandatory.
> `--update-baseline` is only for a large deliberate refactor, e.g. after a big file
> split moves existing violations to new paths.

---

## Per-session workflow (READ AND FOLLOW EVERY SESSION)

### Search & context (do this first)

- For any code search or lookup, use **Graphify** (`graphify-avatok-2-flutter`) as your
  first preference — it searches the internal codebase faster and with far fewer tokens
  than reading files directly. Only fall back to direct file reads if Graphify doesn't
  surface what you need.
- For any issue you're about to work on, FIRST check/pull **Graphiti**
  (`group_id="proj_avaflutterapp"`) to understand how the relevant piece was built and
  how it works. Graphiti is the memory/context bank — distinct from Graphify, which is
  for code search.

### Telemetry (PostHog)

- **ALWAYS ASK WHOSE EMAIL FIRST — never assume `hdavy2005@gmail.com`.** There are now
  many testers on different emails, and a bug is often a CONVERSATION BETWEEN TWO PEOPLE
  (a call, a chat thread, an SMS), so the owner may need to give you two or more emails
  to pull both sides. Pulling the wrong person's telemetry means diagnosing the wrong
  device.

  Before touching PostHog, call **AskUserQuestion**:

  > **header:** `Telemetry`
  > **question:** "Whose PostHog telemetry should I pull for this?"
  > **options:** `hdavy2005@gmail.com` · `Two people (I'll give both)` · `Skip telemetry`
  >
  > (the tool always offers "Other" automatically, for a different tester's email)

  - Answer names one person → pull that person's events.
  - Answer is two-sided → get BOTH emails, pull each, and line the two timelines up
    against each other; a call/message bug usually only makes sense from both ends.
  - If the owner already named the tester(s) in his message, skip the widget and use
    those.
  - Skip the widget only when the task provably has no telemetry surface (e.g. a pure
    static code read with no device behaviour) — and say so in one line rather than
    silently skipping.

- If telemetry exists for the named user(s), review it. If it doesn't, build rich
  telemetry data for future retrievals.
- After completing your work, generate rich telemetry and send it to PostHog. It MUST
  include the user's email (and phone number, if available) so error/info/telemetry data
  can be pulled to fix or identify issues — the email is what makes a future pull
  possible, and with many testers it is the ONLY way to tell whose device a problem is
  on. For two-sided features (calls, chats, SMS), tag BOTH parties where the event has
  them, so either email retrieves the interaction. Leave any pre-existing telemetry in
  place; where possible, ADD new telemetry for the new work done.
- Once a task/fix is finished, **update Graphiti** with what you did
  (`add_memory(..., group_id="proj_avaflutterapp")`).

### Tooling

- Use **Desktop Commander** for all file and shell operations.
- **🚫 NO LOCAL BUILD TOOLCHAIN — DO NOT INSTALL ONE (owner decision 2026-08-05).**
  The entire local toolchain was **deleted on 2026-08-05** at the owner's instruction:
  Android SDK, Gradle caches, Android Studio.app, the Flutter SDK, `~/.pub-cache`,
  Temurin 17 and the Pixel AVD — about 25 GB. It had left the boot disk at **100 %
  full with 119 MB free**, and the owner does not have the space to keep it.

  **ALL builds happen in GitHub Actions.** `flutter`, `dart`, `adb`, `gradle` and
  `sdkmanager` are not on this machine and are not coming back.

  **Do NOT re-install any of it** — not `flutter`, not the Android SDK, not
  Android Studio, not an emulator, not a JDK, and do not run `flutter pub get`,
  `dart run build_runner build`, `scripts/dev-emulator.sh`, or `python3
  tool/postcreate.py` locally. If a task seems to need a local build, **stop and ask
  the owner** rather than downloading 25 GB onto a disk that has no room for it.
  The 2026-07-31 "local emulator hot reload" section that used to live here is
  **void**; earlier revisions of this file described a setup that no longer exists.

  What this costs you: no hot reload, and **you cannot compile-check your own Dart
  changes.** Compensate by reading carefully and keeping diffs small — CI
  (`verify.yml`) is now the only compile net, and it is a 40–80 min round trip.

  `scripts/dev-emulator.sh` remains in the repo but will fail; it is kept only so the
  toolchain can be rebuilt deliberately if the owner ever buys the disk space back.

- **REPO LOCATION — `/Users/davy/Documents/websites/avaTOK-2-Flutter` (verified 2026-08-02).**
  This is a REAL directory holding the real `.git`, not a symlink. There is no
  `~/dev` copy: the 2026-07-31 move to `/Users/davy/dev/avaTOK-2-Flutter` was
  reverted, and what's left there is an empty `app/build` shell with no `.git`.
  **Do not `cd` into `~/dev/avaTOK-2-Flutter` and do not "restore" the symlink** —
  earlier revisions of this file described that layout and it is no longer true.

  **This path is NOT iCloud-synced, so it is safe.** Desktop & Documents sync is
  OFF (`defaults read com.apple.finder FXICloudDriveDocuments` → `0`), and
  `~/Documents` is a plain local folder with a different inode from the real
  iCloud Documents at `~/Library/Mobile Documents/com~apple~CloudDocs/Documents`.
  **If that sync setting is ever turned back ON, this repo lands in iCloud and
  must be moved out immediately** — iCloud silently corrupted the old `.git` over
  ~2 months: conflict duplicates (`HEAD 2`, `config 2`, `objects 2`, `index 2`…
  `index 8`) and finally an unreadable loose object that made `git status`,
  `diff`, `fetch` and `fsck` all die with **SIGBUS**. Never keep a git repo under
  an iCloud-synced path. The old corrupted copy survives only as
  `…/CloudDocs/Documents/websites/avaTOK-2-Flutter-recover.nosync`.

### Git protocol (MANDATORY — this repo is shared by multiple agents)

- **NO AUTO-BUILD — builds are MANUAL ONLY (owner decision 2026-07-04, PERMANENT).**
  Every build workflow (`android.yml`, `avaconsult.yml`, `macos.yml`, `web-deploy.yml`)
  has its `push:` trigger DISABLED and runs on `workflow_dispatch` only. A `git push`
  therefore NO LONGER triggers any build. The owner starts builds by hand from the
  Actions tab (Run workflow) or `gh workflow run <file>`. **NEVER trigger a build**
  (no `gh workflow run`, no `workflow_dispatch` via API, and never re-enable a `push:`
  trigger) unless the owner EXPLICITLY asks. Do NOT re-add push triggers to the
  workflows on your own initiative.
- **Pushing commits is allowed** (it's safe — no build fires), but it MUST go through
  the push wrapper, which enforces that you only publish YOUR OWN commits:

  ```bash
  python3 scripts/git_safe_push.py AVA-AUTH-401 AVA-AUTH-OTP     # the issue ids you own
  python3 scripts/git_safe_push.py AVA-AUTH-401 --dry-run        # preview, touches nothing
  ```

  **Never run `git push` (or `ALLOW_PUSH=1 git push`) directly.** The wrapper sets
  `ALLOW_PUSH=1` for you — it IS the deliberate push path the pre-push hook asks for.
  Do NOT use `--no-verify`, do NOT force-push a shared branch, and do NOT remove or
  disable the hook.

- **Why the wrapper exists (the cross-agent push-sweeping bug).** `git_safe_commit.py`
  keeps other agents' FILES out of your commit; `git_safe_push.py` keeps other agents'
  COMMITS out of your push. Git pushes a BRANCH, not a set of commits — so if another
  agent has an unpushed commit sitting BELOW yours on `main`, it is an ANCESTOR and
  goes to origin with yours whether anyone decided to or not. That is exactly what
  happened on 2026-07-14: an agent pushed `[AVADIAL-GROUPS-1]` and silently carried two
  unrelated `[AVA-AUTH-*]` commits along. No tool can push your commit without its
  ancestors, so the wrapper does the only correct thing — it **refuses** and tells you
  whose work is in the way, instead of publishing it for them.

  Ownership is read from the `[ISSUE-ID]` prefix (every agent commits as the same git
  user, so the author field cannot tell agents apart) — which is another reason the
  one-issue-per-commit rule below is mandatory. A commit with no `[ISSUE]` prefix is
  unattributable and also blocks the push.

  If you're blocked, the fix is to let the owning agent push their own work first, then
  re-run. `--allow-foreign` bypasses the check and is for the OWNER's deliberate merge
  push only — an agent should never reach for it to get unstuck.

  The wrapper also refuses to push if any workflow has an **active `push:` trigger**, so
  a re-enabled trigger can't silently ship a build.
- **One issue per commit.** Each commit fixes a single issue, and the message must start
  with the issue ID, e.g. `[ISSUE-123] Fix null check in payout handler`. This keeps the
  history bisectable if the final merge build fails.
- **All git writes go through the mandated wrapper — never run `git add` or `git commit`
  directly.** The wrapper serializes every agent's commits through one shared advisory
  lock and works on both macOS and Linux. **ALWAYS pass the explicit paths you changed**
  so your commit contains ONLY your files:

  ```bash
  python3 scripts/git_safe_commit.py "[ISSUE-123] short description" path/one path/two
  ```

  - **Why paths are required in this shared tree.** The lock serializes commits but does
    NOT isolate the working tree: the bare `git add -A` form stages EVERYTHING currently
    changed, so whichever agent commits first sweeps every other agent's uncommitted files
    into ITS commit and mislabels history (a GenUI change landing inside an `[AVA-VOICE-…]`
    commit, etc.). Passing paths makes the wrapper run `git add -- <paths>` then
    `git commit -- <paths>`, so concurrent agents' changes can never ride along.
  - The no-paths form (`… "msg"` with no paths → legacy `git add -A`) still works for
    backward compatibility, but do NOT use it while other agents may be active.

- **Do NOT use the `flock` command.** It is not installed on macOS (where commits run via
  Desktop Commander), so it fails silently and breaks serialization. `scripts/git_safe_commit.py`
  (which uses `fcntl.flock` on `/tmp/repo.gitlock`) is the ONLY approved method — every
  agent must use it so the lock is shared and consistent.
- **Stale `.git/index.lock` is handled by the wrapper.** While holding the advisory lock,
  it removes an orphaned `index.lock` only after confirming no `git` process is running;
  if a git process is live, it waits. Never delete `index.lock` by hand, and do NOT rely
  on a plain wait-and-retry loop (a 0-byte orphaned lock never releases on its own).
- **Run all git operations on the host filesystem via Desktop Commander.** Sandbox mounts
  cannot write to `.git`, and the shared lock only means anything if every agent commits
  on the same host using the same `/tmp/repo.gitlock`.
