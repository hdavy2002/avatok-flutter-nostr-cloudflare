// call_authority.ts — thin, FAIL-OPEN client helpers for CallStateAuthorityDO
// (worker/src/do/call_state_authority.ts). See Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md
// §2 (API), §3 (receptionist), §8B (telemetry).
//
// ABSOLUTE SAFETY CONTRACT — read before touching this file:
//   1. FAIL-OPEN: every helper below is wrapped in try/catch + a hard timeout.
//      ANY error, throw, or slow DO response resolves to `null` — it can NEVER
//      throw into a caller, and it can NEVER block/slow down a real call beyond
//      the timeout budget.
//   2. FLAG-GATED: callers MUST check `authorityEnabled(cfg)` (or a specific
//      flag) before invoking a mutation helper. This module itself doesn't read
//      config — the call-site decides, per §5.3 (shadow → read → write → enforced).
//   3. OBSERVE, DON'T OVERRIDE: while `authorityEnforced` is false, a caller may
//      use these helpers to WATCH/RECORD (shadow) but must never let the
//      authority's verdict change legacy behavior.
import type { Env } from "../types";
import { track } from "../hooks";

const AUTHORITY_TIMEOUT_MS = 1500;

/** Subset of PlatformConfig this module cares about — kept structurally typed
 *  so callers can pass the real PlatformConfig without an import cycle. */
export interface AuthorityFlags {
  authorityShadowEnabled?: boolean;
  authorityReadEnabled?: boolean;
  authorityWriteEnabled?: boolean;
  authorityEnforced?: boolean;
}

/** True if ANY of the 3 rollout flags is on (shadow/read/write). Enforced
 *  implies write is meaningful too, but we don't require it be set alone. */
export function authorityEnabled(cfg: AuthorityFlags | null | undefined): boolean {
  if (!cfg) return false;
  return cfg.authorityShadowEnabled === true
    || cfg.authorityReadEnabled === true
    || cfg.authorityWriteEnabled === true;
}

/** DO stub for the account's CallStateAuthorityDO, keyed by account_uid
 *  (idFromName), mirroring the CALL_ROOMS/GROUP_CALL_ROOMS pattern in index.ts.
 *  Never throws — returns null if the binding is missing/misconfigured. */
export function getAuthorityStub(env: Env, accountUid: string): DurableObjectStub | null {
  try {
    if (!env.CALL_STATE_AUTHORITY || !accountUid) return null;
    return env.CALL_STATE_AUTHORITY.get(env.CALL_STATE_AUTHORITY.idFromName(accountUid));
  } catch {
    return null;
  }
}

/** Races a promise against a hard timeout; resolves `null` on timeout instead
 *  of leaving the caller hanging on a slow/hibernating DO. */
function withTimeout<T>(p: Promise<T>, ms = AUTHORITY_TIMEOUT_MS): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, ms);
    p.then((v) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
    }).catch(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    });
  });
}

/** Generic best-effort POST to a DO endpoint. Never throws; returns the parsed
 *  JSON body, or null on ANY failure (network, non-JSON, non-2xx, timeout). */
async function postAuthority(
  env: Env,
  accountUid: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const stub = getAuthorityStub(env, accountUid);
    if (!stub) return null;
    const result = await withTimeout(
      stub.fetch(new Request(`https://do/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })),
    );
    if (!result) return null;
    if (!(result as Response).ok) return null;
    const json = await (result as Response).json().catch(() => null);
    return (json ?? null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** POST /acquire — claim a call for accountUid's authority. Fail-open: null on
 *  any error means "authority has no opinion", NEVER "call is busy". */
export async function authorityAcquire(
  env: Env,
  accountUid: string,
  args: {
    peer: string;
    call_id: string;
    direction: "in" | "out";
    rtc_provider?: string;
    owner_session_id?: string;
    owner_device_id?: string;
    mutation_uuid?: string;
    expected_epoch?: number;
  },
): Promise<Record<string, unknown> | null> {
  return postAuthority(env, accountUid, "acquire", args);
}

/** POST /transition — move accountUid's authority to a new phase (CAS). */
export async function authorityTransition(
  env: Env,
  accountUid: string,
  args: {
    to: string;
    from?: string;
    reason?: string;
    mutation_uuid?: string;
    expected_epoch?: number;
  },
): Promise<Record<string, unknown> | null> {
  return postAuthority(env, accountUid, "transition", args);
}

/** GET|POST /query — read-only busy/phase snapshot for accountUid. Uses the
 *  POST fallback (handleQuery accepts POST too) so we can reuse postAuthority. */
export async function authorityQuery(
  env: Env,
  accountUid: string,
): Promise<Record<string, unknown> | null> {
  return postAuthority(env, accountUid, "query", {});
}

/** POST /reserve-callback — reserve a short callback window with a peer. */
export async function authorityReserveCallback(
  env: Env,
  accountUid: string,
  args: {
    peer: string;
    call_id?: string;
    ttl_ms?: number;
    mutation_uuid?: string;
    expected_epoch?: number;
  },
): Promise<Record<string, unknown> | null> {
  return postAuthority(env, accountUid, "reserve-callback", args);
}

/** POST /preempt-callback — ask whether `caller` may preempt accountUid's
 *  current RECEPTIONIST_ACTIVE session to get a live callback. */
export async function authorityPreemptForCallback(
  env: Env,
  accountUid: string,
  args: {
    caller: string;
    call_id?: string;
    mutation_uuid?: string;
    expected_epoch?: number;
  },
): Promise<Record<string, unknown> | null> {
  return postAuthority(env, accountUid, "preempt-callback", args);
}

/** POST /abandon-receptionist — cleanly end a receptionist session and return
 *  accountUid's authority to idle. */
export async function authorityAbandonReceptionist(
  env: Env,
  accountUid: string,
  args: {
    reason?: string;
    mutation_uuid?: string;
    expected_epoch?: number;
  } = {},
): Promise<Record<string, unknown> | null> {
  return postAuthority(env, accountUid, "abandon-receptionist", args);
}

/** POST /release — release the current call and return accountUid's authority
 *  to idle (used at session finalize, general call teardown, etc.). */
export async function authorityRelease(
  env: Env,
  accountUid: string,
  args: {
    reason?: string;
    mutation_uuid?: string;
    expected_epoch?: number;
  } = {},
): Promise<Record<string, unknown> | null> {
  return postAuthority(env, accountUid, "release", args);
}

/** §8B shadow/telemetry emit. Reuses the SAME best-effort PostHog mechanism the
 *  rest of the codebase uses (hooks.ts `track`), so this can never throw and
 *  never introduces a second telemetry pipeline. Caller passes its own `env`,
 *  `uid` (whoever's perspective this event is recorded from), and props. */
export async function shadowRecord(
  env: Env,
  uid: string,
  event: string,
  props: Record<string, unknown> = {},
): Promise<void> {
  try {
    await track(env, uid, event, "call_authority", props);
  } catch {
    // best-effort — telemetry must never affect call flow
  }
}
