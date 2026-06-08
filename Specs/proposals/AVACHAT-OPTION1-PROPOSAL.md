# AvaChat — Option 1 Proposal (0xchat as the app shell)

**Date:** 2026-06-08 · **Owner:** davy · **Status:** For approval
**Companion docs:** `AVACHAT-0XCHAT-INTEGRATION-PROPOSAL.md` (the original graft
study), `AVACHAT-PHASE-LOG.md` (build progress), `LICENSES.md` (compliance).

This is the plain-English plan. Everything is point-based so you can see exactly
what you're getting, what stays, and what changes.

---

## 1. The plan in one line

- Make **0xchat the app your users open**, repointed at **your Cloudflare backend**.
- Rebuild your **sidebar / menu** on top of it, with each menu item wired to your
  own services.
- Your old avatok screens were dummy menu-holders anyway, so nothing real is lost.

---

## 2. What you're getting "for free" from 0xchat (already built, already compiles)

These are finished, polished features 0xchat brings the moment it's the shell:

- A complete **chat list + conversation UI** (text, replies, reactions, threads).
- **Encrypted 1:1 direct messages** (gift-wrapped, metadata-hidden — the strong kind).
- **Private group chats** (under 100 members) with member management.
- **Media in chat** — images, video, voice notes, files.
- **1:1 audio & video calls** with a full call UI (incoming/outgoing/in-call screens).
- **Contacts**, profiles, QR-code add, "safety number" verification.
- **Push notifications** plumbing.
- **Multi-platform** — the same code can later ship iOS, macOS, Windows, Linux.
- Settings, theming, localization scaffolding.

> You already have a working **136 MB arm64 APK on your Desktop** proving this runs
> on your relay today.

## 3. What WE add on top (your ecosystem, via the `avachat` adapter)

- **Your relay** instead of public Nostr relays (done — already repointed).
- **Your login** (Clerk) linked to each user's Nostr key, with parent/child
  per-account scoping.
- **Your media storage** (R2 / `blossom.avatok.ai`) for all uploads.
- **Your calls** routed through CallRoom + Cloudflare TURN, enforced 1:1.
- **AvaWallet / AvaCoins** as the money layer (not Cashu — see §6).
- **AvaBrain** — on-device DM fact extraction feeding your vector store.
- **Your sidebar** — the menu that turns this from "a chat app" into "your app".

---

## 4. How Option 1 is structured (plain English)

- Think of 0xchat as the **building**, and your features as **rooms** you add.
- The chat, calls, and contacts are 0xchat's rooms — already furnished.
- Your sidebar/menu becomes the **front door and hallway**: from it users reach
  chat (0xchat's) plus your other sections (marketplace, wallet, etc.).
- Each new menu item is a screen **you** build, talking to **your** Workers — sitting
  beside 0xchat's chat, not replacing it.
- Because your other apps were dummy screens, "Option 1 inverts your app" is only
  true on paper: in practice you're building those sections for real for the first
  time, on a shell that already has working chat + calls.

---

## 5. What happens to your Cloudflare infrastructure (the important part)

**Nothing gets thrown away. Option 1 only changes the phone app, not the backend.**

- **Nostr relay (Worker + Durable Object)** — your MVP backbone. 0xchat talks to it
  natively; messaging already flows through it. ✅ in use now.
- **Workers (avatok-api control plane, calls)** — stay. The client calls them for
  login, wallet, identity, TURN. ⛏ wiring in progress (the adapter seams).
- **Durable Objects (RelayRoom, CallRoom, Conversation, Wallet, UserBrain…)** — all
  stay. Relay DO already serving; CallRoom used once calls are wired.
- **R2 (storage)** — stays, clean fit. 0xchat uploads via Blossom → point at
  `blossom.avatok.ai` (R2-backed). Files land in your R2.
- **KV** — stays. Server-side ephemeral data/tokens; client never touches it.
- **Cloudflare image transforms (AVIF/resize)** — stays. Point 0xchat's image loads
  at `/cdn-cgi/image/...` URLs for edge-resized, cached avatars/media.
- **AvaBrain (Vectorize + Gemma inference)** — stays, pure bonus. 0xchat has no
  equivalent; we feed it via on-device extraction → `/api/brain/remember`.

> Rule of thumb: anything that is **pure Nostr** (messaging, contacts, relay) works
> automatically. Anything that is **your custom REST/Worker** (login, wallet, TURN,
> brain) needs the adapter to call it — that's the remaining wiring.

---

## 6. Money: how the wallet works, and why AvaWallet (not Cashu)

You asked specifically: if we kept 0xchat's **Cashu** wallet, how does money move
USD → crypto → USD, given you want **marketplace earnings withdrawn to Wise → bank**.

### 6a. How Cashu money actually moves (what you'd be signing up for)

- Cashu is **Bitcoin ecash**. "AvaCoins" would really be **satoshis** held by a
  **mint** (a custodial service someone has to run and that holds users' Bitcoin).
- **USD → crypto (on-ramp):** a buyer pays USD on an exchange/on-ramp, gets Bitcoin
  over the **Lightning network**, then "mints" Cashu tokens (bearer tokens stored on
  the phone). USD never enters the system directly — it must be converted to BTC first.
- **User → user:** Cashu tokens pass between users privately, like digital cash.
- **Crypto → USD (off-ramp):** a seller redeems tokens back to Lightning sats, then
  must sell those sats for USD somewhere and withdraw to a bank.
- **Cashu's blinding hides balances/transactions even from the mint** — good for
  privacy, but it also means **you can't see or audit a user's marketplace balance**,
  which a marketplace usually needs to.

### 6b. Why Cashu collides with your Wise → bank requirement

- **Wise bans crypto.** Wise's policy prohibits crypto transactions, and
  crypto-sourced funds arriving in a Wise account is **account-termination territory**.
  So "Cashu earnings → Wise" **does not work** — you'd be forced onto a different
  off-ramp (Coinbase/Kraken/P2P), not Wise.
- **You'd be running a custodial Bitcoin service** (the mint) → money-transmitter /
  MSB licensing, KYC/AML, and you holding customer crypto.
- **Volatility.** A seller's earnings could change value between earning and cashing
  out, because they're denominated in Bitcoin, not dollars.
- **Net:** Cashu adds crypto rails, a custodial mint, regulatory load, and a hard
  fiat off-ramp — and still can't reach Wise.

### 6c. How AvaWallet moves money (what fits your marketplace)

- **USD in:** buyer tops up with **Stripe** → credited as **AvaCoins** on your ledger
  (your `wallet` Worker + WALLET_DO). Dollars stay dollars; AvaCoins are a 1:1 book
  entry, not crypto.
- **User → user / marketplace:** AvaCoins move as **ledger entries** on your backend —
  fully visible and auditable (escrow, refunds, fees all possible).
- **USD out:** a seller withdraws via **Wise → their bank**, in plain fiat. No crypto
  ever touches Wise, so no policy conflict.
- **No mint, no volatility, no MSB-via-crypto, no off-ramp puzzle.**

### 6d. Recommendation (locked unless you say otherwise)

- **Use AvaWallet. Disable Cashu in 0xchat.** It's the only model that supports
  "marketplace earnings → Wise → bank" cleanly and keeps you out of crypto licensing.
- In the app, anywhere 0xchat shows "send ecash / zap," we route to AvaWallet instead.

---

## 7. Login & identity (plain English)

- 0xchat normally logs you in with a secret key (an "nsec"). We keep that key under
  the hood but **provision it through your Clerk login**, so users sign in the way
  your ecosystem expects.
- The key is stored **per account** (parent + each child on one phone stay separate).
- Every write to your backend is signed (NIP-98) and carries the Clerk token.

## 8. Calls (plain English)

- 0xchat's call screens stay exactly as-is.
- The "ringing" signaling already rides your relay (same message type your relay
  already handles).
- We point the actual audio/video connection at **Cloudflare TURN + your CallRoom**,
  and enforce **1:1 only** (group calling stays in AvaConsult).

## 9. Licensing — are you forced to open-source? No.

- App shell is **MIT** (do anything, stay closed).
- Engine is **LGPL** — fine for closed apps **if** kept as a separate, unmodified
  library (already how it's set up). You publish only changes *to that library*.
- Your code, your menus, your other apps, and your **entire backend** stay proprietary.
- Full detail + the one lawyer-review nuance: see **`LICENSES.md`**.

---

## 10. What works TODAY vs what's left

**Works today (in the APK on your Desktop):**

- App launches (crash-safe), full 0xchat UI, pointed at your relay.
- 0xchat-native login + encrypted DMs **should** round-trip through your relay
  (needs a two-device test to confirm).

**Still to wire (the `TODO(build)` seams):**

- Clerk login → key provisioning + per-account scoping.
- NIP-98 signing on your REST calls.
- Media uploads → `blossom.avatok.ai` (R2).
- Calls → Cloudflare TURN + CallRoom.
- AvaWallet replacing Cashu surfaces.
- AvaBrain on-device extraction → `/api/brain/remember`.
- Your sidebar/menu + the marketplace section.

---

## 11. Build plan (suggested order)

1. **Smoke test** the current APK on two phones — confirm DM + call basics over your
   relay. (No code; validates the foundation.)
2. **Identity** — Clerk → scoped key; sign-in matches your ecosystem.
3. **Media** — point uploads/avatars at R2/Blossom + image transforms.
4. **Wallet** — AvaWallet in, Cashu out (Stripe top-up → AvaCoins → Wise payout).
5. **Calls** — CallRoom + TURN, 1:1 enforced.
6. **Sidebar/menu shell** — rebuild your navigation; add the **marketplace** section.
7. **AvaBrain** — on-device DM facts → your vector store, with the consent toggle.
8. **Polish & store builds** — branding, then Android release signing (and iOS later).

---

## 12. Decisions to confirm

1. **Approve Option 1** (0xchat as shell, rebuild menus on top). _Recommended._
2. **Wallet = AvaWallet, Cashu disabled.** _Strongly recommended given Wise + marketplace._
3. **First milestone:** smoke-test the existing APK, or jump straight to wiring identity?
4. **Branding/app id** — keep building under a new AvaChat app id (not `com.oxchat.nostr`)?

---

_Sources for the money-flow section: cashu.space docs; reporting that Wise prohibits
crypto-sourced funds; 2026 crypto off-ramp comparisons. Links shared in chat._
