// [HDFC-SMS-2] Internal test evidence and its single SQL claim authority.
import type { Env } from '../types';
import { metaDb } from '../db/shard';
import { readConfig } from '../routes/config';
import { sha256Hex } from './payments/types';
export const SMOKE_LISTING = 'avatok-upi-smoke-2026';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface Intent {
 intent_id:string; uid:string; request_key:string; receiving_account_key:string;
 amount_paise:number; created_at:number; expires_at:number; recover_until:number;
 active:number; superseded_by:string|null; payer_reference:string|null;
 payer_vpa:string|null; payer_phone:string|null;
 reference_revision:number; updated_at:number; claimed_at:number|null;
 disposition:string|null; evidence_reason:string|null; relevant_count:number;
 unsupported_count:number; conflict_count:number;
}
export interface Policy { enabled:boolean; configured:boolean; ready:boolean; account:string; cutover:number; reason:string|null }
export function normalizeReference(value:unknown):string|null {
 return typeof value==='string' && /^\d{12}$/.test(value.trim()) ? value.trim() : null;
}
/** Self-reported routing details, never proof of VPA or phone ownership. */
export function normalizePayerVpa(value:unknown):string|null {
 if(typeof value!=='string')return null;
 const v=value.trim().toLowerCase();
 return v.length<=280 && /^[a-z0-9][a-z0-9._-]{0,198}[a-z0-9]@[a-z][a-z0-9.-]{0,78}[a-z0-9]$/.test(v) && !v.includes('..') ? v : null;
}
export function normalizePayerPhone(value:unknown):string|null {
 if(typeof value!=='string')return null;
 const v=value.trim();
 if(/^[6-9]\d{9}$/.test(v))return `+91${v}`;
 return /^\+[1-9]\d{7,14}$/.test(v)?v:null;
}
/** Parse the entire bank-labelled field; duplicate fields are ambiguous even
 * when equal. A trailing malformed token must never match a valid prefix. */
export function parsePayerVpa(message:string):string|null {
 const labels=[...message.matchAll(/\bfrom\s+VPA\b/gi)];
 if(labels.length!==1||[...message.matchAll(/\bVPA\b/gi)].length!==1)return null;
 const tail=message.slice(labels[0].index!+labels[0][0].length);
 const field=/^\s+([^\s()]+)\s*\(\s*UPI\s+\d{12}\s*\)/i.exec(tail);
 return field?normalizePayerVpa(field[1]):null;
}
export function parseReference(message:string):string|null {
 const pattern=/\b(?:UTR|UPI\s*(?:REF(?:ERENCE)?|RRN)|REF(?:ERENCE)?(?:\s*NO\.?)?)\s*[:#-]?\s*(\d{12})(?![A-Za-z0-9])|\(\s*UPI\s+(\d{12})\s*\)/gi;
 const refs=new Set([...message.matchAll(pattern)].map(m=>m[1]??m[2]));
 return refs.size===1 ? [...refs][0] : null;
}
export function parseAmountPaise(message:string):number|null {
 if (/\b(?:otp|one[ -]?time|password|pin|verification|debited|declined|failed)\b/i.test(message) || !/\b(?:credited|received)\b/i.test(message)) return null;
 const m=message.match(/(?:\bINR\b|\bRs\.?|₹)\s*((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?(?![\d.,])/i);
 if (!m || /\b(?:USD|EUR|GBP|KES)\b/i.test(message)) return null;
 const n=Number(m[1].replace(/,/g,''))*100+Number((m[2]??'').padEnd(2,'0'));
 return Number.isSafeInteger(n)&&n>0 ? n : null;
}
export function isHdfcSender(sender:string):boolean { return /^(?:[A-Z0-9]{2}-)?(?:HDFCBK|HDFCBN|HDFCBANK)(?:-[A-Z])?$/i.test(sender); }
export function hasAccountSuffix(message:string,suffix:string):boolean {
 if (!/^\d{4,6}$/.test(suffix)) return false;
 const values=[...message.matchAll(/\b(?:a\s*\/\s*c|acct|account|ac)\b\s*(?:(?:no\.?|number)\s*)?[:.\-]?\s*([xX*0-9]+)(?![A-Za-z0-9])/gi)];
 return values.length>0 && values.every(m=>m[1].endsWith(suffix));
}
/** Deployed companion signs whole seconds at +03:00; never reinterpret locale.
 * Millisecond timestamps retain their precise interval, old seconds cover 0..999ms. */
export function timestampInterval(value:string):{start:number;end:number}|null {
 const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{3})?(Z|\+03:00)$/.exec(value);
 if (!m) return null;
 const start=Date.parse(value); if(!Number.isFinite(start))return null;
 const offset=m[4]==='+03:00'?10800000:0;
 if(new Date(start+offset).toISOString().slice(0,19)!==`${m[1]}T${m[2]}`)return null;
 return {start,end:start+(m[3]?0:999)};
}
export async function boundedBody(req:Request,max=8192):Promise<Record<string,unknown>|null> {
 if(Number(req.headers.get('content-length')??0)>max)return null;
 const reader=req.body?.getReader();if(!reader)return null;
 const chunks:Uint8Array[]=[];let size=0;
 try { while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>max){await reader.cancel();return null;}chunks.push(r.value);}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  const value=JSON.parse(new TextDecoder().decode(bytes));return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
 }catch{return null;}
}
export async function policy(env:Env):Promise<Policy> {
 const config=await readConfig(env);
 const configured=/^[A-Za-z0-9._-]{2,200}@[A-Za-z0-9.-]{2,80}$/.test(env.HDFC_UPI_VPA??'')&&/^\d{4,6}$/.test(env.HDFC_SMS_ACCOUNT_SUFFIX??'')&&Boolean(env.HDFC_SMS_DEVICE_ID&&env.HDFC_SMS_DEVICE_SECRET);
 const account=await sha256Hex(`HDFC|${env.HDFC_SMS_ACCOUNT_SUFFIX??''}|INR`);
 let ready=false,cutover=0;
 try {
  const db=metaDb(env);
  const marker=await db.prepare('SELECT protocol_version,cutover_ms,seed_digest,receiving_account_key FROM hdfc_sms_smoke_ready').first<{protocol_version:number;cutover_ms:number;seed_digest:string;receiving_account_key:string}>();
  await db.prepare('SELECT i.reference_revision,i.payer_vpa,i.payer_phone,r.payer_vpa,r.received_at_end_ms,r.claimed_at FROM hdfc_sms_smoke_intents i LEFT JOIN hdfc_sms_smoke_receipts r ON r.claimed_intent_id=i.intent_id LIMIT 1').first();
  const indexes=await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('hdfc_sms_smoke_one_active','hdfc_sms_smoke_bank_identity','hdfc_sms_public_payer_active','hdfc_sms_public_owner_active')").all();
  ready=Boolean(marker?.protocol_version===2&&marker.receiving_account_key===account&&/^[a-f0-9]{64}$/.test(marker.seed_digest)&&Number.isSafeInteger(marker.cutover_ms)&&indexes.results.length===4);
  cutover=marker?.cutover_ms??0;
 }catch{ /* Missing/partial seed is deliberately retryable, never fallback to v1. */ }
 const reason=!ready?'schema_not_ready':!configured?'configuration_incomplete':config.hdfcSmsEnabled!==true?'rail_paused':null;
 return {enabled:ready&&configured&&config.hdfcSmsEnabled===true,configured,ready,account,cutover,reason};
}
const INTENT_SELECT=`SELECT i.*,r.claimed_at,r.disposition,r.reason_code AS evidence_reason,
 (SELECT count(*) FROM hdfc_sms_smoke_receipts e WHERE e.receiving_account_key=i.receiving_account_key AND e.amount_paise=i.amount_paise AND e.disposition='accepted' AND (i.payer_vpa IS NULL OR e.payer_vpa=i.payer_vpa) AND e.claimed_intent_id IS NULL AND ((i.payer_vpa IS NULL AND e.received_at_end_ms>=i.created_at) OR (i.payer_vpa IS NOT NULL AND e.received_at_ms>=i.created_at)) AND e.received_at_ms<=i.expires_at) AS relevant_count,
 (SELECT count(*) FROM hdfc_sms_smoke_receipts e WHERE e.receiving_account_key=i.receiving_account_key AND e.amount_paise=i.amount_paise AND e.reason_code='unsupported_reference' AND e.received_at_end_ms>=i.created_at AND e.received_at_ms<=i.expires_at) AS unsupported_count,
 (SELECT count(*) FROM hdfc_sms_smoke_receipts e WHERE e.receiving_account_key=i.receiving_account_key AND (e.bank_reference=i.payer_reference OR (NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts settled WHERE settled.claimed_intent_id=i.intent_id AND settled.disposition='accepted') AND i.payer_vpa IS NOT NULL AND e.payer_vpa=i.payer_vpa AND e.amount_paise=i.amount_paise AND e.received_at_ms>=i.created_at AND e.received_at_ms<=i.expires_at)) AND e.disposition='review_required') AS conflict_count
 FROM hdfc_sms_smoke_intents i LEFT JOIN hdfc_sms_smoke_receipts r ON r.claimed_intent_id=i.intent_id`;
export async function readIntent(db:D1Database,id:string,uid:string):Promise<Intent|null> {
 return db.prepare(`${INTENT_SELECT} WHERE i.intent_id=? AND i.uid=?`).bind(id,uid).first<Intent>();
}
export async function currentIntent(db:D1Database,uid:string):Promise<Intent|null> {
 return db.prepare(`${INTENT_SELECT} WHERE i.uid=? ORDER BY i.active DESC,i.created_at DESC,i.intent_id DESC LIMIT 1`).bind(uid).first<Intent>();
}
export function publicIntent(i:Intent,env:Env,p:Policy,now=Date.now()) {
 const confirmed=i.disposition==='accepted'&&i.claimed_at!==null;
 const conflict=i.disposition==='review_required'||i.conflict_count>0||(!confirmed&&Boolean(i.payer_vpa)&&i.relevant_count>1);
 const status=i.superseded_by?'superseded':conflict?'review_pending':confirmed?'confirmed':i.expires_at<=now?'expired':'pending';
 const reason=i.superseded_by?'superseded':conflict?'evidence_conflict':confirmed?null:i.payer_vpa?'awaiting_sms':i.relevant_count?(i.payer_reference?'no_match':'reference_required'):i.unsupported_count?'unsupported_reference':'awaiting_sms';
 const canPay=p.enabled&&status==='pending';
 return {protocol_version:2,intent_id:i.intent_id,status,reason_code:reason,amount_paise:100,created_at:i.created_at,expires_at:i.expires_at,recover_until:i.recover_until,updated_at:Math.max(i.updated_at,i.claimed_at??0),claim_submitted:Boolean(i.payer_reference),reference_revision:i.reference_revision,smoke_test:true,order_id:null,
 ...(canPay?{upi_url:`upi://pay?${new URLSearchParams({pa:env.HDFC_UPI_VPA!,pn:env.HDFC_UPI_PAYEE_NAME??'AvaTOK',am:'1.00',cu:'INR',tr:`AV${i.intent_id.replace(/-/g,'')}`,tn:'AvaTOK internal smoke test'})}`}:{})};
}
export async function legacyIntent(db:D1Database,id:string,uid:string) {
 const i=await db.prepare('SELECT intent_id,status,amount_paise,expires_at,updated_at,commercial_order_id,listing_id FROM hdfc_sms_payment_intents WHERE intent_id=? AND uid=?').bind(id,uid).first<{intent_id:string;status:string;amount_paise:number;expires_at:number;updated_at:number;commercial_order_id:string|null;listing_id:string}>();
 return i?{protocol_version:1,intent_id:i.intent_id,status:i.status,reason_code:'legacy_unverified',amount_paise:i.amount_paise,expires_at:i.expires_at,recover_until:null,updated_at:i.updated_at,claim_submitted:false,reference_revision:0,smoke_test:i.listing_id===SMOKE_LISTING,order_id:i.listing_id===SMOKE_LISTING?null:i.commercial_order_id}:null;
}
export async function createIntent(db:D1Database,uid:string,key:string,replace:string|null,p:Policy,now=Date.now()):Promise<Intent|null> {
 const prior=await db.prepare('SELECT intent_id FROM hdfc_sms_smoke_intents WHERE uid=? AND request_key=?').bind(uid,key).first<{intent_id:string}>();
 if(prior)return readIntent(db,prior.intent_id,uid);
 const active=await db.prepare('SELECT intent_id,uid FROM hdfc_sms_smoke_intents WHERE receiving_account_key=? AND payer_vpa IS NULL AND active=1 AND expires_at>?').bind(p.account,now).first<{intent_id:string;uid:string}>();
 if(active&&!replace)return active.uid===uid?readIntent(db,active.intent_id,uid):null;
 if(active&&(active.uid!==uid||replace!==active.intent_id))return null;
 const id=crypto.randomUUID();
 await db.batch([
  db.prepare('UPDATE hdfc_sms_smoke_intents SET active=0,updated_at=? WHERE receiving_account_key=? AND payer_vpa IS NULL AND active=1 AND expires_at<=?').bind(now,p.account,now),
  db.prepare(`UPDATE hdfc_sms_smoke_intents SET active=0,superseded_by=?1,updated_at=?2 WHERE intent_id=?3 AND uid=?4 AND receiving_account_key=?5 AND superseded_by IS NULL
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id=?3)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE receiving_account_key=?5 AND payer_vpa IS NULL AND active=1 AND intent_id<>?3)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE uid=?4 AND request_key=?6)`).bind(id,now,replace,uid,p.account,key),
  db.prepare(`INSERT INTO hdfc_sms_smoke_intents(intent_id,uid,request_key,receiving_account_key,created_at,expires_at,recover_until,updated_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?5
   WHERE NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE receiving_account_key=?4 AND payer_vpa IS NULL AND active=1)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE uid=?2 AND request_key=?3)
   AND (?8 IS NULL OR EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE intent_id=?8 AND uid=?2 AND superseded_by=?1))`).bind(id,uid,key,p.account,now,now+1800000,now+88200000,replace),
 ]);
 const saved=await db.prepare('SELECT intent_id FROM hdfc_sms_smoke_intents WHERE uid=? AND request_key=?').bind(uid,key).first<{intent_id:string}>();
 return saved?readIntent(db,saved.intent_id,uid):null;
}
/** Public customer attempts are isolated by their anonymous capability, so one
 * waiting customer cannot block another customer from receiving a QR. */
export async function createPublicConcurrentIntent(db:D1Database,uid:string,key:string,p:Policy,now=Date.now()):Promise<Intent|null> {
 const prior=await db.prepare('SELECT intent_id FROM hdfc_sms_smoke_intents WHERE uid=? AND request_key=?').bind(uid,key).first<{intent_id:string}>();
 if(prior)return readIntent(db,prior.intent_id,uid);
 const open=await db.prepare('SELECT intent_id FROM hdfc_sms_smoke_intents WHERE uid=? AND receiving_account_key=? AND payer_vpa IS NULL AND active=1 AND expires_at>? ORDER BY created_at DESC LIMIT 1').bind(uid,p.account,now).first<{intent_id:string}>();
 if(open)return readIntent(db,open.intent_id,uid);
 const id=crypto.randomUUID();
 await db.prepare(`INSERT INTO hdfc_sms_smoke_intents(intent_id,uid,request_key,receiving_account_key,created_at,expires_at,recover_until,updated_at)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?5 WHERE NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE uid=?2 AND request_key=?3)`).bind(id,uid,key,p.account,now,now+1800000,now+88200000).run();
 const saved=await db.prepare('SELECT intent_id FROM hdfc_sms_smoke_intents WHERE uid=? AND request_key=?').bind(uid,key).first<{intent_id:string}>();
 return saved?readIntent(db,saved.intent_id,uid):null;
}
/** Public attempts never supersede an unresolved transfer. The guarded INSERT
 * is serialized by D1 and backed by independent owner/payer unique indexes.
 * Even an expired QR reserves its payer through the complete recovery window. */
export async function createPublicIntent(db:D1Database,uid:string,key:string,vpa:string,phone:string,p:Policy,now=Date.now()):Promise<Intent|null> {
 const id=crypto.randomUUID();
 await db.batch([
  db.prepare(`UPDATE hdfc_sms_smoke_intents SET active=0,updated_at=?2
   WHERE receiving_account_key=?1 AND payer_vpa IS NOT NULL AND active=1 AND recover_until<?2`).bind(p.account,now),
  db.prepare(`INSERT INTO hdfc_sms_smoke_intents(intent_id,uid,request_key,receiving_account_key,payer_vpa,payer_phone,created_at,expires_at,recover_until,updated_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?7
   WHERE NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents WHERE uid=?2 AND request_key=?3)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents i WHERE i.receiving_account_key=?4
    AND i.payer_vpa IS NOT NULL AND (i.uid=?2 OR (i.payer_vpa=?5 AND i.amount_paise=100))
    AND i.recover_until>=?7 AND i.superseded_by IS NULL
    AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts r WHERE r.claimed_intent_id=i.intent_id AND r.disposition='accepted'))
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents i WHERE i.active=1 AND i.payer_vpa IS NOT NULL
    AND (i.uid=?2 OR (i.receiving_account_key=?4 AND i.payer_vpa=?5 AND i.amount_paise=100)))`)
   .bind(id,uid,key,p.account,vpa,phone,now,now+1800000,now+88200000),
 ]);
 const saved=await db.prepare('SELECT intent_id FROM hdfc_sms_smoke_intents WHERE uid=? AND request_key=?').bind(uid,key).first<{intent_id:string}>();
 const intent=saved?await readIntent(db,saved.intent_id,uid):null;
 return intent?.payer_vpa===vpa&&intent.payer_phone===phone?intent:null;
}
export async function saveReference(db:D1Database,i:Intent,reference:string,revision:number,now=Date.now()):Promise<boolean> {
 await db.prepare(`UPDATE hdfc_sms_smoke_intents SET payer_reference=?3,reference_revision=reference_revision+1,updated_at=?5
 WHERE intent_id=?1 AND uid=?2 AND payer_vpa IS NULL AND reference_revision=?4 AND payer_reference IS NOT ?3 AND superseded_by IS NULL AND recover_until>=?5
  AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id=?1)
  AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE bank_reference=?3 AND claimed_intent_id IS NOT NULL AND claimed_intent_id<>?1)`).bind(i.intent_id,i.uid,reference,revision,now).run();
 return (await readIntent(db,i.intent_id,i.uid))?.payer_reference===reference;
}
/** Both association modes share the same atomic authority and ambiguity count.
 * Public matches require the whole signed timestamp interval after creation.
 * Historical NULL-VPA receipts cannot match a public VPA intent. */
function eligibleIntent(alias:string, nowParameter:string):string {
 const r='hdfc_sms_smoke_receipts';
 return `${alias}.receiving_account_key=${r}.receiving_account_key
  AND ${alias}.amount_paise=${r}.amount_paise AND ${r}.currency='INR'
  AND ${alias}.superseded_by IS NULL AND ${alias}.recover_until>=${nowParameter}
  AND ${r}.received_at_ms<=${alias}.expires_at
  AND ((${alias}.payer_vpa IS NULL AND ${alias}.payer_reference=${r}.bank_reference
    AND ${r}.received_at_end_ms>=${alias}.created_at)
   OR (${alias}.payer_vpa IS NOT NULL AND ${alias}.payer_vpa=${r}.payer_vpa
    AND ${r}.received_at_ms>=${alias}.created_at
    AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts previous
     WHERE previous.claimed_intent_id=${alias}.intent_id AND previous.disposition='accepted')))`;
}
/** All eligibility and recovery guards are inside the UPDATE. A receipt is the
 * only source of confirmation; conflicting evidence revokes that confirmation. */
export function claimStatement(db:D1Database,id:string,uid:string,p:Policy,now=Date.now()):D1PreparedStatement {
 return db.prepare(`UPDATE hdfc_sms_smoke_receipts SET claimed_intent_id=?1,claimed_at=?4
 WHERE claimed_intent_id IS NULL AND disposition='accepted' AND bank_reference IS NOT NULL AND received_at_ms>=?5
 AND EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents i WHERE i.intent_id=?1 AND i.uid=?2 AND i.receiving_account_key=?3
  AND ${eligibleIntent('i','?4')}
  AND (i.payer_vpa IS NULL OR NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts conflict
   WHERE conflict.receiving_account_key=i.receiving_account_key AND conflict.payer_vpa=i.payer_vpa
   AND conflict.amount_paise=i.amount_paise AND conflict.disposition='review_required'
   AND conflict.received_at_ms>=i.created_at AND conflict.received_at_ms<=i.expires_at)))
 AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id=?1)
 AND (SELECT count(*) FROM hdfc_sms_smoke_intents other WHERE ${eligibleIntent('other','?4')})=1
 AND (EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents target WHERE target.intent_id=?1 AND target.payer_vpa IS NULL)
  OR (SELECT count(*) FROM hdfc_sms_smoke_receipts candidate
   JOIN hdfc_sms_smoke_intents target ON target.intent_id=?1 AND candidate.payer_vpa=target.payer_vpa
   WHERE candidate.disposition='accepted' AND candidate.claimed_intent_id IS NULL
    AND candidate.receiving_account_key=?3 AND candidate.bank_reference IS NOT NULL AND candidate.received_at_ms>=?5
    AND candidate.amount_paise=target.amount_paise AND candidate.currency='INR'
    AND candidate.received_at_ms>=target.created_at AND candidate.received_at_ms<=target.expires_at)=1)`).bind(id,uid,p.account,now,p.cutover);
}
export async function matchIntent(db:D1Database,id:string,uid:string,p:Policy,now=Date.now()):Promise<Intent|null> {
 if(p.enabled)await db.batch([
 db.prepare(`UPDATE hdfc_sms_smoke_receipts SET disposition='review_required',reason_code='evidence_conflict'
 WHERE disposition='accepted' AND claimed_intent_id IS NULL AND receiving_account_key=?1
 AND EXISTS(SELECT 1 FROM hdfc_sms_smoke_intents target WHERE target.intent_id=?2 AND target.uid=?3 AND ${eligibleIntent('target','?4')})
 AND (SELECT count(*) FROM hdfc_sms_smoke_intents i WHERE ${eligibleIntent('i','?4')})>1`).bind(p.account,id,uid,now),
 claimStatement(db,id,uid,p,now),
 db.prepare(`UPDATE hdfc_sms_smoke_intents SET active=0,updated_at=MAX(updated_at,?3)
 WHERE intent_id=?1 AND uid=?2 AND active=1 AND EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id=?1)`).bind(id,uid,now)]);
 return readIntent(db,id,uid);
}
/** Incoming uses the same eligibility predicate as the final atomic claim. */
export async function receiptCandidates(db:D1Database,hash:string,now=Date.now()) {
 return db.prepare(`SELECT i.intent_id,i.uid FROM hdfc_sms_smoke_receipts
 JOIN hdfc_sms_smoke_intents i ON ${eligibleIntent('i','?2')}
 WHERE hdfc_sms_smoke_receipts.message_hash=?1`).bind(hash,now).all<{intent_id:string;uid:string}>();
}
export interface Evidence {payer_vpa?:string|null;message_hash:string;receiving_account_key:string;bank_reference:string|null;amount_paise:number;received_at_ms:number;received_at_end_ms:number;ingested_at:number;disposition:string;reason_code:string|null;claimed_intent_id:string|null}
export async function storeEvidence(db:D1Database,e:Evidence,raw:{device:string;sender:string;message:string;received:string;nonce:string}):Promise<Evidence|null> {
 // Raw transport dedup is allowed ONLY with the exact-row existence guard below.
 // Duplicate bank identities update the canonical row rather than violating UNIQUE.
 await db.batch([
  db.prepare('INSERT OR IGNORE INTO hdfc_sms_receipts(message_hash,device_id,sender,message,received_at,nonce,created_at) VALUES(?,?,?,?,?,?,?)').bind(e.message_hash,raw.device,raw.sender,raw.message,raw.received,raw.nonce,e.ingested_at),
  db.prepare(`UPDATE hdfc_sms_smoke_receipts SET disposition='review_required',reason_code='evidence_conflict'
   WHERE disposition<>'legacy' AND (message_hash=?1 OR (receiving_account_key=?2 AND bank_reference=?3))
   AND EXISTS(SELECT 1 FROM hdfc_sms_receipts WHERE message_hash=?1)
   AND (receiving_account_key<>?2 OR bank_reference IS NOT ?3 OR amount_paise IS NOT ?4 OR currency IS NOT 'INR'
    OR payer_vpa IS NOT ?9 OR received_at_end_ms<?5 OR received_at_ms>?6 OR (?7<>'accepted' AND reason_code IS NOT ?8))`).bind(e.message_hash,e.receiving_account_key,e.bank_reference,e.amount_paise,e.received_at_ms,e.received_at_end_ms,e.disposition,e.reason_code,e.payer_vpa??null),
  db.prepare(`INSERT INTO hdfc_sms_smoke_receipts(message_hash,receiving_account_key,bank_reference,amount_paise,currency,received_at_ms,received_at_end_ms,ingested_at,disposition,reason_code,payer_vpa)
   SELECT ?1,?2,?3,?4,'INR',?5,?6,?7,?8,?9,?10 WHERE EXISTS(SELECT 1 FROM hdfc_sms_receipts WHERE message_hash=?1)
   AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE message_hash=?1 OR (receiving_account_key=?2 AND bank_reference=?3))`).bind(e.message_hash,e.receiving_account_key,e.bank_reference,e.amount_paise,e.received_at_ms,e.received_at_end_ms,e.ingested_at,e.disposition,e.reason_code,e.payer_vpa??null),
  db.prepare(`UPDATE hdfc_sms_smoke_intents SET updated_at=MAX(updated_at,?4) WHERE receiving_account_key=?2
   AND EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts r WHERE (r.message_hash=?1 OR (r.receiving_account_key=?2 AND r.bank_reference=?3))
    AND r.disposition='review_required' AND (r.claimed_intent_id=hdfc_sms_smoke_intents.intent_id OR r.bank_reference=hdfc_sms_smoke_intents.payer_reference))
   AND EXISTS(SELECT 1 FROM hdfc_sms_receipts WHERE message_hash=?1)`).bind(e.message_hash,e.receiving_account_key,e.bank_reference,e.ingested_at),
 ]);
 const stored=await db.prepare('SELECT message_hash FROM hdfc_sms_receipts WHERE message_hash=?').bind(e.message_hash).first();
 if(!stored)return null;
 return db.prepare(`SELECT * FROM hdfc_sms_smoke_receipts WHERE message_hash=?1 OR (receiving_account_key=?2 AND bank_reference=?3) ORDER BY CASE WHEN message_hash=?1 THEN 0 ELSE 1 END LIMIT 1`).bind(e.message_hash,e.receiving_account_key,e.bank_reference).first<Evidence>();
}
