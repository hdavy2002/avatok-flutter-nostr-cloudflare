# AvaChat × 0xchat — Integration Proposal

**Status:** In progress — graft scaffolding on branch `feat/avachat-0xchat-graft` (see `AVACHAT-PHASE-LOG.md`) · **Owner:** davy
**Scope:** Evaluate adopting the open-source 0xchat Nostr client to ship a fully-working AvaChat inside the AvaTalk ecosystem, hosted on our existing Cloudflare backend.

---

## 1. The one-sentence finding

**0xchat and our stack speak the same protocol.** 0xchat is a Nostr client written in Dart/Flutter; AvaChat is *already* a Nostr client written in Dart/Flutter talking to a Cloudflare-hosted Nostr relay. This is **not a port across foreign systems** — it is a *protocol-compatible graft*. Your instinct ("mostly we just change the relay points") is correct at the wire level. The real work is in four reconciliation layers — identity, calls, payments, and per-account scoping — none of which are protocol-blocking.

That is the difference between this and every other "merge two apps" project: we are not translating between TCP and Nostr, or REST and websockets. Both ends already emit and consume signed Nostr events (kind-1059 gift wraps, kind-22242 AUTH, etc.). We are choosing a *more mature client* to sit on top of a backend that already exists.

---

## 2. Why even consider 0xchat

0xchat is, by a wide margin, the most complete open-source Nostr **chat** codebase in Dart:

- **0xchat-app-main** — Flutter app, MIT licensed, 5,900+ commits, 58 releases, ships on Android/iOS/macOS/Linux/Windows.
- **0xchat-core** — the protocol/business engine (account, chat, relay-connection modules), LGPL-3.0, 1,500+ commits.
- **nostr-dart** — their Dart Nostr implementation, LGPL-3.0.
- Plus `cashu-dart` (ecash wallet), `nostr-mls-package` (MLS group encryption), `relay29` (Go NIP-29 group relay).

Its NIP coverage is essentially the full chat surface: **NIP-01/02/04/05/09/10/13/17/18/19/21/23/25/27/28/29/30/33/40/42/44/47/51/57/58/59/65/78/96/98**, plus NIP-101 (forward-secret "Secret Chat"), NIP-100 (WebRTC calls), and a push spec.

By contrast, our current AvaChat client (`app/lib/nostr/nostr_client.dart`) is a capable but **hand-rolled, thinner** Nostr layer — it does NIP-01 signing and recently gained NIP-42 AUTH, but it does not have the breadth of DM types, group/channel handling, reactions/threads, or the polished chat UI that 0xchat has spent years on. Our investment is on the **backend** (four Cloudflare Workers, relay DO, CallRoom DO, AvaBrain, AvaWallet); 0xchat's investment is on the **client**. They are complementary.

---

## 3. Side-by-side architecture

| Concern | 0xchat (as shipped) | AvaChat / AvaTalk (our infra) |
|---|---|---|
| Client | Flutter + nostr-dart + 0xchat-core | Flutter + hand-rolled `NostrClient` |
| Identity | nsec private key only, **no registration** | Clerk JWT **+** Nostr keypair, linked via `clerk_nostr_link`; handles |
| Relay | User-chosen public Nostr relays | Our **Cloudflare DO relay** (`relay/src/relay_do.ts`), D1-backed, NIP-42-gated |
| DM model | NIP-17 gift-wrap (default), NIP-04, Secret Chat (NIP-101) | NIP-17 gift-wrap; relay gates private kinds `{13,14,1059,10050,10443}` |
| Mutations auth | Plain relay write | **NIP-98 signature required on every write** + Clerk |
| Groups | NIP-17 private (<100) + NIP-29 relay groups (large) + NIP-28 public channels | Relay supports replaceable/param-replaceable; **no NIP-29 group mgmt yet** |
| Calls | NIP-100 WebRTC signaling over relay + generic ICE/TURN | **Cloudflare Realtime** via `CallRoom` DO, **1:1 only, capped at 2 peers** (kind 25050 signaling) |
| Payments | Cashu ecash + NIP-57 zaps + NIP-47 NWC | **AvaWallet / AvaCoins**, Stripe top-up, Wise payout |
| Media | NIP-96 HTTP file storage / Blossom | R2 + Cloudflare image resize + per-account decrypted media cache |
| Push | DM-to-push-server + UnifiedPush/FCM | Push Worker; relay enqueues `Q_PUSH` for kinds `{1059,25050}` |
| AI layer | none | **AvaBrain** — on-device DM fact extraction, opt-out, `/api/brain/remember` |
| Multi-account | single identity per install | **parent + child accounts share one phone**; all state `scopedKey()`-namespaced |

The rows that are **green (compatible today):** relay transport, NIP-42 AUTH, NIP-17/59 gift-wrap DMs, push wake kinds. The rows that need **reconciliation work:** identity/auth, calls, payments, groups, media, and the multi-account scoping refactor.

---

## 4. NIP-level compatibility with our relay

Our relay DO already implements the spine 0xchat depends on:

- **NIP-01** events + replaceable (kind 0/3/10000–19999) + parameterized replaceable (30000–39999) ✅
- **NIP-42** AUTH challenge (kind 22242) gating `PRIVATE_KINDS` ✅
- **NIP-17/44/59** gift-wrap DMs — kinds 1059/13/14 are in `PRIVATE_KINDS` ✅
- **Call signaling** — kind 25050 gated + push-enqueued ✅ (aligns with NIP-100-style signaling)

Gaps the relay would need to grow for full 0xchat parity:

- **NIP-29 relay groups** (large/open/closed groups) — group-management kinds + moderation. Not implemented. Either add to the DO relay, or run 0xchat's `relay29` (Go) as a separate service, or scope groups to NIP-17 private groups (<100) for v1.
- **NIP-28 public channels** — straightforward kinds (40–44) but currently no special handling.
- **NIP-65 / NIP-51 / NIP-78** lists & app data — mostly "just events," low effort.
- **NIP-96 media** — needs an R2-backed upload endpoint that speaks the NIP-96 contract (or adapt 0xchat's uploader to our `media.ts` route).

---

## 5. Three ways to do this

### Option A — Fork 0xchat wholesale as "AvaChat", repoint everything
Take `0xchat-app-main`, rebrand, change default relays to ours, bolt our auth on.
- ✅ Fastest path to a polished UI.
- ❌ Inherits 0xchat's *single-identity* assumption — collides head-on with our mandatory parent/child per-account scoping.
- ❌ We'd be maintaining a 5,900-commit fork and re-merging upstream forever.
- ❌ Drags in Cashu, NIP-100 calls, NIP-96 media as first-class — all of which we want to replace with AvaWallet / Cloudflare Realtime / R2.

### Option B — Graft 0xchat's protocol engine + UI into *our* app (recommended)
Adopt **nostr-dart + 0xchat-core** as the protocol/business layer and harvest 0xchat's chat **UI components**, dropping them into our existing AvaChat Flutter app behind an adapter layer. Keep our `NostrClient`'s NIP-42/NIP-98 know-how, our scoping, our Workers, AvaBrain, AvaWallet.
- ✅ Respects existing investment (scoping, dual-auth, brain, wallet, calls DO).
- ✅ We consume LGPL libs as *libraries* (cleaner licensing — see §7).
- ✅ Replace side-channels (calls/pay/media) with our infra by **not** importing those 0xchat modules.
- ❌ More integration glue than a dumb fork; requires a clean adapter boundary.

### Option C — Hybrid "engine swap"
Same as B, but go further: **retire our hand-rolled `NostrClient`** entirely and make 0xchat-core the single source of truth for event signing/relay management, wrapping it with an `AvaChatIdentity`/`AvaChatTransport` adapter that injects Clerk + NIP-98 + per-account storage.
- ✅ One protocol engine instead of two; less long-term drift.
- ❌ Larger upfront refactor; our recently-fixed NIP-42 path gets re-homed.

**Recommendation: Option B now, with C as the natural follow-on** once the adapter boundary proves out. B lets us ship the 0xchat UX and DM richness on our backend quickly, while keeping identity/scoping/calls/wallet ours. We migrate fully onto 0xchat-core (C) only if maintaining two Nostr layers becomes the bottleneck.

> **DECISION (locked 2026-06-08): Option B now → Option C later.** Graft 0xchat-core + the *full* 0xchat UI onto our backend behind an adapter; consolidate onto 0xchat-core as the single engine in a later pass.

---

## 6. The four reconciliation layers (where the work actually is)

**1. Identity & auth adapter — the biggest single piece.**
0xchat assumes "the user *is* their nsec." We assume "the user is a Clerk account that *owns* a per-account-scoped nsec, and every write carries a NIP-98 signature + Clerk JWT." Build an `AvaChatIdentity` shim that: provisions/loads the Nostr keypair through Clerk login, stores it via `scopedKey()`/`AccountScope.id` (never a global key), and a transport interceptor that attaches NIP-42 AUTH (already done) on the websocket and NIP-98 on HTTP mutations. 0xchat-core already implements NIP-42 and NIP-98 — we're wiring *which key* and *which JWT*, not the crypto.

**2. Calls — full 0xchat call UI on our CallRoom, 1:1 enforced.**
*Decision: adopt 0xchat's entire call experience (incoming/outgoing screens, in-call controls, the call room UI) and re-home its transport.* 0xchat does NIP-100 WebRTC over the relay with generic ICE; we keep the **UI** but swap the **backend** to Cloudflare Realtime through the `CallRoom` DO — **1:1 only, capped at 2 peers**, signaling on kind 25050, ICE via Cloudflare TURN (`TURN_KEY_API_TOKEN`). Critically: **strip any group-call entry point** in the harvested UI and keep the layered guard (call buttons in 1:1 threads only, `_call()` rejects `group`/`gid`, CallRoom refuses a 3rd peer). Group calling stays in AvaConsult.

**3. Payments — Cashu out, AvaWallet in.**
Do **not** import `cashu-dart`. Replace 0xchat's zap/ecash affordances with AvaWallet/AvaCoins (`worker/src/routes/wallet.ts`, `wallet` DO). This also keeps us clear of running Cashu mints. NIP-57 zaps can be deferred or mapped to AvaCoin transfers later.

**4. Per-account scoping refactor.**
0xchat's local DB and key storage are *global to the install*. Our rulebook makes per-account scoping **mandatory** (parent + each child share a phone). Every store 0xchat opens — message DB, key store, media cache, prefs — must be namespaced by `AccountScope.id` before we ship. This is the highest-risk correctness item and must be designed in from line one, not retrofitted.

Plus two additive items: **media** (route 0xchat's NIP-96 uploader to an R2-backed endpoint via `media.ts`, reuse our decrypted-media on-device cache) and **AvaBrain** (wire on-device DM fact extraction into the message pipeline with the opt-out toggle + `/api/brain/remember`; private content read on-device only).

---

## 7. Risks & flags

- **Licensing (read before forking).** `0xchat-core` and `nostr-dart` are **LGPL-3.0**; `0xchat-app-main` is **MIT**. MIT lets us fork the app shell freely. LGPL lets us *use the libraries* in a closed product, **but modifications to those libraries must be published**, and we must allow relinking. Practical guidance: keep LGPL components as **separable library modules** (don't fold them into proprietary source), which favors Option B over a deep fork. Legal sign-off recommended before any code lands.
- **Scoping correctness.** A single un-scoped global key or DB path = data leaking across parent/child accounts. Treat as a release blocker; add a lint/test that fails on raw global keys.
- **Large groups.** NIP-29 is a real gap — **out of scope for v1 by decision** (private NIP-17 groups <100 only). Revisit only if large/open groups become a product requirement.
- **Two protocol engines (Option B).** Running 0xchat-core *and* our `NostrClient` temporarily means two code paths for signing/relay. Acceptable as a bridge; plan the Option-C consolidation so it doesn't ossify.
- **Upstream drift.** 0xchat ships often (last release Mar 2026). Pin versions; vendor deliberately.

---

## 8. Suggested phased roadmap

- **Phase 0 — Spike (1–2 wks).** Stand up `0xchat-app-main` locally, point its default relay at our DO relay, log in with a raw nsec, confirm a NIP-17 gift-wrap DM round-trips and that our relay's NIP-42 gate + push enqueue fire. *Pure feasibility proof, no AvaChat code yet.*
- **Phase 1 — Identity adapter.** `AvaChatIdentity` (Clerk → scoped nsec) + NIP-98/JWT transport interceptor. Per-account-scoped storage from the start.
- **Phase 2 — UI graft.** Import 0xchat chat list/thread/composer + DM types into our app behind the adapter; replace our thinner chat screens (`chat_thread.dart`, `chat_list.dart`).
- **Phase 3 — Side-channels.** Calls → CallRoom DO + Cloudflare TURN (1:1 enforced); media → R2/`media.ts`; push → our Push Worker.
- **Phase 4 — Ecosystem.** AvaWallet replaces Cashu; AvaBrain fact extraction wired in with consent toggle.
- **Phase 5 — Groups decision.** Ship NIP-17 private groups; scope/plan NIP-29 separately.
- **Phase 6 — Consolidation (optional, Option C).** Retire hand-rolled `NostrClient`; 0xchat-core becomes the single engine.

---

## 9. Decisions — locked 2026-06-08

1. **Approach:** ✅ **Option B (graft) now → Option C (engine swap) later.**
2. **Groups in v1:** ✅ **Private only (NIP-17, <100 members).** NIP-29 deferred; no large-group/relay-group work in v1.
3. **Calls:** ✅ **Use the entire 0xchat UI including the call room**, re-homed onto our `CallRoom` DO + Cloudflare TURN, 1:1 enforced.
4. **Payments:** ✅ **AvaWallet / AvaCoins only.** No Cashu import, no NIP-57 zaps in v1.
5. **Licensing posture:** ✅ **LGPL-as-library — proceed.** Consume `0xchat-core` and `nostr-dart` as **unmodified** pub/git dependencies (never vendored into proprietary source); keep all AvaChat-proprietary code (identity, scoping, AvaWallet, AvaBrain) in **separate modules**; contribute any fixes to those two libraries **back upstream** to satisfy LGPL's publish-modifications + allow-relinking terms. `0xchat-app-main` is MIT, so harvested UI is unrestricted. One-line legal sign-off recommended but non-blocking.

### What this prunes from scope
We will **not** import: `cashu-dart` (payments), NIP-100/generic-ICE calling transport (replaced by CallRoom), NIP-29 group management, NIP-57 zaps. We **will** import: nostr-dart + 0xchat-core protocol engine, 0xchat chat UI (list/thread/composer/DM types), and the 0xchat call UI (transport swapped).

---

*Sources: 0xchat org & repos (0xchat-app-main, 0xchat-core, nostr-dart) on GitHub; 0xchat.com feature docs; our `relay/src/relay_do.ts`, `app/lib/nostr/nostr_client.dart`, worker routes/DOs; Specs/AVATALK-CLOUDFLARE-RULEBOOK.md; project Graphiti memory (`proj_avaflutterapp`).*
