# One Brain — Proposal v2 (approved direction; implementation contracts included)
**Status:** APPROVED DIRECTION — v2, revised 2026-07-18 after design review. v1's seven
review findings are resolved inline (§7). Not "final" as code until B0 lands and the
contracts in §3, §5 and §6 survive first contact.
**§10 (Guardian) added then DEFERRED 2026-07-18 (owner).** Design of record for a future
Guardian/One Brain task; **B0 ships without it**. Only two live P0s + a placeholder agent
boundary are carved out into the marketplace plan. Its three corrections to the incoming
proposal stand for whoever picks it up: safety runs on **legal basis, not consent** (§10.1);
safety records must be **exempt from the §5.1 deletion contract** or it becomes a
reputation-laundering tool (§10.2); safety is **two-party and therefore not a per-user brain
domain** (§10.3). **B-D7** (turn `sentinelEnabled`/`sentinelMem0Enabled` off) moves to that
task and should be sequenced first there — it's two flags and it's costing money daily.
**Supersedes:** v1 (2026-07-17) and the draft inventory/plan. The draft's Part 1 inventory
remains the factual baseline.

---

## 0. The decision in one paragraph

AvaBrain is **not a new AI**. It is the single shared memory and governance layer that every
existing feature AI (ChatAVA, Copilot, receptionist, GenUI, moderation, voicemail) plugs into.
Feature AIs keep the models best suited to their jobs; what unifies them is that **all data
enters through one contract (`brainIngest`), all memory is answered through one API
(`brainRecall`), and all inference goes through one gateway (`avaReason`)**. Message content
never lives server-side: the server brain holds account-private data and conversation
metadata; the device brain holds content. Unified recall merges the two lanes so the user
experiences one brain.

---

## 1. Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| **B-D1** | Message content ingestion | **Metadata + on-device.** Server ingests who/when/thread-topic only. Content is indexed on-device (`AvaLocalIndex` lane). `brainEnabled` full-content server ingestion is **rejected** — no change to Play data-safety declaration, no permanent server archive of private chats. |
| **B-D2** | `RagService` (chat text → user's Gemini File Search store, no consent check) | **CUT.** It is a second, unaudited brain. The on-device index takes over its role. |
| **B-D3** | `brain_relationships` | **Drop for now.** Written-never-read graph. Stop writing; remove schema later; revisit only with a concrete recall use case. |
| **B-D4** | Retention | Raw `brain_events` roll off at **12 months**. Derived facts/embeddings get a **decay-and-rebuild policy, not indefinite persistence** — see §5.3. 90-day churn purge unchanged. Content retention is a non-issue server-side by B-D1. |
| **B-D5** | B0 consent fixes ship first, as their own release | **Yes. Non-negotiable entry price.** No new domain is wired before B0 lands. |
| **B-D6** *(new, v2)* | Cloud reasoning over device-private content | **Default ON — owner decision 2026-07-18.** Strict no-retention transport; a **"local-only answers"** toggle keeps private snippets off the network entirely — see §6. Review noted some users may expect opt-in; mitigation is a **first-run disclosure** the first time a private snippet would go to the cloud (informational, not blocking), plus the always-available toggle. |
| — | Separate "AvaBrain AI"? | **No.** A new assistant would be the 9th memory store and 7th provider. AvaBrain has no model of its own — it is ingest + store + recall + governance. |

---

## 2. Architecture

```
 ┌────────────────────────────────────────────────────────┐
 │ GOVERNANCE   domain registry · consent (fail-CLOSED) · │
 │              deletion contract · retention · audit     │
 └────────────────────────────────────────────────────────┘
            ▲                                  ▲
 ┌──────────┴────────────┐        ┌────────────┴───────────────┐
 │ REASONING PLANE       │        │ MEMORY PLANE               │
 │ avaReason core:       │        │ brainIngest → stores →     │
 │ policy·routing·budget │        │ brainRecall(uid,query)     │
 │ telemetry·kill-switch │        │  ├ server lane             │
 │  └ adapters/: one per │        │  │  (account_private:      │
 │    provider+verb, thin│        │  │   D1 + Vectorize)       │
 └───────────────────────┘        │  └ device lane             │
   ▲    ▲    ▲    ▲    ▲          │     (device_private:       │
 ChatAVA Copilot GenUI Mod. …     │      AvaLocalIndex)        │
                                  └────────────────────────────┘
```

### 2.1 Scope taxonomy (v2 — replaces public/private)

| Scope | Meaning | Where it lives |
|---|---|---|
| `account_private` | Server-readable, belongs to one account, never shared beyond it | D1 `avatok-brain` + Vectorize (uid-prefixed) |
| `device_private` | Never leaves the device except transiently under §6 | Per-account on-device SQLite (`AvaLocalIndex`) |

Nothing in the brain is "public". The old `scope` column values migrate
`public → account_private`, `private → device_private`.

**Scope is derived, never trusted.** The registry is the sole authority for each
`(domain, kind)`'s scope. Callers do **not** send a scope field. The server ingestion
endpoint recomputes scope from the registry and **hard-rejects** any payload whose domain
resolves to `device_private` — a buggy or compromised producer cannot upload content by
mislabelling it. `device_private` ingestion uses a **separate device-only API**
(`AvaLocalBrain.ingest(...)` in the app) that has no network path at all.

### 2.2 Live-token sessions

Gemini Live mints (avavision, avavoice, ava_live, translate, receptionist) cannot be
proxied — accepted. Every token mint MUST emit a session-open/close telemetry pair so spend
is attributable.

---

## 3. The Ingestion Contract (v2)

Server-lane entry point — the only way data enters the server brain:

```ts
await brainIngest(env, {
  v: 1,                        // envelope version — see §3.2
  uid,                         // account id (AccountScope), never device id
  domain: 'calls',             // must exist in BRAIN_DOMAINS
  kind:   'call_completed',
  idempotencyKey,              // producer-generated, stable across retries — see §3.2
  text:   'Call with Priya, 4m12s, outgoing',
  meta:   { peer, duration, direction },
  ts,                          // event time (client clock), serverTs assigned on ingest
});
// NOTE: no `scope` field. Scope comes from the registry (§2.1).
```

```ts
export const BRAIN_DOMAINS = {
  contacts:   { consent: 'contacts',  label: 'Contacts',      default: true, scope: 'account_private' },
  calls:      { consent: 'calls',     label: 'Call history',  default: true, scope: 'account_private' },
  missed:     { consent: 'calls',     label: 'Call history',  default: true, scope: 'account_private' },
  voicemail:  { consent: 'voicemail', label: 'Voicemails',    default: true, scope: 'account_private' },
  msg_meta:   { consent: 'messages',  label: 'Chat activity', default: true, scope: 'account_private' }, // metadata ONLY (B-D1)
  msg_content:{ consent: 'messages',  label: 'Chat content',  default: true, scope: 'device_private'  }, // device API only
  listings:   { consent: 'listings',  label: 'Marketplace',   default: true, scope: 'account_private' },
  wallet:     { consent: 'wallet',    label: 'Wallet',        default: true, scope: 'account_private' },
  files:      { consent: 'files',     label: 'Files',         default: true, scope: 'account_private' },
} as const;
// Tomorrow's new app = one new row + brainIngest calls. That IS the integration.
```

`brainIngest` guarantees, in one place: registry-resolved consent key; consent check that
**fails CLOSED**; unknown domains rejected at the type level; scope derived and
`device_private` payloads rejected at the server edge; one canonical `Q_BRAIN` envelope;
vector-id registration so the deletion contract (§5) covers every domain automatically.

Settings UI is **generated from the registry** — a toggle can never again gate nothing, and
a capability can never exist without a toggle.

### 3.2 Envelope & delivery semantics

- **Versioning:** every envelope carries `v`. Consumers reject unknown majors; additive
  fields only within a major.
- **Idempotency:** `idempotencyKey` = `hash(uid, domain, kind, sourceId)` where `sourceId`
  is the producing row/event id. `brain_events` has a unique index on
  `(uid, idempotency_key)`; duplicates (queue redelivery, client retry, multi-device
  double-fire) are ACKed and dropped. Ingestion is **at-least-once + idempotent** = effectively
  once.
- **Ordering:** none guaranteed. Consumers must not assume order; derived facts are built
  from event-time (`ts`), with `serverTs` for audit.
- **Offline/retry:** client producers queue locally (per-account, scoped storage) and
  drain with backoff; the idempotency key makes replays safe.
- **Account scoping:** `uid` is the AccountScope id. On a shared phone, each account's
  producer queue and device lane are namespaced per the rulebook (`scopedKey`); one
  account's events can never carry another's uid.
- **Multi-device:** server lane converges via idempotency keys. Device lanes are
  intentionally per-device (content indexed where it exists); `brainRecall` treats a device
  lane as "this device's view", not a replicated store. No cross-device sync of
  `device_private` indexes in scope for v1.

---

## 4. The Reasoning Plane (v2 — core + adapters)

`avaReason` is **policy and routing only**, deliberately small:
consent/kill-switch check → model policy lookup → budget/token cap → adapter dispatch →
telemetry emit → cache. Everything provider-shaped lives in thin adapters:

```
worker/src/lib/ava_reason/
  core.ts          // the gateway: policy, routing, budget, telemetry, cache, kill switch
  policy.ts        // model selection per (verb, feature), env-overridable
  adapters/
    openrouter.ts  cf_ai.ts  google.ts  openai.ts  xai.ts
```

- Verbs: `reason` · `embed` · `transcribe` · `speak` · `see`. A verb is a routing key, not
  a code path in core.
- One shared module (kills the worker/consumers fork). Consumers import the same core.
- **Enforcement:** ESLint bans raw `fetch` to provider hosts and bare `env.AI.run` outside
  `lib/ava_reason/`. Without this, v1's 48 bypasses regrow.
- One telemetry schema (`ava_reason_call`) absorbs the other three.
- **God-module tripwire:** core stays under ~400 lines; anything provider-specific that
  creeps in moves to an adapter in review.

---

## 5. Governance contracts

### 5.1 Deletion contract (replaces "purge covers everything")

Deletion across D1, DO SQLite, Vectorize, caches and queues is asynchronous — so it is a
**job with state, not a request**:

```
brain_deletions (D1):  id · uid · requested_at · targets(json) · state · attempts · completed_at
state: pending → running → partial → complete | failed
```

- **Idempotent steps**, one per store: DB_BRAIN tables, Vectorize ids (from
  `brain_vectors`), `avachat_sessions`, InboxDO `'brain'` conv, device lane (client
  executes on next sync and ACKs), provider stores while any exist (Gemini File Search,
  until B-D2 removal lands), KV/edge caches (cache-bust keys).
- **Retry:** failed steps retried with backoff; a step that keeps failing pins state at
  `partial` and **alerts** — deletion never silently half-completes.
- **In-flight events:** the deletion job records a watermark; `Q_BRAIN` consumers drop any
  event for a uid with an active deletion at ingest time (checked against
  `brain_deletions`), so retries can't resurrect data.
- **Proof:** on `complete`, the job writes an audit record (counts per store, timestamps)
  that Settings can surface as "your data was deleted on <date>". Backups/PITR expire on
  the platform's fixed window (Cloudflare D1 30-day time-travel); the audit record states
  this honestly rather than claiming instant erasure from backups.
- Capability toggle-off = the same job, scoped to one domain (`retro_delete` no longer
  env-gated).

### 5.2 Exit criterion restated

B0's exit is not "zero rows" but: **every deletion request reaches `complete` with an
audit record, or alerts at `partial`** — and a consent-store outage blocks ingestion
instead of allowing it.

### 5.3 Derived-fact retention (fixes the indefinite-profile problem)

Raw events expiring while derived facts persist forever would turn the brain into a
permanent inference profile. Instead:

- Every `brain_facts` row carries `derived_from_max_ts` (newest supporting event) and
  `last_confirmed_at`.
- **Decay:** a fact not re-supported by any event within **18 months** is deleted by the
  nightly job. Re-observation refreshes it.
- **Rebuildability:** facts are always recomputable from events + device lane; nothing is
  load-bearing only in `brain_facts`. This makes aggressive decay safe.
- Embeddings follow their source row: event vector dies with the event (12 mo), fact
  vector dies with the fact (18 mo decay), enforced via `brain_vectors` registration.
- `forget`/deletion contract override all of the above immediately.

---

## 6. The recall→model boundary (fixes the silent-exfiltration gap)

`brainRecall` merging lanes means a `device_private` snippet can be handed to a feature AI
that then calls a **cloud** model — content leaves the device transiently even though it
was never stored server-side. This is now explicit and governed:

- `brainRecall` results are tagged per-hit with their scope. Feature AIs cannot see an
  untagged blob.
- **Default path:** `device_private` hits may be included in a cloud `avaReason.reason`
  call **only** via our-keys routes configured with no-retention/no-training transport
  (provider zero-retention flags set; BYO-key third-party stores are out per B-D2).
  Snippets are request-scoped: never written to server logs, KV caches, or telemetry
  (telemetry records counts and token totals, not content).
- **User control ("local-only answers"):** a per-account toggle (registered in Settings
  from the same registry). When ON, `brainRecall` still searches the device lane, but
  `device_private` hits are stripped before any cloud model call; if the answer needs the
  private content, ChatAVA answers with a local-model/on-device summarization path or
  tells the user it can't without cloud reasoning. Local search always works regardless.
- **Consent key:** this sits under the `messages` consent domain plus the new
  `cloudReasoningOverPrivate` flag (declared in `config.ts` DEFAULTS per the fake-flag
  rule — interface + DEFAULTS in the same change, proven flippable).
- Which model receives snippets is a `policy.ts` decision, pinned to providers whose
  no-retention terms we've verified — not whatever a feature happens to call.
- **First-run disclosure (B-D6):** the first time a `device_private` snippet would be sent
  to a cloud model on an account, show a one-time informational notice with a direct link
  to the "local-only answers" toggle. Non-blocking; remembered per account (scoped key).

### 6.1 Enforcement requirements (not convention — proven)

- **Networkless `AvaLocalBrain` is proven, not promised.** The device-lane module lives in
  its own directory with a dependency boundary: an analyzer/lint rule forbids importing
  `dart:io` HTTP, `http`, `dio`, or any network-capable package from
  `app/lib/core/local_brain/` (allowlist: sqlite, path, crypto). CI adds a test that walks
  the module's transitive imports and fails on any network-capable dependency. A convention
  can rot; the lint + import-walker test cannot.
- **RagService removal is a checklist, not a deletion.** B3 includes an inventory step:
  grep/graphify every call site of `RagService`, Gemini File Search endpoints, and
  `file_search` API strings; each site is either deleted or explicitly migrated to
  `AvaLocalBrain`/`brainRecall` and ticked off in the B3 PR description. A lint ban on the
  File Search endpoint hostname/paths lands in the same PR so the second brain cannot
  quietly return behind an undocumented path.

---

## 7. v1 review findings → where resolved

| # | Finding | Resolution |
|---|---|---|
| 1 | Caller-supplied `scope` untrustworthy | §2.1 — scope derived from registry, server rejects `device_private` uploads, separate device-only API |
| 2 | "public" mislabels server data | §2.1 — `account_private` / `device_private` taxonomy |
| 3 | Recall→model boundary implicit | §6 — tagged hits, no-retention transport, "local-only answers" toggle, B-D6 |
| 4 | Purge lacks deletion semantics | §5.1–5.2 — stateful idempotent deletion job with audit proof |
| 5 | Derived facts = indefinite profile | §5.3 — 18-month decay, rebuildable facts, embeddings follow source |
| 6 | `avaReason` god-module risk | §4 — thin core + provider adapters, size tripwire |
| 7 | No versioning/delivery semantics | §3.2 — envelope version, idempotency, ordering, offline, account scoping, multi-device |

---

## 8. Phases (build order, with exit criteria)

### B0 — Stop the bleeding (own release, ships first)
- Consent checks fail **CLOSED** (`consumers/brain.ts:42,281`).
- `BRAIN_DOMAINS` registry + `brainIngest` v1 envelope (§3); migrate the three live
  producers (listings, wallet, media); delete the `source_app` fallback.
- Settings generated from registry (fixes the two dead toggles + mislabelled messaging
  toggle).
- Deletion contract job (§5.1) covering all current stores; `retro_delete` un-env-gated.
- `stt.ts` model allowlist. Real migration for `avachat_sessions`.
- **Exit:** §5.2.

### B1 — One gateway
- `ava_reason/` core + adapters (§4); verbs; migrate `marketplace.ts callSonnet`, then
  `util.ts geminiRun`, then `genui_planner.ts` Opus (+ KV cache), then the 17 `env.AI.run`
  sites; ESLint ban; unified telemetry; live-token session pairs.
- **Exit:** "what did AI cost last month, by feature" answerable from one table; 0 provider
  calls outside the gateway (lint-enforced).

### B2 — Wire the missing domains
- Contacts, call history, missed calls → one `brainIngest` call site each
  (`contacts_backup.ts`, `call_billing_routes.ts`/`do/call_room.ts`, `missedcall.ts`).
- **Exit:** 6+ of 10 domains live, all via the contract.

### B3 — Messages, metadata-only (B-D1 applied)
- `msg_meta` producer (peer, thread, ts, direction, topic label) — **never content**; the
  dark `brainEnabled` content path is **removed**, not flipped.
- Voicemail transcripts (`brain.ts:415-443`) under the `voicemail` domain.
- Device lane formalized: `AvaLocalBrain.ingest` for `msg_content` (§2.1), with the
  networkless dependency boundary + CI import-walker test (§6.1).
- Remove `RagService` (B-D2) via the §6.1 call-site checklist + File Search endpoint lint.
- **Exit:** "who did I talk to about the Bandra flat" answerable — topic from server
  metadata, content from device lane; no message body in any server store.

### B4 — One recall
- `brainRecall(uid, query, {domains?, k})` with scope-tagged hits (§6), incl. the
  "local-only answers" toggle and `cloudReasoningOverPrivate` flag.
- Nightly rollup writes `brain_daily_summaries` (or table + readers dropped together).
- Fact decay + embedding lifecycle jobs (§5.3). Stop writing `brain_relationships`.
- 12-month event roll-off (B-D4).
- **Exit:** ChatAVA, Copilot, briefing, receptionist all answer via `brainRecall`; direct
  call sites on the five old recall paths are gone.

---

## 10. AMENDMENT — Guardian — **DEFERRED (owner, 2026-07-18)**

> **SCOPE DECISION — owner, 2026-07-18. Do not build §10.** Marketplace chat is the
> priority. **Guardian does not expand into AvaBrain yet.** This section is the *design of
> record for a future Guardian/One Brain task* — it is analysis, not a work item, and B0
> ships without it.
>
> **Carved out and kept — the only Guardian work that proceeds now** (as a bounded
> dependency of the marketplace plan, not as brain work):
>
> 1. **P0-1 — `guardianScan` sender/member spoofing** (`ava_guardian.ts:1358-1362`). Live
>    in prod; three crafted calls auto-block an innocent user. → marketplace plan Phase 0.
> 2. **P0-2 — `isMinorAccount` fails open to adult** (`:194-195`). → Phase 0.
> 3. **Placeholder boundary only:** marketplace agents cannot reach Guardian **or** brain
>    safety memory. Lint + closed type, ~3 files, no Guardian changes. → marketplace plan
>    §1.2b-b.
> 4. **Connect stays behind Guardian readiness** and is **explicitly unscheduled**.
>
> **Deferred to the separate Guardian/One Brain task:** everything else in §10 —
> Sentinel/mem0 consolidation (**incl. B-D7**), the `safety` domain and `basis` field
> (§10.1), the deletion exemption (§10.2), the two-party store model (§10.3),
> `guardianContext()`, safety recall, the ranking boundary (§10.5), and broader Connect
> policy.
>
> **One note for whoever picks that task up, not a re-litigation:** B-D7 (§10.4) is two
> KV flags, not a build. While `sentinelEnabled` and `sentinelMem0Enabled` stay `true` in
> prod we are paying Nemotron **twice per watched message** (P1-5) to feed a system where 6
> of 7 rules have no producer, and the replay check *will* start paging — *"a matter of
> volume, not if"*. It is the cheapest item on the deferred list and the only one that
> costs money daily. Sequence it first there.

*(Design of record below — retained in full for the future task.)*

Source: `Specs/GUARDIAN-SYSTEM-REPORT-2026-07-18.md` (prod-read, not DEFAULTS-read) + a
design proposal. **The proposal's shape is adopted.** Guardian would be a **governed safety
consumer and producer**: it reads narrow context, reasons via `avaReason({role:"guardian"})`
(already true, `moderation.ts:274`), and writes **minimal structured events** — never raw
content — into a restricted store that general `brainRecall` cannot see.

Adopted as proposed, no changes: no raw chat into the brain (B-D1 consistent); minimal
derived record only (category/severity, subject+counterparty ids, ts, action, model+version,
appeal state); a purpose-specific `guardianContext({subjectUid, conversationId, purpose})`
instead of `brainRecall`; Guardian results must not become general context for every Ava
feature; safety labels treated as sensitive even though derived (provenance, model version,
human review for serious enforcement, appeal/correction).

**Three corrections. Two of them matter a great deal.**

### 10.1 Safety is not consent — the registry needs `basis`

The proposal suggests `safety: { consent:'safety', default:'system_required' }`. **If it
can't be turned off, it isn't consent** — and Settings is *generated from the registry*
(§3), so `system_required` renders as **a toggle the user cannot move**. That is the
"consent UI that lies" failure (draft §1.5 defect 1) re-created in inverted form: a control
that appears to exist and doesn't.

The lawful basis for safety processing is **legitimate interest / legal obligation**, not
consent. So the registry gains a field, and Settings renders on it:

```ts
BRAIN_DOMAINS = {
  listings: { basis:'consent', consent:'listings', default:true,  scope:'account_private' },
  safety:   { basis:'legal',   consent:null,       deletable:false, acl:'guardian',
              scope:'account_private', retention:'§10.2' },
}
```

`basis:'consent'` → a toggle. `basis:'legal'` → **a disclosure, not a toggle** — visible in
Settings, plainly explained, no switch. Honest, and it makes B0's generated-Settings
guarantee stronger rather than weaker.

### 10.2 Safety data must NOT follow the deletion contract — this is the important one

The proposal ends with: *"follows the same deletion, retention, audit, and rebuildability
contracts as every other Brain store."* **Audit and retention yes. Deletion no — and this
would be a serious mistake to ship.**

§5.1's deletion contract is user-initiated and complete by design. Apply it to safety data
and **"delete my AvaBrain data" erases your own grooming flags.** A user accumulates two of
the three sev-2 flags that trigger `blockSender` (`ava_guardian.ts:1042-1059`), taps delete,
and the counter resets. **The deletion contract becomes a reputation-laundering tool, and
the more dangerous the user, the more motivated they are to use it.**

This isn't a new position for us — **we already decided it, twice, without noticing:**

- **M-D11** (marketplace plan, resolved yesterday): Connect's gate is *"liveness + face-dedup
  **against a ban list**"*. A ban list only works if the banned person cannot delete
  themselves from it. We committed to non-deletable safety state when we chose face-dedup
  over OTP.
- `blockSender` already writes the `blocks` table, and nobody thinks a blocked user should
  be able to DELETE their way out.

GDPR anticipates this exactly — Art. 17(3)(b)/(e) permit refusing erasure where processing
is necessary for a legal obligation or the establishment/defence of legal claims. Every
platform runs this way: **you may delete your account; you may not delete your ban record.**

So:

- `safety` is **`deletable:false`** with a documented lawful basis, and the §5.1 deletion job
  **skips it by design** — recorded in the completion audit as *"safety records retained
  under legitimate interest"* rather than silently omitted. §5.1 already insists deletion
  never silently half-completes; this is the honest version of the same rule.
- It gets its **own retention clock**, not §5.3's fact decay: flags 12 months, enforcement
  actions (blocks, bans, ban-list face hashes) longer, defined with legal.
- **Not rebuildable** — unlike §5.3's facts, safety events cannot be recomputed from raw
  events, because we deliberately never stored the raw content. That's correct, and it is
  the reason retention has to be explicit rather than inherited.

### 10.3 Safety is two-party — so it is not a per-user brain domain

The proposal scopes `safety` as `account_private`. But a flag is inherently **about a sender,
raised in a conversation with a recipient** — Sentinel's subject is the *sender*
(report §3.8). Whose brain holds it? The sender's, and they delete it (§10.2). The
recipient's, and the sender's reputation is unaffected by their own conduct.

**Neither. It is not per-user memory at all** — it's a platform safety record that happens to
reference users. Concretely: same governance plane (one ingest contract, one audit, one
retention policy, `brainIngest`-shaped envelope with §3.2 idempotency), **separate store**,
`acl:'guardian'`, no `brainRecall` path. "One Brain" holds — one governance plane, one
contract — while being honest that **safety ≠ memory**. Collapsing them is what creates both
the deletion hole and the leak risk.

**ACL by module boundary, not convention** — the pattern §6.1 already establishes for
`AvaLocalBrain` (*"a convention can rot; the lint + import-walker test cannot"*) and the
marketplace plan's agent runtime: `guardianContext` is importable only from `lib/guardian/`,
lint-enforced; `safety` is unreachable from ChatAVA, Copilot, marketplace compose, and
Connect.

### 10.4 Prerequisites — three of these are live in prod right now

The report's headline: **four Guardian subsystems the code calls "dark" are ON in prod** —
`sentinelEnabled`, `sentinelMem0Enabled`, `guardianInlineEnabled`, `guardianGateEnabled` are
all `true` in KV while `DEFAULTS` says `false`. Consequences for this amendment:

1. **P0-1 blocks Guardian-as-producer, not just Connect.** `guardianScan` trusts
   caller-supplied `members`/`sender` (`ava_guardian.ts:1358-1362`) — three crafted calls
   auto-block an innocent user and poison their Sentinel score, **today, in prod**. Making
   Guardian a brain producer while that hole is open means the spoof writes into the safety
   store too. **Fix before wiring, not before Connect.**
2. **P0-2 `isMinorAccount` fails open to adult** (`:194-195`). One Brain B0's whole thesis is
   consent fails *closed*; the same argument applies with more force to child protection. If
   B0 is flipping fail-open→fail-closed across the consent path, this belongs in the same PR.
3. **mem0 is RagService again.** B-D2 cut `RagService` as *"a second, unaudited brain."* mem0
   is the same pattern with a worse payload: `sentinelMem0Enabled=true` in prod is shipping
   **our behavioural inferences about users** to a third-party store whose purge drops after
   8 attempts leaving a telemetry breadcrumb, drained only opportunistically, **with no cron**
   (`purge.ts:98-104`, `summariser.ts:219`). RagService at least held the user's own files
   under the user's own key. Consistency says: **cut it, or bring it under §5.1.**

> **RECOMMENDATION (B-D7).** Set **`sentinelEnabled=false` and `sentinelMem0Enabled=false`
> in prod now**, ahead of B0. Rationale, from the report itself: 6 of 7 Sentinel rules have
> no producer; `SentinelDO` is orphaned; the replay-mismatch bug (`fold.ts:100-104`) *will*
> start emitting "page immediately" alerts once consolidation triggers — *"a matter of
> volume, not if"*; and the mem0 purge path has no guaranteed sweep. We are currently paying
> Nemotron **twice per watched message** (P1-5) to feed a half-built reputation system into
> an ungoverned third-party store. Turning two flags off stops that today and costs nothing —
> Guardian's actual protection (scan, flag, warn, block, parent alert) does not depend on
> either flag. Then finish Sentinel *inside* the governance plane rather than beside it.

### 10.5 Two boundaries this amendment adds

- **Safety must never feed ranking or matching.** Sentinel already has a **`marketplace_trust`
  bucket** and SEN-004 (`listing_moderation_fail` → −6). It currently feeds nothing, because
  SentinelDO is orphaned — which makes now the moment to say it: **a trust score must not
  affect listing visibility, search order, or dating recommendations.** A reputation system
  that silently changes who sees you, with no notice and no appeal, is a shadow-ban system.
  If we ever want that, it's a decision with an appeals process attached, not a side-effect
  of wiring up an orphaned DO.
- **M-D17 extends to Guardian** (marketplace plan §2.1b-i): Guardian must not infer, store,
  search on, or use **orientation or neurodivergence** for trust scoring, moderation
  weighting, or ranking. One concrete risk worth measuring rather than asserting: safety
  classifiers are known to over-flag LGBTQ+ content as "sexual." Guardian on a dating
  vertical could therefore flag gay users at a higher rate for identical behaviour. That is
  **testable** — flag-rate parity across the `orientation` field, as a CI fixture — and it
  should be tested before Connect ships, not after someone notices.

### 10.6 Amendment summary

> **Guardian is a governed safety consumer and producer.** It may inspect content transiently
> and ingest minimal structured safety events into a **restricted, ACL'd safety store** —
> reachable only via `guardianContext()` from `lib/guardian/`, never via `brainRecall`.
> Safety records are governed by **legitimate interest, not consent** (`basis:'legal'` —
> disclosed, not toggleable), are **not deletable by their subject** (§10.2), carry their own
> retention clock, and are **never used to infer protected traits or to rank anything**.
> Same governance plane; not the same store. **Safety ≠ memory.**

New decisions: **B-D7** (turn Sentinel + mem0 off now — recommended), **B-D8** (cut mem0 or
govern it), **B-D9** (retention periods for flags vs enforcement actions — needs legal).

---

## 9. Out of scope / explicitly rejected

- A standalone "AvaBrain assistant" or dedicated AvaBrain model — rejected (§1).
- Flipping `brainEnabled` for server-side message content — rejected; path removed in B3.
- Proxying Gemini Live client-side inference through the gateway — impossible by design;
  attribution-only telemetry instead.
- Cross-device sync of `device_private` indexes — out for v1 (§3.2).
- Dating/matrimony domains — no routes exist; wire via registry when the product exists.
