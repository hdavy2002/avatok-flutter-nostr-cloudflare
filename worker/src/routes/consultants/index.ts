// [AUMFE-CONSULT-FOUNDATION-1 2026-10-02] Real Consultants — one dispatcher for /api/consultants/*.
// Each lane owns ONE module below; this file and the order of the list are frozen (append-only).
// Spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md
import type { Env } from "../../types";
import { json } from "../../util";
import { publicRoutes } from "./public";     // lane W1 — consultants, slots, reviews (read)
import { bookingsRoutes } from "./bookings"; // lane W1 — create / pay / my bookings / cancel
import { fileRoutes } from "./file";         // lane W2 — photo upload, customer file, card edits, rerun
import { deskRoutes } from "./desk";         // lane W4 — consultant profile, availability, rate, bookings list, customers, earnings
import { callRoutes } from "./call";         // lane W3 — call ticket (WebSocket is routed in index.ts → callWs)
import { reviewRoutes } from "./review";     // lane W3 — review token page + submit
import { adminRoutes } from "./admin";       // lane W4 — promote/attach, publish/pause, bookings, refunds, review moderation

const MODULES = [publicRoutes, bookingsRoutes, fileRoutes, deskRoutes, callRoutes, reviewRoutes, adminRoutes];

export async function consultRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  if (!p.startsWith("/api/consultants/")) return null;
  for (const m of MODULES) {
    const r = await m(req, env, p, ctx);
    if (r) return r;
  }
  return json({ error: "not_found" }, 404);
}
