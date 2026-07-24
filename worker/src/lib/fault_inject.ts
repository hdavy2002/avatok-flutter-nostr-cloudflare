// [TEST-FAILURE-INJECT-1] Server-side failure injection (F11, v1).
//
// ENV-ONLY switch, deliberately NOT a KV/config flag: `readConfig()` merges KV
// overrides on top of DEFAULTS and any client-visible key can in principle be
// flipped remotely (see the config.ts DEFAULTS/putConfig contract). Failure
// injection must NEVER be something a KV write (or a compromised/careless
// `scripts/flags.sh set`) can turn on in production — it can only be enabled by
// setting the FAULT_INJECT var in wrangler.toml (or a workers.dev preview
// binding) and REDEPLOYING. There is intentionally no code path from
// routes/config.ts into this file.
//
// Usage at a call site (2-3 lines, no behavior change when FAULT_INJECT is unset):
//   import { shouldFail } from "../lib/fault_inject";
//   if (shouldFail(env, "media_upload_private")) throw new Error("fault_inject:media_upload_private");
import type { Env } from "../types";

/**
 * True when `point` is named in the comma-separated env.FAULT_INJECT list.
 * Pure string check — always false when the var is unset/empty, so a call site
 * that guards on this function is a strict no-op in every environment that
 * hasn't explicitly set FAULT_INJECT (which today is every deployed environment).
 */
export function shouldFail(env: Env, point: string): boolean {
  const raw = (env as unknown as { FAULT_INJECT?: string }).FAULT_INJECT;
  if (!raw || typeof raw !== "string") return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(point);
}
