# HANDOVER — Promoting AVA-BIZCALL work to PRODUCTION (2026-07-11)

**From:** the agent that built the dialpad-business-calls + Ava Voice Agent stack (commits
`[AVA-BIZCALL-1]`…`[AVA-BIZCALL-10]` on `staging`).
**To:** the agent merging to `main` and preparing the production AAB.
**Read this BEFORE merging or deploying anything.**

---

## 1. What you are promoting

10 commits on `staging` (staging = old `main` + this work; `main` was fast-forwarded into
staging on 2026-07-11, so the merge back should be clean/fast-forward unless `main` has
moved since):

- Worker: append-only call event stream, call routing engine, escrow/refund engine with
  per-minute settle (round-UP final minute), VoicemailRoom DO (**migration v14**),
  AgentVoiceRoom Grok DO (**migration v15**), Agent Profiles + service numbers,
  paid-call routes, `/api/block`, busy-tone routing for paid lines.
- Flutter: email-only new-chat search, tappable numbers → dialpad, no-answer card,
  business incoming-call screen, paid-call price sheet, Ava Business Agent settings,
  voicemail/transcript thread cards, My AI calls, busy card.
- Spec: `Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md` (locked design).

**Everything ships DARK.** All five new flags default `false` in
`worker/src/routes/config.ts` DEFAULTS: `businessCallUx`, `voicemailBot`, `paidCalls`,
`voiceAgent`, `serviceNumbers`. With flags off, `/api/call` behavior is byte-identical to
today and every new route returns 403. Prod users see zero change until a flag is flipped.

## 2. ORDER OF OPERATIONS (worker BEFORE app)

The new app code calls new worker routes. Deploy the prod worker BEFORE the AAB reaches
users, or the new UI paths would 404 the day a flag is flipped.

1. Merge `staging` → `main` (git protocol: `scripts/git_safe_commit.py` for any new
   commits, explicit paths only — the repo has ~40 untracked report files and a dirty
   `graphify-out/graph.json` tool cache; NEVER `git add -A`, never commit graphify-out).
2. Deploy the prod worker FROM MAIN:
   ```bash
   ALLOW_PROD=1 AVATOK_TARGET=prod scripts/cf.sh worker deploy
   ```
   This applies DO migrations **v14 (VoicemailRoom)** and **v15 (AgentVoiceRoom)**
   automatically. `consumers/` and `calls/` were NOT touched — no deploy needed there.
3. Only then build the AAB, from main with the prod guard:
   ```bash
   gh workflow run android.yml --ref main -f environment=prod -f artifact=aab
   ```
   (The workflow guard fails a prod build not on `main` — do not fight it.)

## 3. PROD SECRETS — set before anyone flips `voiceAgent` (safe to skip for the deploy itself)

These exist ONLY on `avatok-api-staging`. The prod worker deploys safely without them
(code is fail-closed: no key → agent falls back to voicemail; flag is off anyway), but the
voice agent cannot be enabled in prod until they exist:

```bash
printf '%s' '<xai regular key>'    | ALLOW_PROD=1 AVATOK_TARGET=prod scripts/cf.sh worker secret put GROK_API_KEY
printf '%s' '<xai MANAGEMENT key>' | ALLOW_PROD=1 AVATOK_TARGET=prod scripts/cf.sh worker secret put GROK_MANAGEMENT_KEY
printf '%s' '<mem0 key>'           | ALLOW_PROD=1 AVATOK_TARGET=prod scripts/cf.sh worker secret put MEM0_API_KEY
```
Get the values from the owner (they were verified live on 2026-07-11: collections
create/upload/search, realtime WS session, mem0 write/recall — all pass). Note the xai
account bills per use; the team must keep credits.

## 4. FLAGS — DO NOT FLIP IN PROD

- Do NOT set any of the five flags in prod KV. Staging has them ON via KV override;
  **never copy the staging KV flag blob to prod** (it would wipe real users' config —
  standing rule). Prod flags are flipped one at a time, only when the owner says so,
  via `AVATOK_TARGET=prod ALLOW_PROD=1 scripts/flags.sh set <flag>=true`.
- **`paidCalls` in prod additionally requires the owner's legal/compliance review**
  (plan §3B/§12.13) before it may ever be enabled. This is an owner decision, not yours.
- KV holds overrides only; DEFAULTS in config.ts is the source of truth. Never
  re-materialize all flags into the blob.

## 5. Known open items (fine to ship dark, listed for honesty)

- Client does not yet render the busy card for the *post-ring-timeout* busy case
  (`/api/call/no-answer` returns it; only the pre-ring path is wired). Minor UX gap.
- Child-account gate uses a `birth_year` proxy pending a real account-type field.
- Paid-call end-of-time beep uses a system sound placeholder.
- Voicemail recordings live in the public BLOBS bucket (same pre-existing pattern as
  receptionist recordings) — flagged to the owner for a future privacy pass.
- Grok realtime protocol was verified against docs + a live session handshake, but a
  full end-to-end voice conversation on a device is still untested — staging testing
  is happening now on APK run 29147999711.

## 6. Play Store note

The AAB contains the new features fully disabled by server flags — safe for review.
The AI-disclosure greeting (mandatory, non-editable) is built in for when `voiceAgent`
eventually goes live.

## 7. Quick verification after prod worker deploy

```bash
curl -s https://api.avatok.ai/config | grep -o 'businessCallUx[^,]*'   # expect false
curl -s -o /dev/null -w '%{http_code}' https://api.avatok.ai/api/agent/settings  # expect 401/403, NOT 404
```
403/401 proves the new routes are deployed and correctly gated; 404 means you deployed
the wrong code.
