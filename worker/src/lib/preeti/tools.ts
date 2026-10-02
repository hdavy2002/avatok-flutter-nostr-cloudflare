// [SAATHUM-PREETI-1 2026-09-30] Preeti's tools. STRICTLY READ-ONLY (D1 SELECTs) except handover_to_human, which
// only writes ai_handoffs / the conversation status and queues an ops WhatsApp. Nothing here can change a
// booking, a payment, a listing or a price. Other customers' data is never reachable: check_booking only
// answers for (a) the signed-in owner of the checkout, or (b) the caller who proves the 12-digit UTR AND the
// last 4 digits of the WhatsApp number on that booking; three failures in 10 minutes lock lookups for 1 hour.
import type { Env } from "../../types";
import { sha256Hex } from "../../util";
import { track, trackException } from "../../hooks";
import { notEndedSql, toMs } from "../listing_schedule";
import { bookingRef, formatIst, verifiedWhatsAppNumber } from "../whatsapp_notify";
import { sendWhatsAppText } from "../whatsapp_send";
import { GUIDE_TOOL_NAMES, GUIDE_TOOL_SUMMARY, guideDeclarations, runGuideTool } from "./brain";
import type { BrandRuntime, PreetiCard } from "./contracts";
import { EVENT_SELECT, eventReadMore, eventState, loadEventRow, seatsTaken, type EventRow } from "./cards";
import { getConv, updateConversation, type AgentConfigRow, type ConvRow } from "./store";

const APP = "saathum";
const LOOKUP_WINDOW_MS = 10 * 60_000;
const LOOKUP_MAX_FAILS = 3;
const LOOKUP_LOCK_MS = 60 * 60_000;

export interface ToolCtx {
  env: Env; brand: BrandRuntime; agentName: string; cfg: AgentConfigRow;
  conv: ConvRow; uid: string | null; traceId: string;
  /** set by handover_to_human so the stream can emit the handover event */
  handoverUrl?: string;
  // [AUMFE-PREETI-BRAIN-1] shared-brain turn: admin-preview only (signed-in uid that canSeeGuides lets through). All off by default.
  guides?: boolean;
  /** agent_memory session for this stretch of chat (guides + uid + not a test). */
  memorySessionId?: string | null;
  /** chat.ts sends the card to the widget (and stores it on the reply). */
  showCard?: (card: PreetiCard) => void;
  /** cards already shown this turn (dedupe + cap) */
  shown?: Set<string>;
}

export const TOOL_DECLARATIONS = [
  {
    name: "list_upcoming_events",
    description: "List upcoming or live pujas/havans (events) that can be booked. Use for any question about what is coming up, dates, prices or booking availability. Filters are optional.",
    parameters: { type: "OBJECT", properties: {
      ritual: { type: "STRING", description: "Ritual/deity/topic keyword, e.g. 'Ganesh', 'Rudrabhishek', 'havan'." },
      temple: { type: "STRING", description: "Temple or place keyword, e.g. 'Kedarnath', 'Haridwar'." },
      from: { type: "STRING", description: "Earliest date, YYYY-MM-DD (India time)." },
      to: { type: "STRING", description: "Latest date, YYYY-MM-DD (India time)." },
    } },
  },
  {
    name: "get_event",
    description: "Get full details of ONE event by id or by (part of) its name: date/time, price, temple, live/ended state, whether booking is open, and any active incident or delay notice.",
    parameters: { type: "OBJECT", properties: {
      id: { type: "STRING", description: "Listing id." },
      name: { type: "STRING", description: "Part of the event title." },
    } },
  },
  {
    name: "get_event_incidents",
    description: "Active notices/delays for an event (weather, network, schedule change).",
    parameters: { type: "OBJECT", properties: { listing_id: { type: "STRING" } }, required: ["listing_id"] },
  },
  {
    name: "check_booking",
    description: "Look up the status of a customer's booking/payment. Needs the 12-digit UTR (UPI transaction id) and, unless the customer is signed in as the owner, the last 4 digits of the WhatsApp number used for the booking. Returns status only.",
    parameters: { type: "OBJECT", properties: {
      utr: { type: "STRING", description: "12-digit UPI transaction reference (UTR)." },
      last4: { type: "STRING", description: "Last 4 digits of the WhatsApp number on the booking." },
    } },
  },
  {
    name: "handover_to_human",
    description: "Connect the customer to the human support team on WhatsApp. Use ONLY when the customer clearly asks for a person/agent/human/call, or insists on it after you offered help. Never for anger alone, errors, or on your own.",
    parameters: { type: "OBJECT", properties: {
      reason: { type: "STRING", description: "Short reason (angry, payment_issue, asked_for_human, refund, unsure, other)." },
      summary: { type: "STRING", description: "2-3 sentence summary of what the customer needs, for the human." },
    }, required: ["reason", "summary"] },
  },
];

/** The function declarations for THIS turn: today's five, plus the shared-brain tools only when guides is on. */
export function toolDeclarations(ctx: ToolCtx): unknown[] {
  return ctx.guides ? [...TOOL_DECLARATIONS, ...guideDeclarations(ctx)] : TOOL_DECLARATIONS;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** 'YYYY-MM-DD' (IST midnight) -> epoch ms, or null. */
function istDayStart(s: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - 5.5 * 3600_000;
}

async function incidentsFor(ctx: ToolCtx, listingId: string | null, now: number): Promise<{ message: string; since: string }[]> {
  const rs = await ctx.env.DB_META.prepare(
    `SELECT message, starts_at FROM ai_incidents
      WHERE (listing_id IS NULL OR listing_id=?1) AND starts_at<=?2 AND (expires_at IS NULL OR expires_at>?2)
      ORDER BY starts_at DESC LIMIT 5`,
  ).bind(listingId, now).all<{ message: string; starts_at: number }>().catch(() => null);
  return (rs?.results ?? []).map((r) => ({ message: clip(r.message, 300), since: formatIst(Number(r.starts_at)) }));
}

async function eventView(ctx: ToolCtx, row: EventRow, now: number, withDesc: boolean) {
  const taken = row.capacity != null ? await seatsTaken(ctx.env, row.id) : 0;
  const st = eventState(row, now, taken);
  const start = toMs(row.starts_at);
  const url = eventReadMore(ctx.brand, row.id);
  return {
    id: row.id, title: row.title, ritual_type: row.category_label ?? row.category ?? null,
    temple: row.temple_name ? `${row.temple_name}${row.temple_place ? `, ${row.temple_place}` : ""}` : (row.location ?? null),
    starts_at_ist: start ? formatIst(start) : null, starts_at_ms: start, duration_min: row.duration_min ?? null,
    ticket_price_rupees: row.price != null ? Number(row.price) : null,
    price_note: "Ticket price only; optional offerings (chadhava, dakshina, prasad) and GST are shown at checkout.",
    state: st.state, live_now: st.live_now, booking_open: st.booking_open, booking_note: st.booking_note,
    read_more_url: url, book_url: `${url}/checkout`, card_marker: `[[event:${row.id}]]`,
    ...(withDesc ? { description: clip(row.description, 700), how_to_watch: `After booking, the buyer watches on the event page (${url}) once signed in with a verified WhatsApp number.` } : {}),
  };
}

async function listUpcoming(ctx: ToolCtx, a: any) {
  const now = Date.now();
  const binds: unknown[] = [now];
  const where = [`l.kind='live_event'`, `l.status IN ('published','live')`, notEndedSql("l", "?1")];
  const like = (v: unknown) => `%${String(v).trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 40)}%`;
  if (a?.ritual && String(a.ritual).trim()) {
    binds.push(like(a.ritual)); const p = `?${binds.length}`;
    where.push(`(lower(l.title) LIKE ${p} OR lower(COALESCE(l.description,'')) LIKE ${p} OR lower(COALESCE(c.label,'')) LIKE ${p} OR lower(COALESCE(l.attrs,'')) LIKE ${p})`);
  }
  if (a?.temple && String(a.temple).trim()) {
    binds.push(like(a.temple)); const p = `?${binds.length}`;
    where.push(`(lower(COALESCE(t.name,'')) LIKE ${p} OR lower(COALESCE(t.place,'')) LIKE ${p} OR lower(COALESCE(l.location,'')) LIKE ${p} OR lower(l.title) LIKE ${p})`);
  }
  const from = istDayStart(a?.from); const to = istDayStart(a?.to);
  if (from) { binds.push(from); where.push(`l.starts_at >= ?${binds.length}`); }
  if (to) { binds.push(to + 24 * 3600_000); where.push(`l.starts_at < ?${binds.length}`); }
  const rs = await ctx.env.DB_META.prepare(`${EVENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY l.starts_at ASC LIMIT 8`).bind(...binds).all<EventRow>();
  const events = [];
  for (const r of rs.results ?? []) events.push(await eventView(ctx, r, now, false));
  const incidents = await incidentsFor(ctx, null, now);
  return { count: events.length, events, general_notices: incidents, note: events.length ? "Show at most 2 cards with the card_marker." : "No matching upcoming events. Offer to notify via WhatsApp team or suggest browsing the site." };
}

async function getEvent(ctx: ToolCtx, a: any) {
  const now = Date.now();
  let row: EventRow | null = null;
  if (a?.id) row = await loadEventRow(ctx.env, String(a.id).slice(0, 80));
  if (!row && a?.name) {
    const like = `%${String(a.name).trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60)}%`;
    row = await ctx.env.DB_META.prepare(
      `${EVENT_SELECT} WHERE l.kind='live_event' AND l.status IN ('published','live','completed') AND lower(l.title) LIKE ?1 ORDER BY l.starts_at DESC LIMIT 1`,
    ).bind(like).first<EventRow>().catch(() => null);
  }
  if (!row || row.kind !== "live_event" || !["published", "live", "completed"].includes(String(row.status))) return { found: false };
  return { found: true, ...(await eventView(ctx, row, now, true)), incidents: await incidentsFor(ctx, row.id, now) };
}

async function getIncidents(ctx: ToolCtx, a: any) {
  return { listing_id: String(a?.listing_id ?? ""), incidents: await incidentsFor(ctx, a?.listing_id ? String(a.listing_id).slice(0, 80) : null, Date.now()) };
}

const STATUS_WORDS: Record<string, string> = {
  confirmed: "Confirmed — payment received and the booking is active.",
  review_pending: "Payment is being verified by our team; this is usually quick.",
  awaiting_payment: "Payment not received yet.",
  expired: "This checkout expired before payment was received.",
  cancelled: "This booking was cancelled.",
};

async function lookupFailed(ctx: ToolCtx, utrHash: string | null): Promise<void> {
  const db = ctx.env.DB_META; const now = Date.now();
  await db.prepare("INSERT INTO ai_booking_lookups (conversation_id, utr_hash, ok, created_at) VALUES (?1,?2,0,?3)").bind(ctx.conv.id, utrHash, now).run();
  const r = await db.prepare("SELECT COUNT(*) n FROM ai_booking_lookups WHERE conversation_id=?1 AND ok=0 AND created_at>?2").bind(ctx.conv.id, now - LOOKUP_WINDOW_MS).first<{ n: number }>();
  if (Number(r?.n ?? 0) >= LOOKUP_MAX_FAILS) {
    await db.prepare("UPDATE ai_conversations SET lookup_locked_until=?2 WHERE id=?1").bind(ctx.conv.id, now + LOOKUP_LOCK_MS).run();
    await track(ctx.env, ctx.uid ?? "anon", "preeti_lookup_locked", APP, { conversation_id: ctx.conv.id });
  }
}

async function checkBooking(ctx: ToolCtx, a: any) {
  const db = ctx.env.DB_META; const now = Date.now();
  const fresh = await getConv(ctx.env, ctx.conv.id);
  if ((fresh?.lookup_locked_until ?? 0) > now) return { ok: false, locked: true, message: "Lookups are paused for this chat for a while. Tell the customer you cannot check this right now." };

  const utr = String(a?.utr ?? "").replace(/\s+/g, "");
  const last4 = String(a?.last4 ?? "").replace(/\D/g, "").slice(-4);

  // Signed-in owner without a UTR: their own most recent bookings.
  if (!utr) {
    if (!ctx.uid) return { ok: false, need: "utr", message: "Ask for the 12-digit UTR and the last 4 digits of the WhatsApp number used for the booking (or ask them to sign in)." };
    const rs = await db.prepare(
      `SELECT c.checkout_id, c.status, c.total_rupees, c.confirmed_at, c.email_sent_at, c.created_at, l.title, l.starts_at
         FROM saathum_checkouts c LEFT JOIN listings l ON l.id=c.listing_id WHERE c.uid=?1 ORDER BY c.created_at DESC LIMIT 3`,
    ).bind(ctx.uid).all<any>();
    await db.prepare("INSERT INTO ai_booking_lookups (conversation_id, utr_hash, ok, created_at) VALUES (?1,NULL,1,?2)").bind(ctx.conv.id, now).run();
    return { ok: true, bookings: (rs.results ?? []).map((r) => bookingView(r, null)) };
  }
  if (!/^\d{12}$/.test(utr)) return { ok: false, need: "utr", message: "A UTR is exactly 12 digits. Ask the customer to re-check it in their UPI app or bank SMS." };

  // [SAATHUM-PREETI-1 review] Ask for the second factor BEFORE touching the table, so the reply for a
  // real UTR and a made-up one is identical (no oracle for which UTRs exist).
  if (!ctx.uid && last4.length !== 4) return { ok: false, need: "last4", message: "Ask for the last 4 digits of the WhatsApp number used for the booking." };
  const utrHash = await sha256Hex(utr);
  const row = await db.prepare(
    `SELECT c.checkout_id, c.uid, c.status, c.total_rupees, c.confirmed_at, c.email_sent_at, c.created_at, l.title, l.starts_at
       FROM saathum_checkouts c LEFT JOIN listings l ON l.id=c.listing_id
      WHERE c.payer_reference=?1 OR c.utr=?1 ORDER BY c.created_at DESC LIMIT 1`,
  ).bind(utr).first<any>().catch(() => null);

  let allowed = false;
  if (row) {
    if (ctx.uid && row.uid === ctx.uid) allowed = true;
    else if (last4.length === 4) {
      const wa = (await verifiedWhatsAppNumber(ctx.env, row.uid))
        ?? (await db.prepare("SELECT e164 FROM whatsapp_outbox WHERE checkout_id=?1 ORDER BY id DESC LIMIT 1").bind(row.checkout_id).first<{ e164: string }>().catch(() => null))?.e164
        ?? null;
      allowed = !!wa && wa.replace(/\D/g, "").slice(-4) === last4;
    }
  }
  if (!row || !allowed) {
    await lookupFailed(ctx, utrHash);
    return { ok: false, message: "No booking matches those details. Do not say which detail was wrong. Suggest re-checking the details." };
  }
  await db.prepare("INSERT INTO ai_booking_lookups (conversation_id, utr_hash, ok, created_at) VALUES (?1,?2,1,?3)").bind(ctx.conv.id, utrHash, now).run();
  const sent = await db.prepare("SELECT 1 x FROM whatsapp_outbox WHERE checkout_id=?1 AND status='sent' LIMIT 1").bind(row.checkout_id).first().catch(() => null);
  return { ok: true, bookings: [bookingView(row, !!sent)] };
}

function bookingView(r: any, waSent: boolean | null) {
  const start = toMs(r.starts_at);
  return {
    reference: bookingRef(String(r.checkout_id)),
    event: r.title ?? null, event_time_ist: start ? formatIst(start) : null,
    status: r.status, status_meaning: STATUS_WORDS[String(r.status)] ?? String(r.status),
    amount_rupees: r.total_rupees != null ? Number(r.total_rupees) : null,
    confirmed_at_ist: r.confirmed_at ? formatIst(Number(r.confirmed_at)) : null,
    confirmation_email_sent: !!r.email_sent_at,
    whatsapp_confirmation_sent: waSent,
  };
}

const digits = (s: string) => s.replace(/\D/g, "");

/** wa.me link with prefilled text carrying the conversation reference. */
export function handoverUrl(cfg: AgentConfigRow, brand: BrandRuntime, agentName: string, conversationId: string): string {
  const text = `Hi, I was chatting with ${agentName} on ${brand.name}. Ref: ${conversationId}`;
  return `https://wa.me/${digits(cfg.support_whatsapp)}?text=${encodeURIComponent(text)}`;
}

/** Record a handover, flag the conversation, alert ops. Idempotent per conversation per 10 minutes. */
export async function doHandover(ctx: ToolCtx, reason: string, summary: string): Promise<{ url: string }> {
  const { env, conv, cfg, brand } = ctx;
  const url = handoverUrl(cfg, brand, ctx.agentName, conv.id);
  ctx.handoverUrl = url;
  const now = Date.now();
  const recent = await env.DB_META.prepare("SELECT id FROM ai_handoffs WHERE conversation_id=?1 AND created_at>?2 LIMIT 1").bind(conv.id, now - 10 * 60_000).first().catch(() => null);
  if (!recent) {
    await env.DB_META.prepare("INSERT INTO ai_handoffs (id, conversation_id, reason, summary, created_at) VALUES (?1,?2,?3,?4,?5)")
      .bind(crypto.randomUUID(), conv.id, clip(reason, 80), clip(summary, 600), now).run();
    const fresh = await getConv(env, conv.id);
    await updateConversation(env, conv.id, { status: "needs_human", badges: [...(fresh?.badges ?? conv.badges), "needs_human"] });
    const who = conv.name ? `${conv.name}${conv.e164 ? ` (${conv.e164})` : ""}` : (conv.e164 ?? "Anonymous visitor");
    if (!conv.is_test) {
      const text = `🙏 ${brand.name} chat handover — ${who}\nReason: ${clip(reason, 80)}\n${clip(summary, 400)}\nRef: ${conv.id}`;
      const r = await sendWhatsAppText(env, cfg.alert_whatsapp, text);
      if (!r.ok) await trackException(env, new Error(`preeti_handover_alert_failed:${r.reason}`), { route: "preeti.handover", handled: true, app_name: APP, extra: { conversation_id: conv.id } });
    }
    await track(env, ctx.uid ?? "anon", "preeti_handover", APP, { conversation_id: conv.id, reason: clip(reason, 40), signed_in: !!ctx.uid, is_test: !!conv.is_test });
  }
  return { url };
}

export const TOOL_SUMMARY: Record<string, (r: any) => string> = {
  list_upcoming_events: (r) => `${r?.count ?? 0} events`,
  get_event: (r) => (r?.found ? `event ${r.id} state=${r.state} booking_open=${r.booking_open}` : "not found"),
  get_event_incidents: (r) => `${r?.incidents?.length ?? 0} incidents`,
  check_booking: (r) => (r?.ok ? `found ${r.bookings?.length ?? 0} (status ${r.bookings?.[0]?.status ?? "?"})` : r?.locked ? "locked" : "no match"),
  handover_to_human: () => "handover requested",
  ...GUIDE_TOOL_SUMMARY,
};

export async function runTool(ctx: ToolCtx, name: string, args: any): Promise<unknown> {
  try {
    switch (name) {
      case "list_upcoming_events": return await listUpcoming(ctx, args);
      case "get_event": return await getEvent(ctx, args);
      case "get_event_incidents": return await getIncidents(ctx, args);
      case "check_booking": return await checkBooking(ctx, args);
      case "handover_to_human": {
        await doHandover(ctx, String(args?.reason ?? "other"), String(args?.summary ?? ""));
        return { ok: true, instruction: "Tell the customer warmly that the human team has been notified and they can tap the WhatsApp button that appears; the team is available 24/7. Do not include any link yourself." };
      }
      default:
        if (GUIDE_TOOL_NAMES.has(name)) return await runGuideTool(ctx, name, args);
        return { error: "unknown_tool" };
    }
  } catch (e) {
    await trackException(ctx.env, e, { route: `preeti.tool.${name}`, handled: true, app_name: APP, extra: { conversation_id: ctx.conv.id } });
    return { error: "tool_failed", message: "Could not read this right now. Say you could not confirm it." };
  }
}
