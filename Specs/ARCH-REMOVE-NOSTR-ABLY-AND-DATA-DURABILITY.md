# AvaTOK — Remove Nostr + Ably, and Make User Data Durable at Scale

> Status: SPEC for build. Author decisions captured 2026-07-01 (hdavy2005@gmail.com).
> Goal: a clean, Clerk-`uid`-native architecture with **no Nostr and no Ably (no dead
> code)**, where **user data survives reinstall / new-phone for millions of users**, and
> every fix reaches phones through a **normal app update — never a manual reinstall**.

---

## 0. Why this exists (the two problems, one root)

1. **Data loss on reinstall.** The identity key is a **random Nostr private key** created by
   `NostrKeys.generatePrivateKey()` (`app/lib/identity/identity.dart`), stored only in the
   phone's secure storage, and **never backed up**. The contact list (and any vault data) is
   encrypted with a key *derived from that private key* (`Vault._key` = SHA256 of `privHex`,
   `app/lib/core/vault.dart`). Reinstall wipes secure storage → `AccountRestore._install`
   mints a **new random key** (`app/lib/core/account_restore.dart`) → the old contacts blob
   on the server can no longer be decrypted. Chats survive because they live in the InboxDO
   keyed by Clerk `uid`; the encrypted vault does not.

2. **Nostr + Ably are half-retired but still wired in.** Ably was replaced by PartyKit
   (`PARTY-4/5/6` commits); the Nostr key is called "vestigial" in code but is still the
   **routing address, contact id, avatar seed, and vault encryption key**.

**Root cause is shared:** identity/encryption is pegged to a device-only Nostr key. Fixing
durability and removing Nostr are the **same migration** — move identity, addressing, and
encryption onto the Clerk `uid` + an account-escrowed key. Ably removal is independent and
small (dead-code deletion).

**Measured footprint (2026-07-01):**
- Nostr: **546 references across 55 app files + 34 worker files** (`npub`/`nsec`/`NostrKeys`).
  `npub` is used as address, contact id, avatar seed, and key source. This is a *replacement*,
  not a delete.
- Ably: a handful of real files (transport + token route + dependency). Already superseded by
  PartyKit. This is a *delete*.

---

## 1. Principles (target state)

- **The account is the backup; the phone is disposable.** Every restore-critical datum lives
  server-side, keyed by Clerk `uid`. Any device that signs in rebuilds itself.
- **One identity: the Clerk `uid`.** No `npub`, no `nsec`, no Nostr keys as identity.
- **One realtime transport: PartyKit** (ephemeral) + **InboxDO** (durable). No Ably.
- **Encryption key is recoverable from the account**, not random-per-device.
- **Ship via normal store updates + forced-update switch + self-heal on launch.** Never ask a
  user to uninstall/reinstall.
- **No dead code.** When a subsystem is replaced, its files, deps, routes, and bindings are
  deleted in the same PR.

---

## 2. Target architecture (what stores what)

| Data | Today | Target | Survives reinstall? |
|------|-------|--------|---------------------|
| Identity | random Nostr key, device-only | Clerk `uid` (+ escrowed encryption key) | ✅ (was ❌) |
| Chats / call log | InboxDO by `uid` | unchanged | ✅ already |
| Profile (name/email/avatar/number) | server (`/api/me`, directory) | unchanged | ✅ already |
| Media | R2, content-addressed | unchanged | ✅ already |
| **Contacts** | encrypted vault (npub key) | **server-side by `uid`** + escrowed-key backup | ✅ (was ❌) |
| **Prefs/settings/apps** | vault (`PrefsSync`) | same treatment as contacts | ✅ (was partial) |
| Realtime (presence/typing/receipts/reactions) | PartyKit (live) + dead Ably | PartyKit only | n/a |

---

## PART A — Remove Ably (small, safe, do first)

Ably is already dark (PartyKit is the live transport). This PR is pure deletion.

### A.1 App (`app/lib`)
- Delete `sync/transport/ably_transport.dart`.
- In `sync/transport/ava_transport.dart`: remove the Ably branch of the transport selector
  (`useAblyTransport()`), leaving PartyKit/InboxDO as the only path. Delete the selector if it
  now has one branch.
- `sync/sync_hub.dart`: remove the `_ably` field and every `_ably?.…` call and the
  `resubscribeKnown()` Ably re-subscribe; presence/reactions already ride PartyKit
  (`sync/party/party_hub.dart`, `sync/presence.dart`).
- `push/push_service.dart`, `features/avatok/chat_thread.dart`, `features/profile/*`,
  `core/config.dart`, `core/feature_flags.dart`, `core/remote_config.dart`: strip any
  `ably`/`messagingProvider == 'ably'` reads. (Note: many `[Aa]bly` hits are false positives
  inside "probably/notably" — verify before editing.)
- `pubspec.yaml`: remove `ably_flutter: ^1.2.39`. Run `flutter pub get`.
- Remove the global-error markers that swallow `AblyException` in `main.dart` once no Ably code
  can throw (the marker becomes dead).

### A.2 Worker (`worker/src`)
- Delete `routes/ably.ts` and the `/api/ably/token` route registration in `index.ts`.
- Remove `MSG_TRANSPORT == 'ably'` / `messagingProvider` from `routes/config.ts` (`getConfig`);
  keep `partyEnabled`.
- Strip Ably references in `routes/messaging.ts`, `routes/push.ts`, `routes/archive.ts`,
  `routes/marketplace.ts`, `do/party.ts`, `do/reception_room.ts`, `types.ts`, `lib/composio.ts`.
- Remove Ably secrets from the deploy (`ABLY_*` via `wrangler secret delete`) once unreferenced.

### A.3 Acceptance
- App builds with `ably_flutter` gone; grep for `[Aa]bly` returns only false-positive words.
- Presence/typing/receipts/reactions still work over PartyKit (manual + PostHog check).
- The Ably presence-exception noise disappears from PostHog `$exception`.

**Risk:** low (dead path). **Rollback:** revert the PR; PartyKit is unaffected.

---

## PART B — Remove Nostr / migrate identity to Clerk `uid`

`npub` currently plays four roles. Replace each:

1. **Routing address** (who a message/call targets). Already `uid` server-side (InboxDO by
   `uid`); the client still converts via `NostrKeys.npubToHex`. → Address everything by `uid`.
2. **Contact id** (`Contact.npub`). → `Contact.uid` (the Clerk uid). Keep JSON back-compat by
   reading `npub` as a fallback during migration, then drop it.
3. **Avatar seed** (deterministic color/initials). → seed on `uid` (pure cosmetic; a shim keeps
   old and new avatars stable during migration if desired).
4. **Vault encryption key** (`Vault._key(privHex)`). → account-escrowed key (Part C).

### B.1 App changes
- `identity/identity.dart`: `Identity` becomes a thin wrapper whose `id`/address **is** the
  Clerk `uid`. Remove `npub`/`nsec`/`pubHex` from the public surface. `IdentityStore` no longer
  generates Nostr keys; it holds the **escrowed encryption key** (Part C) keyed by account.
- `identity/nostr_keys.dart`: **delete** once no caller remains (`npubToHex`, `npub`, `nsec`,
  bech32). 7 files call `npubToHex` — migrate them to pass `uid` directly.
- `features/avatok/contacts.dart` (`Contact`, `ContactsStore`, `Directory`): key on `uid`.
  `Directory.resolve/search` already return `uid` (`j['uid']`); drop the `npub` aliasing.
- Everywhere a message/call is addressed, pass `uid` (remove `npubToHex` hops).
- Avatar (`core/avatar.dart`) + any `seed: c.npub` → `seed: c.uid`.

### B.2 Worker changes
- Drop `npub`/`nsec` columns and params (profiles, contacts, directory). Directory already
  returns `uid`; remove the Nostr-key acceptance in `registerProfile` (`encrypted_nsec_backup`,
  `backup_method`) — superseded by Part C.
- Remove NIP-98 signing if it's no longer the auth (Clerk session is the credential). **Audit
  first:** if any mutation still verifies NIP-98, replace with Clerk-session auth before
  deleting the verifier. This is the highest-risk step — do it behind a flag and test.
- Delete Nostr helpers/relay stubs (`sync/legacy_stubs.dart` on the app; relay endpoints on the
  worker) once unreferenced.

### B.3 Acceptance
- Grep for `npub|nsec|nostr|NostrKeys` returns 0 in `app/lib` and `worker/src`.
- New signup, message, call, add-contact, and directory search all work addressed by `uid`.

**Risk:** high (touches addressing + auth). **Mitigation:** land behind flags, staged rollout,
keep the npub→uid read-compat shim through one release window (§D), then delete.

---

## PART C — Key durability: backup & restore (the core fix)

Make the encryption key **recoverable from the account** via server escrow.

### C.1 Data model (D1 `DB_META`)
```
key_backup(
  uid        TEXT PRIMARY KEY,     -- Clerk uid
  wrapped    TEXT NOT NULL,        -- account-encryption key, wrapped (see C.2)
  alg        TEXT NOT NULL,        -- 'v1'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```
One small row per user — D1 handles this at hundreds-of-millions scale.

### C.2 Wrapping
- Introduce an **account encryption key** `aek` (random 32 bytes) — the single key the client
  uses for the contacts/prefs vault (replacing the Nostr-derived key).
- Server holds a **master wrap key** (`KEY_WRAP_MASTER`, a `wrangler secret`). Per-account wrap
  key = `HKDF(KEY_WRAP_MASTER, salt=uid)`. Store `wrapped = AESGCM(aek, wrapKey)`.
- Trade-off (decided): **server-escrow, not zero-knowledge.** The server *can* derive the key.
  Consistent with the already-server-readable chats; means users just sign in and data returns.
  (Zero-knowledge alternative = user recovery passphrase/OTP; rejected for a non-technical
  consumer base because users lock themselves out.)

### C.3 Routes (`worker/src/routes/keybackup.ts`, behind Clerk session)
- `POST /api/keybackup { aek_plain }` → wrap + upsert row. Idempotent. Rate-limited per uid+IP.
- `GET  /api/keybackup` → return `aek_plain` (unwrapped server-side) to the authed account.
- Both require the Clerk session JWT; no anonymous access.

### C.4 Client changes
- `Vault._key`: use `aek` (fetched/held per account) instead of `SHA256(privHex)`.
- On launch, if the account has a local `aek` and no server row yet → `POST /api/keybackup`
  (protects existing users going forward, §D).
- `AccountRestore._install`: **before** minting anything, `GET /api/keybackup`; if present,
  adopt that `aek` → contacts/prefs vaults decrypt → data restored. Only truly-new accounts
  generate a fresh `aek` (and immediately back it up).

### C.5 Second safety net
- Also store the **contact list itself server-side by `uid`** (server-readable, like chats):
  `POST/GET /api/contacts`. Then contacts restore even if the key path ever fails. Two nets.

**Acceptance:** sign in on a fresh install → contacts + prefs return automatically, no user
action, no passphrase.

---

## PART D — Migration for existing users (no data left behind, going forward)

- On first launch of the durability build, the app:
  1. If it has a local Nostr key + vault: derive the *old* `aek_old = SHA256(privHex)`,
     decrypt the current contacts/prefs, **re-encrypt under the new `aek`**, upload the new
     vault + escrow `aek`. (One-time, idempotent, best-effort with retry.)
  2. Re-key contacts from `npub`→`uid` (read `npub` fallback, write `uid`).
- Users who **already** reinstalled and lost the old key: that specific vault is unrecoverable
  (the random key is gone). Everyone who updates *before* their next reinstall is fully safe.
- Keep the `npub`→`uid` read-compat shim for **one release window**, then delete (§B.3).

---

## PART E — Rollout to millions WITHOUT reinstalls

You already own every lever needed:

1. **Normal Play Store update.** Users auto-update; no reinstall. The `+21` self-healing launch
   (clear bad cache, escrow key, migrate data on first run) is the template — the app fixes
   itself when it opens.
2. **Forced-update switch (already built).** `minAppBuild` in `platform_config` (KV) +
   `_UpdateRequiredScreen` (`main.dart`) + `RemoteConfig`. Bump `minAppBuild` server-side → every
   phone shows a one-tap "Update" gate within one poll cycle. No manual anything.
3. **Server-side is instant + universal.** Config flags and worker fixes reach every phone with
   zero app change (as already demonstrated: the call-log crash fix, Ava on/off, timing). Always
   prefer server-side where possible.
4. **Staged rollout.** Play Console staged rollout 5% → 25% → 100%, gated on the PostHog
   crash-free rate + `restore_ok`/`restore_failed` events. Halt/rollback on any spike.

---

## PART F — Telemetry, abuse, cost, monitoring

- **Telemetry:** `key_backup_ok/failed`, `key_restore_ok/failed`, `contacts_restore_ok/failed`,
  crash-free rate, migration success. Watch these during staged rollout.
- **Abuse:** rate-limit `keybackup`/`contacts` per uid + per IP with exponential backoff; alert
  on anomalous fetch rates. All account-scoped behind Clerk.
- **Cost:** one D1 row + small KV/vault blob per user — negligible at millions on the Cloudflare
  plan. Contact/prefs blobs are small JSON; media stays in R2.
- **Backup of the backup:** D1 time-travel/PITR is already available; R2 is durable. Document the
  restore-from-D1-snapshot runbook.

---

## Sequencing & acceptance

1. **Phase 0 (now, no app change):** `+21` self-heal rolling via store; Ava off; monitor. ✅ server-side only.
2. **Phase 1 — Ably removal (Part A):** contained deletion PR. Low risk. Ship normally.
3. **Phase 2 — Durability + Nostr→uid (Parts B, C, D):** the big one; behind flags, staged
   rollout, then `minAppBuild` bump; delete the npub shim after one window.
4. **Phase 3 — Hardening (Part F):** history archive to R2, prefs durability, abuse limits,
   runbooks.

**Definition of done:** `grep -rE 'npub|nsec|nostr|NostrKeys|[Aa]bly'` returns only unrelated
words; a wiped phone that signs in restores chats **and** contacts **and** prefs with no user
action and no reinstall; forced-update can move the whole fleet from your side.

## Risks & rollback

- **Highest risk:** replacing NIP-98 auth and re-keying addressing (Part B.2). Land behind a
  flag, verify Clerk-session auth on every mutation *before* deleting the verifier, stage the
  rollout, keep the read-compat shim for one window.
- **Rollback:** each phase is its own PR + flag. Ably (Phase 1) reverts trivially. Phase 2 is
  gated by flags + staged rollout + `minAppBuild`; a spike in `restore_failed` or crash-free
  rate halts the rollout and reverts the flag — server-side, no reinstall.
