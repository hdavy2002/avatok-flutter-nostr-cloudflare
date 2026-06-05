# AvaTok — Where We Are (Plain-English Status)

_Last updated: 2026-06-05_

## In one line
The backend is built, hardened, scale-proofed, and given an AI memory layer — all
code-complete and tested. Nothing is switched on in production yet: it's waiting on
3 keys, one deploy, and the phone-app build.

---

## ✅ What's done

**The core backend (4 services on Cloudflare)**
- Directory, contacts, communities, media upload, calling, push — all live as code.
- Real-time chat relay (Nostr) with end-to-end encrypted DMs.
- Background workers for moderation, push, email, analytics + a 6-hour cleanup job.

**Security**
- Every write now requires a cryptographic signature (you own your keys) **plus** a verified account login (Clerk). Reads stay open.
- DMs are end-to-end encrypted — even our own server can't read them.
- Public uploads are AI-scanned before they go live; repeat bad images are caught even after resize.
- Strike system: warning-block → longer block → permanent ban.

**Speed (global)**
- Photos/videos load from Cloudflare's edge cache worldwide, not our server (verified on).
- Database reads come from the nearest region (replicas), not one far-away location.
- Chat connections are split per-user so a user in Delhi and one in New York are both fast.

**Cost control (built for 10M users)**
- Fixed a bug that would crash for anyone with >100 contacts or >100 follows.
- Replaced a "scan the whole table" search with a proper search index.
- AI moderation cost is metered and one config-flip away from a ~100× cheaper model.
- Media caching, batched analytics, and lazy cleanup keep per-user cost tiny.

**Email & analytics**
- Email switched to Brevo. Analytics flows to PostHog (batched) + Cloudflare Analytics Engine for ops dashboards.

**AvaBrain (new — the AI memory layer)**
- Every user gets a private "brain" that remembers people, projects, and facts and can answer "what happened today?" / generate a daily briefing.
- Learns only from **public** content on the server; private chat memory is opt-in and synced from your phone (never breaks encryption).
- Uses an efficient 8B AI model in the background (not an expensive one), with its own database so it never slows the rest down.
- Can also "investigate" a complaint ("my messages aren't sending") by reading your error logs and explaining the cause.

**In-app notifications (new)**
- A real notification feed (bell + list) for system alerts like "₹30 deducted", "your briefing is ready", "content removed" — server-generated, so no encryption/Nostr needed.
- Built native on what we already run: realtime to an open app over the existing chat socket, a feed stored in D1, and background push via FCM/APNs. No Novu — no extra vendor or per-user cost.
- Already fires on content-moderation removals; ready to plug into wallet/payment events.

**Storage & privacy (new)**
- Every user's media now lives in their own folder (`u/<npub>/…` in storage; a per-user "collection" in Bunny for video) — no more guessing who owns a file.
- **Delete account = everything goes:** one button wipes the user's photos/videos, chat history, contacts, AI memory, and profile from every store. Built for privacy-law "right to erasure."

**Quality checks**
- All 3 backend services pass type-checking and a Cloudflare build dry-run.
- Full written records: scale audit, final audit report, and handoff docs (now in the `Specs/` folder).

---

## ⏳ What's pending (your side)

**1. Three secret keys** — paste into `secrets/secret-values.env`:
- `BREVO_API_KEY` — sending email (Brevo dashboard → SMTP & API → API Keys).
- `TURN_KEY_API_TOKEN` — calls across mobile networks (Cloudflare → Realtime/Calls).
- `BUNNY_API_KEY` — video uploads (Bunny.net → Stream → library 553793).

**2. One optional key** (only if you want the brain's "investigate" feature now):
- `POSTHOG_PERSONAL_API_KEY` — lets AvaBrain read logs to diagnose issues. Without it, everything else works; investigate just says "unavailable".

**3. Go-live deploy** — once keys are in, run `bash secrets/deploy.sh`.
- ⚠️ Must be done **together with shipping the new phone app** (the old app version will stop working after this — it's a clean cutover).

**4. Build the phone app (APK)** — needs the Flutter build (runs on CI / your build machine; I can't compile it in this environment). Then smoke-test: log in → set profile → add a contact → send a photo → make a call.

**5. One manual cleanup** — delete the two old test apps `avaglobal` and `avablobal` in the RealtimeKit dashboard (can't be done via API; keep `avatok-calls`).

---

## 🔜 Nice-to-have follow-ups (not blockers)
- The AvaChat "brain" tab UI + on-device DM fact extraction (server side is ready).
- Enable a cheaper NSFW image model when one appears in your Cloudflare AI catalog (one-line swap).
- iOS push (APNs) — code is ready; just needs an Apple `.p8` key when you go iOS.
- Stream video-recording content scan (image scan + dedupe already live).
- Build the PostHog dashboards once real events start flowing.

---

## 📄 Where the detail lives (in the `Specs/` folder)
- `Specs/FINAL_AUDIT_REPORT.md` — full technical audit + cost posture.
- `Specs/SCALE_AUDIT.md` — the 12 scale fixes (all done).
- `Specs/BACKEND_REBUILD_HANDOFF.md` — full session-by-session record (incl. AvaBrain + storage/erasure).
- `Specs/AVABRAIN-OBSERVABILITY-CORRECTED.md` — the AI-layer design that was built.
- `secrets/deploy.sh` — the one command to go live.
