# PROPOSAL — Cloudflare Dynamic Workers in AvaTOK

**Date:** 2026-07-28 · **Status:** PROPOSAL (nothing implemented) · **Audience:** an AI agent implementing this
**Docs:** https://developers.cloudflare.com/dynamic-workers/ (llms.txt: `/dynamic-workers/llms.txt`)

---

## 0. What Dynamic Workers give us (30-second version)

A `worker_loaders` binding lets a deployed Worker spin up sandboxed child Workers **from code strings at runtime** — no deploy. The loader controls everything the child sees:

- `env.LOADER.load({modules, mainModule, compatibilityDate, env, globalOutbound})` → one-shot isolate.
- `env.LOADER.get(id, callback)` → cached/warm isolate keyed by code version.
- **Capability bindings**: pass `WorkerEntrypoint` stubs (created via `ctx.exports.MyClass({props})`) into the child's `env`. The child can only call methods you expose; the host keeps secrets out of the dynamic Worker's environment. `ctx.props` is available to the capability implementation, so it must contain only non-secret scope and policy data. Stubs are unforgeable (Cap'n Web RPC).
- **`globalOutbound: null`** → zero network. Or pass a fetcher to intercept/allowlist egress.
- **Custom limits** on CPU/memory; **Tail Workers** for per-run logs.
- **DO Facets**: `this.ctx.facets.get(name, cb)` inside any DO runs a dynamically-loaded DO class as a child with its **own isolated SQLite** (supervisor DB unreadable to it). `abort()` for hot code swap, `delete()` to wipe.
- **Dynamic Workflows** (`@cloudflare/dynamic-workflows`): runtime-loaded code gets durable `step.do()/step.sleep()/step.waitForEvent()` via `wrapWorkflowBinding({tenantId})` + `createDynamicWorkflowEntrypoint`.
- TS/npm must be pre-bundled (`@cloudflare/worker-bundler` runs inside a Worker).

Key mental model for AvaTOK: **we already ship behavior as data** (trigger banks, KV policy, refund_rules params, persona prompts, A2UI templates). Dynamic Workers is the next rung — ship behavior as *sandboxed code* — and it eliminates two chronic costs: LLM token burn on tool loops, and deploy-coupled logic changes.

### 0.1 Messaging versus AvaBrain / AI chat — the important answer

**Ordinary messaging is not a Dynamic Workers target in the current architecture.**
`InboxDO` is the per-user durable message log and hibernatable WebSocket endpoint;
`PartyDO` is an ephemeral room/broadcast layer. Dynamic code must not sit in the
message append, sync, receipt, ordering, or WebSocket hot paths. Those paths need
small, deterministic, strongly-consistent code.

**AvaBrain and Ava AI chat do have useful, bounded use cases.** Dynamic Workers can
run deterministic orchestration around the LLM, for example:

- execute a multi-step AvaApps / AvaBrain plan after one model-generated script;
- search several consented AvaBrain sources, filter/deduplicate results, and return
  a compact context package to the normal chat model;
- evaluate deterministic per-chat triggers, output formatting, or action routing;
- run a user/creator-authored skill that computes or transforms data before Ava
  writes the natural-language answer.

Dynamic Workers do **not** replace the AI model, make ordinary text generation free,
or become the AvaBrain source of truth. `DynBrain` is read-only, account-scoped, and
must check the master AvaBrain consent plus the relevant per-app guardrail before
every call. Private/E2E content remains device-only and is never passed to a dynamic
Worker. Brain writes, ingestion, embeddings, safety truth, wallet actions, and
message persistence remain static host-controlled code.

**Decision:** pursue Dynamic Workers for Ava AI chat orchestration and AvaBrain
read/context tooling; do not pursue Dynamic Workers for ordinary messaging in this
proposal. A future chat-plugin design is listed only as a research item below and
is not an implementation target.

---

## 1. Ground rules for the implementer (non-negotiable)

1. **Staging first.** All work lands on `staging`, deployed via `scripts/cf.sh worker deploy`. Never bare wrangler. Prod only on explicit owner instruction with `ALLOW_PROD=1`.
2. **Every new flag = real flag.** Declare in `PlatformConfig` interface AND `DEFAULTS` in `worker/src/routes/config.ts` in the same commit (numbers also in `numericKeys`), then prove `flags.sh set <key>=false` doesn't 400. No fake flags.
3. **Commit before deploy** (`scripts/git_safe_commit.py "[ISSUE] msg" <paths>`), one issue per commit, push via `git_safe_push.py`. No builds triggered.
4. **Deployment boundary:** `worker`, `consumers`, and `calls` are separate deployments. A `LOADER` binding in `avatok-api` is not available to consumers or calls. Dynamic code must run in the deployment that owns its host API, or be invoked through an explicit service binding/queue contract. Do not use Dynamic Workers to solve cross-package imports.
5. **Default-deny sandbox posture:** every `load()`/`get()` sets `globalOutbound: null` unless a workstream explicitly needs an egress interceptor. All capability bindings scope by account via `props` — per-account scoping is enforced by the host capability, not by discipline.
6. **Respect the `fault_inject.ts` doctrine:** security-critical behavior must NOT become remotely-swappable code. Dynamic code is for *user/tenant behavior*, never for auth, wallet ledger math, moderation thresholds, or Sentinel scoring truth (Sentinel gets static, reviewable versions, see WS-6, with replay verification — not remote hot-patching).
7. **User-authored logic is untrusted twice:** moderate the *source* (existing `guardWrite`/`ModField` pipeline) AND sandbox the execution (no network, scoped bindings, CPU limits, tail logs).
8. **Telemetry:** every dynamic run emits a PostHog event (`dyn_worker_run` — props: `area`, `code_id`, `uid/email`, `ok`, `cpu_ms`, `wall_ms`, `tool_calls_saved`) and failures go through `hooks.trackException`. Wire Tail-Worker output into the Logs pipeline. Never put message bodies, private Brain content, tokens, or secrets in telemetry.
9. **Pricing check before enabling any high-volume path in prod:** read the current Cloudflare pricing documentation and put projected Dynamic Worker creation, request, CPU, and Workflow costs in the PR description.

---

## 2. Phase 0 — Shared foundation (prerequisite for everything)

**Issue:** `[DYNW-CORE-1]`

### 2.1 Wrangler config
Add to `worker/wrangler.toml` (both staging and prod env blocks; deploy staging only):

```toml
[[worker_loaders]]
binding = "LOADER"
```

### 2.2 New library: `worker/src/lib/dynw/`

- **`host.ts`** — the ONLY entry point for running dynamic code:
  ```ts
  export interface DynRunOpts {
    area: string;              // "codemode" | "receptionist_rules" | ...
    codeId: string;            // stable id incl. version, for LOADER.get()
    modules: Record<string,string>;
    mainModule: string;
    env?: Record<string, unknown>;   // capability stubs only
    outbound?: Fetcher | null;       // default null
    limits?: { cpuMs?: number };     // default 100ms
    timeoutMs?: number;              // wall clock guard, default 5000
  }
  export async function runDynamic(env: Env, ctx: ExecutionContext, opts: DynRunOpts): Promise<DynResult>
  ```
  Responsibilities: flag check (`dynamicWorkersEnabled` master kill switch), `LOADER.get(codeId, ...)`, wall-clock timeout via `Promise.race`, telemetry emit, exception capture. Never expose `env.LOADER` outside this file.
- **`caps.ts`** — exported `WorkerEntrypoint` capability classes (grow per workstream): `DynKV` (prefix-scoped TOKENS access), `DynBrain` (read-only `brainSearchTyped`, scoped to uid and consent/guardrail), `DynComposio` (validated tool execution with budget and confirmation gates), `DynWallet` (read-only balance; **no spend method ever**), and `DynHttp` (allowlisted fetch, only where a workstream needs egress). There is deliberately no generic `DynConv`/message-write capability in the foundation. Each capability reads scope from `this.ctx.props`; props carry `{uid, accountScope, consentSnapshot, ...}` but never API keys or other secrets.
- **`registry.ts`** — code storage/versioning. Table (D1 `DB_META`):
  ```sql
  CREATE TABLE IF NOT EXISTS dyn_modules (
    code_id TEXT PRIMARY KEY,        -- "<area>:<owner>:<semver-or-hash>"
    area TEXT NOT NULL, owner_uid TEXT,
    source TEXT NOT NULL,            -- bundled JS (post worker-bundler)
    sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', -- active|disabled
    created_at INTEGER NOT NULL
  );
  ```
  `codeId` embeds the sha — a code change is a new id, so `LOADER.get` caching is always correct and rollback = flip a pointer.

### 2.3 Flags (declare all in `config.ts` DEFAULTS now, all `false`)
`dynamicWorkersEnabled` (master), plus per-workstream: `dynCodeModeEnabled`, `dynAvaBrainContextEnabled`, `dynReceptionistRulesEnabled`, `dynMarketplaceFlowsEnabled`, `dynCallRoutingEnabled`, `dynCreatorAgentToolsEnabled`. Do not add a `dynMessagingEnabled` flag: ordinary messaging is explicitly out of scope. A future chat-plugin experiment must receive a separate architecture decision first.

### 2.4 Acceptance
Hello-world dynamic worker runs on staging behind the flag; blocked-egress test proves `fetch("https://example.com")` inside dynamic code throws; a `DynKV` stub with prefix `A` provably cannot read prefix `B`; telemetry event visible in PostHog.

---

## 3. Workstreams (fine-grained)

Ranked by value/effort. Each is an independent issue; WS-1..3 are the recommended first wave.

---

### WS-1 · Code Mode for AvaApps + AvaBrain chat orchestration — `[DYNW-CODEMODE-1]`
**Target:** `lib/composio.ts` (`runAgentLoop` :1170, `runAppsToolLoop` :965, `executeTool` :571), called from `do/ava_agent.ts:1081` and `routes/ava_apps.ts` (`avaAppsRun`).

**Problem:** every multi-step AvaApps command round-trips tool results through the LLM — N tool calls = N inference passes carrying full intermediate payloads. This is the exact case CF built Code Mode for (claimed up to ~80% token savings).

**Design:**
1. New `lib/dynw/codemode.ts`. For a user turn, instead of the tool loop, make ONE LLM call whose system prompt contains TypeScript declarations of the user's available tools (generate from the same Composio schemas `geminiTools` already builds, composio.ts:1226-1230 — new `toolkitsToDts()` helper). LLM returns a script: `export default async function run(env) { ... }`.
2. Execute via `runDynamic` with env = `{ TOOLS: DynComposio stub, MEMORY: DynBrain stub }`, `globalOutbound: null`. `MEMORY` is read-only and must enforce AvaBrain consent/guardrails; it cannot read private/E2E content or write Brain state.
   - `DynComposio extends WorkerEntrypoint`: single method `exec(slug, args)` → existing `executeTool` with the exact validation chain from `avaGenuiAction` (`isExecutableTool` capabilities.ts:413, `coerceArgs` :424). Props: `{uid, connectedToolkits, budget}`. Enforce the tool budget *inside the stub* (count calls, throw over budget) — dynamic code cannot bypass it.
   - Pending-action/human-confirm: stub throws `NeedsConfirmError(token)`; host catches, persists the KV confirm token exactly as today (ava_apps.ts:202-222), returns pending state. On confirm, resume with an idempotency key and an explicit completed-tool ledger; never blindly repeat already-successful side effects.
3. Script result (structured JSON) goes through the existing GenUI `renderData` path unchanged.
4. Fallback ladder: flag off / script throws / times out → fall back to the current `runAppsToolLoop` transparently. Log `codemode_fallback` with reason.
5. Neuron/budget accounting: keep existing `AgentDO.reserve` + ai_gate reservations; add `tool_calls_saved` = (script tool calls) − 1 LLM calls to telemetry.

**Rollout:** staging → owner dogfood on `hdavy2005@gmail.com` → `dynCodeModeEnabled` per-uid allowlist (config array key) → default on.
**Acceptance:** a 3-step command ("find last invoice email, add reminder to calendar, tell me the total") completes with 1 planning inference; a Brain-context command proves consent-scoped read access; token delta, latency, Dynamic Worker CPU, request count, and fallback rate are measured; confirm-pause flow does not duplicate side effects; kill switch flips back to legacy loop instantly.

---

### WS-2 · Per-user receptionist & delegate rule scripts — `[DYNW-RECEPT-RULES-1]`
**Targets:** `do/reception_room_cf.ts` (`processCfTurn` :566, `cfChat` :773), `routes/receptionist.ts` (`composeReceptionistPrompt` :616, `receptionist_settings`), `routes/ava_delegate.ts` (`delegateScan` :277), `routes/auto_responder.ts`.

**Problem:** all per-owner behavior is prompt-stuffed (`instructions_text`, `status_note`, activation-mode branches) — every rule rides every LLM turn, and deterministic rules ("brother → tell him X", "sales call → decline") still cost inference and are non-guaranteed.

**Design:**
1. Owner rules (created via existing settings UI, or compiled from natural language by a one-time LLM pass at save time) become a script implementing:
   ```ts
   interface CallRules {
     onCallStart(caller: CallerInfo): Verdict;   // {action:"say",text}|{action:"voicemail"}|{action:"continue",promptAddendum?}|{action:"escalate"}
     onTurn(transcript: Turn[]): Verdict | null; // null = let LLM handle
   }
   ```
2. Compile+bundle at save time (worker-bundler), moderate source via `guardWrite(ModField:"prompt")`, store in `dyn_modules` (`area:"recept_rules"`, owner_uid), sha-versioned.
3. In `ReceptionRoomCf.processCfTurn`: before `cfChat`, call the owner's rules worker (not a DO facet — a warm loader isolate) — `LOADER.get(codeId)` warm across the whole call, `globalOutbound:null`, env `{}` (pure function over transcript; caller info from InitBlob). `say` verdicts skip the LLM entirely (direct `cfSpeak`); `continue` verdicts append `promptAddendum`. Hard 20ms CPU limit; any error → ignore, proceed to LLM (fail-open, matches delegateScan's cheap-first cascade philosophy).
4. Same host for `ava_delegate` (script decides reply/ignore/alert before `generateDelegateReply` :365) and `auto_responder` `depth:"chat"` (script can produce the canned reply without the consumers-side AI call).

**Acceptance:** deterministic rule answered with 0 LLM calls (verify via `$ai_generation` absence + `dyn_worker_run` presence); a thrown script never breaks a live call (chaos test: script with `throw` mid-call); disable = KV flag + `dyn_modules.status='disabled'`.

---

### WS-3 · Durable multi-step flows via Workflows — `[DYNW-FLOWS-1]`
**Targets (hand-rolled workflows found in survey):**
- `consumers/src/deletion.ts` — 15-store ordered cascade, **no checkpoint on partial failure** (best candidate, but the first implementation should be a static Workflow in the Worker deployment, not a Dynamic Worker in consumers).
- `routes/payout.ts` + `wise.ts` — createRecipient → quote → transfer → fund → **wait for `/webhooks/wise`** (textbook `step.waitForEvent`).
- `routes/marketplace.ts:300-484` + `consumers/src/mkt_audio.ts` — negotiation → TTS render 30–60s, previously "reaped → 'No audio'".
- `routes/ava_apps.ts` confirm-token pause (KV TTL today) — becomes `step.waitForEvent("user_confirm")`.
- `consumers/src/calendar.ts:82` reminder ladder + `listing_expiry.ts` — cron-poll + boolean columns → `step.sleep` until T−24h/T−60m/T−10m.

**Design:** these are OUR code, not tenant code → use **static Cloudflare Workflows** first (`[[workflows]]` binding, `WorkflowEntrypoint` classes in `worker/src/workflows/`). The existing consumer deployment cannot use the Worker's loader without its own binding and deployment work. Adopt `@cloudflare/dynamic-workflows` only where the steps themselves are tenant-defined (WS-4 marketplace automations, WS-1 long agent plans). Order: (1) deletion cascade — each store = one `step.do` with per-step retry, legal-hold checks, and idempotency keys; cron backstop kept as safety net; (2) Wise payout; (3) mkt audio; (4) reminders. Keep queue producers; migrate each consumer only after the owning deployment has a deliberate Workflow binding.
**Acceptance:** kill the worker mid-deletion-cascade on staging → workflow resumes at the failed step, no re-deletion of completed stores (idempotency preserved); Wise flow survives a 2-day webhook delay without cron polling.

---

### WS-4 · Marketplace: tenant automations + agent negotiation sandbox — `[DYNW-MKT-1]`
**Targets:** `routes/agent_settings.ts` (fixed-shape guardrails), `routes/marketplace.ts` (negotiation prompt :494-522, `negotiationProfile` :199), `routes/listings.ts` book flow :1452, `rules.ts`/`money_engine.ts`.

**Design:**
1. **Seller policy scripts** (behind `dynMarketplaceFlowsEnabled`): extend agent settings with an optional script implementing `evaluateOffer(offer, listing, history): {accept|counter(amount)|reject|ask_owner}`. Runs sandboxed, no network, env `{}`; the *outer* negotiation pipeline still clamps to `floor_pct` and `ask_before_commit` — a malicious/buggy script can never undercut the D1-stored floor. This converts negotiation from prompt-only to deterministic-first (script) with LLM for language only.
2. **Seller fulfillment automations** via Dynamic Workflows: per-seller order flows (`step.waitForEvent("payment_confirmed")` → deliver → sleep 3d → review nudge), `wrapWorkflowBinding({sellerUid})`, code from `dyn_modules`. This is the "SaaS per-tenant automation" case verbatim from CF's docs.
3. **Explicitly OUT of scope:** `rules.ts` refund engine and ledger stay static code + D1 params (money math, rule #6 of §1).
**Acceptance:** script attempting `counter(1)` below floor is clamped and flagged; seller workflow survives isolate recycling across a 3-day sleep.

---

### WS-5 · Messaging plugins / chat Facets — RESEARCH ONLY, NOT IMPLEMENTATION

**Finding:** ordinary messaging has no safe Dynamic Workers insertion point today. `InboxDO` is per-user durable storage, `PartyDO` is ephemeral broadcast, and `ConversationDO` is agent-to-agent logic. None is currently a shared conversation/plugin supervisor. Do not add a dynamic code path to message append, sync, receipts, ordering, or WebSocket handling.

**Possible future design:** create a dedicated per-thread supervisor with an explicit event stream and capability API. Only first-party plugins would be considered initially; they would receive sanitized events, a post-only rate-limited capability, and their own Facet SQLite. The supervisor—not the plugin—would own membership, persistence, moderation, ordering, and message authorization. This requires a separate architecture proposal and is not part of the Dynamic Workers rollout.

**Current decision:** no `DynConv`, no `dynMessagingEnabled`, no chat Facet implementation in this proposal. AI chat orchestration belongs in WS-1 through read-only AvaBrain and validated tool capabilities, not in the messaging transport.

---

### WS-6 · Sentinel/moderation versioned policy modules — `[DYNW-SENTINEL-POLICY-1]`
**Targets:** `sentinel/extractors.ts` (static switch, SEN-00x rules, deploy-coupled), `sentinel/evidence.ts` (reserved `policy_version` field — the planned policy engine), `spam/scoring.ts`.

**Design:** keep extraction/policy rules as static, reviewable modules. Dynamic Workers may be used only for a staging shadow comparison of a candidate pure function, with zero bindings and zero network. The active Sentinel ruleset must continue to ship through git and be promoted through an owner-approved deployment; no remotely-swappable moderation truth. `verifyReplay` remains the acceptance gate.
**Acceptance:** shadow output is compared without affecting enforcement; `verifyReplay` passes across a version boundary; a mismatch stops promotion. “New rule live without deploy” is explicitly rejected for Sentinel.

---

### WS-7 · Live-room games/plugins in StreamSessionDO/PartyDO — RESEARCH ONLY
**Targets:** `do/party.ts` (events already opaque, :19-24 — "new live feature is a client-only change"), `do/stream_session.ts`.

**Design:** same facet pattern as WS-5 on `StreamSessionDO`: creator enables a room game (trivia, prediction, tip-race) → facet with own SQLite holds authoritative game state, env `{ ROOM: DynRoom stub (broadcast, read reactions/roster) }`. Solves the current gap: opaque relay means anything *server-authoritative* (scores, anti-cheat) must be hard-coded into the DO today. First-party game catalog; creator-authored games later.
**Decision:** do not implement in this proposal. Revisit only after a dedicated
room-supervisor design proves that authoritative game state, creator permissions,
anti-cheat, and uninstall semantics can be isolated from the live-room control
plane.

---

### WS-8 · Creator AI agents (AvaVision/AvaVoice) + campaign tools — `[DYNW-CREATOR-1]`
**Targets:** `routes/avavision.ts`/`avavoice.ts` (creators author agents w/ prompts + brain files, buyers pay — third-party behavior on our keys; strongest sandboxing case after AvaApps), `lib/tool_runtime.ts` (already a hand-built sandbox: frozen decls, FIFO, 8s timeout, circuit breaker, 6/2/2 budgets), `do/campaign_do.ts` + `lib/campaign_prompt.ts` (prompts frozen at launch w/ `PROMPT_VERSION`).

**Design:** creator agents gain optional *skills* — small scripts callable mid-session (lookup pricing table, compute quote, quiz logic) executed via `runDynamic` with `ToolRuntime` as the calling convention (ToolRuntime keeps its budgets/circuit-breaker; the dynamic worker replaces only the tool *implementation*). Campaign per-tenant call scripts similarly become `dyn_modules` versioned like `PROMPT_VERSION`. Egress: default none; document-lookup skill gets a `DynHttp` stub allowlisted to the creator's own File Search store only.
**Effort:** medium-high; after WS-1 + WS-2 (reuses both hosts).

---

### WS-9 (evaluate, don't build yet) · A/V call routing scripts — `[DYNW-CALLROUTE-1]`
Per-user IVR/routing on the DID/PSTN lane ("after 6pm → voicemail; VIP list rings through") at call-setup time — same host as WS-2, different hook point (before ring, not per turn). Media paths (CallRoom P2P, LiveKit, Realtime SFU) get **nothing** — isolates never touch media. Build only when the DID lane's routing demand is real.

### Non-goals / rejected
- **Consumers cross-import friction** (`liveness_verify.ts`, `fault_inject.ts` duplication): tempting to fix by runtime-loading shared modules, but a **service binding** is the right tool — don't use dynamic code to solve a packaging problem.
- **Wallet/ledger/auth/refund math as dynamic code:** never (§1.6).
- **`ava_triggers.ts` as shipped code:** stays data — device needs it serializable.

---

## 4. Sequencing & effort

| Phase | Workstreams | Est. effort | Gate to next |
|---|---|---|---|
| 0 | DYNW-CORE-1 loader/egress/capability spike | 3–5 agent-days | staging hello-world, egress block, scoped Brain read, telemetry and cost baseline |
| 1 | WS-1 AvaApps + AvaBrain Code Mode | 4–6 days | measured token/cost savings, consent proof, idempotent confirmation, fallback |
| 2 | WS-2 receptionist rules; static WS-3 deletion/payout Workflow | 5–7 days | deterministic receptionist turn; deletion resume and legal-hold tests |
| 3 | WS-4 marketplace policies/automations | 5–7 days | floor enforcement, payment workflow idempotency, projected cost approval |
| 4 | WS-8 creator skills; WS-9 PSTN routing | as prioritized | capability review and staged dogfood |
| Research only | WS-5 messaging plugins; WS-6 Sentinel shadow comparison; WS-7 room games | no implementation commitment | separate architecture/security decision |

Per-workstream commits follow one-issue-per-commit with the IDs above. Every workstream PR includes: flag proof (`flags.sh set` round-trip), staging deploy note, PostHog dashboard link for its `dyn_worker_run` events, and a cost estimate against Dynamic Workers pricing.

## 5. Open questions for the owner
1. Pricing sign-off once Phase 1 volume projections exist (Code Mode runs ≈ every AvaApps command).
2. WS-2: should owners write rules in natural language (LLM-compiled at save, shown back for approval) or is this AI-generated-only at first?
3. For WS-1, which AvaBrain sources are allowed in the first dogfood cohort, and should the first capability be search-only with no Brain writes? (Recommended: yes.)
4. Messaging plugins and room games remain separate future architecture proposals; no implementation decision is requested here.
