# Ava In-Chat — Master Build Plan (multi-agent)

**Read this first. Every agent reads this file before touching code.**
Source of truth for *what* to build: `Specs/AVA-IN-CHAT-AI-PROPOSAL.md`.
This file is the *how/who/when* — how the work is split across agents so they
never clash, and the rule that **nobody commits or pushes until the final phase.**

Status: PLAN — 2026-06-17. Owner: davy.

---

## 0. The three hard rules (non-negotiable)

1. **DO NOT commit. DO NOT push. DO NOT run `git add/commit/push`, branch, or
   stash.** Just edit/create files in the working tree and stop. Only **Phase 11**
   (Integration & Release) makes the single commit + push.
2. **Stay inside your phase's `OWNED FILES`.** Never edit a file owned by another
   phase. If you think you need to, you don't — use the contract/registry that
   Phase 0 created, or add a note in `Specs/ava-build/INTEGRATION-NOTES.md`
   (append-only) for Phase 11 to resolve.
3. **Do not run `flutter build`/`flutter analyze` expecting green mid-stream.**
   The tree is intentionally incomplete until all phases land; APK/Worker builds
   run in CI and are validated in Phase 11. (No local Flutter toolchain — see
   project memory.)

---

## 1. How we avoid clashes (the model)

The whole plan hinges on one idea: **Phase 0 owns every shared/"hot" file and
turns each into a registry or a stable contract. Every later phase only creates
NEW files in its own directory and registers itself.** No two phases edit the
same file.

**Hot files — owned exclusively by Phase 0, frozen afterward:**

| File | What Phase 0 makes it |
|---|---|
| `app/lib/core/feature_flags.dart` | adds ALL new flags up front |
| `app/pubspec.yaml` | adds ALL new client deps up front |
| `worker/wrangler.toml` | adds ALL new bindings (DOs, R2, queues, vars) |
| `worker/src/api.ts` | registers ALL new routes (→ handlers phases will fill) |
| `worker/src/routes/config.ts` | adds ALL new kill-switches/flags |
| `worker/src/do/inbox.ts` | adds the message-kind + **visibility scope** contract |
| `app/lib/core/app_registry.dart` | adds focus-mode helper + any new app entries |
| `app/lib/features/settings/settings_screen.dart` | refactored to render a **SettingsSectionRegistry** |
| `app/lib/features/avatok/chat_thread.dart` | renders `ava`/`ava_private`/`ava_status` kinds generically + a "working" chip slot |
| `app/lib/main.dart` | calls a single `AvaBootstrap.init()` hook |

After Phase 0, those files are **read-only for everyone**. Feature phases plug in
through the registries/contracts Phase 0 exposes:

- **SettingsSectionRegistry** — a feature adds a settings section by registering a
  `SettingsSection` from its own file; `settings_screen.dart` renders the list.
- **AvaMessageKind contract** — `ava`, `ava_private` (to:<uid>), `ava_status`
  ("working…") are rendered generically by `chat_thread.dart`, so any phase that
  *posts* one of these (image, guardian, companion) needs **no** chat-UI edits.
- **InboxDO visibility scope** — `append({..., scope: 'thread' | 'to:<uid>'})`
  enforced in the DO; private messages never reach other participants.
- **Route registration** — Phase 0 wires `api.ts` to handler names; each phase
  creates the handler file with that exact exported name.
- **ToolRegistry / AvaBootstrap.init()** — central init + tool registration.

**Directory ownership (new dirs — fully disjoint):**

| Dir / file | Owner phase |
|---|---|
| `app/lib/features/ava/` | P3 (spine UI) |
| `app/lib/core/ava_memory/` | P4 |
| `app/lib/core/ava_tools/` + `app/lib/features/ava_tools/` | P5 |
| `app/lib/features/ava_companion/` + `chat_list` new-chat entry point | P6 |
| `app/lib/features/ava_guardian/` | P8 |
| `app/lib/features/ava_generative/` | P9 |
| `app/lib/features/ava_ai/` | already built (P2 only adds worker side) |
| `worker/src/routes/ava_gemini.ts`, `worker/src/lib/ai_gate.ts` | P2 |
| `worker/src/routes/ava_thread.ts`, `worker/src/do/ava_agent.ts` | P3 |
| `worker/src/routes/ava_tools.ts` | P5 |
| `worker/src/routes/ava_guardian.ts` | P8 |
| `worker/src/routes/ava_image.ts` | P9 |
| `worker/src/routes/backup.ts`, `worker/src/do/backup.ts` | P10 |
| `app/lib/features/settings/sections/*` | each feature owns its own section file |

If two phases both need a settings toggle, each writes **its own** file under
`settings/sections/` and registers it — they never share a file.

---

## 2. Wave schedule (dependencies)

```
Wave 1  ── P0  Foundations & Contracts                (SOLO, blocks everything)
Wave 2  ── P1  Menu focus mode + paid gating UI
        ── P2  BYO-AI worker proxy + moderation gate
        ── P3  In-thread Ava spine                     (blocks P6–P9)
        ── P4  Two-lane memory
        ── P5  Tool layer (Strata + broker)
        ── P10 Backup & sync
Wave 3  ── P6  Companion / blank Ava chat + voice      (needs P3)
        ── P7  Delegate: monitor + auto-reply + push   (needs P3, P2)
        ── P8  Guardian                                (needs P3, P2)
        ── P9  Generative image gen                    (needs P3)
Wave 4  ── P11 Integration, Verification & Single Commit/Push  (SOLO, last)
```

Within a wave, phases run **in parallel** safely because their `OWNED FILES`
are disjoint. A later wave starts only when its dependencies report done.

---

## 3. Phase index

| # | Phase | Depends on | New surface |
|---|---|---|---|
| 0 | Foundations & Contracts | — | registries, flags, contracts, deps, bindings |
| 1 | Menu Focus Mode + Paid gating UI | P0 | hide non-AvaTok apps; `PaidFeature` + PAID badges |
| 2 | BYO-AI worker proxy + gate | P0 | `/api/ava/gemini` proxy, llama-guard gate, daily cap |
| 3 | In-thread Ava spine | P0 | `ava`/`ava_private`/`ava_status`, agent loop, `@ava` 1:1 |
| 4 | Two-lane memory | P0 | on-device FTS5+ZVEC+embedder, server Vectorize, `brain.search` |
| 5 | Tool layer | P0 | Strata self-host, tool broker, core tools, MCP connect UI |
| 6 | Companion / blank Ava chat | P0,P3 | new Ava chat, personas, ElevenLabs voice toggle |
| 7 | Delegate | P0,P2,P3 | group monitor gate, `@mention` auto-reply (disclosed), push |
| 8 | Guardian | P0,P2,P3 | live classifier, private warnings, deepfake check, parent digest |
| 9 | Generative | P0,P3 | Nano Banana 2 image gen, async present-in-thread |
| 10 | Backup & sync | P0 | R2 premium sync, Google Drive free backup |
| 11 | Integration, Verify & Commit | ALL | reconcile, build/test, ONE commit + push, Graphiti episode |

Per-phase briefs: `Specs/ava-build/PHASE-0N-*.md`. Each brief is self-contained
(goal, owned files, do-not-touch, tasks, acceptance) and repeats the no-git rule.

---

## 4. Contracts Phase 0 must publish (so others can code in parallel)

- **AvaMessageKind**: `ava`, `ava_private`, `ava_status` + JSON body shapes.
- **InboxDO.append scope**: `'thread'` (default) | `'to:<uid>'` (private).
- **AvaApi routes** (registered in `api.ts`, handlers filled by owners):
  `POST /api/ava/gemini` (P2), `POST /api/ava/thread/turn` (P3),
  `GET/POST /api/ava/tools/*` (P5 — ⚠️ REMOVED 2026-06-22, Strata purged; apps run via Composio),
  `POST /api/ava/guardian/scan` (P8),
  `POST /api/ava/image` (P9), `*/api/backup/*` (P10).
- **SettingsSection** + `SettingsSectionRegistry.register(...)`.
- **AvaTool** interface + `ToolRegistry.register(...)` (core tools only; Strata/MCP removed 2026-06-22).
- **AvaFlags**: `focusMode`, `aiEnabled`, `webSearchEnabled`, `fileAnalysisEnabled`,
  `openChatUncapped`, `dailyAvaTurnLimit`, `guardianEnabled`, `conferenceEnabled`
  (exists), `companionEnabled`, `generativeEnabled`.
- **PaidFeature** widget + `Wallet.canSpend()/spend()` hook + `kMinTopUpUsd = 5`.
- **AvaBootstrap.init()** called once from `main.dart`.
- **Memory/Vector interface** (`AvaMemory`) + **embedder download** hook (P4 fills).

If a contract is missing or ambiguous, the blocked phase appends a question to
`Specs/ava-build/INTEGRATION-NOTES.md` and proceeds against a local stub.

---

## 5. Definition of done (per phase)

- All `OWNED FILES` created/edited; nothing outside them touched.
- Self-review against the brief's **Acceptance** list.
- A short entry appended to `Specs/ava-build/INTEGRATION-NOTES.md`:
  `Phase N done — files: …; stubs/assumptions: …; needs from integration: …`.
- **No git operations.** Leave the tree dirty for Phase 11.

---

## 6. Phase 11 (the only release step)

Phase 11 runs solo after all others: reads `INTEGRATION-NOTES.md`, reconciles any
cross-phase wiring, ensures route handlers + registries all line up, runs the
build/analyze (or pushes a branch for CI as configured), fixes integration-only
breakage, then makes **one** descriptive commit and **one** push — followed by a
detailed Graphiti episode under `proj_avaflutterapp` (per the project's
autolog-on-push rule). No feature work happens in Phase 11.
