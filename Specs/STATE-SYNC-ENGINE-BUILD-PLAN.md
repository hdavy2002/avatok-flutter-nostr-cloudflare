# State Sync Engine — Build Plan (multi-device sync)

**Status: IMPLEMENTATION PLAN (not a new architecture).** This is the concrete build
plan that instantiates **Part XV (Implementation Roadmap)** of the frozen
`STATE-PLATFORM-ARCHITECTURE.md`. It does not introduce any new architecture — it
turns the frozen State Platform into buildable phases. Governed by
`ENGINEERING-CONSTITUTION.md`. Grounded in the as-built system
(`CURRENT-SYNC-SYSTEM-REPORT-2026-07-05.md`) and the v5 design
(`STATE-SYNC-ENGINE-PROPOSAL.md`), both of which this plan supersedes for *sequencing*.

---

## 0. The goal, in one sentence

**A user signs in on any device — a second phone, a reinstall, a desktop — and every
conversation, setting, and file comes back correctly, stays in sync while multiple
devices are active, and never depends on another device to do it.**

---

## 1. What already works (do NOT rebuild)

The two hardest things are already right, so this is a *unification*, not a rebuild:

- **Server-durable messages.** Every user has a per-user InboxDO
  (`worker/src/do/inbox.ts`); messages are appended per member and kept forever by
  default. This is the authoritative log.
- **Recovery by sign-in.** Restore is "just sign in with Clerk"
  (`app/lib/core/account_restore.dart`) — no password, no recovery key. Keys (`aek`,
  backup `bk`) are escrowed server-side and pulled back automatically.
- **A working client sync loop.** `app/lib/sync/sync_hub.dart` holds one WebSocket to
  the InboxDO, ingests backlog, then streams live.

Keep all of it. We are changing *how positions are tracked*, not the transport.

---

## 2. The one root problem

Everything users experience as "sync is flaky" traces to a single cause:

> **There is no unified, per-conversation, per-device cursor.** Messages use one
> **global** cursor (`ava_inbox_cursor` = highest InboxDO id). The vault and the
> Drive/R2 snapshot are two more uncoordinated planes. Two active devices, partial
> catch-up, and "messages arrived but contacts didn't" all fall out of this.

The fix, straight from the frozen State Platform: **one cursor model —
`(stream, sequence)` per stream, tracked per device.** The snapshot becomes a speed-up,
never a source of truth.

---

## 3. Target model (from the frozen State Platform)

- **Everything is an operation** on a **stream** owned by one **aggregate root**.
- **Per-stream sequence** (each stream counts its own operations; no global counter).
- **Idempotency = `(stream, actor, client_op_id)`** — the one dedup formula everywhere.
- **Per-device cursor** — each device remembers its own position *per stream*.
- **Five stream owners:** Conversation, User State, Media, Vault, Device.
- **Snapshots are accelerators**; the truth is always the operation log.
- **Recovery is one defined sequence:** sign in → identity → streams → operations →
  projection → verify → ready.

---

## 4. Build phases

Each phase ships behind its own kill-switch flag (KV + `config.ts`), emits telemetry
with the test user's email, and is independently reversible. **Builds are
manual-only** — no phase triggers CI.

### Phase 0 — Operation & cursor primitives *(foundation, no behaviour change)*
- Define the `Op` shape and the per-stream `next_seq` allocator on top of the existing
  InboxDO log. Formalise idempotency as `(stream, actor, client_op_id)`.
- Server: `worker/src/do/inbox.ts` — stamp each appended row with a per-conversation
  `server_sequence` alongside the existing global id (dual-write; nothing reads it yet).
- Flag: `syncOpsV2` (off). **Done when:** every new message row carries a correct
  per-conversation sequence, verified by a read query. Telemetry: `op_appended`.

### Phase 1 — Conversation Sync (per-conversation cursors) *(the core of device sync)*
- Replace the global `ava_inbox_cursor` with **per-conversation cursors** on the
  client; add `GET /sync?conv=<id>&after=<seq>` paged catch-up on the server.
- Client: `app/lib/sync/sync_hub.dart` — track a cursor map `{conv_id: seq}`, persist
  per account (scoped storage), request catch-up per conversation.
- Remove the need for `/api/conversations/adopt`: a device **lists its conversations
  by identity** and syncs each. (Deprecation notice, not deletion, until verified.)
- Flag: `convCursorV2`. **Done when:** a fresh install pulls each conversation
  independently and a reinstall re-syncs with no full-backlog re-download. Telemetry:
  `conv_catchup_started/completed`, `conv_cursor_advanced`.

### Phase 2 — User State Sync (settings that follow you)
- Model mute / pin / archive / folders / prefs / read-state as tiny **versioned
  documents** with field-level last-writer-wins on `user:*` and `chat:*` streams.
- Uniform verbs: `changes / apply / ack`. This is what makes settings identical on
  both phones.
- Flag: `userStateSyncV2`. **Done when:** muting a chat on phone A shows muted on
  phone B within seconds. Telemetry: `userstate_applied`, `userstate_conflict_lww`.

### Phase 3 — Device Sync (multi-device becomes first-class)
- **Per-device cursors, capabilities, push token, and "which devices are active"** as
  Device stream state. A message sent from the desktop is an op your phone catches via
  its own cursor — sent and received are the same operation seen from two cursors.
- Presence/Delivery choose which device(s) to ring; Sync guarantees each can reach the
  latest `seq` independently.
- Flag: `deviceSyncV2`. **Done when:** two phones + one desktop stay consistent live,
  each with its own position, none syncing from another. Telemetry:
  `device_registered`, `device_cursor_advanced`, `device_fanin`.

### Phase 4 — Snapshots + Recovery (demote the backup)
- Turn the Drive/R2 SQLite+media backup into a **SNAPSHOT accelerator only**: on a new
  device, load the snapshot to get instant state, then replay operations *after* the
  snapshot's sequence to become current. Wire `RESET` and `VERIFY`. Fold the `aek`/`bk`
  escrow in as the Vault lane, unchanged.
- Unify the new-phone path into the single recovery sequence (§3).
- Flag: `snapshotAcceleratorV2`. **Done when:** the catastrophic-failure test passes —
  wipe a device, sign in, everything returns; and with a snapshot present it returns
  *fast*. Telemetry: `snapshot_created`, `snapshot_loaded`, `recovery_duration`,
  `verification_failed`.

### Phase 5 — Generalise (other products ride the same rails)
- Bring Wallet, Trust, Marketplace, Notifications, Search onto the same stream +
  cursor contract. Finalise Media Sync's lazy-original policy (media never on the login
  path). Complete the telemetry mapping.
- Flag: per-owner. **Done when:** a new product needs zero new sync code — it declares
  a stream and inherits everything.

---

## 5. The proof (multi-device acceptance test)

Sync is "done" for users when this passes end-to-end:

1. Sign in on **Phone A**, send/receive in 3 conversations, mute one, pin one.
2. Sign in on **Phone B** (same account). Within seconds: all 3 conversations,
   correct history, the mute and the pin are all present.
3. With both live, send from A → appears on B; send from B → appears on A; mute on B →
   reflected on A. Neither device fetched from the other.
4. Wipe Phone A completely, reinstall, sign in. Everything returns; with a snapshot it
   returns fast; `verify` reports a matching checksum.

---

## 6. Risks & sharp edges (already known)

- **Secure-storage fragility** — `flutter_secure_storage` has thrown `BAD_DECRYPT`
  after OS updates. Boot self-heal + Android backup exclusion already landed; escrow
  covers data loss, but keep it on the recovery-path watchlist.
- **Sequence allocation under concurrent fan-out** — the conversation's DO is the
  natural serialization point; make it the single allocator.
- **Stream granularity for User State** — one `user:preferences` doc vs. many
  fine-grained docs (merge simplicity vs. write amplification). Decide at Phase 2.
- **Snapshot cadence** — sequence-interval vs. time-interval checkpoints; per-stream
  vs. whole-device. Decide at Phase 4.

---

## 7. What to build first

**Phases 0 → 1 → 3 are the spine of "sync my devices."** If the goal is to make
multi-device work as fast as possible: do Phase 0 (primitives), Phase 1
(per-conversation cursors), then jump to Phase 3 (per-device cursors), and bring
Phase 2 (settings) and Phase 4 (fast recovery) right after. Phase 5 is later reuse.

Every step is reversible behind its flag, so we can ship one phase, watch the
telemetry for `hdavy2005@gmail.com`, and only then move to the next.
