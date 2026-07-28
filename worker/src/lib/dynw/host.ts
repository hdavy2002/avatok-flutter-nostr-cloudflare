// [DYNW-CORE-1] The ONLY entry point for executing dynamically-loaded code
// (Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md §2.2). Nothing outside this file
// may touch env.LOADER.
//
// Guarantees enforced here, for every run:
//   • master kill switch (dynamicWorkersEnabled) + per-area flag — fail-closed;
//   • NO NETWORK by default: globalOutbound is null unless the caller explicitly
//     passes an interceptor stub (none exist in Phase 0);
//   • wall-clock timeout (default 5 s) — a hung script cannot pin the request;
//   • never throws: every outcome is a DynResult envelope;
//   • telemetry: one `dyn_worker_run` PostHog event per run (uid/email carried by
//     the analytics pipeline), failures additionally via trackException. No user
//     content, message bodies, or secrets in telemetry props.
//
// Dynamic-module calling convention (Phase 0): the module's main module default-
// exports a class extending WorkerEntrypoint with an async `run(input)` method.
// TODO(DYNW): per-isolate CPU limits — Cloudflare "Custom limits" for Dynamic
// Workers (docs: /dynamic-workers/usage/limits/) — adopt once we pin the exact
// WorkerCode field on a staging probe; wall-clock timeout guards until then.
import type { Env } from "../../types";
import type { PlatformConfig } from "../../routes/config";
import { readConfig } from "../../routes/config";
import { track, trackException } from "../../hooks";
import type { DynResult, DynWorkerCode, DynModule } from "./types";

export type DynArea =
  | "acceptance"      // Phase 0 staging acceptance battery (master flag only)
  | "codemode"        // WS-1
  | "recept_rules"    // WS-2
  | "marketplace"     // WS-4
  | "call_routing"    // WS-9
  | "creator_tools";  // WS-8

const AREA_FLAG: Record<DynArea, keyof PlatformConfig | null> = {
  acceptance: null,
  codemode: "dynCodeModeEnabled",
  recept_rules: "dynReceptionistRulesEnabled",
  marketplace: "dynMarketplaceFlowsEnabled",
  call_routing: "dynCallRoutingEnabled",
  creator_tools: "dynCreatorAgentToolsEnabled",
};

/** Compatibility date for CHILD isolates (independent of this Worker's own date). */
const CHILD_COMPAT_DATE = "2026-06-22";

export interface DynRunOpts {
  area: DynArea;
  /** Stable id INCLUDING a content hash — same id must always mean same code. */
  codeId: string;
  uid: string; // for telemetry attribution (the acting account)
  modules: Record<string, DynModule>;
  mainModule: string;
  /** Capability stubs (ctx.exports loopbacks) + structured data only. */
  env?: Record<string, unknown>;
  /** Named entrypoint export to invoke; default export when omitted. */
  entrypoint?: string;
  /** RPC method on the entrypoint. Default "run". */
  method?: string;
  input?: unknown;
  /** Explicit egress interceptor stub. OMIT for no network (the default). */
  outbound?: unknown;
  timeoutMs?: number; // default 5000
}

export async function runDynamic<T = unknown>(
  env: Env,
  ctx: ExecutionContext,
  opts: DynRunOpts,
): Promise<DynResult<T>> {
  const t0 = Date.now();
  const done = (r: Omit<DynResult<T>, "wall_ms">): DynResult<T> => {
    const res = { ...r, wall_ms: Date.now() - t0 } as DynResult<T>;
    try {
      ctx.waitUntil(track(env, opts.uid, "dyn_worker_run", "avatok", {
        area: opts.area,
        code_id: opts.codeId,
        ok: res.ok,
        error: res.error ?? null,
        wall_ms: res.wall_ms,
      }));
    } catch { /* telemetry must never break the run */ }
    return res;
  };

  // ── flags (fail-closed) ────────────────────────────────────────────────────
  let cfg: PlatformConfig;
  try { cfg = await readConfig(env); } catch { return done({ ok: false, error: "flag_off", detail: "config unreadable" }); }
  if (!cfg.dynamicWorkersEnabled) return done({ ok: false, error: "flag_off" });
  const areaFlag = AREA_FLAG[opts.area];
  if (areaFlag && cfg[areaFlag] !== true) return done({ ok: false, error: "area_flag_off" });

  // ── load ──────────────────────────────────────────────────────────────────
  let entry: { [m: string]: unknown };
  try {
    const stub = env.LOADER.get(opts.codeId, (): DynWorkerCode => ({
      compatibilityDate: CHILD_COMPAT_DATE,
      mainModule: opts.mainModule,
      modules: opts.modules,
      env: opts.env ?? {},
      // Default-deny egress: null = fetch()/connect() throw inside the sandbox.
      globalOutbound: opts.outbound !== undefined ? opts.outbound : null,
    }));
    entry = stub.getEntrypoint(opts.entrypoint);
  } catch (e) {
    void trackException(env, e instanceof Error ? e : new Error(String(e)), {
      uid: opts.uid, route: "dynw.host", method: "load", handled: true,
      extra: { area: opts.area, code_id: opts.codeId },
    });
    return done({ ok: false, error: "load_error", detail: String(e).slice(0, 200) });
  }

  // ── invoke with wall-clock guard ──────────────────────────────────────────
  const method = opts.method ?? "run";
  const timeoutMs = Math.min(Math.max(250, opts.timeoutMs ?? 5000), 30_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("dynw_timeout")), timeoutMs);
  });
  try {
    const fn = entry[method];
    if (typeof fn !== "function") {
      return done({ ok: false, error: "script_error", detail: `entrypoint has no method '${method}'` });
    }
    const result = (await Promise.race([
      (fn as (input: unknown) => Promise<unknown>).call(entry, opts.input),
      timeout,
    ])) as T;
    return done({ ok: true, result });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg.includes("dynw_timeout")) return done({ ok: false, error: "timeout" });
    // Script errors are EXPECTED for untrusted code — handled, but visible.
    void trackException(env, e instanceof Error ? e : new Error(msg), {
      uid: opts.uid, route: "dynw.host", method: "invoke", handled: true,
      extra: { area: opts.area, code_id: opts.codeId },
    });
    return done({ ok: false, error: "script_error", detail: msg.slice(0, 200) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
