// Phase 7 A2 — test clock. Every now() in the refund/settlement engine goes
// through here. In STAGING (TEST_CLOCK_ALLOWED="1") an offset can be applied:
//   - statically  via the TEST_CLOCK_OFFSET_MS var, and/or
//   - live        via POST /api/admin/test-clock (stored in KV `test_clock_offset`)
// so R1/R2/R4/R5 are testable in minutes. PRODUCTION REFUSES the offset: when
// TEST_CLOCK_ALLOWED is unset the offset is hard-zero regardless of vars/KV.
import type { Env } from "./types";
import { json } from "./util";

export async function nowMs(env: Env): Promise<number> {
  if (env.TEST_CLOCK_ALLOWED !== "1") return Date.now();
  let off = Math.trunc(Number(env.TEST_CLOCK_OFFSET_MS || 0)) || 0;
  try {
    const kv = await env.TOKENS.get("test_clock_offset");
    if (kv) off += Math.trunc(Number(kv)) || 0;
  } catch { /* best-effort */ }
  return Date.now() + off;
}

/** POST /api/admin/test-clock {offset_ms} — staging only; admin gate applied by caller. */
export async function setTestClock(req: Request, env: Env): Promise<Response> {
  if (env.TEST_CLOCK_ALLOWED !== "1") {
    return json({ error: "test clock refused", reason: "production worker (TEST_CLOCK_ALLOWED unset)" }, 403);
  }
  const b = (await req.json().catch(() => ({}))) as any;
  const off = Math.trunc(Number(b.offset_ms ?? 0)) || 0;
  await env.TOKENS.put("test_clock_offset", String(off));
  return json({ ok: true, offset_ms: off, now: await nowMs(env) });
}
