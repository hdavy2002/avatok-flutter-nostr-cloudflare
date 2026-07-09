# Phase C/D — ORCHESTRATOR WIRING (Agent ODL, 2026-07-09)

Agent ODL does NOT own `worker/src/index.ts` or `worker/src/routes/config.ts`.
These are the EXACT additions the orchestrator must make. Nothing else.

## 1. worker/src/index.ts — route registration

Import (top, alongside the other route imports):

```ts
import { avaTriggersGet, avaLedgerGet, avaMomentOutcome } from "./routes/ava_odl_routes";
```

Routes (inside the `/api/ava/*` block, e.g. right after the
`/api/ava/guardian/scan` line):

```ts
      if (p === "/api/ava/triggers" && req.method === "GET") return await avaTriggersGet(req, env);        // ODL: on-device trigger bank sync (D31)
      if (p === "/api/ava/ledger" && req.method === "GET") return await avaLedgerGet(req, env);            // ODL: capability cost ledger snapshot (D25)
      if (p === "/api/ava/moment-outcome" && req.method === "POST") return await avaMomentOutcome(req, env); // ODL: learning loop outcome (Constitution 11)
```

## 2. worker/src/routes/config.ts — two new flags, both default OFF

Add to the `PlatformConfig` interface:

```ts
  odlEnabled: boolean;        // Phase C: ODL wake scan from guardianScan (shadow-mode telemetry)
  avaMomentsEnabled: boolean; // Phase C: master gate for user-visible Moments (nothing posts while false)
```

Add to `DEFAULTS`:

```ts
  odlEnabled: false,          // ODL ships DARK — flip via scripts/flags.sh set odlEnabled=true
  avaMomentsEnabled: false,   // no user-visible Moments until a capability is production AND this is on
```

Notes:
- `odlEnabled` is already read (defensively, via `readConfig(env) as any`) at the
  ODL call site in `worker/src/routes/ava_guardian.ts` and defaults to OFF when
  absent, so deploying before this config change is still a no-op.
- `avaMomentsEnabled` is reserved as the master posting gate for the future
  production path (`ava_odl.ts` step 6) — declared now so the flag exists in the
  DEFAULTS source of truth before anything can read it.
- Per-capability kill switches (`avaCapMeetingEnabled`, `avaCapExpenseSplitEnabled`,
  `avaCapBirthdayEnabled`, `avaCapOtpGuardEnabled`, `avaCapOrderTrackingEnabled`,
  `avaCapTravelPlanEnabled`, `avaCapCelebrationEnabled`, `avaCapReminderEnabled`)
  do NOT need DEFAULTS entries: absent = allowed, explicitly `false` in the KV
  blob = capability off (checked in `ava_odl.ts`). Add them to DEFAULTS only if
  you want them visible in `GET /api/config`.
