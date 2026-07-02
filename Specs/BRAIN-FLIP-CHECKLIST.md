# AvaBrain flip checklist — owner privacy sign-off

**Flag:** `brainEnabled` (config.ts `DEFAULTS`, currently `false`) · **Decision owner:** davy.
**The AI does not flip this** — read this, verify, then flip it yourself in KV `platform_config`.

AvaBrain lets ChatAva answer from the user's own chats and files ("what did <contact> and I
agree about X last week?"). This document states exactly what changes when you flip it, so the
privacy trade-off is explicit before any user data is ingested.

## What STARTS being ingested when `brainEnabled: true`

Ingestion is currently gated at the **producer** by `brainEnabled` (e.g. `messaging.ts:310` skips
enqueuing to `Q_BRAIN` while the flag is off), so today **nothing is ingested**. When flipped ON:

- **Peer messages** (text; voice notes get Whisper-transcribed) are enqueued to `Q_BRAIN` for the
  sender and each in-window recipient, embedded (gemini-embedding-2), and stored in **Vectorize**
  with a `uid` metadata tag.
- **`brainFact(...)` writers** already sprinkled through routes (profile updates, identity events,
  listing events, etc.) become live memory facts.
- **Files / AvaLibrary, call summaries, receptionist messages** — ingestion plumbing for these was
  **not fully traced** in the Phase 7 audit. Confirm which are wired before relying on them; treat
  unlisted sources as "not ingested yet."

## What STAYS on-device (never uploaded), regardless of the flag

- **E2E / private media** is read by the **on-device RAG path only** (`ondevice_rag_*`) — decrypted
  bytes never leave the device. The server never sees them.
- Per the rulebook, private/E2E content is on-device-only even when guardrails are ON.

## The one non-negotiable security invariant (already verified in code)

Retrieval is uid-scoped by a **HARD filter**: `ava_memory.ts` queries Vectorize with
`filter: { uid }` ("never optional", ~lines 72–74). **A user can never retrieve another user's
vectors** — cross-tenant retrieval is impossible by construction. This holds today (verified in the
Phase 7 audit, commit `55dc631`).

## How a user turns it off (must exist before flip — currently DEFERRED)

The **guardrail-toggle UI is not built yet** (Phase 7 deferred item): a master AvaBrain switch +
per-app toggles (messaging / library / marketplace / receptionist), defaults ON, scoped storage,
synced to a server prefs row the ingestion pipeline consults. **Do not flip `brainEnabled` until
this exists**, or users have no opt-out. (Follow-up F7 step 1.)

## Verification steps before you flip (do these in staging)

1. Confirm the guardrail-toggle UI ships and writes a server prefs row.
2. Flip `brainEnabled: true` in **staging** KV only.
3. Send a test message from account A. Confirm a vector appears **for A's uid only** (check the
   `ava_memory_context` / ingestion telemetry; confirm no vector is retrievable by account B).
4. In ChatAva as A, ask "what did I say about <topic>" → confirm a **sourced** answer.
5. Toggle the messaging guardrail **OFF** for A → send another message → confirm **no new vector**
   is ingested (ingestion telemetry shows the skip).
6. Confirm E2E/private media never produced a server-side vector (on-device path only).
7. Only after 1–6 pass in staging and you accept the privacy posture: flip `brainEnabled: true` in
   **prod** KV. It is reversible — flip back to `false` to stop all new ingestion.

## Reversibility

Flipping back to `false` stops new ingestion immediately (producer-gated). Existing vectors remain
queryable unless separately purged; the GDPR delete cascade (`/purge`) already wipes a user's DO
storage and should be confirmed to also clear their Vectorize namespace if you need full erasure.
