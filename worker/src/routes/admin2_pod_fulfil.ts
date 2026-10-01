// [AUMFE-POD-FULFIL-1 2026-10-01] Admin 2 -- send a paid shop order to the print partner (Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md §6.2).
// Spread into ADMIN2_ROUTES by routes/admin2.ts ("ADMIN2_POD_FULFIL_ROUTES", wired by AUMFE-POD-CORE-1). All under /api/admin/v2/shop/.
//   POST orders/:id/send-to-production {confirm:true}
//   POST orders/:id/production/retry · POST orders/:id/production/resolve {action:'resend'|'manual'|'cancel'}
//   GET  orders/:id/production
// The work is in lib/pod_fulfil.ts; this file is the guard, the body checks and the HTTP mapping.
// NOTE: only a TYPE is imported from ./admin2 (admin2 imports this file at runtime -- no value cycle).
import type { Env } from "../types";
import type { Admin2RouteDef } from "./admin2";
import { json } from "../util";
import { track } from "../hooks";
import { requireAdmin } from "./admin_money";
import { SHOP_ORDER_ID_RE } from "../lib/shop_orders_logic";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import {
  describeShipment, loadFulfilmentEvents, loadOrderExtras, moneyAndProduction, resolveProduction, sendOrderToPartner, type SendResult,
} from "../lib/pod_fulfil";
import { loadShopOrder } from "./shop_orders";

const APP = "saathum";
const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);

async function admin(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try { const v = await req.json(); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}

async function productionPayload(env: Env, orderId: string) {
  const row = await loadShopOrder(env, orderId);
  if (!row) return null;
  const x = await loadOrderExtras(env, [row]);
  const wa = await verifiedWhatsAppNumber(env, row.uid).catch(() => null);
  const mp = moneyAndProduction(row, x, wa);
  return { money: mp.money, production: mp.production, events: await loadFulfilmentEvents(env, orderId), shipment: await describeShipment(env, row) };
}

function reply(r: SendResult, payload: object): Response {
  if (r.ok) return json({ ok: true, adopted: r.adopted, ...payload });
  return err(r.status, r.error, r.message, r.extra ?? {});
}

async function sendToProduction(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const b = await readBody(req);
  if (b?.confirm !== true) return err(400, "confirm_required", "Please confirm you want to send this order to production.");
  const r = await sendOrderToPartner(env, id, a.uid);
  await track(env, a.uid, "admin2_pod_send_to_production", APP, { order_id: id, ok: r.ok, error: r.ok ? null : r.error });
  return reply(r, (await productionPayload(env, id)) ?? {});
}

async function retry(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const r = await sendOrderToPartner(env, id, a.uid, { retry: true });
  await track(env, a.uid, "admin2_pod_production_retry", APP, { order_id: id, ok: r.ok, error: r.ok ? null : r.error });
  return reply(r, (await productionPayload(env, id)) ?? {});
}

async function resolve(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const b = await readBody(req);
  const action = b?.action;
  if (action !== "resend" && action !== "manual" && action !== "cancel") return err(400, "invalid_action", "Action must be resend, manual or cancel.");
  const r = await resolveProduction(env, id, action, a.uid);
  await track(env, a.uid, "admin2_pod_production_resolve", APP, { order_id: id, action, ok: r.ok, error: r.ok ? null : r.error });
  return reply(r, (await productionPayload(env, id)) ?? {});
}

async function getProduction(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const p = await productionPayload(env, id);
  if (!p) return err(404, "not_found", "No such order.");
  return json(p, 200, { "cache-control": "private, no-store" });
}

const ID = "([^/]+)";
const B = "/api/admin/v2/shop";
const guardId = (h: (req: Request, env: Env, id: string) => Promise<Response>) =>
  (req: Request, env: Env, [id]: string[]) => (SHOP_ORDER_ID_RE.test(id) ? h(req, env, id) : Promise.resolve(err(404, "not_found", "No such order.")));

export const ADMIN2_POD_FULFIL_ROUTES: Admin2RouteDef[] = [
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/send-to-production$`), handler: guardId(sendToProduction) },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/production/retry$`), handler: guardId(retry) },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/production/resolve$`), handler: guardId(resolve) },
  { method: "GET", path: new RegExp(`^${B}/orders/${ID}/production$`), handler: guardId(getProduction) },
];
