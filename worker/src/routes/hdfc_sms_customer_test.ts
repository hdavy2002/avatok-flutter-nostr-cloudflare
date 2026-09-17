// Ordinary authenticated customers only; all state is private and owner-scoped.
import type { Env } from '../types';
import { metaDb } from '../db/shard';
import { requireUser, isFail } from '../authz';
import { json } from '../util';
import { rateLimit } from '../money';
import { UUID, boundedBody, normalizeReference, readIntent, saveReference, matchIntent } from '../lib/hdfc_sms_smoke';
import { TEST_SERVICE, customerPolicy, redeemInvite, readInvite, readBooking, bookingEnvelope, createCustomerTestBooking } from '../lib/hdfc_sms_customer_test';

const failure = (error: string, status = 503) => json({error, retryable: status === 503 || status === 429}, status);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const exactKeys = (body: Record<string, unknown>, keys: string[]) => Object.keys(body).every(key => keys.includes(key));
async function limited(env: Env, bucket: string, max: number) {
 const result = await rateLimit(env, `hdfc-smoke:customer:${bucket}`, max, 60);
 return result ? json({error: 'rate_limited', retryable: true}, 429, {'retry-after': result.headers.get('retry-after') ?? '60'}) : null;
}
type Action = (req: Request, env: Env, uid: string) => Promise<Response>;
function secured(action: Action) {
 return async (req: Request, env: Env): Promise<Response> => {
  let response: Response;
  try {
   // requireUser also supports WebSocket query tokens. These routes MUST NOT.
   if (!/^Bearer [^\s]+$/i.test(req.headers.get('authorization') ?? '')) {
    response = failure('unauthorized', 401);
   } else {
    const auth = await requireUser(req, env);
    response = isFail(auth)
     ? failure(auth.status === 403 ? 'account_forbidden' : auth.status === 401 ? 'unauthorized' : 'auth_unavailable', auth.status === 403 ? 403 : auth.status === 401 ? 401 : 503)
     : await action(req, env, auth.uid);
   }
  } catch { response = failure('state_unavailable'); }
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
 };
}
export const hdfcCustomerRedeem = secured(async (req, env, uid) => {
 const body = await boundedBody(req, 1024);
 if (!body || !exactKeys(body, ['invite_token']) || typeof body.invite_token !== 'string' || !/^[a-f0-9]{64}$/.test(body.invite_token)) return failure('invalid_request', 400);
 const throttle = await limited(env, `redeem:${uid}`, 20); if (throttle) return throttle;
 const db = metaDb(env), p = await customerPolicy(db, env);
 if (!p.ready) return failure('schema_not_ready');
 const invite = await redeemInvite(db, body.invite_token, uid);
 return invite ? json({ok: true, account_id: uid, invite_id: invite.invite_id, expires_at: invite.expires_at}) : failure('invite_unavailable', 404);
});
export const hdfcCustomerCurrent = secured(async (req, env, uid) => {
 const id = new URL(req.url).searchParams.get('invite_id');
 if (id !== null && !uuid(id)) return failure('invalid_request', 400);
 const db = metaDb(env), p = await customerPolicy(db, env);
 if (!p.ready) return failure('schema_not_ready');
 const invite = await readInvite(db, uid, id ?? undefined);
 if (!invite) return failure(id === null ? 'invite_required' : 'invite_unavailable', 404);
 return json(await bookingEnvelope(db, invite, uid, env, p));
});
export const hdfcCustomerOrder = secured(async (req, env, uid) => {
 const body = await boundedBody(req, 2048);
 if (!body || !exactKeys(body, ['invite_id', 'service_id', 'request_key']) || !uuid(body.invite_id) || !uuid(body.request_key) || body.service_id !== TEST_SERVICE.id) return failure('invalid_request', 400);
 const db = metaDb(env), p = await customerPolicy(db, env);
 if (!p.ready) return failure('schema_not_ready');
 const invite = await readInvite(db, uid, body.invite_id);
 if (!invite) return failure('invite_unavailable', 404);
 // Settled identity wins over expiry/rail state, including an uncertain retry.
 if (await readBooking(db, invite.invite_id, uid)) return json(await bookingEnvelope(db, invite, uid, env, p));
 if (invite.expires_at <= Date.now()) return failure('invite_unavailable', 404);
 if (!p.enabled) return failure(p.reason ?? 'rail_paused');
 const throttle = await limited(env, `create:${uid}`, 10); if (throttle) return throttle;
 const booking = await createCustomerTestBooking(db, invite.invite_id, uid, body.request_key, p);
 return booking ? json(await bookingEnvelope(db, invite, uid, env, p)) : failure('intent_busy', 409);
});
export const hdfcCustomerStatus = secured(async (req, env, uid) => {
 const params = new URL(req.url).searchParams, inviteId = params.get('invite_id'), intentId = params.get('intent_id');
 if (!uuid(inviteId) || !uuid(intentId)) return failure('invalid_request', 400);
 const db = metaDb(env), p = await customerPolicy(db, env);
 if (!p.ready) return failure('schema_not_ready');
 const invite = await readInvite(db, uid, inviteId), booking = await readBooking(db, inviteId, uid);
 if (!invite || !booking || booking.intent_id !== intentId) return failure('not_found', 404);
 return json(await bookingEnvelope(db, invite, uid, env, p));
});
function claimOrRecheck(recheck: boolean): Action {
 return async (req, env, uid) => {
  const body = await boundedBody(req, 2048);
  const keys = recheck ? ['invite_id', 'intent_id'] : ['invite_id', 'intent_id', 'bank_reference', 'expected_reference_revision'];
  if (!body || !exactKeys(body, keys) || !uuid(body.invite_id) || !uuid(body.intent_id)) return failure('invalid_request', 400);
  const reference = recheck ? null : normalizeReference(body.bank_reference);
  if (!recheck && !reference) return failure('reference_must_be_12_digits', 400);
  if (!recheck && (!Number.isSafeInteger(body.expected_reference_revision) || Number(body.expected_reference_revision) < 0)) return failure('invalid_request', 400);
  const db = metaDb(env), p = await customerPolicy(db, env);
  if (!p.ready) return failure('schema_not_ready');
  const invite = await readInvite(db, uid, body.invite_id), booking = await readBooking(db, body.invite_id, uid);
  if (!invite || !booking || booking.intent_id !== body.intent_id) return failure('not_found', 404);
  const intent = await readIntent(db, booking.intent_id, uid);
  if (!intent) return failure('not_found', 404);
  if (!p.enabled) return failure(p.reason ?? 'rail_paused');
  const throttle = await limited(env, `claim:${uid}`, 20); if (throttle) return throttle;
  if (reference && !await saveReference(db, intent, reference, Number(body.expected_reference_revision))) return failure('reference_conflict', 409);
  await matchIntent(db, intent.intent_id, uid, p);
  return json(await bookingEnvelope(db, invite, uid, env, p));
 };
}
export const hdfcCustomerClaim = secured(claimOrRecheck(false));
export const hdfcCustomerRecheck = secured(claimOrRecheck(true));
