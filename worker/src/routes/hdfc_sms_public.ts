// Anonymous payment-test capabilities own only their own isolated smoke intent.
import type { Env } from '../types';
import { metaDb } from '../db/shard';
import { json } from '../util';
import { rateLimit } from '../money';
import { sha256Hex } from '../lib/payments/types';
import { UUID, boundedBody, policy, publicIntent, createPublicConcurrentIntent, currentIntent, readIntent, saveReference, normalizeReference, matchIntent, type Intent, type Policy } from '../lib/hdfc_sms_smoke';

const failure = (error: string, status = 503) => json({error, retryable: status === 503 || status === 429}, status);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const exactKeys = (body: Record<string, unknown>, keys: string[]) => Object.keys(body).every(key => keys.includes(key));
type Action = (req: Request, env: Env, uid: string) => Promise<Response>;

/** The random bearer is a browser-tab capability, never a Clerk/admin token.
 * Persist only its hash as an owner ID; never accept a uid or token from a URL. */
function scoped(action: Action) {
 return async (req: Request, env: Env): Promise<Response> => {
  let response: Response;
  try {
   const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('authorization') ?? '')?.[1];
   response = token
    ? await action(req, env, `hdfc-public:${await sha256Hex(token)}`)
    : failure('session_required', 401);
  } catch { response = failure('state_unavailable'); }
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
 };
}

async function limited(req: Request, env: Env, uid: string, action: string, userMax: number, ipMax: number) {
 // CF-Connecting-IP is supplied by the edge; do not trust caller X-Forwarded-For.
 const ip = await sha256Hex(req.headers.get('cf-connecting-ip') ?? 'unknown');
 for (const [key, maximum] of [[`owner:${uid}`, userMax], [`ip:${ip}`, ipMax]] as const) {
  const result = await rateLimit(env, `hdfc-smoke:public:${action}:${key}`, maximum, 60);
  if (result) return json({error: 'rate_limited', retryable: true}, 429, {'retry-after': result.headers.get('retry-after') ?? '60'});
 }
 return null;
}

function envelope(intent: Intent, env: Env, p: Policy) {
 const visible = publicIntent(intent, env, p);
 if (visible.upi_url) {
  const url = new URL(visible.upi_url);
  url.searchParams.set('tn', 'AvaTOK test payment');
  visible.upi_url = url.toString();
 }
 return {ok: true, enabled: p.enabled, intent: {
  ...visible, currency: 'INR', matching_mode: 'bank_reference',
  confirmed_at: visible.status === 'confirmed' ? intent.claimed_at : null,
 }};
}

export const hdfcPublicOrder = scoped(async (req, env, uid) => {
 const body = await boundedBody(req, 1024);
 if (!body || !exactKeys(body, ['request_key']) || !uuid(body.request_key)) return failure('invalid_request', 400);
 const throttle = await limited(req, env, uid, 'order', 10, 40); if (throttle) return throttle;
 const db = metaDb(env), p = await policy(env);
 if (!p.ready) return failure('schema_not_ready');
 // An uncertain retry must still recover its existing result after rail pause.
 const prior = await db.prepare('SELECT intent_id FROM hdfc_sms_smoke_intents WHERE uid=? AND request_key=?')
  .bind(uid, body.request_key).first<{intent_id: string}>();
 if (prior) {
  const intent = await readIntent(db, prior.intent_id, uid);
  if (intent) return json(envelope(intent, env, p));
 }
 // A browser handoff can lose the locally stored intent id while retaining the
 // same capability bearer. Recover that capability's existing attempt instead
 // of trying to create a second payment and returning intent_busy forever.
 const owned = await currentIntent(db, uid);
 if (owned && owned.claimed_at === null && owned.superseded_by === null) return json(envelope(owned, env, p));
 if (!p.enabled) return failure(p.reason ?? 'rail_paused');
 const intent = await createPublicConcurrentIntent(db, uid, body.request_key, p);
 if (intent) return json(envelope(intent, env, p));
 return failure('intent_busy', 409);
});

export const hdfcPublicStatus = scoped(async (req, env, uid) => {
 const id = new URL(req.url).searchParams.get('intent_id');
 if (!uuid(id)) return failure('invalid_request', 400);
 const throttle = await limited(req, env, uid, 'status', 60, 240); if (throttle) return throttle;
 const db = metaDb(env), p = await policy(env);
 if (!p.ready) return failure('schema_not_ready');
 // Polling is read-only: only trusted ingress or an explicit POST may reconcile.
 const intent = await readIntent(db, id, uid);
 return intent ? json(envelope(intent, env, p)) : failure('not_found', 404);
});

function claimOrRecheck(recheck: boolean): Action {
 return async (req, env, uid) => {
  const body = await boundedBody(req, 1024);
  const keys = recheck ? ['intent_id'] : ['intent_id', 'bank_reference', 'expected_reference_revision'];
  if (!body || !exactKeys(body, keys) || !uuid(body.intent_id)) return failure('invalid_request', 400);
  const reference = recheck ? null : normalizeReference(body.bank_reference);
  if (!recheck && !reference) return failure('reference_must_be_12_digits', 400);
  if (!recheck && (!Number.isSafeInteger(body.expected_reference_revision) || Number(body.expected_reference_revision) < 0)) return failure('invalid_request', 400);
  const throttle = await limited(req, env, uid, 'claim', 20, 60); if (throttle) return throttle;
  const db = metaDb(env), p = await policy(env);
  if (!p.ready) return failure('schema_not_ready');
  const intent = await readIntent(db, body.intent_id, uid);
  if (!intent) return failure('not_found', 404);
  if (!p.enabled) return failure(p.reason ?? 'rail_paused');
  if (reference && !await saveReference(db, intent, reference, Number(body.expected_reference_revision))) return failure('reference_conflict', 409);
  const result = await matchIntent(db, intent.intent_id, uid, p);
  return result ? json(envelope(result, env, p)) : failure('not_found', 404);
 };
}

export const hdfcPublicClaim = scoped(claimOrRecheck(false));
export const hdfcPublicRecheck = scoped(claimOrRecheck(true));
