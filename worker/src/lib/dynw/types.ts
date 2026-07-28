// [DYNW-CORE-1] Minimal structural types for the Cloudflare Worker Loader binding
// (Dynamic Workers). Our @cloudflare/workers-types pin does not ship these yet,
// so we declare exactly the surface we use, per the API reference:
// https://developers.cloudflare.com/dynamic-workers/api-reference/
//
// IMPORTANT: nothing outside lib/dynw/ may import these — env.LOADER is only
// touched by lib/dynw/host.ts (see Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md §2.2).

/** A module map entry: plain string (name's extension decides type) or typed object. */
export type DynModule =
  | string
  | { js: string }
  | { cjs: string }
  | { py: string }
  | { text: string }
  | { json: object };

/** WorkerCode — the object load()/get() callbacks return. */
export interface DynWorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, DynModule>;
  /** Capability stubs (ctx.exports loopbacks) and structured-clonable data ONLY. */
  env?: Record<string, unknown>;
  /** null = no network at all. Omitting inherits the parent's network — never do that here. */
  globalOutbound?: unknown | null;
  /** Tail workers observing the dynamic Worker's logs. */
  tails?: unknown[];
}

/** Entrypoint stub — fetch() plus arbitrary RPC methods the dynamic Worker exports. */
export interface DynEntrypointStub {
  fetch(req: Request): Promise<Response>;
  // RPC methods are dynamic by nature; callers cast the specific method they expect.
  [method: string]: unknown;
}

/** WorkerStub returned by load()/get(). */
export interface DynWorkerStub {
  getEntrypoint(name?: string): DynEntrypointStub;
  getDurableObjectClass?(name: string): unknown;
}

/** The `worker_loaders` binding (env.LOADER). */
export interface WorkerLoaderBinding {
  load(code: DynWorkerCode): DynWorkerStub;
  get(id: string, cb: () => Promise<DynWorkerCode> | DynWorkerCode): DynWorkerStub;
}

/** Result envelope every runDynamic() call resolves to (never throws). */
export interface DynResult<T = unknown> {
  ok: boolean;
  /** RPC return value when ok. */
  result?: T;
  /** Stable machine-readable failure code when !ok. */
  error?:
    | "flag_off"
    | "area_flag_off"
    | "timeout"
    | "script_error"
    | "load_error";
  /** Human detail (script error message, capped) — safe for telemetry, never contains user content. */
  detail?: string;
  wall_ms: number;
}
