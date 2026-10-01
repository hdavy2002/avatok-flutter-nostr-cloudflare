// [AUMFE-POD-FULFIL-1 2026-10-01] Send paid shop orders to the print partner and keep their status in sync
// (Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md §6). All partner talk goes through lib/pod (getPodProvider) -- no partner
// field name appears here. Rules this file enforces:
//   * nothing is sent until shop_orders.pay_status='confirmed' (the money rule);
//   * sending is idempotent: ONE shop_fulfilments row per order (first writer wins), reference_number = order_no, and
//     findOrderByReference() runs before createOrder() so a retry after a lost response adopts instead of duplicating;
//   * buyer messages reuse lib/shop_notify.ts notifyShopTransition -- the same helper the admin's manual buttons call;
//   * every failure is recorded (row + event + PostHog + owner alert); nothing is swallowed.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { track, trackException } from "../hooks";
import { readConfig } from "../routes/config";
import { emailFor } from "./identity";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { orderItems, type ShopOrderRow } from "./shop_orders_logic";
import type { Address } from "./saathum_checkout_logic";
import { notifyShopTransition, alertOwnerFulfilmentProblem } from "./shop_notify";
import { loadShopOrder, appendShopEvent } from "../routes/shop_orders";
import {
  getPodProvider, splitAddressForPartner, deliveryPhone10, PRINT_SPECS, PodError,
  type FulfilmentOrder, type NormalisedStatus, type PodProvider, type PrintPlacement,
} from "./pod";
import {
  AUTO_SEND_GRACE_MS, AUTO_SEND_PER_TICK, BACKOFF_MS, POLL_PER_TICK, deriveMoney, deriveProduction, mapPartnerState, moneyIsConfirmed,
  nextAttemptAt, placementForPartner, pollDue, type FulfilmentLite, type FulfilmentStatus, type Money, type MoneySms, type Production,
} from "./pod_fulfil_logic";

export * from "./pod_fulfil_logic";

const APP = "saathum";
const JSON_CAP = 6000;
const cap = (v: unknown): string => { let s: string; try { s = JSON.stringify(v) ?? "null"; } catch { s = '"[unserialisable]"'; } return s.length > JSON_CAP ? s.slice(0, JSON_CAP) : s; };
const parse = <T>(s: string | null | undefined, fallback: T): T => { if (!s) return fallback; try { return (JSON.parse(s) ?? fallback) as T; } catch { return fallback; } };
const lower = (s: string): string => s.trim().toLowerCase();
const maskPhone = (p: string | null): string | null => (p ? `+91 ••••• •${p.slice(-4)}` : null);

async function safely<T>(env: Env, route: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { await trackException(env, e, { route: `pod_fulfil:${route}`, handled: true, app_name: APP }); return fallback; }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export type ProviderInfo = { id: string; label: string; supportsApi: boolean };
const MANUAL: ProviderInfo = { id: "manual", label: "By hand", supportsApi: false };

export async function providerInfo(env: Env): Promise<ProviderInfo> {
  try {
    // shopPodProvider is declared in config.ts DEFAULTS (AUMFE-POD-CORE-1); read loosely so a bad override falls back to manual.
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (String(cfg.shopPodProvider ?? "manual") === "manual") return MANUAL;
    const p = await getPodProvider(env);
    return { id: p.id, label: p.label, supportsApi: p.supportsApi };
  } catch (e) {
    await trackException(env, e, { route: "pod_fulfil:provider_info", handled: true, app_name: APP });
    return MANUAL;
  }
}

async function podConfig(env: Env): Promise<{ autoSend: boolean; pollMinutes: number }> {
  // shopPodAutoSend / shopPodPollMinutes are declared in config.ts DEFAULTS (AUMFE-POD-CORE-1).
  const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
  const pm = Number(cfg.shopPodPollMinutes);
  return { autoSend: cfg.shopPodAutoSend === true, pollMinutes: Number.isFinite(pm) && pm > 0 ? pm : 30 };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
export type FulfilmentRow = {
  order_id: string; provider: string; reference_number: string; provider_order_id: string | null; status: FulfilmentStatus;
  request_json: string | null; last_response_json: string | null; provider_status: string | null; courier: string | null; awb: string | null;
  tracking_url: string | null; attempts: number; next_attempt_at: number | null; last_polled_at: number | null; last_error: string | null;
  sent_by: string | null; created_at: number; updated_at: number;
};
type MapRow = { product_id: string; colour: string; size: string; provider_variant_id: string; base_cost_paise: number | null; sku: string | null };
type DesignRow = {
  product_id: string; design_id: string | null; design_version: number | null; provider_design_ref: string | null; provider_listing_ref: string | null;
  print_w: number | null; print_h: number | null; print_preview_url: string | null; placement_json: string | null; locked_at: number | null;
};

const mapKey = (pid: string, colour: string, size: string): string => `${pid}|${lower(colour)}|${lower(size)}`;
const placeholders = (n: number, from: number): string => Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");

async function loadFulfilments(env: Env, orderIds: string[]): Promise<Map<string, FulfilmentRow>> {
  const out = new Map<string, FulfilmentRow>();
  if (!orderIds.length) return out;
  const rs = await safely(env, "load_fulfilments", [] as FulfilmentRow[], async () =>
    (await metaDb(env).prepare(`SELECT * FROM shop_fulfilments WHERE order_id IN (${placeholders(orderIds.length, 1)})`).bind(...orderIds).all<FulfilmentRow>()).results ?? []);
  for (const r of rs) out.set(r.order_id, r);
  return out;
}

async function loadVariantMaps(env: Env, productIds: string[], provider: string): Promise<Map<string, MapRow>> {
  const out = new Map<string, MapRow>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return out;
  const rs = await safely(env, "load_variant_map", [] as MapRow[], async () =>
    (await metaDb(env).prepare(
      `SELECT product_id, colour, size, provider_variant_id, base_cost_paise, sku FROM pod_variant_map WHERE provider=?1 AND active=1 AND product_id IN (${placeholders(ids.length, 2)})`,
    ).bind(provider, ...ids).all<MapRow>()).results ?? []);
  for (const r of rs) out.set(mapKey(r.product_id, r.colour, r.size), r);
  return out;
}

async function loadDesigns(env: Env, productIds: string[], provider: string): Promise<Map<string, DesignRow>> {
  const out = new Map<string, DesignRow>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return out;
  const db = metaDb(env);
  const viaListing = await safely(env, "load_designs_listing", [] as DesignRow[], async () =>
    (await db.prepare(
      `SELECT l.product_id AS product_id, l.design_id AS design_id, l.design_version AS design_version, l.provider_design_ref AS provider_design_ref,
              l.provider_listing_ref AS provider_listing_ref, d.print_w AS print_w, d.print_h AS print_h, d.print_preview_url AS print_preview_url,
              d.placement_json AS placement_json, d.locked_at AS locked_at
         FROM pod_listings l LEFT JOIN studio_designs d ON d.id=l.design_id
        WHERE l.provider=?1 AND l.product_id IN (${placeholders(ids.length, 2)})`,
    ).bind(provider, ...ids).all<DesignRow>()).results ?? []);
  for (const r of viaListing) out.set(r.product_id, r);
  const missing = ids.filter((i) => !out.has(i));
  if (missing.length) {
    const viaDesign = await safely(env, "load_designs_direct", [] as DesignRow[], async () =>
      (await db.prepare(
        `SELECT product_id, id AS design_id, version AS design_version, NULL AS provider_design_ref, NULL AS provider_listing_ref,
                print_w, print_h, print_preview_url, placement_json, locked_at
           FROM studio_designs WHERE product_id IN (${placeholders(missing.length, 1)})`,
      ).bind(...missing).all<DesignRow>()).results ?? []);
    for (const r of viaDesign) out.set(r.product_id, r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What WILL be sent -- shared by the send, the list's can_send and the detail panel's "What Printrove gets"
// ---------------------------------------------------------------------------
export type Blocker = { code: "variant_unmapped" | "address_unfit" | "phone_missing" | "placement_missing"; message: string };

export type ShipmentLine = {
  name: string; colour: string; size: string; qty: number;
  print: { design_id: string | null; version: number | null; width_px: number | null; height_px: number | null; preview_url: string | null; shape: string | null; locked: boolean } | null;
  placement: PrintPlacement | null;
  partner_item: { provider_variant_id: string; base_cost_paise: number | null; sku: string | null } | null;
  problem: string | null;
};
export type ShipmentDescription = {
  provider: ProviderInfo;
  lines: ShipmentLine[];
  address: { ok: boolean; lines: string[]; pincode: string | null; serviceable: boolean | null; reason: string | null };
  phone: { ok: boolean; masked: string | null; source: "address" | "whatsapp" | null };
  blocker: Blocker | null;
  ready: boolean;
};

type Analysis = { description: ShipmentDescription; order: FulfilmentOrder | null };

function addressOf(row: ShopOrderRow): Partial<Address> { return parse<Partial<Address>>(row.address_json, {}); }

/** Cheap checks only (no designs, no network): used by the list for can_send. Returns the FIRST blocker. */
function cheapBlocker(row: ShopOrderRow, wa: string | null, maps: Map<string, MapRow>, label: string): Blocker | null {
  for (const l of orderItems(row)) {
    if (!maps.has(mapKey(l.product_id, l.colour, l.size))) {
      return { code: "variant_unmapped", message: `${l.name} · ${l.colour} · ${l.size} is not linked to a ${label} item yet. Publish it from Studio, or send this order by hand.` };
    }
  }
  const a = addressOf(row);
  const split = splitAddressForPartner({ line1: a.line1 ?? "", line2: a.line2 });
  if ((split as { ok?: boolean }).ok === false) return { code: "address_unfit", message: `The address does not fit ${label}: ${(split as { reason: string }).reason}` };
  if (!deliveryPhone10(a.phone, wa)) return { code: "phone_missing", message: `${label} needs a 10-digit delivery phone and this order has none (no phone on the address, no verified +91 WhatsApp).` };
  return null;
}

/** Everything the partner would receive for this order, plus the FulfilmentOrder itself when nothing blocks it. */
async function analyseOrder(env: Env, row: ShopOrderRow, provider: ProviderInfo, withServiceability: PodProvider | null): Promise<Analysis> {
  const items = orderItems(row);
  const a = addressOf(row);
  const [wa, email] = await Promise.all([
    verifiedWhatsAppNumber(env, row.uid).catch(() => null),
    emailFor(env, row.uid).catch(() => null),
  ]);
  const [maps, designs] = await Promise.all([
    loadVariantMaps(env, items.map((l) => l.product_id), provider.id),
    loadDesigns(env, items.map((l) => l.product_id), provider.id),
  ]);

  let blocker: Blocker | null = null;
  const lines: ShipmentLine[] = [];
  const orderLines: FulfilmentOrder["lines"] = [];
  for (const l of items) {
    const m = maps.get(mapKey(l.product_id, l.colour, l.size)) ?? null;
    const d = designs.get(l.product_id) ?? null;
    const pl = d ? parse<Record<string, unknown> | null>(d.placement_json, null) : null;
    const kind = typeof pl?.kind === "string" ? pl.kind : null;
    const side = pl?.side === "back" ? "back" : "front";
    const area = kind ? (PRINT_SPECS.areas as Record<string, { front: readonly [number, number]; back: readonly [number, number] } | undefined>)[kind]?.[side] : undefined;
    const placement = pl ? placementForPartner(pl, area ? area[0] : null) : null;
    let problem: string | null = null;
    if (!m) problem = `Not linked to a ${provider.label} item.`;
    else if (d && !placement) problem = "The design has no saved placement.";
    if (problem && !blocker) {
      blocker = m
        ? { code: "placement_missing", message: `${l.name}: ${problem} Open it in Studio and press "Looks good" again.` }
        : { code: "variant_unmapped", message: `${l.name} · ${l.colour} · ${l.size} is not linked to a ${provider.label} item yet. Publish it from Studio, or send this order by hand.` };
    }
    lines.push({
      name: l.name, colour: l.colour, size: l.size, qty: l.qty,
      print: d ? { design_id: d.design_id, version: d.design_version, width_px: d.print_w, height_px: d.print_h, preview_url: d.print_preview_url, shape: typeof pl?.shape === "string" ? pl.shape : null, locked: d.locked_at != null } : null,
      placement, partner_item: m ? { provider_variant_id: m.provider_variant_id, base_cost_paise: m.base_cost_paise, sku: m.sku } : null, problem,
    });
    if (m) {
      orderLines.push({
        provider_variant_id: m.provider_variant_id, quantity: l.qty,
        ...(d?.provider_listing_ref ? { provider_listing_ref: d.provider_listing_ref } : {}),
        ...(d?.provider_design_ref ? { design_ref: d.provider_design_ref } : {}),
        ...(placement ? { placement } : {}),
      });
    }
  }

  const split = splitAddressForPartner({ line1: a.line1 ?? "", line2: a.line2 });
  const splitOk = (split as { ok?: boolean }).ok !== false;
  const phone10 = deliveryPhone10(a.phone, wa);
  if (!splitOk && !blocker) blocker = { code: "address_unfit", message: `The address does not fit ${provider.label}: ${(split as { reason: string }).reason}` };
  if (!phone10 && !blocker) blocker = { code: "phone_missing", message: `${provider.label} needs a 10-digit delivery phone and this order has none (no phone on the address, no verified +91 WhatsApp).` };

  let serviceable: boolean | null = null;
  if (withServiceability && a.pincode) {
    try { serviceable = (await withServiceability.serviceability(a.pincode, 300 * items.reduce((s, l) => s + l.qty, 0))).ok; }
    catch (e) { await trackException(env, e, { route: "pod_fulfil:serviceability", handled: true, app_name: APP }); }
  }

  const description: ShipmentDescription = {
    provider, lines,
    address: {
      ok: splitOk,
      lines: splitOk ? [(split as { address1: string }).address1, (split as { address2: string }).address2, (split as { address3?: string }).address3].filter((x): x is string => !!x) : [],
      pincode: a.pincode ?? null, serviceable, reason: splitOk ? null : (split as { reason: string }).reason,
    },
    phone: { ok: !!phone10, masked: maskPhone(phone10), source: phone10 ? (a.phone && a.phone.replace(/\D/g, "").slice(-10) === phone10 ? "address" : "whatsapp") : null },
    blocker, ready: !blocker,
  };
  const order: FulfilmentOrder | null = blocker || !splitOk || !phone10 ? null : {
    reference_number: row.order_no, retail_price_rupees: row.total_rupees,
    customer: {
      name: a.name ?? row.contact_name ?? "Customer", email, phone10,
      address1: (split as { address1: string }).address1, address2: (split as { address2: string }).address2,
      ...((split as { address3?: string }).address3 ? { address3: (split as { address3: string }).address3 } : {}),
      city: a.city ?? "", state: a.state ?? "", pincode: a.pincode ?? "", country: "India",
    },
    lines: orderLines,
  };
  return { description, order };
}

/** The detail panel's "What the partner gets" -- exactly what sendOrderToPartner would post. */
export async function describeShipment(env: Env, row: ShopOrderRow): Promise<ShipmentDescription> {
  const info = await providerInfo(env);
  let p: PodProvider | null = null;
  if (info.supportsApi) { try { p = await getPodProvider(env); } catch (e) { await trackException(env, e, { route: "pod_fulfil:describe_provider", handled: true, app_name: APP }); } }
  return (await analyseOrder(env, row, info, p)).description;
}

// ---------------------------------------------------------------------------
// Money + production on list/detail rows
// ---------------------------------------------------------------------------
export type OrderExtras = { provider: ProviderInfo; sms: Map<string, MoneySms>; outbox: Map<string, number | null>; fulfil: Map<string, FulfilmentRow>; maps: Map<string, MapRow> };

export async function loadOrderExtras(env: Env, rows: ShopOrderRow[]): Promise<OrderExtras> {
  const db = metaDb(env);
  const provider = await providerInfo(env);
  const hashes = [...new Set(rows.map((r) => r.matched_message_hash).filter((h): h is string => !!h))];
  const ids = rows.map((r) => r.order_id);
  const confirmedIds = rows.filter((r) => r.pay_status === "confirmed").map((r) => r.order_id);
  const [sms, outbox, fulfil, maps] = await Promise.all([
    safely(env, "extras_sms", new Map<string, MoneySms>(), async () => {
      const m = new Map<string, MoneySms>();
      if (!hashes.length) return m;
      const rs = (await db.prepare(`SELECT message_hash, amount_paise, received_at_ms, bank_reference, payer_vpa FROM hdfc_sms_smoke_receipts WHERE message_hash IN (${placeholders(hashes.length, 1)})`)
        .bind(...hashes).all<MoneySms & { message_hash: string }>()).results ?? [];
      for (const r of rs) m.set(r.message_hash, r);
      return m;
    }),
    safely(env, "extras_outbox", new Map<string, number | null>(), async () => {
      const m = new Map<string, number | null>();
      if (!confirmedIds.length) return m;
      const rs = (await db.prepare(`SELECT checkout_id, status, sent_at FROM whatsapp_outbox WHERE kind='shop_order_confirmed' AND checkout_id IN (${placeholders(confirmedIds.length, 1)})`)
        .bind(...confirmedIds).all<{ checkout_id: string; status: string; sent_at: number | null }>()).results ?? [];
      for (const r of rs) m.set(r.checkout_id, r.status === "sent" ? r.sent_at : null);
      return m;
    }),
    loadFulfilments(env, ids),
    loadVariantMaps(env, rows.flatMap((r) => (r.pay_status === "confirmed" && r.fulfil_status === "new" ? orderItems(r).map((l) => l.product_id) : [])), provider.id),
  ]);
  return { provider, sms, outbox, fulfil, maps };
}

export function moneyAndProduction(row: ShopOrderRow, x: OrderExtras, wa: string | null, now = Date.now()): { money: Money; production: Production } {
  const sms = row.matched_message_hash ? (x.sms.get(row.matched_message_hash) ?? null) : null;
  const money = deriveMoney(row, sms, x.outbox.get(row.order_id) ?? null, now);
  const f = x.fulfil.get(row.order_id) ?? null;
  const lite: FulfilmentLite | null = f ? { status: f.status, provider: f.provider, provider_order_id: f.provider_order_id, courier: f.courier, awb: f.awb, tracking_url: f.tracking_url, last_error: f.last_error } : null;
  const needsBuild = moneyIsConfirmed(money.state) && row.fulfil_status === "new" && (!f || f.status === "problem") && x.provider.supportsApi;
  const buildBlocker = needsBuild ? (cheapBlocker(row, wa, x.maps, x.provider.label)?.message ?? null) : null;
  const production = deriveProduction(row.fulfil_status, lite, {
    money: money.state, providerLabel: x.provider.label, providerSupportsApi: x.provider.supportsApi, providerId: x.provider.id, buildBlocker,
  });
  return { money, production };
}

export type FulfilmentEvent = { at: number; kind: string; provider_status: string | null; note: string | null };
export async function loadFulfilmentEvents(env: Env, orderId: string): Promise<FulfilmentEvent[]> {
  return safely(env, "load_events", [] as FulfilmentEvent[], async () =>
    (await metaDb(env).prepare(`SELECT at, kind, provider_status, note FROM shop_fulfilment_events WHERE order_id=?1 ORDER BY at ASC, id ASC LIMIT 100`).bind(orderId).all<FulfilmentEvent>()).results ?? []);
}

async function fulfilEvent(env: Env, orderId: string, kind: string, providerStatus: string | null, note: string | null, at = Date.now()): Promise<void> {
  await safely(env, `event:${kind}`, undefined, async () => {
    await metaDb(env).prepare(`INSERT INTO shop_fulfilment_events (order_id, at, kind, provider_status, note) VALUES (?1,?2,?3,?4,?5)`).bind(orderId, at, kind, providerStatus, note ? note.slice(0, 500) : null).run();
  });
}

async function auditSend(env: Env, actor: string, action: string, orderId: string, meta: Record<string, unknown>): Promise<void> {
  if (actor.startsWith("system:")) return; // automatic runs are in shop_fulfilment_events, not the admin audit log
  await safely(env, "audit", undefined, async () => {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), actor, action, orderId, JSON.stringify(meta), Date.now()).run();
  });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------
export type SendResult =
  | { ok: true; fulfilment: FulfilmentRow | null; adopted: boolean }
  | { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> };
const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): SendResult => ({ ok: false, status, error, message, extra });

export type SendOpts = { auto?: boolean; retry?: boolean; dueOnly?: boolean; resetAttempts?: boolean };

async function recordProblem(env: Env, row: ShopOrderRow, provider: ProviderInfo, code: string, message: string, attempts: number, retryAt: number | null, actor: string): Promise<void> {
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO shop_fulfilments (order_id, provider, reference_number, status, attempts, next_attempt_at, last_error, sent_by, created_at, updated_at)
     VALUES (?1,?2,?3,'problem',?4,?5,?6,?7,?8,?8)
     ON CONFLICT(order_id) DO UPDATE SET status='problem', attempts=?4, next_attempt_at=?5, last_error=?6, updated_at=?8`,
  ).bind(row.order_id, provider.id, row.order_no, attempts, retryAt, message.slice(0, 500), actor, now).run();
  await fulfilEvent(env, row.order_id, "problem", null, `${code}: ${message}`, now);
  await track(env, row.uid, "shop_fulfilment_failed", APP, { code, order_id: row.order_id, provider: provider.id, attempts });
  if (attempts <= 1 || retryAt == null) await alertOwnerFulfilmentProblem(env, row, message);
}

/** Apply one shop_orders step with a compare-and-set, write the event, tell the buyer. Returns true if THIS call moved the order. */
async function advanceOrder(env: Env, orderId: string, step: "at_printer" | "shipped" | "delivered", f: { courier?: string | null; awb?: string | null; tracking_url?: string | null; eta_text?: string | null; ref?: string | null }, actor: string, now = Date.now()): Promise<boolean> {
  const db = metaDb(env);
  let sql: string; let binds: unknown[];
  if (step === "at_printer") {
    sql = `UPDATE shop_orders SET fulfil_status='at_printer', sent_to_printer_at=COALESCE(sent_to_printer_at,?2), printrove_order_ref=COALESCE(?3,printrove_order_ref), updated_at=?2
            WHERE order_id=?1 AND pay_status='confirmed' AND fulfil_status='new'`;
    binds = [orderId, now, f.ref ?? null];
  } else if (step === "shipped") {
    sql = `UPDATE shop_orders SET fulfil_status='shipped', shipped_at=?2, courier=COALESCE(?3,courier), awb=COALESCE(?4,awb), tracking_url=COALESCE(?5,tracking_url), eta_text=COALESCE(?6,eta_text), updated_at=?2
            WHERE order_id=?1 AND pay_status='confirmed' AND fulfil_status IN ('new','at_printer')`;
    binds = [orderId, now, f.courier ?? null, f.awb ?? null, f.tracking_url ?? null, f.eta_text ?? null];
  } else {
    sql = `UPDATE shop_orders SET fulfil_status='delivered', delivered_at=?2, updated_at=?2 WHERE order_id=?1 AND pay_status='confirmed' AND fulfil_status='shipped'`;
    binds = [orderId, now];
  }
  const res = await db.prepare(sql).bind(...binds).run();
  if (Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return false;
  const after = await loadShopOrder(env, orderId);
  if (!after) return true;
  const note = step === "at_printer" ? (f.ref ? `Sent to the print partner · ${f.ref}` : "Sent to the print partner") : step === "shipped" ? [f.courier, f.awb].filter(Boolean).join(" ") || null : null;
  await appendShopEvent(env, orderId, step, actor, note, now).catch((e) => trackException(env, e, { route: `pod_fulfil:${step}:event`, handled: true, app_name: APP }));
  await track(env, after.uid, "shop_order_status_changed", APP, { order_id: orderId, buyer_uid: after.uid, from: step === "at_printer" ? "new" : step === "shipped" ? "at_printer" : "shipped", to: step, notify: true, source: "print_partner" });
  await notifyShopTransition(env, step === "at_printer" ? "at-printer" : step, after);
  return true;
}

export async function sendOrderToPartner(env: Env, orderId: string, actorUid: string, opts: SendOpts = {}): Promise<SendResult> {
  const db = metaDb(env);
  const row = await loadShopOrder(env, orderId);
  if (!row) return fail(404, "not_found", "No such order.");
  if (row.pay_status !== "confirmed") return fail(409, "not_paid", "This order has not been paid yet. Nothing is sent until your bank (or you) confirmed the money.");

  const info = await providerInfo(env);
  if (!info.supportsApi) return fail(409, "manual_provider", "Place this order in the partner's dashboard, then use 'Sent to Printrove'.");
  let provider: PodProvider;
  try { provider = await getPodProvider(env); }
  catch (e) {
    await trackException(env, e, { uid: actorUid, route: "pod_fulfil:provider", handled: true, app_name: APP });
    return fail(409, "not_configured", `${info.label} is not connected. Check Print partner settings.`);
  }

  const existing = (await loadFulfilments(env, [orderId])).get(orderId) ?? null;
  if (existing && existing.status !== "problem" && !(opts.retry && existing.status === "sending")) return fail(409, "already_sent", `This order is already with ${info.label}.`);
  if (row.fulfil_status !== "new") {
    if (existing) await db.prepare(`UPDATE shop_fulfilments SET next_attempt_at=NULL, updated_at=?2 WHERE order_id=?1 AND status IN ('problem','sending')`).bind(orderId, Date.now()).run();
    return fail(409, "bad_transition", `An order that is "${row.fulfil_status}" can't be sent to production.`);
  }

  const analysis = await analyseOrder(env, row, info, null);
  if (!analysis.order) {
    const b = analysis.description.blocker as Blocker;
    if (opts.auto && !existing) {
      await recordProblem(env, row, info, b.code, b.message, 0, null, actorUid);
    }
    return fail(400, b.code, b.message, { line_problems: analysis.description.lines.filter((l) => l.problem).map((l) => ({ name: l.name, colour: l.colour, size: l.size, problem: l.problem })) });
  }

  // First writer wins. A 'problem' row (retry) or a stuck 'sending' row whose retry time passed may be re-claimed once.
  const now = Date.now();
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO shop_fulfilments (order_id, provider, reference_number, status, attempts, next_attempt_at, sent_by, created_at, updated_at)
     VALUES (?1,?2,?3,'sending',1,?4,?5,?6,?6)`,
  ).bind(orderId, info.id, row.order_no, now + BACKOFF_MS[0], actorUid, now).run();
  let attempts = 1;
  if (Number((ins as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
    const from = opts.retry ? `('problem','sending')` : `('problem')`;
    const claim = await db.prepare(
      `UPDATE shop_fulfilments SET status='sending', attempts=${opts.resetAttempts ? "1" : "attempts+1"}, next_attempt_at=?2, sent_by=?3, updated_at=?4
        WHERE order_id=?1 AND status IN ${from} ${opts.dueOnly ? "AND next_attempt_at IS NOT NULL AND next_attempt_at<=?4" : ""}`,
    ).bind(orderId, now + BACKOFF_MS[0], actorUid, now).run();
    if (Number((claim as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return fail(409, "already_sent", `This order is already with ${info.label}.`);
    attempts = (await loadFulfilments(env, [orderId])).get(orderId)?.attempts ?? existing?.attempts ?? 1;
  }
  await fulfilEvent(env, orderId, "sending", null, attempts > 1 ? `Attempt ${attempts}` : null, now);

  const t0 = Date.now();
  try {
    const found = await provider.findOrderByReference(row.order_no);
    let providerOrderId: string; let raw: unknown; const adopted = !!found;
    if (found) { providerOrderId = found.provider_order_id; raw = { adopted: true }; }
    else { const r = await provider.createOrder(analysis.order); providerOrderId = r.provider_order_id; raw = r.raw; }
    const done = Date.now();
    await db.prepare(
      `UPDATE shop_fulfilments SET status='sent', provider_order_id=?2, request_json=?3, last_response_json=?4, next_attempt_at=NULL, last_error=NULL, last_polled_at=NULL, updated_at=?5
        WHERE order_id=?1`,
    ).bind(orderId, providerOrderId, cap(analysis.order), cap(raw), done).run();
    await fulfilEvent(env, orderId, adopted ? "adopted" : "sent", null, `${info.label} order ${providerOrderId}`, done);
    await auditSend(env, actorUid, "shop_order_send_to_production", orderId, { provider: info.id, provider_order_id: providerOrderId, adopted, attempts });
    await track(env, row.uid, "shop_fulfilment_sent", APP, { provider: info.id, ms: done - t0, order_id: orderId, adopted });
    await advanceOrder(env, orderId, "at_printer", { ref: providerOrderId }, actorUid, done);
    return { ok: true, fulfilment: (await loadFulfilments(env, [orderId])).get(orderId) ?? null, adopted };
  } catch (e) {
    const code = e instanceof PodError ? e.code : "unavailable";
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    // A rejected/unconfigured order will not fix itself -- leave it for the owner. Transient failures back off.
    const retryAt = code === "rejected" || code === "not_configured" || code === "auth_failed" ? null : nextAttemptAt(attempts, Date.now());
    if (!(e instanceof PodError)) await trackException(env, e, { uid: actorUid, route: "pod_fulfil:send", handled: true, app_name: APP });
    await recordProblem(env, row, info, code, message, attempts, retryAt, actorUid);
    return fail(502, "partner_error", message, { code });
  }
}

// ---------------------------------------------------------------------------
// Resolve (owner decisions on a stuck order)
// ---------------------------------------------------------------------------
export async function resolveProduction(env: Env, orderId: string, action: "resend" | "manual" | "cancel", actorUid: string): Promise<SendResult> {
  const db = metaDb(env);
  const f = (await loadFulfilments(env, [orderId])).get(orderId);
  if (!f) return fail(404, "no_fulfilment", "This order was never sent to a print partner.");
  const now = Date.now();
  if (action === "resend") return sendOrderToPartner(env, orderId, actorUid, { retry: true, resetAttempts: true });
  if (action === "manual") {
    if (f.status !== "problem") return fail(409, "bad_transition", "Only an order with a problem can be handed back to you.");
    await db.prepare(`UPDATE shop_fulfilments SET status='cancelled', next_attempt_at=NULL, last_error=COALESCE(last_error,'')||' [handled by hand]', updated_at=?2 WHERE order_id=?1 AND status='problem'`).bind(orderId, now).run();
    await fulfilEvent(env, orderId, "handled_by_hand", null, "Owner will place this order in the partner's dashboard.", now);
    await auditSend(env, actorUid, "shop_production_manual", orderId, { provider: f.provider });
    return { ok: true, fulfilment: (await loadFulfilments(env, [orderId])).get(orderId) ?? null, adopted: false };
  }
  if (!["problem", "queued", "sending", "sent", "printing"].includes(f.status)) return fail(409, "bad_transition", "This order can no longer be cancelled at the partner.");
  await db.prepare(`UPDATE shop_fulfilments SET status='cancelled', next_attempt_at=NULL, updated_at=?2 WHERE order_id=?1 AND status IN ('problem','queued','sending','sent','printing')`).bind(orderId, now).run();
  await fulfilEvent(env, orderId, "cancelled", null, "Stopped tracking. The partner has no cancel API: cancel it in their dashboard too.", now);
  await auditSend(env, actorUid, "shop_production_cancel", orderId, { provider: f.provider });
  return { ok: true, fulfilment: (await loadFulfilments(env, [orderId])).get(orderId) ?? null, adopted: false };
}

// ---------------------------------------------------------------------------
// Status sync
// ---------------------------------------------------------------------------
async function applyPartnerStatus(env: Env, f: FulfilmentRow, ns: NormalisedStatus, provider: PodProvider): Promise<void> {
  const db = metaDb(env);
  const order = await loadShopOrder(env, f.order_id);
  if (!order) return;
  const now = Date.now();
  const ch = mapPartnerState(f.status, order.fulfil_status, ns.state);
  const to = ch.to ?? f.status;
  await db.prepare(
    `UPDATE shop_fulfilments SET status=?2, provider_status=?3, courier=COALESCE(?4,courier), awb=COALESCE(?5,awb), tracking_url=COALESCE(?6,tracking_url),
            last_response_json=?7, last_polled_at=?8, last_error=?9, updated_at=?8 WHERE order_id=?1`,
  ).bind(f.order_id, to, ns.provider_status, ns.courier, ns.awb, ns.tracking_url, cap(ns.raw), now, ns.state === "problem" ? (ns.problem ?? "The print partner reported a problem.").slice(0, 500) : null).run();
  if (ch.to != null && ch.to !== f.status) {
    await fulfilEvent(env, f.order_id, ch.to, ns.provider_status, ns.problem, now);
    await track(env, order.uid, "shop_fulfilment_status", APP, { from: f.status, to: ch.to, provider: provider.id, order_id: f.order_id });
  }
  for (const step of ch.orderSteps) {
    await advanceOrder(env, f.order_id, step, { courier: ns.courier ?? f.courier, awb: ns.awb ?? f.awb, tracking_url: ns.tracking_url ?? f.tracking_url, eta_text: ns.eta_text }, "system:pod", now);
  }
  if (ch.alertOwner) await alertOwnerFulfilmentProblem(env, order, ns.problem ?? `${provider.label} reports this order as ${ns.state}.`);
}

export type TickResult = { skipped?: "manual"; retried: number; autoSent: number; polled: number; changed: number };

export async function runPodFulfilmentTick(env: Env, _ctx?: ExecutionContext): Promise<TickResult> {
  const out: TickResult = { retried: 0, autoSent: 0, polled: 0, changed: 0 };
  const info = await providerInfo(env);
  if (!info.supportsApi) return { ...out, skipped: "manual" };
  const db = metaDb(env);
  const cfg = await podConfig(env);
  const now = Date.now();

  // (a) retry problem/sending rows whose backoff elapsed
  const due = await safely(env, "tick_retry_list", [] as Array<{ order_id: string }>, async () =>
    (await db.prepare(`SELECT order_id FROM shop_fulfilments WHERE status IN ('problem','sending') AND next_attempt_at IS NOT NULL AND next_attempt_at<=?1 ORDER BY next_attempt_at LIMIT 10`).bind(now).all<{ order_id: string }>()).results ?? []);
  for (const d of due) {
    const r = await sendOrderToPartner(env, d.order_id, "system:retry", { retry: true, dueOnly: true });
    if (r.ok) out.retried++;
  }

  // (b) auto-send paid orders nobody has touched
  if (cfg.autoSend) {
    const fresh = await safely(env, "tick_auto_list", [] as Array<{ order_id: string }>, async () =>
      (await db.prepare(
        `SELECT o.order_id AS order_id FROM shop_orders o
          WHERE o.pay_status='confirmed' AND o.fulfil_status='new' AND o.confirmed_at IS NOT NULL AND o.confirmed_at<=?1
            AND NOT EXISTS (SELECT 1 FROM shop_fulfilments f WHERE f.order_id=o.order_id)
          ORDER BY o.confirmed_at LIMIT ${AUTO_SEND_PER_TICK}`,
      ).bind(now - AUTO_SEND_GRACE_MS).all<{ order_id: string }>()).results ?? []);
    for (const o of fresh) {
      const r = await sendOrderToPartner(env, o.order_id, "system:auto", { auto: true });
      if (r.ok) out.autoSent++;
    }
  }

  // (c) poll partner status
  const rows = await safely(env, "tick_poll_list", [] as FulfilmentRow[], async () =>
    (await db.prepare(
      `SELECT * FROM shop_fulfilments WHERE status IN ('sent','printing','shipped') AND provider_order_id IS NOT NULL AND (last_polled_at IS NULL OR last_polled_at<=?1)
        ORDER BY COALESCE(last_polled_at,0) LIMIT ${POLL_PER_TICK}`,
    ).bind(now - Math.max(1, cfg.pollMinutes) * 60_000).all<FulfilmentRow>()).results ?? []);
  if (rows.length) {
    let provider: PodProvider | null = null;
    try { provider = await getPodProvider(env, info.id as "printrove"); } catch (e) { await trackException(env, e, { route: "pod_fulfil:tick_provider", handled: true, app_name: APP }); }
    for (const f of rows) {
      if (!provider || !pollDue(f.last_polled_at, cfg.pollMinutes, now)) continue;
      try {
        const ns = await provider.getOrder(f.provider_order_id as string);
        await applyPartnerStatus(env, f, ns, provider);
        out.polled++;
        if (mapPartnerState(f.status, "at_printer", ns.state).to) out.changed++;
      } catch (e) {
        const code = e instanceof PodError ? e.code : "unavailable";
        await db.prepare(`UPDATE shop_fulfilments SET last_polled_at=?2, last_error=?3, updated_at=?2 WHERE order_id=?1`).bind(f.order_id, Date.now(), (e instanceof Error ? e.message : String(e)).slice(0, 300)).run()
          .catch((e2) => trackException(env, e2, { route: "pod_fulfil:poll_mark", handled: true, app_name: APP }));
        await track(env, "system", "shop_fulfilment_failed", APP, { code, order_id: f.order_id, provider: provider.id, stage: "poll" });
        if (!(e instanceof PodError)) await trackException(env, e, { route: "pod_fulfil:poll", handled: true, app_name: APP });
      }
    }
  }
  return out;
}
