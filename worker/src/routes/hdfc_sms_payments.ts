// [PAY-HDFC-SMOKE-V2] Admin-owned ₹1 web harness; no commercial provisioning.
import type { Env } from '../types';
import { metaDb } from '../db/shard';
import { json } from '../util';
import { rateLimit } from '../money';
import { requireAdmin } from './admin_money';
import { hmacSha256Hex,sha256Hex,constantTimeEqual } from '../lib/payments/types';
import { SMOKE_LISTING,UUID,policy,currentIntent,readIntent,legacyIntent,publicIntent,createIntent,saveReference,normalizeReference,parseReference,parsePayerVpa,receiptCandidates,parseAmountPaise,isHdfcSender,hasAccountSuffix,matchIntent,boundedBody,timestampInterval,storeEvidence } from '../lib/hdfc_sms_smoke';
import { finalizeSaathumCheckoutByIntent } from './saathum_checkout';
import { trackException } from '../hooks';
export const UPI_SMOKE_TEST_LISTING_ID=SMOKE_LISTING;
const failure=(error:string,status=503)=>json({error,retryable:status===503||status===429},status);
async function limited(env:Env,bucket:string,max:number):Promise<Response|null>{
 const r=await rateLimit(env,`hdfc-smoke:${bucket}`,max,60);
 return r?json({error:'rate_limited',retryable:true},429,{'retry-after':r.headers.get('retry-after')??'60'}):null;
}
export async function hdfcSmsMethod(req:Request,env:Env):Promise<Response>{
 const a=await requireAdmin(req,env);if(a instanceof Response)return a;
 const p=await policy(env);
 return json({gateway:'hdfc_sms',enabled:p.enabled,protocol_version:2,label:'Internal ₹1 smoke test',test_mode:true,reason_code:p.reason});
}
export async function hdfcSmsCurrent(req:Request,env:Env):Promise<Response>{
 const a=await requireAdmin(req,env);if(a instanceof Response)return a;
 try{const p=await policy(env);if(!p.ready)return failure('schema_not_ready');
 const i=await currentIntent(metaDb(env),a.uid);
 return json({ok:true,protocol_version:2,account_id:a.uid,enabled:p.enabled,intent:i?publicIntent(i,env,p):null});
 }catch{return failure('state_unavailable');}
}
export async function hdfcSmsCreateOrder(req:Request,env:Env):Promise<Response>{
 const a=await requireAdmin(req,env);if(a instanceof Response)return a;
 const b=await boundedBody(req,2048);
 if(!b)return failure('invalid_request',400);
 if(b.listingId!==SMOKE_LISTING)return failure('commercial_hdfc_disabled',403);
 if(typeof b.request_key!=='string'||!UUID.test(b.request_key)||(b.replace_intent_id!==undefined&&(typeof b.replace_intent_id!=='string'||!UUID.test(b.replace_intent_id))))return failure('invalid_request',400);
 try{
  const p=await policy(env);if(!p.enabled)return failure(p.reason??'rail_paused');
  const throttle=await limited(env,`create:${a.uid}`,10);if(throttle)return throttle;
  const i=await createIntent(metaDb(env),a.uid,b.request_key,typeof b.replace_intent_id==='string'?b.replace_intent_id:null,p);
  return i?json({ok:true,...publicIntent(i,env,p)}):failure('intent_busy',409);
 }catch{return failure('state_unavailable');}
}
export async function hdfcSmsStatus(req:Request,env:Env):Promise<Response>{
 const a=await requireAdmin(req,env);if(a instanceof Response)return a;
 const id=new URL(req.url).searchParams.get('intent_id')??'';
 if(!id||id.length>100)return failure('not_found',404);
 try{
  const db=metaDb(env),p=await policy(env);
  // Historical state stays readable before the seed; GET never reconciles anything.
  if(p.ready){const i=await readIntent(db,id,a.uid);if(i)return json({ok:true,...publicIntent(i,env,p)});}
  const legacy=await legacyIntent(db,id,a.uid);
  return legacy?json({ok:true,...legacy}):p.ready?failure('not_found',404):failure('schema_not_ready');
 }catch{return failure('state_unavailable');}
}
async function claimOrRecheck(req:Request,env:Env,recheck:boolean):Promise<Response>{
 const a=await requireAdmin(req,env);if(a instanceof Response)return a;
 const b=await boundedBody(req,2048);
 if(!b||typeof b.intent_id!=='string'||b.intent_id.length>100)return failure('invalid_request',400);
 const ref=recheck?null:normalizeReference(b.bank_reference);
 if(!recheck&&!ref)return failure('reference_must_be_12_digits',400);
 if(!recheck&&(!Number.isSafeInteger(b.expected_reference_revision)||Number(b.expected_reference_revision)<0))return failure('invalid_request',400);
 try{
  const p=await policy(env);if(!p.enabled)return failure(p.reason??'rail_paused');
  const db=metaDb(env),i=await readIntent(db,b.intent_id,a.uid);if(!i)return failure('not_found',404);
  const throttle=await limited(env,`claim:${a.uid}`,20);if(throttle)return throttle;
  if(ref&&!await saveReference(db,i,ref,Number(b.expected_reference_revision)))return failure('reference_conflict',409);
  const result=await matchIntent(db,i.intent_id,a.uid,p);
  return result?json({ok:true,...publicIntent(result,env,p)}):failure('not_found',404);
 }catch{return failure('match_retry_required');}
}
export const hdfcSmsClaim=(req:Request,env:Env)=>claimOrRecheck(req,env,false);
export const hdfcSmsRecheck=(req:Request,env:Env)=>claimOrRecheck(req,env,true);
function field(b:Record<string,unknown>,key:string,max:number):string|null{const v=b[key];return typeof v==='string'&&v.length>0&&v.length<=max?v:null;}
const ack=(receipt:string|null,state:string,match:string,reason:string|null)=>json({ok:true,protocol_version:2,receipt_id:receipt,receipt_state:state,match_state:match,reason_code:reason});
export async function hdfcSmsIncoming(req:Request,env:Env):Promise<Response>{
 const b=await boundedBody(req);if(!b)return failure('invalid_payload',400);
 const device=field(b,'device_id',128),sender=field(b,'sender',32),message=field(b,'message',4096),received=field(b,'received_at',40),sent=field(b,'sent_at',40),hash=field(b,'message_hash',64),nonce=field(b,'nonce',128),signature=field(b,'signature',64);
 if(!device||device!==env.HDFC_SMS_DEVICE_ID||!env.HDFC_SMS_DEVICE_SECRET||!sender||!message||!received||!sent||!hash||!nonce||!signature||!/^[a-f0-9]{64}$/.test(hash)||!/^[a-f0-9]{64}$/i.test(signature)||(b.sim_slot!==undefined&&b.sim_slot!==null&&(!Number.isInteger(b.sim_slot)||Number(b.sim_slot)<-1||Number(b.sim_slot)>8)))return failure('invalid_device_payload',401);
 const window=timestampInterval(received),sentWindow=timestampInterval(sent),now=Date.now();
 if(!window||!sentWindow||Math.abs(now-sentWindow.start)>300000)return failure('invalid_timestamp',400);
 const expected=await hmacSha256Hex(env.HDFC_SMS_DEVICE_SECRET,[device,sender,message,received,b.sim_slot??'',hash,nonce,sent].join('\n'));
 if(!constantTimeEqual(expected,signature.toLowerCase()))return failure('invalid_signature',401);
 if(!constantTimeEqual(await sha256Hex(`${sender}|${message}|${received}`),hash))return failure('message_hash_mismatch',400);
 try{
  const p=await policy(env);if(!p.ready)return failure('schema_not_ready');
  if(!p.configured)return failure('configuration_incomplete');
  const throttle=await limited(env,`incoming:${device}`,120);if(throttle)return throttle;
  const amount=parseAmountPaise(message),reference=parseReference(message),payerVpa=parsePayerVpa(message);
  // Never retain unrelated raw messages, OTPs or password notifications.
  if(!isHdfcSender(sender)||!amount)return ack(null,'ignored','unmatched',!isHdfcSender(sender)?'sender_not_allowed':'not_supported_credit');
  const reason=!hasAccountSuffix(message,env.HDFC_SMS_ACCOUNT_SUFFIX??'')?'account_mismatch':window.start<p.cutover?'pre_cutover':window.start>now+60000?'future_receipt':!reference?'unsupported_reference':null;
  const db=metaDb(env);
  let receipt=await storeEvidence(db,{message_hash:hash,receiving_account_key:p.account,bank_reference:reference,payer_vpa:payerVpa,amount_paise:amount,received_at_ms:window.start,received_at_end_ms:window.end,ingested_at:now,disposition:reason?'review_required':'accepted',reason_code:reason,claimed_intent_id:null},{device,sender,message,received,nonce});
  // A nonce collision is not acknowledgement of an unstored message.
  if(!receipt)return failure('nonce_conflict');
  if(receipt.disposition==='accepted'&&!receipt.claimed_intent_id&&p.enabled&&receipt.bank_reference){
   const candidates=await receiptCandidates(db,receipt.message_hash,now);
   // The shared SQL helper rejects all ambiguous eligible pairs atomically.
   if(candidates.results.length){const i=candidates.results[0];await matchIntent(db,i.intent_id,i.uid,p,now);}
   receipt=await db.prepare('SELECT * FROM hdfc_sms_smoke_receipts WHERE message_hash=?').bind(receipt.message_hash).first<typeof receipt>();
   if(!receipt)return failure('match_retry_required');
  }
  // [SAATHUM-CHECKOUT-API 2026-09-26] This evidence row might instead belong to a
  // Saa Thum checkout waiting on this exact (account, reference, amount) — see
  // worker/migrations/2026-09-26-saathum-checkout.sql for why Saa Thum keeps its
  // own payment-matching state rather than a row in hdfc_sms_smoke_intents.
  // Best-effort and independent of the smoke-engine match above: never breaks the
  // SMS device's ack either way.
  if(receipt.disposition==='accepted'&&receipt.bank_reference){
   try{
    const waiting=await db.prepare(`SELECT checkout_id FROM saathum_checkouts WHERE receiving_account_key=?1 AND payer_reference=?2 AND amount_paise=?3 AND status='awaiting_payment'`).bind(receipt.receiving_account_key,receipt.bank_reference,receipt.amount_paise).first<{checkout_id:string}>();
    if(waiting)await finalizeSaathumCheckoutByIntent(env,waiting.checkout_id);
   }catch(err){await trackException(env,err,{route:'/api/sms/incoming',handled:true,app_name:'saathum'});}
  }
  if(receipt.disposition==='legacy')return ack(receipt.message_hash,'review_pending','unmatched','legacy_unverified');
  if(receipt.disposition!=='accepted')return ack(receipt.message_hash,'review_pending','unmatched',receipt.reason_code);
  if(receipt.claimed_intent_id)return ack(receipt.message_hash,'accepted','confirmed',null);
  const unassigned=await db.prepare(`SELECT intent_id FROM hdfc_sms_smoke_intents WHERE receiving_account_key=?1 AND payer_vpa IS NULL AND payer_reference IS NULL AND superseded_by IS NULL AND recover_until>=?2
   AND amount_paise=?3 AND created_at<=?4 AND expires_at>=?5 AND NOT EXISTS(SELECT 1 FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id=hdfc_sms_smoke_intents.intent_id) LIMIT 1`).bind(p.account,now,receipt.amount_paise,receipt.received_at_end_ms,receipt.received_at_ms).first();
  return ack(receipt.message_hash,'accepted',unassigned?'awaiting_reference':'unmatched',unassigned?'reference_required':'no_match');
 }catch{return failure('receipt_storage_or_match_unavailable');}
}
/** Compatibility health check; no device-health store or checkout health gate. */
export async function hdfcSmsHeartbeat(req:Request,env:Env):Promise<Response>{
 const b=await boundedBody(req,2048);if(!b)return failure('invalid_payload',400);
 const device=field(b,'device_id',128),nonce=field(b,'nonce',128),sent=field(b,'sent_at',40),signature=field(b,'signature',64);
 if(!device||device!==env.HDFC_SMS_DEVICE_ID||!env.HDFC_SMS_DEVICE_SECRET||!nonce||!sent||!signature)return failure('unknown_device',401);
 const time=timestampInterval(sent);if(!time||Math.abs(Date.now()-time.start)>300000)return failure('invalid_timestamp',400);
 const expected=await hmacSha256Hex(env.HDFC_SMS_DEVICE_SECRET,`${device}\n${nonce}\n${sent}`);
 return constantTimeEqual(expected,signature.toLowerCase())?json({ok:true}):failure('invalid_signature',401);
}
