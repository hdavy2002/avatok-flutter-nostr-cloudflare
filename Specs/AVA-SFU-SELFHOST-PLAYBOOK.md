# AVA SFU Self-Host Playbook — Cloudflare TURN + Upstash Redis + LiveKit per region

**Owner decision, 2026-06-28.** This is the canonical plan for moving AvaTOK group
conferencing off **per-use LiveKit Cloud** onto a **fixed-cost, self-hosted, global
SFU** so a flat subscription ($10 → 20-person conference) stays margin-safe.

> TL;DR of the architecture: **LiveKit (self-hosted) = SFU media only, one cluster
> per region. Upstash Redis = per-region cluster state/bus. Cloudflare Calls =
> TURN/STUN (NAT traversal).** Free users stay on **LiveKit Cloud** (small, capped)
> until self-host is proven; paid users move to self-hosted regional clusters.

---

## 0. Why (the money)

- A flat subscription on top of **per-minute** LiveKit Cloud is a margin trap: one
  heavy subscriber can cost more than they pay.
- The SFU **software is free**; the only real cost is **bandwidth egress**.
  Bandwidth-cheap hosts (~€1/TB) vs cloud egress (~$0.09/GB ≈ $90/TB) ⇒ ~**80×**
  cost difference for identical software.
- Self-hosting converts variable per-minute cost into **fixed monthly infra**,
  which is exactly what a flat plan needs.

A worked figure: a 5-person **video** call ≈ 4.5 GB/hr total egress.
- LiveKit Cloud (per-use): ~$0.0005/participant/min ⇒ ~$0.15/hr for the call.
- Self-hosted on a €1/TB host: ~**€0.005/hr** for the call. (~30× cheaper.)

---

## 1. Target architecture

```
            ┌──────────────────────── Cloudflare Worker (avatok-api) ───────────────────────┐
            │  /api/conference/:gid/{start,join,beat,end,status,webhook}                      │
            │  - auth (Clerk), membership (D1 conversation_members), plan caps (plans.ts)     │
            │  - mints LiveKit JWT (HS256) + Twirp RoomService calls  (NO LiveKit SDK)        │
            │  - REGION ROUTER: picks the nearest self-hosted cluster (paid) or Cloud (free)  │
            │  - mints Cloudflare TURN short-lived credentials and hands them to the client   │
            └───────────────┬───────────────────────────────────────────────┬────────────────┘
                            │ region = us | eu | ap (pinned per room)         │ free tier
                            ▼                                                 ▼
        ┌── Region cluster (e.g. eu) ──────────────┐                ┌── LiveKit Cloud ──┐
        │  LiveKit SFU node(s)  ── Upstash Redis ──┐│                │  (free, ≤5, 60m)  │
        │  UDP 50000-60000 + TCP 443 (TURN/TLS)    ││                └───────────────────┘
        │  state/bus = Upstash Redis (this region) ││
        └──────────────────────────────────────────┘
                            ▲
                            │ ICE / TURN relay when P2P path blocked
                  ┌─────────┴───────────┐
                  │  Cloudflare Calls    │  TURN/STUN (global anycast). Used by:
                  │  (TURN / STUN)       │   - 1:1 P2P CallRoom (existing)
                  └──────────────────────┘   - SFU clients behind symmetric NAT
```

### Component split (what each piece is for)

| Concern | Service | Notes |
|---|---|---|
| **SFU media forwarding** | **LiveKit (self-hosted)**, one cluster per region | Free OSS. Our worker already speaks its JWT+Twirp API, **no SDK** — migration = swap 3 env vars. |
| **Cluster state + message bus** | **Upstash Redis**, one DB **per region** | LiveKit distributed mode needs Redis to track rooms/participants/nodes. Keep Redis **co-located with its region's nodes** (low latency). Do NOT share one global Redis across regions. |
| **NAT traversal (TURN/STUN)** | **Cloudflare Calls (TURN)** | Replaces self-hosting coturn. Global anycast, generous free tier, short-lived creds minted by the worker. Used by both 1:1 P2P and the SFU clients. |
| **Signaling / token issue / caps** | **Cloudflare Worker** (existing `conference.ts`) | Region router + plan gate + telemetry. |

---

## 2. The one hard constraint: self-hosted ≠ Cloud's global mesh

- **LiveKit Cloud**'s premium feature is a **cross-region media mesh**: one room can
  span multiple regional SFUs that relay to each other; each participant connects to
  their nearest node.
- **Self-hosted OSS does NOT do this.** A cluster shares one Redis, and **a room
  lives on a single node, in a single region.** All participants of that room
  connect to that one region.

**Design rule:** pin each room to ONE region (nearest the host / majority of
members) at `CreateRoom` time, store the region in **room metadata**, and on
**join** hand every joiner the **same region's URL** (read from metadata) — never
"nearest to the joiner," or they connect to the wrong cluster and don't find the
room. Far-away participants still work, just with more latency. Only a genuinely
globe-scattered single call suffers — the narrow case where Cloud earns its premium.

---

## 3. Regions (start small, expand)

| Region key | Suggested host (bandwidth-cheap) | Upstash Redis region | Serves |
|---|---|---|---|
| `eu` | Hetzner (DE/FI) or OVH | EU (Frankfurt) | Europe, Africa, Middle East |
| `us` | Hetzner US or OVH US | US (N. Virginia/Oregon) | Americas |
| `ap` | low-cost SG/Mumbai VPS | AP (Singapore/Mumbai) | Asia-Pacific, India |

Stand up **one region first** (wherever most test users are), verify against the
real app, then add the others one at a time. Each region = LiveKit node(s) + its own
Upstash Redis. One node serves hundreds of concurrent streams; add nodes to a
region's cluster for horizontal scale.

---

## 4. Per-node deployment requirements (LiveKit)

- **Public IP**.
- **UDP 50000–60000** open (media), **TCP/TLS 443** open (TURN/relay fallback +
  signaling for restrictive networks).
- **TLS** on the wss signaling endpoint (LiveKit can terminate, or front with a TLS
  proxy / Cloudflare).
- **Redis** reachable from every node in that region's cluster (use the region's
  Upstash DB; connect over TLS with the Upstash credentials).
- LiveKit `config.yaml` essentials: `redis: {address, username, password, use_tls:
  true}`, `rtc: {udp_port_range, tcp_port, use_external_ip: true}`, `turn:` pointed
  at **Cloudflare Calls** (or LiveKit's embedded TURN as a backup), `keys:` =
  `LIVEKIT_API_KEY: LIVEKIT_API_SECRET` (must match the worker's secrets).
- Set `max_participants` per room from the worker (already done) — server-side
  backstop regardless of node config.

---

## 5. Cloudflare TURN/STUN (Cloudflare Calls)

- Create a **Cloudflare Calls (TURN)** app → get a **TURN token id + secret**.
- The **worker mints short-lived TURN credentials** per call and returns them to the
  client in the `start`/`join` response (alongside the LiveKit url+token). Never ship
  the static TURN secret to clients.
- Wire the same TURN creds into the existing **1:1 P2P CallRoom** path (replaces any
  prior TURN provider) and into the **mesh fallback** if used.
- STUN: Cloudflare provides STUN too; clients list Cloudflare STUN + TURN in their
  `iceServers`.

---

## 6. Region router — BUILT (commit, 2026-06-28)

The region router now ships in `worker/src/routes/conference.ts`. Behaviour:

1. **`LIVEKIT_REGIONS` secret** (one JSON blob) maps region→creds:
   ```json
   {"eu":{"url":"wss://eu.sfu.avatok.ai","key":"APIxxx","secret":"yyy"},
    "us":{"url":"wss://us.sfu.avatok.ai","key":"APIxxx","secret":"yyy"},
    "ap":{"url":"wss://ap.sfu.avatok.ai","key":"APIxxx","secret":"yyy"}}
   ```
   Set with `wrangler secret put LIVEKIT_REGIONS`. When **unset/empty**, the worker
   synthesizes a single `cloud` region from the legacy `LIVEKIT_URL/API_KEY/
   API_SECRET` — so behaviour is unchanged until you populate it. `cloud` is always
   the default + fallback; add a region by editing this one secret.
2. **start** (`pickRegion`): free → `cloud`; paid → nearest region by
   `req.cf.continent` (EU/AF→eu, NA/SA→us, AS/OC→ap), falling back to `cloud` when
   that region isn't deployed. `CreateRoom` runs on the chosen region; the room is
   **pinned** in KV `conf_region:<gid>` (6 h TTL) **and** in room metadata.
3. **join / end / status** (`roomRegion`): read the KV pin so every participant +
   teardown targets the SAME node. Defaults to `cloud` if the pin is missing.
4. **Cloudflare TURN** minted per call via `mintIceServers()` (shared with
   `/api/ice`) and returned as `iceServers` in the start/join response.
5. **Webhook** (`verifyLkJwt`) validates the signature against EVERY region's
   secret, so webhooks from any cluster authenticate.

Because the worker uses **plain JWT + Twirp (no SDK)**, "switch a region to
self-hosted" = add that region's 3 values to `LIVEKIT_REGIONS`. Cloud stays wired
as overflow/fallback indefinitely (cheap insurance).

**Remaining (small) follow-ups:**
- **Client TURN wiring (optional):** the start/join response now carries
  `iceServers`, but `conference_screen.dart` still calls `room.connect(url, token)`
  without `ConnectOptions.rtcConfiguration`. For self-hosted clusters LiveKit
  serves its own TURN (config.yaml §4/§5), so this is belt-and-suspenders; wire it
  only if you want the client to force Cloudflare TURN directly.
- **Stand up region #1**: deploy LiveKit + Upstash Redis + point its `turn:` at
  Cloudflare Calls, then add its entry to `LIVEKIT_REGIONS`. Nothing else changes.

---

## 7. Free vs paid (current state after the 2026-06-28 PR)

- **Free (tier 0):** LiveKit **Cloud**, **max 5** participants, **60 min/day**
  (`plans.ts` `conf_min: 60`, `confParticipants: 5`). Metered every minute by
  `conferenceBeat` (always-on, not gated by `billingEnabled`). Entry is pre-checked
  so a tapped-out user can't start/join.
  - **Planned expansion:** 60 → **180 min/day (3h)** once self-hosted SFU is live and
    revenue covers it — a one-line `conf_min` bump in `plans.ts`, no code change.
- **Paid:** Plus 10 ppl / 180 min, Pro 25 / 480, Max 25 / unlimited. Move to
  self-hosted regional clusters per §6. Per-call cost attributed to the **host**
  (the starter's plan governs room size + minutes); free guests of a paid host ride
  the host's entitlement (host-billed model, like Zoom/Meet).

---

## 8. Rollout order

1. ✅ **Free → LiveKit Cloud (5 ppl, 60 min/day)** + rich telemetry.
2. ✅ **Region router** — `LIVEKIT_REGIONS` map + KV-pinned routing + Cloudflare
   TURN minting + multi-region webhook verify (§6). `cloud` = default until you
   add regions, so this is live and inert today.
3. Stand up **region #1** (LiveKit + Upstash Redis + Cloudflare TURN), then add its
   entry to `LIVEKIT_REGIONS`. Verify with the real app.
4. Migrate paid traffic region-by-region off Cloud as each is verified.
5. Bump free `conf_min` 60 → 180 when revenue supports it.
6. Keep LiveKit Cloud configured as permanent overflow/fallback.

---

## 9. Telemetry & observability (see §10 of conference.ts events)

Every conference path emits PostHog events with edge geo (country/city/region/
timezone/continent/Cloudflare colo), tier, provider, and group id, plus the user's
email (`trackUser`) for support lookups. Events: `conf_start`, `conf_join`,
`conf_minute`, `conf_blocked` (reason: daily_limit | size_cap | not_member |
no_live_room | room_full), `conf_limit_reached`, `conf_error`, `conf_end`,
`conf_room_event` (server-truth from LiveKit webhook). Dashboard tracks top
video-conf regions, free vs paid SFU minutes, and error/abuse signals — used to
decide WHERE to stand up the next self-hosted region.
