// [AGENT-LIVE-1] Dispatcher for everything under `/api/agents…`
// (Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md §3 "Worker API surface", §9
// "Dispatcher contract"). Mounted from `worker/src/index.ts`:
//
//   if (p.startsWith("/api/agents")) {
//     const r = await routeAgentLive(req, env, ctx, url);
//     if (r) return r;
//   }
//
// Route table below is method + regex -> handler, checked in order (more
// specific literal segments — admin/bookings/talk namespaces — before the
// generic `/api/agents/:id...` customer routes so ":id" never swallows
// "admin", "list", "voices" etc). Every handler has the shared
// `AgentLiveHandler` signature from lib/agent_live/types.ts.
//
// WS ownership: admin.ts + public.ts = WS-C, checkout.ts = WS-D, talk.ts =
// WS-E1, media.ts = WS-E2. Each currently exists as a `// STUB — owned by
// WS-<x>` file created by WS-A only so this dispatcher (and `tsc`) has
// something to import while those workstreams build the real handlers at
// the same path — WS-A does not implement any of them.
import type { Env } from "../../types";
import type { AgentLiveHandler } from "../../lib/agent_live/types";
import { json } from "../../util";

import {
  agentAdminList,
  agentAdminCreate,
  agentAdminGet,
  agentAdminPatch,
  agentAdminPublish,
  agentAdminKbUpload,
  agentAdminKbList,
  agentAdminKbDelete,
  agentAdminTestCall,
  agentAdminVoices,
} from "./admin";
import { agentPublicGet, agentAvailability } from "./public";
import {
  agentQuote,
  agentBook,
  agentBookingCancel,
  agentBookingsMine,
  agentBookingGet,
} from "./checkout";
import { agentTalkPrejoin, agentTalkWs } from "./talk";
import { agentTalkImageUpload, agentMemoryForget } from "./media";

export { runAgentLiveSweeps } from "../../lib/agent_live/money";

interface Route {
  method: string;
  // Named capture groups become `params` keys.
  re: RegExp;
  handler: AgentLiveHandler;
}

const ROUTES: Route[] = [
  // --- Admin (requireAgentAdmin — enforced inside each handler) ---
  { method: "GET", re: /^\/api\/agents\/admin\/list$/, handler: agentAdminList },
  { method: "POST", re: /^\/api\/agents\/admin$/, handler: agentAdminCreate },
  { method: "GET", re: /^\/api\/agents\/admin\/voices$/, handler: agentAdminVoices },
  {
    method: "POST",
    re: /^\/api\/agents\/admin\/(?<id>[^/]+)\/publish$/,
    handler: agentAdminPublish,
  },
  {
    method: "POST",
    re: /^\/api\/agents\/admin\/(?<id>[^/]+)\/kb$/,
    handler: agentAdminKbUpload,
  },
  {
    method: "GET",
    re: /^\/api\/agents\/admin\/(?<id>[^/]+)\/kb$/,
    handler: agentAdminKbList,
  },
  {
    method: "DELETE",
    re: /^\/api\/agents\/admin\/(?<id>[^/]+)\/kb\/(?<fileId>[^/]+)$/,
    handler: agentAdminKbDelete,
  },
  {
    method: "POST",
    re: /^\/api\/agents\/admin\/(?<id>[^/]+)\/test-call$/,
    handler: agentAdminTestCall,
  },
  { method: "GET", re: /^\/api\/agents\/admin\/(?<id>[^/]+)$/, handler: agentAdminGet },
  { method: "PATCH", re: /^\/api\/agents\/admin\/(?<id>[^/]+)$/, handler: agentAdminPatch },

  // --- Bookings (customer, Clerk requireUser inside each handler) ---
  {
    method: "POST",
    re: /^\/api\/agents\/bookings\/(?<bookingId>[^/]+)\/cancel$/,
    handler: agentBookingCancel,
  },
  { method: "GET", re: /^\/api\/agents\/bookings\/mine$/, handler: agentBookingsMine },
  {
    method: "GET",
    re: /^\/api\/agents\/bookings\/(?<bookingId>[^/]+)$/,
    handler: agentBookingGet,
  },

  // --- Talk (browser <-> AgentLiveRoom DO) ---
  {
    method: "POST",
    re: /^\/api\/agents\/talk\/(?<bookingId>[^/]+)\/prejoin$/,
    handler: agentTalkPrejoin,
  },
  {
    method: "GET",
    re: /^\/api\/agents\/talk\/(?<bookingId>[^/]+)\/ws$/,
    handler: agentTalkWs,
  },
  {
    method: "POST",
    re: /^\/api\/agents\/talk\/(?<bookingId>[^/]+)\/image$/,
    handler: agentTalkImageUpload,
  },

  // --- Public persona card / availability / quote / book / memory ---
  {
    method: "GET",
    re: /^\/api\/agents\/(?<id>[^/]+)\/availability$/,
    handler: agentAvailability,
  },
  { method: "POST", re: /^\/api\/agents\/(?<id>[^/]+)\/quote$/, handler: agentQuote },
  { method: "POST", re: /^\/api\/agents\/(?<id>[^/]+)\/book$/, handler: agentBook },
  {
    method: "DELETE",
    re: /^\/api\/agents\/(?<id>[^/]+)\/memory\/me$/,
    handler: agentMemoryForget,
  },
  // Catch-all — must stay LAST: a single path segment after /api/agents/.
  { method: "GET", re: /^\/api\/agents\/(?<id>[^/]+)$/, handler: agentPublicGet },
];

/**
 * Matches `url.pathname` + `req.method` against the table above. Returns
 * `null` only when the path is not under `/api/agents`, so the caller can
 * `if (r) return r;` without this dispatcher swallowing unrelated routes. A
 * path that IS under `/api/agents` but matches no route (or the wrong
 * method) gets a real 404 from here, not a fall-through.
 */
export async function routeAgentLive(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/agents")) return null;

  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    const m = route.re.exec(p);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.groups ?? {})) {
      if (v !== undefined) params[k] = decodeURIComponent(v);
    }
    return route.handler(req, env, ctx, params);
  }

  return json({ error: "agent_live_route_not_found" }, 404);
}
