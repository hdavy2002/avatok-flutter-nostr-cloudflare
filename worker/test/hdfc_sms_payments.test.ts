import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const H=vi.hoisted(()=>({enabled:true}));
vi.mock('../src/routes/config',()=>({readConfig:async()=>({hdfcSmsEnabled:H.enabled})}));
vi.mock('../src/authz',()=>({requireUser:async(req:Request)=>req.headers.get('x-test-uid')==='anonymous'?{error:'unauthorized',status:401}:{uid:req.headers.get('x-test-uid')??'outsider'},isFail:(v:any)=>Boolean(v.error)}));
import {fixture,request,smokeSql} from './hdfc_test_db';
import {hdfcSmsCreateOrder,hdfcSmsClaim,hdfcSmsCurrent,hdfcSmsStatus,hdfcSmsIncoming,hdfcSmsRecheck,hdfcSmsMethod} from '../src/routes/hdfc_sms_payments';
import {parseReference,normalizeReference,parseAmountPaise,policy,timestampInterval,hasAccountSuffix,isHdfcSender,claimStatement,saveReference,readIntent,matchIntent,createIntent} from '../src/lib/hdfc_sms_smoke';
import {hmacSha256Hex,sha256Hex} from '../src/lib/payments/types';
import {resolveGateway} from '../src/lib/payments/registry';
import {adminRefund} from '../src/routes/admin_money';
import {executeCommercialRefund,refundRailFor} from '../src/lib/commercial_refund_rail';
let f:ReturnType<typeof fixture>;
let now:number;
beforeEach(()=>{now=1800000000500;vi.spyOn(Date,'now').mockImplementation(()=>now);f=fixture();H.enabled=true;});
afterEach(()=>{f.sql.close();vi.restoreAllMocks();});
async function create(uid='admin',extra:Record<string,unknown>={}){const res=await hdfcSmsCreateOrder(request('/order',{listingId:'avatok-upi-smoke-2026',request_key:crypto.randomUUID(),...extra},uid),f.env);return {res,body:await res.json() as Record<string,any>};}
async function receipt(reference='000123456789',amount='1.00',received=new Date(now).toISOString(),extra='',override:Record<string,unknown>={}){
 const sender='VM-HDFCBK',message=`Rs.${amount} credited to A/c XX1234 from Shopping sapin@okhdfc (UPI ${reference}). ${extra}`;
 const b={device_id:'test-device',sender,message,received_at:received,sim_slot:-1,message_hash:'',nonce:crypto.randomUUID(),sent_at:new Date(now).toISOString(),signature:'',...override};
 b.message_hash=await sha256Hex(`${b.sender}|${b.message}|${b.received_at}`);
 b.signature=await hmacSha256Hex(f.env.HDFC_SMS_DEVICE_SECRET!,[b.device_id,b.sender,b.message,b.received_at,b.sim_slot,b.message_hash,b.nonce,b.sent_at].join('\n'));return b;
}
async function claim(id:string,ref='000123456789',revision=0,uid='admin'){return hdfcSmsClaim(request('/claim',{intent_id:id,bank_reference:ref,expected_reference_revision:revision},uid),f.env);}
async function status(id:string){return (await hdfcSmsStatus(request(`/status?intent_id=${id}`),f.env)).json() as Promise<Record<string,any>>;}
const claims=()=>f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id IS NOT NULL').get()?.n;
const ingest=(body:unknown)=>hdfcSmsIncoming(request('/incoming',body),f.env);
describe('HDFC v2 authority / actual SQLite',()=>{
 it('A1 admin and owner gates cover every smoke API; commercial adapter is removed',async()=>{
  expect((await create('outsider')).res.status).toBe(403);
  expect((await create('anonymous')).res.status).toBe(401);
  expect((await create('admin',{listingId:'commercial'})).res.status).toBe(403);
  const {body:i}=await create();
  expect((await claim(i.intent_id,'000123456789',0,'other')).status).toBe(404);
  expect((await hdfcSmsStatus(request(`/status?intent_id=${i.intent_id}`,undefined,'other'),f.env)).status).toBe(404);
  for(const fn of [hdfcSmsCurrent,hdfcSmsMethod,hdfcSmsStatus])expect((await fn(request('/x',undefined,'outsider'),f.env)).status).toBe(403);
  expect((await hdfcSmsRecheck(request('/recheck',{intent_id:i.intent_id},'outsider'),f.env)).status).toBe(403);
  expect(resolveGateway('hdfc_sms')).toBeNull();
 });
 it('A1 every legacy refund shortcut fails before ledger/provider effects',async()=>{
  expect(await refundRailFor(f.env,'hdfc_sms-order:legacy')).toMatchObject({rail:'manual_external_review'});
  for(const amount of [0,100])for(const walletCredit of [false,true])expect(await executeCommercialRefund(f.env,{orderId:'hdfc_sms-order:legacy',buyerId:'admin',amount,reason:'test',walletCredit})).toEqual({ok:false,error:'manual_external_review_required'});
  for(const amount of [0,100])expect((await adminRefund(request('/admin/refund',{orderId:'hdfc_sms-order:legacy',amount,reason:'test'}),f.env)).status).toBe(409);
  expect(f.sql.prepare('SELECT count(*) n FROM wallet_ledger').get()?.n).toBe(0);
 });
 it('A2 parser accepts observed UPI template/labelled references and preserves zeroes',()=>{
  for(const label of ['(UPI 000123456789)','UTR: 000123456789','UPI REF 000123456789','REFERENCE 000123456789'])expect(parseReference(label)).toBe('000123456789');
  expect(normalizeReference('000123456789')).toBe('000123456789');expect(normalizeReference(123456789012)).toBeNull();
  expect(parseReference('credit 000123456789')).toBeNull();expect(parseReference('UTR 0001234567890')).toBeNull();
  expect(parseReference('(UPI 000123456789) UTR 999123456789')).toBeNull();
  expect(parseAmountPaise('Rs.1.00 credited from Shopping sapin@okhdfc')).toBe(100);
  for(const word of ['OTP','PIN','debited','declined','password','failed'])expect(parseAmountPaise(`Rs.1.00 credited ${word}`)).toBeNull();
  expect(parseAmountPaise('USD 1.00 credited')).toBeNull();expect(parseAmountPaise('Rs.0 credited')).toBeNull();expect(parseAmountPaise('INR 90071992547409910 credited')).toBeNull();
  expect(hasAccountSuffix('A/c XX1234','1234')).toBe(true);expect(hasAccountSuffix('A/c XX1234','')).toBe(false);expect(hasAccountSuffix('A/c XX1234','234')).toBe(false);
  expect(isHdfcSender('VM-HDFCBK')).toBe(true);expect(isHdfcSender('EVILHDFCBK')).toBe(false);
 });
 it('A2 explicit EAT/UTC timestamps preserve signed value and quantized interval',()=>{
  expect(timestampInterval('2026-09-18T12:00:00+03:00')).toEqual(timestampInterval('2026-09-18T09:00:00Z'));
  const t=timestampInterval('2026-09-18T09:00:00Z')!;expect(t.end-t.start).toBe(999);
  expect(timestampInterval('2026-09-18T09:00:00.123Z')!.end-t.start).toBe(123);
  expect(timestampInterval('2026-09-18T12:00:00')).toBeNull();expect(timestampInterval('2026-02-31T12:00:00Z')).toBeNull();
 });
 it('A4 concurrent create retry/replacement keeps one active and original request immutable',async()=>{
  const key=crypto.randomUUID();const responses=await Promise.all([create('admin',{request_key:key}),create('admin',{request_key:key})]);
  expect(responses.every(r=>r.res.status===200)).toBe(true);expect(new Set(responses.map(r=>r.body.intent_id)).size).toBe(1);
  const original=responses[0].body;expect((await create()).body.intent_id).toBe(original.intent_id);expect((await create('other')).res.status).toBe(409);
  const replacements=await Promise.all([create('admin',{replace_intent_id:original.intent_id}),create('admin',{replace_intent_id:original.intent_id})]);
  expect(replacements.filter(r=>r.res.status===200)).toHaveLength(1);
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_intents WHERE active=1').get()?.n).toBe(1);
  expect((await create('admin',{request_key:key})).body.status).toBe('superseded');
 });
 it('A4 stale replacement blocked by another active intent never mutates the old row',async()=>{
  const {body:old}=await create();now=old.expires_at+1;
  const {body:fresh}=await create('other');
  expect((await create('admin',{replace_intent_id:old.intent_id})).res.status).toBe(409);
  expect((await status(old.intent_id)).status).toBe('expired');
  expect(f.sql.prepare('SELECT superseded_by FROM hdfc_sms_smoke_intents WHERE intent_id=?').get(old.intent_id)?.superseded_by).toBeNull();
  expect(fresh.intent_id).not.toBe(old.intent_id);
 });
 it('A3/A5 accepted evidence alone awaits a reference; claim/retry has one authoritative row',async()=>{
  const {body:i}=await create();const b=await receipt();
  expect(await (await ingest(b)).json()).toMatchObject({receipt_state:'accepted',match_state:'awaiting_reference'});
  expect((await status(i.intent_id)).status).toBe('pending');
  await Promise.all([claim(i.intent_id),ingest(b),hdfcSmsRecheck(request('/recheck',{intent_id:i.intent_id}),f.env)]);
  expect((await status(i.intent_id)).status).toBe('confirmed');expect(claims()).toBe(1);
  const duplicate=await receipt('000123456789','1.00',b.received_at,'different transport body');
  expect(await (await ingest(duplicate)).json()).toMatchObject({receipt_id:b.message_hash,match_state:'confirmed'});
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_receipts').get()?.n).toBe(2);
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_receipts').get()?.n).toBe(1);
  expect((await claim(i.intent_id)).status).toBe(200);expect((await claim(i.intent_id,'999123456789',1)).status).toBe(409);
  const {body:next}=await create();await claim(next.intent_id);expect(claims()).toBe(1);expect((await status(next.intent_id)).status).toBe('pending');
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_payment_intents').get()?.n).toBe(0);
  expect(f.sql.prepare('SELECT count(*) n FROM commercial_policy_snapshots').get()?.n).toBe(0);
 });
 it('A3 authoritative prepared UPDATE rereads saved reference and SQL guards after concurrent correction',async()=>{
  const {body:i}=await create();await ingest(await receipt());await claim(i.intent_id,'999123456789');
  const p=await policy(f.env),intent=(await readIntent(f.db,i.intent_id,'admin'))!;
  const staleClaim=claimStatement(f.db,i.intent_id,'admin',p,now);
  await saveReference(f.db,intent,'888123456789',1,now);await staleClaim.run();expect(claims()).toBe(0);
  expect((await claim(i.intent_id,'000123456789',1)).status).toBe(409);
  expect((await claim(i.intent_id,'000123456789',2)).status).toBe(200);expect(claims()).toBe(1);
  expect((await status(i.intent_id)).reference_revision).toBe(3);
 });
 it('A3 conflicting amount/account/receipt time persists raw evidence and revokes displayed confirmation',async()=>{
  const {body:i}=await create();const b=await receipt();await ingest(b);await claim(i.intent_id);expect(claims()).toBe(1);
  const changed=await receipt('000123456789','2.00',b.received_at);
  expect(await (await ingest(changed)).json()).toMatchObject({receipt_id:b.message_hash,receipt_state:'review_pending',match_state:'unmatched'});
  expect((await status(i.intent_id)).status).toBe('review_pending');expect(claims()).toBe(1);
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_receipts').get()?.n).toBe(2);
 });
 it('A3 nonce collision never acknowledges unstored evidence; failures roll back complete D1 batch',async()=>{
  const first=await receipt();await ingest(first);
  const second=await receipt('000123456788','1.00',first.received_at,'',{nonce:first.nonce});
  expect((await ingest(second)).status).toBe(503);
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_receipts').get()?.n).toBe(1);
  await expect(f.db.batch([f.db.prepare("UPDATE hdfc_sms_smoke_receipts SET reason_code='must_rollback'"),f.db.prepare("INSERT INTO hdfc_sms_smoke_receipts(message_hash,receiving_account_key,ingested_at,disposition) VALUES('bad','x',0,'accepted')")])).rejects.toThrow();
  expect(f.sql.prepare('SELECT reason_code FROM hdfc_sms_smoke_receipts').get()?.reason_code).toBeNull();
 });
 it('A5 no evidence stays awaiting_sms; wrong reference can be corrected with CAS only',async()=>{
  const {body:i}=await create();await claim(i.intent_id,'999123456789');
  expect((await status(i.intent_id)).reason_code).toBe('awaiting_sms');
  await ingest(await receipt());expect((await status(i.intent_id)).reason_code).toBe('no_match');
  expect((await claim(i.intent_id,'999123456789',0)).status).toBe(200);
  expect((await claim(i.intent_id,'000123456789',0)).status).toBe(409);
  expect(await (await claim(i.intent_id,'000123456789',1)).json()).toMatchObject({status:'confirmed',reference_revision:2});
 });
 it('A5 whole-second overlap recovers original window after expiry, never widens it',async()=>{
  const {body:i}=await create();const second=new Date(Math.floor(now/1000)*1000).toISOString().replace('.000Z','Z');
  await ingest(await receipt('000123456789','1.00',second));now=i.expires_at+1;
  expect(await (await claim(i.intent_id)).json()).toMatchObject({status:'confirmed'});
  const p=await policy(f.env);const old=await createIntent(f.db,'admin',crypto.randomUUID(),null,p,now-90000000);
  expect(old).not.toBeNull();
  const before=claims();await matchIntent(f.db,old!.intent_id,'admin',p,now);expect(claims()).toBe(before);
 });
 it('A5 old/precutover/superseded/reference-less evidence cannot confirm',async()=>{
  const {body:i}=await create();await claim(i.intent_id);
  await ingest(await receipt('000123456789','1.00',new Date(now-1000).toISOString()));expect(claims()).toBe(0);
  const {body:newer}=await create('admin',{replace_intent_id:i.intent_id});
  await ingest(await receipt('999123456789'));expect((await status(newer.intent_id)).status).toBe('pending');expect(claims()).toBe(0);
  const unsupported=await receipt('x');expect(await (await ingest(unsupported)).json()).toMatchObject({receipt_state:'review_pending',reason_code:'unsupported_reference'});
 });
 it('A6 flag off and GETs have no claim effects; recheck finds evidence beyond 50 newer rows',async()=>{
  const {body:i}=await create();await claim(i.intent_id);H.enabled=false;
  await ingest(await receipt());
  for(let n=0;n<51;n++)await ingest(await receipt(String(700000000000+n)));
  const changes=f.sql.prepare('SELECT total_changes() n').get()?.n;
  await status(i.intent_id);await hdfcSmsCurrent(request('/current'),f.env);
  expect(f.sql.prepare('SELECT total_changes() n').get()?.n).toBe(changes);expect(claims()).toBe(0);
  expect((await create()).res.status).toBe(503);expect((await claim(i.intent_id)).status).toBe(503);
  H.enabled=true;expect(await (await hdfcSmsRecheck(request('/recheck',{intent_id:i.intent_id}),f.env)).json()).toMatchObject({status:'confirmed'});
 });
 it('A2/A6 pre-readiness returns retryable503 and signed OTP is ignored without raw storage',async()=>{
  const b=await receipt('000123456789','1.00',undefined,'',{message:'OTP 123456 for your PIN'});
  expect(await (await ingest(b)).json()).toMatchObject({receipt_id:null,receipt_state:'ignored',match_state:'unmatched'});
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_receipts').get()?.n).toBe(0);
  f.sql.exec('DROP VIEW hdfc_sms_smoke_ready;');expect((await ingest(await receipt())).status).toBe(503);expect((await create()).res.status).toBe(503);
 });
 it('A3 migration rerun preserves rows; legacy hashes/reference reservations cannot promote',async()=>{
  const b=await receipt();const p=await policy(f.env);
  f.sql.prepare("INSERT INTO hdfc_sms_smoke_receipts(message_hash,receiving_account_key,bank_reference,ingested_at,disposition,reason_code) VALUES(?,?,?,0,'legacy','legacy_receipt')").run(b.message_hash,p.account,'000123456789');
  await create();await claim((await create()).body.intent_id);
  expect(await (await ingest(b)).json()).toMatchObject({receipt_state:'review_pending',reason_code:'legacy_unverified'});
  expect(await (await ingest(await receipt('000123456789','1.00',b.received_at,'new hash'))).json()).toMatchObject({reason_code:'legacy_unverified'});
  f.sql.exec(smokeSql);f.sql.exec(smokeSql);expect(claims()).toBe(0);
  expect(f.sql.prepare("SELECT disposition FROM hdfc_sms_smoke_receipts").get()?.disposition).toBe('legacy');
 });
 it('A1 legacy status is read-only/unverified and returns only real commercial order ID',async()=>{
  for(const [id,listing,order] of [['legacy','commercial','hdfc_sms-order:real'],['smoke','avatok-upi-smoke-2026','bad-old-field']])f.sql.prepare("INSERT INTO hdfc_sms_payment_intents(intent_id,uid,listing_id,kind,amount_paise,status,commercial_order_id,expires_at,created_at,updated_at) VALUES(?,'admin',?,'live_event',100,'confirmed',?,1,0,0)").run(id,listing,order);
  expect(await status('legacy')).toMatchObject({protocol_version:1,status:'confirmed',reason_code:'legacy_unverified',order_id:'hdfc_sms-order:real'});
  expect(await status('smoke')).toMatchObject({order_id:null,protocol_version:1});
 });
 it('A2 invalid HMAC, sender, suffix, and pre-cutover evidence never qualifies',async()=>{
  const {body:i}=await create();await claim(i.intent_id);
  const bad=await receipt();bad.signature='0'.repeat(64);expect((await ingest(bad)).status).toBe(401);
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_receipts').get()?.n).toBe(0);
  expect(await (await ingest(await receipt('000123456789','1.00',undefined,'',{sender:'FAKE-HDFC'}))).json()).toMatchObject({receipt_state:'ignored'});
  expect(await (await ingest(await receipt('000123456789','1.00',undefined,'',{message:'Rs.1 credited to A/c XX9999 (UPI 000123456789)'}))).json()).toMatchObject({receipt_state:'review_pending',reason_code:'account_mismatch'});
  expect(claims()).toBe(0);
  const account=(await policy(f.env)).account;
  f.sql.exec(`DROP VIEW hdfc_sms_smoke_ready; CREATE VIEW hdfc_sms_smoke_ready AS SELECT 2 protocol_version,${now+1000} cutover_ms,'${'b'.repeat(64)}' seed_digest,'${account}' receiving_account_key;`);
  expect(await (await ingest(await receipt('000123456788'))).json()).toMatchObject({reason_code:'pre_cutover'});
 });
 it('A5 recovery cannot accept SMS outside original window or after recovery deadline',async()=>{
  const {body:i}=await create();await claim(i.intent_id);now=i.expires_at+1000;
  await ingest(await receipt());expect(claims()).toBe(0);
  const {body:second}=await create();const received=new Date(now).toISOString();
  await ingest(await receipt('000123456788','1.00',received));
  await claim(second.intent_id,'000123456788');expect(claims()).toBe(1);
  const {body:third}=await create();await claim(third.intent_id,'000123456787');
  const originalTime=new Date(now).toISOString();now=third.recover_until+1;
  await ingest(await receipt('000123456787','1.00',originalTime));
  await hdfcSmsRecheck(request('/recheck',{intent_id:third.intent_id}),f.env);expect(claims()).toBe(1);
 });
 it('A3 overlapping eligible intents are unresolved in the shared SQL helper',async()=>{
  const p=await policy(f.env);
  const first=await createIntent(f.db,'admin',crypto.randomUUID(),null,p,now-1800001);
  const second=await createIntent(f.db,'admin',crypto.randomUUID(),null,p,now);
  // Whole-second transport can overlap the old expiry and new creation. Neither
  // browser is chosen merely because its explicit recheck reached D1 first.
  await saveReference(f.db,first!,'000123456789',0,now);
  await saveReference(f.db,second!,'000123456789',0,now);
  const received=new Date(Math.floor(now/1000)*1000).toISOString().replace('.000Z','Z');
  await ingest(await receipt('000123456789','1.00',received));
  await Promise.all([matchIntent(f.db,first!.intent_id,'admin',p,now),matchIntent(f.db,second!.intent_id,'admin',p,now)]);
  expect(claims()).toBe(0);expect((await status(first!.intent_id)).status).toBe('review_pending');
 });
 it('A3 a later saved reference cannot demote a previously claimed canonical receipt',async()=>{
  const {body:first}=await create();const b=await receipt();await ingest(b);await claim(first.intent_id);
  const {body:second}=await create();await claim(second.intent_id);
  expect(await (await ingest(b)).json()).toMatchObject({match_state:'confirmed'});
  expect((await status(first.intent_id)).status).toBe('confirmed');expect(claims()).toBe(1);
 });
 it('A6 matcher failure leaves committed raw evidence and duplicate delivery resumes matching',async()=>{
  const {body:i}=await create();await claim(i.intent_id);const b=await receipt();
  const original=f.db.batch.bind(f.db);let calls=0;
  const spy=vi.spyOn(f.db,'batch').mockImplementation(async(statements)=>{calls++;if(calls===2)throw new Error('synthetic matcher outage');return original(statements);});
  expect((await ingest(b)).status).toBe(503);
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_receipts').get()?.n).toBe(1);expect(claims()).toBe(0);
  spy.mockRestore();expect(await (await ingest(b)).json()).toMatchObject({match_state:'confirmed'});expect(claims()).toBe(1);
 });

});
