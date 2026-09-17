// Customer invitations grant only an isolated test, never administrator access.
import type { Env } from '../types';
import { sha256Hex } from './payments/types';
import { policy, publicIntent, readIntent, type Intent, type Policy } from './hdfc_sms_smoke';

export const TEST_SERVICE = {
 id: 'upi-demo-consultation', title: 'Demo consultation', duration_minutes: 15,
 test_mode: true, amount_paise: 100, currency: 'INR',
} as const;
export interface TestInvite {
 invite_id: string; expires_at: number; created_at: number;
 bound_uid: string | null; redeemed_at: number | null;
}
export interface TestBooking {
 booking_id: string; invite_id: string; intent_id: string; uid: string;
 service_id: string; created_at: number; test_mode: number;
}
export async function customerPolicy(db: D1Database, env: Env): Promise<Policy> {
 const p = await policy(env);
 try {
  // Probe columns in both additive tables before ANY customer write.
  await db.prepare('SELECT invite_id,token_hash,created_at,expires_at,bound_uid,redeemed_at FROM hdfc_sms_test_invites LIMIT 1').first();
  await db.prepare('SELECT booking_id,invite_id,intent_id,uid,service_id,created_at,test_mode FROM hdfc_sms_test_bookings LIMIT 1').first();
 } catch { return {...p, ready: false, enabled: false, reason: 'schema_not_ready'}; }
 return p;
}
export async function redeemInvite(db: D1Database, token: string, uid: string, now = Date.now()): Promise<TestInvite | null> {
 const hash = await sha256Hex(token);
 await db.prepare(`UPDATE hdfc_sms_test_invites SET bound_uid=?1,redeemed_at=?2
  WHERE token_hash=?3 AND bound_uid IS NULL AND expires_at>?2`).bind(uid, now, hash).run();
 // Only the winner (including retries after expiry) can read the bound invitation.
 return db.prepare('SELECT invite_id,expires_at,created_at,bound_uid,redeemed_at FROM hdfc_sms_test_invites WHERE token_hash=? AND bound_uid=?')
  .bind(hash, uid).first<TestInvite>();
}
export async function readInvite(db: D1Database, uid: string, id?: string): Promise<TestInvite | null> {
 return id
  ? db.prepare('SELECT invite_id,expires_at,created_at,bound_uid,redeemed_at FROM hdfc_sms_test_invites WHERE invite_id=? AND bound_uid=?').bind(id, uid).first<TestInvite>()
  : db.prepare('SELECT invite_id,expires_at,created_at,bound_uid,redeemed_at FROM hdfc_sms_test_invites WHERE bound_uid=? ORDER BY created_at DESC,invite_id DESC LIMIT 1').bind(uid).first<TestInvite>();
}
export async function readBooking(db: D1Database, inviteId: string, uid: string): Promise<TestBooking | null> {
 return db.prepare(`SELECT b.* FROM hdfc_sms_test_bookings b
  JOIN hdfc_sms_test_invites v ON v.invite_id=b.invite_id AND v.bound_uid=b.uid
  JOIN hdfc_sms_smoke_intents i ON i.intent_id=b.intent_id AND i.uid=b.uid
  WHERE b.invite_id=? AND b.uid=?`).bind(inviteId, uid).first<TestBooking>();
}
export function customerEnvelope(invite: TestInvite, booking: TestBooking | null, intent: Intent | null, uid: string, env: Env, p: Policy, now = Date.now()) {
 const visible = intent ? publicIntent(intent, env, p, now) : null;
 if (visible?.upi_url) {
  const url = new URL(visible.upi_url);
  url.searchParams.set('tn', 'AvaTOK test booking');
  visible.upi_url = url.toString();
 }
 const status = visible?.status === 'pending' ? 'awaiting_payment'
  : visible?.status === 'superseded' ? 'unavailable' : visible?.status;
 return {
  ok: true, protocol_version: 2, account_id: uid, enabled: p.enabled, reason_code: p.reason,
  invite: {invite_id: invite.invite_id, expires_at: invite.expires_at, can_create: !booking && invite.expires_at > now && p.enabled},
  service: TEST_SERVICE, intent: visible,
  booking: booking && visible ? {
   booking_id: booking.booking_id, service_id: TEST_SERVICE.id, service_title: TEST_SERVICE.title,
   duration_minutes: TEST_SERVICE.duration_minutes, test_mode: true, status,
   created_at: booking.created_at,
   confirmed_at: visible.status === 'confirmed' && intent?.disposition === 'accepted' ? intent.claimed_at : null,
   amount_paise: visible.amount_paise, currency: 'INR',
  } : null,
 };
}
export async function bookingEnvelope(db: D1Database, invite: TestInvite, uid: string, env: Env, p: Policy) {
 const booking = await readBooking(db, invite.invite_id, uid);
 const intent = booking ? await readIntent(db, booking.intent_id, uid) : null;
 return customerEnvelope(invite, booking, intent, uid, env, p);
}
/** ONE transaction creates the intent and its test record, or neither. Never adopts
 * an existing admin QR, replaces an intent, or attaches another invite's key. */
export async function createCustomerTestBooking(db: D1Database, inviteId: string, uid: string, key: string, p: Policy, now = Date.now()): Promise<TestBooking | null> {
 const existing = await readBooking(db, inviteId, uid);
 if (existing) return existing;
 const intentId = crypto.randomUUID(), bookingId = crypto.randomUUID();
 await db.batch([
  db.prepare('UPDATE hdfc_sms_smoke_intents SET active=0,updated_at=? WHERE receiving_account_key=? AND active=1 AND expires_at<=?').bind(now, p.account, now),
  db.prepare(`INSERT INTO hdfc_sms_smoke_intents(intent_id,uid,request_key,receiving_account_key,created_at,expires_at,recover_until,updated_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?5
   WHERE EXISTS(SELECT 1 FROM hdfc_sms_test_invites WHERE invite_id=?8 AND bound_uid=?2 AND expires_at>?5)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_test_bookings WHERE invite_id=?8)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE receiving_account_key=?4 AND active=1)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE uid=?2 AND request_key=?3)`)
   .bind(intentId, uid, key, p.account, now, now + 1800000, now + 88200000, inviteId),
  db.prepare(`INSERT INTO hdfc_sms_test_bookings(booking_id,invite_id,intent_id,uid,service_id,created_at)
   SELECT ?1,v.invite_id,i.intent_id,i.uid,'upi-demo-consultation',?5
   FROM hdfc_sms_smoke_intents i JOIN hdfc_sms_test_invites v ON v.invite_id=?2 AND v.bound_uid=i.uid
   WHERE i.intent_id=?3 AND i.uid=?4 AND v.expires_at>?5
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_test_bookings WHERE invite_id=?2)`)
   .bind(bookingId, inviteId, intentId, uid, now),
 ]);
 return readBooking(db, inviteId, uid);
}
