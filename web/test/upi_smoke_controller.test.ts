import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpiSmokeController, SmokeFailure, POLL_MS, REQUEST_MS } from '../src/islands/checkout/upiSmokeController.ts';
import type { SmokeDependencies, SmokeIntent, CallOptions } from '../src/islands/checkout/upiSmokeController.ts';

const intent = (patch:Partial<SmokeIntent>={}):SmokeIntent => ({
  intent_id:'intent-a',status:'pending',protocol_version:2,amount_paise:100,
  expires_at:2_000_000,recover_until:90_000_000,updated_at:1,reference_revision:0,
  order_id:null,smoke_test:true,claim_submitted:false,reason_code:'awaiting_sms',upi_url:'upi://pay?am=1',...patch,
});
const drain = async () => {for(let i=0;i<40;i++)await Promise.resolve();};
function fixture(overrides:Partial<SmokeDependencies>={}) {
  const calls:{path:string;options:CallOptions}[]=[];
  const events:string[]=[]; const tokens:boolean[]=[];
  let row=intent(); let account='account-a';
  const deps:SmokeDependencies={
    token:async refresh=>{tokens.push(refresh);return refresh?'fresh':'cached';},
    uuid:()=> '00000000-0000-4000-8000-000000000001',
    emit:event=>events.push(event),
    request:async <T,>(path:string,options:CallOptions):Promise<T>=>{
      calls.push({path,options});
      if(path.endsWith('/current'))return {account_id:account,enabled:true,intent:row} as T;
      return row as T;
    },
    ...overrides,
  };
  const controller=new UpiSmokeController(deps,()=>{});
  return {controller,calls,events,tokens,deps,setRow:(value:SmokeIntent)=>row=value,setAccount:(value:string)=>account=value};
}

test('resume and explicit recheck retain same intent and never create an order',async t=>{
  const f=fixture();t.after(()=>f.controller.cancel());
  await f.controller.resume('intent-a');await f.controller.recheck();
  assert.equal(f.controller.state.intent?.intent_id,'intent-a');
  assert.equal(f.calls.filter(c=>c.path.endsWith('/order')).length,0);
  assert.deepEqual(f.calls.find(c=>c.path.endsWith('/status'))?.options.query,{intent_id:'intent-a'});
  assert.deepEqual(f.calls.find(c=>c.path.endsWith('/recheck'))?.options.body,{intent_id:'intent-a'});
});

test('401 refreshes once; exhaustion visibly fails and clears old payment',async t=>{
  const f=fixture();t.after(()=>f.controller.cancel());await f.controller.resume();
  let attempts=0;const tokens:boolean[]=[];
  f.deps.token=async refresh=>{tokens.push(refresh);return 'expired';};
  f.deps.request=async()=>{attempts++;throw new SmokeFailure(401,'expired');};
  await f.controller.recheck();
  assert.deepEqual(tokens,[false,true]);assert.equal(attempts,2);
  assert.equal(f.controller.state.authRequired,true);assert.equal(f.controller.state.intent,null);
  assert.match(f.controller.state.message,/Sign in again/);
});

test('each poll gets active auth and recovers one expired-token response',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture();const original=f.deps.request;let expired=true;
  f.deps.request=async <T,>(path:string,options:CallOptions):Promise<T>=>{
    if(path.endsWith('/status')&&expired){expired=false;throw new SmokeFailure(401,'expired');}
    return original<T>(path,options);
  };t.after(()=>f.controller.cancel());
  await f.controller.resume();t.mock.timers.tick(POLL_MS);await drain();
  assert.ok(f.tokens.length>=4);assert.equal(f.tokens.filter(Boolean).length,1);
  assert.ok(f.events.includes('auth_renewed'));
});

test('deadline releases hung auth; cancellation aborts and suppresses stale response',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture({token:()=>new Promise(()=>{})});t.after(()=>f.controller.cancel());
  const pending=f.controller.resume();t.mock.timers.tick(REQUEST_MS);await drain();await pending;
  assert.equal(f.controller.state.busy,false);assert.match(f.controller.state.message,/Unable to check/);
  let resolve!:(value:any)=>void;let signal:AbortSignal|undefined;
  const g=fixture({request:(_path,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});}});
  t.after(()=>g.controller.cancel());
  const stale=g.controller.resume();await drain();g.controller.cancel(true);
  assert.equal(signal?.aborted,true);
  resolve({account_id:'old',enabled:true,intent:intent()});
  await stale;assert.equal(g.controller.state.current,null);assert.equal(g.controller.state.intent,null);
});

test('polling continues beyond five minutes and stops at original server expiry',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture();f.setRow(intent({expires_at:601_000}));t.after(()=>f.controller.cancel());
  await f.controller.resume();t.mock.timers.tick(301_000);await drain();
  assert.equal(f.controller.state.timedOut,false);
  const count=f.calls.length;t.mock.timers.tick(POLL_MS);await drain();assert.ok(f.calls.length>count);
  f.controller.setPaused(true);
  const paused=f.calls.length;t.mock.timers.tick(300_000);await drain();
  assert.equal(f.calls.length,paused);
  f.controller.setPaused(false);await drain();
  assert.equal(f.controller.state.timedOut,true);
  await f.controller.recheck();
  const checked=f.calls.length;t.mock.timers.tick(86_400_000);await drain();
  assert.equal(f.calls.length,checked);assert.equal(f.calls.some(c=>c.path.endsWith('/order')),false);
});

test('reload near expiry receives only the remaining window',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture();f.setRow(intent({expires_at:4000}));t.after(()=>f.controller.cancel());
  await f.controller.resume();t.mock.timers.tick(3000);await drain();
  assert.equal(f.controller.state.timedOut,true);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/status')).length,0);
});

test('canonical account switch clears old intent and blocks queued claim',async t=>{
  const f=fixture();t.after(()=>f.controller.cancel());
  await f.controller.resume();f.setAccount('account-b');await f.controller.claim('000000001234');
  assert.equal(f.controller.state.intent,null);assert.equal(f.controller.state.current,null);
  assert.equal(f.calls.some(c=>c.path.endsWith('/claim')),false);
});

test('reference submission and correction include exact current revision',async t=>{
  const f=fixture();t.after(()=>f.controller.cancel());await f.controller.resume();
  await f.controller.claim('000000001234');
  f.setRow(intent({reference_revision:1,claim_submitted:true,reason_code:'no_match'}));
  await f.controller.recheck();await f.controller.claim('000000005678');
  const claims=f.calls.filter(c=>c.path.endsWith('/claim')).map(c=>c.options.body);
  assert.deepEqual(claims,[
    {intent_id:'intent-a',bank_reference:'000000001234',expected_reference_revision:0},
    {intent_id:'intent-a',bank_reference:'000000005678',expected_reference_revision:1},
  ]);
  assert.equal(f.events.includes('confirmed'),false);
});

test('reference conflict is visible without automatic correction or recreation',async t=>{
  const f=fixture();t.after(()=>f.controller.cancel());await f.controller.resume();
  const original=f.deps.request;
  f.deps.request=async <T,>(path:string,options:CallOptions):Promise<T>=>{
    if(path.endsWith('/claim'))throw new SmokeFailure(409,'reference_conflict');
    return original<T>(path,options);
  };
  await f.controller.claim('000000001234');
  assert.match(f.controller.state.message,/Check this payment again/);
  assert.equal(f.controller.state.intent?.reference_revision,0);
  assert.equal(f.calls.some(c=>c.path.endsWith('/order')),false);
});

test('replacement explicitly names previous intent; uncertain retry retains request key',async t=>{
  const f=fixture();t.after(()=>f.controller.cancel());await f.controller.resume();
  const original=f.deps.request;const keys:unknown[]=[];let first=true;
  f.deps.request=async <T,>(path:string,options:CallOptions):Promise<T>=>{
    if(path.endsWith('/order')){keys.push(options.body);if(first){first=false;throw new Error('network');}}
    return original<T>(path,options);
  };
  await f.controller.create(true);await f.controller.create(true);
  assert.deepEqual(keys[0],keys[1]);
  assert.equal((keys[0] as any).replace_intent_id,'intent-a');
});

test('terminal and legacy states stop polling; persisted legacy order is preserved',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  for(const row of [intent({status:'confirmed'}),intent({status:'review_pending'}),
    intent({protocol_version:1,order_id:'hdfc_sms-order:legacy',smoke_test:false})]){
    const f=fixture();f.setRow(row);await f.controller.resume();
    const count=f.calls.length;t.mock.timers.tick(300_000);await drain();
    assert.equal(f.calls.length,count);assert.equal(f.controller.state.intent?.order_id,row.order_id);
    f.controller.cancel();
  }
});
