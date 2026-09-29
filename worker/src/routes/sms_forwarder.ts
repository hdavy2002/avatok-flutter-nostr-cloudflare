// [SAATHUM-UPI-3LAYER 2026-09-29] Layer 2 of the UPI confirmation: webhook for the third-party
// Android app "Auto Forward SMS - Forwarder" (Play id com.smsforwardself), which replaces our own
// SMS companion. The app cannot compute our HMAC, so:
//   AUTH     = a >=32-char secret (SMS_FORWARDER_TOKEN) in the URL path, or the X-Forward-Token header.
//   FORMAT   = lenient (JSON / form / multipart / text / query string, any key names we recognise).
//   CONTENT  = strict: only an HDFC UPI credit to OUR account (amount + 12-digit ref + account suffix +
//              "credited" + HDFC sender) is ever stored; everything else is 200 {ok,ignored} and dropped.
// Accepted messages go through storeEvidence() with device id 'forwarder', so matching, the 10-minute
// cross-device dedupe (same bank_reference) and the unique-amount auto-confirm all apply unchanged.
//   POST|GET /api/sms/forward/:token        (also /api/sms/forward with X-Forward-Token)
//   GET      /api/admin/saathum/forwarder/captures   (requireAdmin)
import type { Env } from '../types';
import { metaDb } from '../db/shard';
import { json } from '../util';
import { rateLimit } from '../money';
import { readConfig } from './config';
import { requireAdmin } from './admin_money';
import { constantTimeEqual, sha256Hex } from '../lib/payments/types';
import { parseAmountPaise, parseReference, parsePayerVpa, hasAccountSuffix, isHdfcSender, policy, storeEvidence } from '../lib/hdfc_sms_smoke';
import { finalizeSaathumCheckoutByIntent, matchSaathumReceipt } from './saathum_checkout';
import { touchSourceHealth } from '../lib/saathum_upi3';
import { trackException } from '../hooks';
import {
  readForwardPayload, messageCandidates, senderCandidates, timestampCandidates, parseTimestampMs, normaliseText, redact,
} from '../lib/sms_forwarder';

export const FORWARDER_DEVICE_ID = 'forwarder';
export const FORWARDER_SOURCE = 'forwarder' as const;
export const MIN_TOKEN_LENGTH = 32;
export const CAPTURE_KEEP = 20;
export const CAPTURE_SAMPLE_MAX = 2048;
const TS_MAX_AGE_MS = 72 * 3_600_000; // a queued/late forward is fine; older than this uses server time
const TS_MAX_FUTURE_MS = 120_000;
const APP = 'saathum';

const notFound = () => json({ error: 'not found' }, 404);

/** Constant-time compare that does not leak the token length through an early return. */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  return constantTimeEqual(a, b);
}

export type SenderRule = 'sender_code' | 'sender_name' | 'text_hdfc_ac';
/** Sender rules: HDFC short code, or "HDFC Bank" name in sender/title, or (no sender at all) the text says "HDFC Bank A/c". */
export function senderRule(senders: string[], text: string): SenderRule | null {
  for (const s of senders) if (isHdfcSender(s.trim())) return 'sender_code';
  for (const s of senders) if (/HDFC\s*Bank/i.test(s)) return 'sender_name';
  if (senders.length === 0 && /HDFC\s*Bank\s*A\s*\/\s*c/i.test(text)) return 'text_hdfc_ac';
  return null;
}

async function capture(env: Env, req: Request, p: { contentType: string; raw: string; topKeys: string[] }, now: number): Promise<void> {
  try {
    const db = metaDb(env);
    // Body sample is the raw body, or (GET) the query string with the path token never included.
    const source = p.raw || new URL(req.url).search;
    await db.prepare(`INSERT INTO sms_forwarder_captures (received_at,method,content_type,top_keys,body_sample) VALUES (?1,?2,?3,?4,?5)`)
      .bind(now, req.method, p.contentType.slice(0, 120) || null, JSON.stringify(p.topKeys), redact(source).slice(0, CAPTURE_SAMPLE_MAX)).run();
    await db.prepare(`DELETE FROM sms_forwarder_captures WHERE id NOT IN (SELECT id FROM sms_forwarder_captures ORDER BY id DESC LIMIT ${CAPTURE_KEEP})`).run();
  } catch (err) {
    await trackException(env, err, { route: '/api/sms/forward', handled: true, app_name: APP });
  }
}

export async function smsForwarderIncoming(req: Request, env: Env, pathToken: string | null): Promise<Response> {
  if (req.method !== 'POST' && req.method !== 'GET') return notFound();
  const expected = env.SMS_FORWARDER_TOKEN ?? '';
  if (expected.length < MIN_TOKEN_LENGTH) return notFound(); // not configured => the route does not exist
  // Brute-force throttle BEFORE the token check (per client IP); a legit phone sends a handful a minute.
  const ip = req.headers.get('cf-connecting-ip') ?? 'na';
  const early = await rateLimit(env, `sms-forward:ip:${ip}`, 120, 60);
  if (early) return early;
  let given = '';
  try { given = pathToken ? decodeURIComponent(pathToken) : ''; } catch { given = ''; }
  const header = req.headers.get('x-forward-token');
  if (!given && header) given = header;
  if (!given || !(await tokenMatches(given, expected))) return notFound();

  const config = await readConfig(env);
  if (!config.saathumSmsIngestEnabled || !(config.smsForwarderEnabled || config.smsForwarderCaptureEnabled)) {
    return json({ error: 'gone', reason: 'sms_forwarder_disabled' }, 410);
  }
  const now = Date.now();
  const payload = await readForwardPayload(req);
  if (!payload) return json({ error: 'payload_too_large' }, 413);

  // Authenticated request: the app is alive, whatever it sent.
  await touchSourceHealth(env, FORWARDER_DEVICE_ID, FORWARDER_SOURCE, 'sms', now);
  if (config.smsForwarderCaptureEnabled) await capture(env, req, payload, now);
  if (!config.smsForwarderEnabled) return json({ ok: true, ignored: true, capture_only: true });

  try {
    // ---- strict content rules (existing parsers) ------------------------------------------------
    const senders = senderCandidates(payload);
    let text: string | null = null, rule: SenderRule | null = null, amount: number | null = null, reference: string | null = null;
    const suffix = env.HDFC_SMS_ACCOUNT_SUFFIX ?? '';
    for (const cand of messageCandidates(payload)) {
      const a = parseAmountPaise(cand), r = parseReference(cand);
      if (!a || !r || !/\bcredited\b/i.test(cand) || !hasAccountSuffix(cand, suffix)) continue;
      const sr = senderRule(senders, cand);
      if (!sr) continue;
      text = cand; rule = sr; amount = a; reference = r; break;
    }
    if (!text || !rule || !amount || !reference) return json({ ok: true, ignored: true }); // never persisted

    const p = await policy(env);
    if (!p.ready) return json({ error: 'schema_not_ready', retryable: true }, 503);
    if (!/^\d{4,6}$/.test(suffix)) return json({ error: 'configuration_incomplete', retryable: true }, 503);

    // ---- receive time: app timestamp if sane, else server time ----------------------------------
    let receivedMs = now;
    for (const t of timestampCandidates(payload)) {
      const ms = parseTimestampMs(t);
      if (ms !== null && ms >= now - TS_MAX_AGE_MS && ms <= now + TS_MAX_FUTURE_MS) { receivedMs = ms; break; }
    }
    const endMs = receivedMs % 1000 === 0 ? receivedMs + 999 : receivedMs;
    const normalised = normaliseText(text);
    const hash = await sha256Hex(`forwarder|${normalised}|${Math.floor(receivedMs / 60_000)}`);
    const reason = receivedMs < p.cutover ? 'pre_cutover' : null;
    const db = metaDb(env);
    let receipt = await storeEvidence(db, {
      message_hash: hash, receiving_account_key: p.account, bank_reference: reference, payer_vpa: parsePayerVpa(text),
      amount_paise: amount, received_at_ms: receivedMs, received_at_end_ms: endMs, ingested_at: now,
      disposition: reason ? 'review_required' : 'accepted', reason_code: reason, claimed_intent_id: null,
    }, {
      device: FORWARDER_DEVICE_ID, sender: (senders.find((s) => isHdfcSender(s) || /HDFC\s*Bank/i.test(s)) ?? 'HDFC-text').slice(0, 64),
      message: normalised, received: new Date(receivedMs).toISOString(), nonce: hash,
    });
    if (!receipt) return json({ error: 'receipt_storage_unavailable', retryable: true }, 503);

    if (receipt.disposition === 'accepted' && receipt.bank_reference) {
      try {
        const waiting = await db.prepare(`SELECT checkout_id FROM saathum_checkouts WHERE receiving_account_key=?1 AND payer_reference=?2 AND amount_paise=?3 AND status IN ('awaiting_payment','review_pending') AND confirmed_at IS NULL`)
          .bind(receipt.receiving_account_key, receipt.bank_reference, receipt.amount_paise).first<{ checkout_id: string }>();
        if (waiting) await finalizeSaathumCheckoutByIntent(env, waiting.checkout_id);
        if (!receipt.claimed_intent_id) await matchSaathumReceipt(env, receipt as any);
      } catch (err) { await trackException(env, err, { route: '/api/sms/forward', handled: true, app_name: APP }); }
    }
    const confirmed = receipt.bank_reference
      ? await db.prepare(`SELECT 1 AS x FROM saathum_checkouts WHERE receiving_account_key=?1 AND payer_reference=?2 AND status='confirmed'`).bind(receipt.receiving_account_key, receipt.bank_reference).first().catch(() => null)
      : null;
    return json({ ok: true, ignored: false, match_state: confirmed ? 'confirmed' : 'unmatched', sender_rule: rule });
  } catch (err) {
    await trackException(env, err, { route: '/api/sms/forward', handled: true, app_name: APP });
    return json({ error: 'receipt_storage_or_match_unavailable', retryable: true }, 503);
  }
}

/** GET /api/admin/saathum/forwarder/captures -- newest first, already redacted at write time. */
export async function adminForwarderCaptures(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const rows = await metaDb(env).prepare(`SELECT id,received_at,method,content_type,top_keys,body_sample FROM sms_forwarder_captures ORDER BY id DESC LIMIT ${CAPTURE_KEEP}`)
    .all<{ id: number; received_at: number; method: string; content_type: string | null; top_keys: string; body_sample: string }>().catch(() => null);
  const config = await readConfig(env);
  return json({
    capture_enabled: config.smsForwarderCaptureEnabled === true,
    forwarder_enabled: config.smsForwarderEnabled === true,
    captures: (rows?.results ?? []).map((r) => {
      let keys: unknown = []; try { keys = JSON.parse(r.top_keys); } catch { /* keep [] */ }
      return { id: r.id, received_at: r.received_at, method: r.method, content_type: r.content_type, top_keys: keys, body_sample: r.body_sample };
    }),
  });
}
