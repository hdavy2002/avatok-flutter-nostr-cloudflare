import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpiCustomerTestController, CustomerFailure, CUSTOMER_POLL_MS, CUSTOMER_REQUEST_MS } from '../src/islands/checkout/upiCustomerTestController.ts';
import type { CustomerCurrent, CustomerDependencies, InvitationHandle } from '../src/islands/checkout/upiCustomerTestController.ts';
import type { CallOptions } from '../src/islands/checkout/upiSmokeController.ts';

const inviteId='00000000-0000-4000-8000-000000000001';
const current=(paid=false):CustomerCurrent=>({
  ok:true,protocol_version:2,account_id:'account-a',enabled:true,reason_code:null,
  invite:{invite_id:inviteId,expires_at:99_000_000,can_create:true},
  service:{id:'upi-demo-consultation',title:'Demo consultation',duration_minutes:15,test_mode:true,amount_paise:100,currency:'INR'},
  intent:paid ? {intent_id:'intent-a',status:'pending',protocol_version:2,amount_paise:100,expires_at:601_000,
    recover_until:99_000_000,updated_at:1,order_id:null,smoke_test:true,claim_submitted:false,reference_revision:0,reason_code:null,upi_url:'upi://pay?am=1'} : null,
  booking:paid ? {booking_id:'booking-a',service_id:'upi-demo-consultation',service_title:'Demo consultation',
    duration_minutes:15,test_mode:true,status:'awaiting_payment',created_at:1,confirmed_at:null,amount_paise:100,currency:'INR'} : null,
});
const drain=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function fixture(hasPayment=false) {
  let row=current(hasPayment);
  const calls:{path:string;options:CallOptions}[]=[]; const tokens:boolean[]=[]; const events:string[]=[];
  const deps:CustomerDependencies={
    token:async refresh=>{tokens.push(refresh);return 'clerk-only';},
    now:()=>Date.now(),uuid:()=>inviteId,emit:event=>events.push(event),
    request:async <T,>(path:string,options:CallOptions):Promise<T>=>{
      calls.push({path,options});
      if(path.endsWith('/redeem'))return {account_id:'account-a',invite_id:inviteId} as T;
      if(path.endsWith('/order'))row=current(true);
      return row as T;
    },
  };
  const controller=new UpiCustomerTestController(deps,()=>{});
  return {controller,deps,calls,tokens,events,setRow:(r:CustomerCurrent)=>{row=r;}};
}

test('redeem sends secret in bounded JSON only, clears its shared handle, and uses invite id thereafter',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture();t.after(()=>f.controller.cancel(true));
  const handle:InvitationHandle={token:'a'.repeat(64)};let scrubbed='';
  f.deps.redeemed=id=>{scrubbed=id;};
  await f.controller.resume(handle);
  assert.equal(handle.token,null);assert.equal(handle.inviteId,inviteId);assert.equal(scrubbed,inviteId);
  const redeem=f.calls[0];
  assert.deepEqual(redeem.options.body,{invite_token:'a'.repeat(64)});
  assert.equal(redeem.options.query,undefined);assert.ok(!redeem.path.includes('a'.repeat(64)));
  assert.deepEqual(f.calls[1].options.query,{invite_id:inviteId});
  await f.controller.create();
  assert.deepEqual(f.calls.find(c=>c.path.endsWith('/order'))?.options.body,{
    invite_id:inviteId,service_id:'upi-demo-consultation',request_key:inviteId});
  await f.controller.create();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/order')).length,1);
});

test('latest invitation resume, same-payment recovery and persisted conflict demotion never create another order',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(true);t.after(()=>f.controller.cancel());
  await f.controller.resume();
  assert.equal(f.calls[0].options.query,undefined);
  let row=current(true);row.intent!.status='confirmed';row.booking!.status='confirmed';row.booking!.confirmed_at=1500;
  f.setRow(row);await f.controller.resume();
  assert.equal(f.controller.state.current?.booking?.status,'confirmed');
  row={...row,intent:{...row.intent!,status:'review_pending'},booking:{...row.booking!,status:'review_pending',confirmed_at:null}};
  f.setRow(row);await f.controller.resume();
  assert.equal(f.controller.state.current?.booking?.status,'review_pending');
  assert.equal(f.controller.state.current?.booking?.confirmed_at,null);
  assert.ok(!f.calls.some(c=>c.path.endsWith('/order')));
});

test('uncertain order response preserves key; preflight resumes a committed response instead of paying twice',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture();t.after(()=>f.controller.cancel());
  await f.controller.resume();const original=f.deps.request;const bodies:unknown[]=[];
  f.deps.request=async <T,>(path:string,options:CallOptions):Promise<T>=>{
    if(path.endsWith('/order')){bodies.push(options.body);throw new Error('network');}
    return original<T>(path,options);
  };
  await f.controller.create();await f.controller.create();
  assert.deepEqual(bodies[0],bodies[1]);
  f.setRow(current(true));await f.controller.create();
  assert.equal(bodies.length,2);assert.equal(f.controller.state.current?.booking?.booking_id,'booking-a');
});

test('busy, conflict, missing invitation and exhausted authentication have distinct safe messages',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  for(const [status,error,pattern] of [
    [409,'intent_busy',/Another test payment is in progress/],
    [409,'reference_conflict',/saved reference changed/],
    [404,'invite_required',/private invitation is required/],
    [404,'invite_unavailable',/unavailable for this account/],
    [401,'expired',/Sign in again/],
  ] as const) {
    const f=fixture(true);await f.controller.resume();
    f.deps.request=async()=>{throw new CustomerFailure(status,error);};
    await f.controller.recheck();assert.match(f.controller.state.message,pattern);
    if(status===401){assert.equal(f.controller.state.current,null);assert.deepEqual(f.tokens.slice(-2),[false,true]);}
    f.controller.cancel();
  }
});

test('one 401 refresh, exact reference revision, account guard and stale-response cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(true);t.after(()=>f.controller.cancel());await f.controller.resume();
  let once=true;const original=f.deps.request;
  f.deps.request=async<T,>(path:string,options:CallOptions):Promise<T>=>{
    if(path.endsWith('/claim') && once){once=false;throw new CustomerFailure(401,'expired');}
    return original<T>(path,options);
  };
  await f.controller.claim('000000001234');
  assert.equal(f.tokens.filter(Boolean).length,1);
  assert.deepEqual(f.calls.find(c=>c.path.endsWith('/claim'))?.options.body,{
    invite_id:inviteId,intent_id:'intent-a',bank_reference:'000000001234',expected_reference_revision:0});
  f.setRow({...current(true),account_id:'account-b'});
  await f.controller.claim('000000005678');
  assert.equal(f.controller.state.current,null);assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);
  let resolve!:(v:CustomerCurrent)=>void;let signal:AbortSignal|undefined;
  f.deps.request=(_path,opts)=>{signal=opts.signal;return new Promise(r=>{resolve=r as typeof resolve;});};
  const pending=f.controller.resume();await drain();f.controller.cancel(true);
  assert.equal(signal?.aborted,true);resolve(current(true));await pending;
  assert.equal(f.controller.state.current,null);
});

test('hung authentication has a deadline; offline pause and expiry never restart automatic recovery or create',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(true);t.after(()=>f.controller.cancel());await f.controller.resume();
  t.mock.timers.tick(301_000);await drain();
  assert.ok(f.calls.some(c=>c.path.endsWith('/status')));
  f.controller.setPaused(true);const paused=f.calls.length;
  t.mock.timers.tick(400_000);await drain();assert.equal(f.calls.length,paused);
  f.controller.setPaused(false);await drain();assert.equal(f.controller.state.timedOut,true);
  await f.controller.recheck();const checked=f.calls.length;
  t.mock.timers.tick(CUSTOMER_POLL_MS*10);await drain();assert.equal(f.calls.length,checked);
  assert.ok(!f.calls.some(c=>c.path.endsWith('/order')));
  const g=fixture();g.deps.token=()=>new Promise(()=>{});
  t.after(()=>g.controller.cancel());
  const pending=g.controller.resume();t.mock.timers.tick(CUSTOMER_REQUEST_MS);await drain();await pending;
  assert.equal(g.controller.state.busy,false);assert.match(g.controller.state.message,/Unable to check/);
});

test('unknown server text never becomes telemetry and malformed reference is never posted',async t=>{
  const f=fixture(true);t.after(()=>f.controller.cancel());await f.controller.resume();
  await f.controller.claim('bad-reference');assert.ok(!f.calls.some(c=>c.path.endsWith('/claim')));
  const emitted:unknown[]=[];f.deps.emit=(event,code)=>emitted.push({event,code});
  f.deps.request=async()=>{throw new CustomerFailure(503,'secret '+ 'b'.repeat(64));};
  await f.controller.resume();
  assert.ok(!JSON.stringify(emitted).includes('b'.repeat(64)));
  assert.ok(!f.controller.state.message.includes('b'.repeat(64)));
});
