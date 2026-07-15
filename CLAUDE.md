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
gh workflow run android.yml --ref staging -f environment=staging -f artifact=apk

# production build (main code, prod backend) — only on an explicit request
gh workflow run android.yml --ref main    -f environment=prod    -f artifact=apk
```

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
was CHANGED in Phase 10 — group conferences ≤25 via LiveKit are now allowed (see
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
Group conferences ARE allowed in AvaTalk groups, **≤25 participants, via LiveKit**
(`worker/src/routes/conference.ts` + `app/lib/features/conference/`). 1:1 calls
stay P2P (CallRoom DO, **2-peer cap unchanged** — group conferences never touch
it; do NOT raise the cap). Group/conference CONSULTING still lives in AvaConsult.
Enforcement: group-thread call icons active only when `memberCount <= 25`
(otherwise greyed + a notice popup), the Worker rejects start/join for >25-member
groups, and LiveKit `max_participants=25` is the server-side backstop. All gated
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
- **No local build tools.** Do NOT attempt builds, compiles, or local verification
  (no `npm build`, `flutter build`, `flutter analyze`, etc.) — they will fail. All
  builds run in GitHub Actions.

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
