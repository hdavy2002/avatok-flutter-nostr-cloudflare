# HF-INTRO-VIDEO-1 — API notes per lane

Master plan: `Specs/HF-INTRO-VIDEO-1.md`. Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` §20. Each lane appends its own section.

## W2 — call option, mainAction, women gate

Lane W2 (backend). Everything is dark: nothing changes until `hfCallOptionEnabled` / `hfWomenAadhaarOnlyEnabled` are on, except the queue break default (below).

### Flags (worker/src/routes/config.ts, both public, default false)

| Flag | Effect |
|---|---|
| `hfCallOptionEnabled` | Call option A/B semantics, `callOption` + `mainAction` in public JSON, `/api/hosts/me/call-option`. Sits on top of `hfCallModesEnabled`. |
| `hfWomenAadhaarOnlyEnabled` | A fan qualifies for the women-only channel with a verified Aadhaar showing Female. No selfie, no lane row. LGBTQ+ unchanged. |
| `hfQueueBreakSeconds` (numeric, existing) | Default changed 60 -> **120** (HF-INTRO-9). Independent of the two flags above. A value already written to KV still wins, so check `flags.sh get` before deploy. |

### Column contract with W1

`hf_hosts.call_option TEXT` ('A' bookings only, 'B' bookings + live, NULL legacy) is created by W1's migration. W2 never creates it and reads it defensively (a DB without it = every host legacy, no error). `lib/hf_call_option.ts` is the one reader/writer: `hostCallOption`, `setCallOption`, `liveBlockedByOption`, `mainActionFor`, `canBookFor`.

### Semantics (flag on)

| Host | Instant call (`POST /api/hf/calls`, queue dispatch) | Queue join | New bookings |
|---|---|---|---|
| A, any presence | refused | refused | allowed |
| B, Online and free | allowed | n/a (call instead) | allowed |
| B, Online on a call / connecting | refused (must queue) | allowed | allowed |
| B, Offline (or Bookings-only switch) | refused | refused | **allowed** (was: Offline = no bookings) |
| legacy (NULL) | today's rules | today's rules | Offline = none (today) |

A BOOKED call still rings in every state: `claimHost(..., {booked:true})` ignores presence and option (HF-INTRO-20). The instant claim is guarded atomically in SQL (`COALESCE(call_option,'B')<>'A'`) as well as in the routes, so a queue dispatch cannot slip through.

### Refusals

`POST /api/hf/calls` for an option-A host: `409 {error:'host_unavailable', message, reason:'bookings_only', canQueue:false, canBook:<hfBookingsEnabled>, queueWaiting:0}`.
`POST /api/hf/hosts/:slug/queue` for an option-A host: `409 {error:'queue_closed', reason:'bookings_only', canQueue:false, canBook:<hfBookingsEnabled>}`.
Option B offline: existing `reason:'offline'`, `canQueue:false`, but `canBook:true` (when bookings are on).
`CallRefusalReason` gained `'bookings_only'`.

### Public JSON added (only while `hfCallOptionEnabled` is on; rides on `hfCallModesEnabled`)

| Field | Where | Values |
|---|---|---|
| `callOption` | host card (`/api/hosts/public`, list, search, reels, favourites), `GET /api/hf/hosts/:slug`, `/api/hf/me` (own host) | `'A' | 'B' | null` (null = legacy) |
| `mainAction` | same places | `'call' | 'queue_or_book' | 'book' | 'none'` |

`mainAction` rules: A -> `book`. B available -> `call`. B on_call / connecting / queue_only -> `queue_or_book` (falls back to `book` when the queue is closed or paused). B offline or Bookings-only -> `book`. Legacy offline -> `none`. `book` becomes `none` when `hfBookingsEnabled` is off.
For an A host `callState` is reported as `'appointments'` and `queue.open` is false. `GET /api/hf/hosts/:slug` also returns `canQueue` / `canBook` computed with the option. The feed filter (hide B-offline, D16) is W1's; this lane only supplies the fields.

### Switch endpoint

`GET|PUT /api/hosts/me/call-option` (auth = the host, any `hf_hosts` row so onboarding can call it before approval; 404 `not_enabled` while the flag is off; 409 `not_host` for a non-influencer).
PUT `{option:'A'|'B', surface?:'web'|'app'|'onboarding'}` -> `{ok, callOption, changed}`. Switching to A closes a running queue exactly like going Offline (waiters told once, lock released). Telemetry `hf_host_call_option_changed{from,to,surface}`. 400 `invalid_field` for anything else, 503 `unavailable` if the column is missing.
W1 can call `setCallOption(env, uid, option)` from `lib/hf_call_option.ts` during onboarding submit.

### Queue break

`hfQueueBreakSeconds` default 120. The heads-up WhatsApp ("You're next for X. We'll call you in about 2 minutes") is sent when the break starts and its wording follows the configured value (`queueWaitPhrase` in `lib/hf_queue_messages.ts`: under 45 s "in a few seconds", else minutes rounded). WhatsApp pacing constants (one message per fan per 60 s) are unrelated and unchanged.

### Women-to-Women gate

With `hfWomenAadhaarOnlyEnabled` on:
- `getLaneAccess` (and so `hasLaneAccess`, lane lists, profile visibility): women = `hf_kyc.verified_at` set and `gender='F'`. The latest-selfie and `hf_lane_access` row are no longer needed for women.
- `callerKycBlocked` returns false for a women-lane host (its "video KYC for callers" rule is the lane rule now).
- Booking SQL `laneGuardSql(customer, host, lane, womenAadhaarOnly)`: the women clause is Aadhaar-F only and the `caller_level='video_kyc'` clause ignores women-lane hosts. Used at quote, confirm and the booked-call start.
- Enforced at call start (`POST /api/hf/calls` and queue dispatch), queue join, booking eligibility/quote/confirm.
- `403 {error:'lane_required', lane:'women', need:'aadhaar'}` when the fan has no verified Aadhaar; `need:'female_only'` when verified but not F. `need` is added only while the flag is on; flag off = the old body.
- LGBTQ+ lane and the Female-only `womenEligible` rule are unchanged.
