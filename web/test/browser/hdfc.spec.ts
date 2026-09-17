import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

function row(patch:Record<string,unknown>={}){
  return {intent_id:'intent-a',status:'pending',protocol_version:2,amount_paise:100,
    expires_at:Date.now()+1_800_000,recover_until:Date.now()+88_200_000,updated_at:Date.now(),
    order_id:null,smoke_test:true,claim_submitted:false,reference_revision:0,reason_code:'awaiting_sms',
    upi_url:'upi://pay?pa=synthetic%40example&am=1',...patch};
}
async function smoke(page:Page,initial:ReturnType<typeof row>|null=row()){
  let intent=initial;let account='account-a';let failAuth=false;let expireOnce=false;let tokenCalls=0;
  let forbidden=false;let conflict=false;
  const calls:{path:string;body:any;query:URLSearchParams}[]=[];
  await page.route('**/fixture-token?**',async route=>{
    tokenCalls++;await route.fulfill({json:{token:failAuth?null:'synthetic-token'}});
  });
  await page.route('**/api/pay/hdfc-sms/**',async route=>{
    const request=route.request();const url=new URL(request.url());const path=url.pathname;
    const body=request.method()==='POST'?request.postDataJSON():null;calls.push({path,body,query:url.searchParams});
    if(forbidden){await route.fulfill({status:403,json:{error:'admin_only'}});return;}
    if(expireOnce&&path.endsWith('/status')){expireOnce=false;await route.fulfill({status:401,json:{error:'expired'}});return;}
    if(path.endsWith('/current')){
      await route.fulfill({json:{ok:true,protocol_version:2,account_id:account,enabled:true,intent}});return;
    }
    if(path.endsWith('/order'))intent=row({intent_id:body.replace_intent_id?'intent-b':'intent-a'});
    if(path.endsWith('/claim')){
      if(conflict){await route.fulfill({status:409,json:{error:'reference_conflict'}});return;}
      intent={...intent!,claim_submitted:true,reference_revision:Number(intent!.reference_revision)+1};
    }
    await route.fulfill({json:{ok:true,...intent}});
  });
  return {calls,setIntent:(next:ReturnType<typeof row>|null)=>{intent=next;},
    switchAccount:()=>{account='account-b';},expire:()=>{expireOnce=true;},failAuth:()=>{failAuth=true;},
    forbid:()=>{forbidden=true;},conflict:()=>{conflict=true;},tokenCalls:()=>tokenCalls};
}

test('legacy URL resumes and becomes canonical; reference correction uses revision; reload never creates',async({page})=>{
  const f=await smoke(page);await page.goto('/?intent_id=intent-a');
  await expect(page.getByRole('img',{name:'UPI payment QR code'})).toBeVisible();
  await expect(page).toHaveURL(/\?intent=intent-a$/);
  expect(f.calls.find(c=>c.path.endsWith('/status'))?.query.get('intent_id')).toBe('intent-a');
  await page.getByLabel('UPI transaction reference').fill('000000001234');
  await page.getByRole('button',{name:'Submit payment reference'}).click();
  await expect(page.getByRole('heading',{name:'Reference saved. Waiting for matching bank evidence.'})).toBeVisible();
  await page.getByLabel('UPI transaction reference').fill('000000005678');
  await page.getByRole('button',{name:'Correct payment reference'}).click();
  await expect(page.getByLabel('UPI transaction reference')).toHaveValue('');
  expect(f.calls.filter(c=>c.path.endsWith('/claim')).map(c=>c.body)).toEqual([
    {intent_id:'intent-a',bank_reference:'000000001234',expected_reference_revision:0},
    {intent_id:'intent-a',bank_reference:'000000005678',expected_reference_revision:1},
  ]);
  await page.reload();
  await expect(page.getByRole('heading',{name:'Reference saved. Waiting for matching bank evidence.'})).toBeVisible();
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
  expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);
});

test('sign-out mounts no payment state; Worker denies a signed-in non-admin',async({page})=>{
  const f=await smoke(page);await page.goto('/?signedOut=1');
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  expect(f.calls).toHaveLength(0);expect(f.tokenCalls()).toBe(0);
  f.forbid();await page.evaluate(()=>(window as any).__switchSession('member:session'));
  await expect(page.getByRole('alert')).toContainText('Access denied');
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Create ₹1 UPI QR'})).toHaveCount(0);
});

test('fresh auth reaches attributed confirmation; exhausted auth clears QR visibly',async({page})=>{
  const f=await smoke(page);await page.goto('/');await expect(page.getByRole('img')).toBeVisible();
  f.expire();f.setIntent(row({claim_submitted:true,status:'confirmed'}));
  await expect(page.getByRole('heading',{name:'Payment confirmed for this test',exact:true})).toBeVisible({timeout:10_000});
  expect(f.tokenCalls()).toBeGreaterThan(2);
  expect(await page.evaluate(()=>(window as any).__events)).toContain('auth_renewed');
  f.failAuth();await page.reload();await expect(page.getByRole('alert')).toContainText('Sign in again');
  await expect(page.getByRole('img')).toHaveCount(0);
});

test('polling lasts beyond five minutes; expiry check stays on same payment without another poll loop',async({page})=>{
  const f=await smoke(page,row({expires_at:Date.now()+610_000}));
  await page.clock.install();await page.goto('/');await expect(page.getByRole('img')).toBeVisible();
  await page.clock.fastForward(301_000);
  await expect(page.getByRole('img')).toBeVisible();
  await expect(page.getByText('Automatic checking has ended.',{exact:false})).toHaveCount(0);
  await page.clock.fastForward(310_000);await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('QR expired');
  await page.getByRole('button',{name:'Check this payment again'}).click();
  await expect.poll(()=>f.calls.filter(c=>c.path.endsWith('/recheck')).length).toBe(1);
  await expect(page.getByRole('button',{name:'Check this payment again'})).toBeEnabled();
  const count=f.calls.length;await page.clock.fastForward(60_000);
  expect(f.calls.length).toBe(count);
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
});

test('replacement requires confirmation and preserves canonical earlier status link',async({page})=>{
  const f=await smoke(page);await page.goto('/');
  await page.getByRole('button',{name:'Replace this QR explicitly'}).click();
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
  await expect(page.getByRole('alert')).toContainText('does not refund');
  await page.getByRole('button',{name:'Confirm replacement'}).click();
  await expect(page.getByRole('link',{name:'View earlier payment'})).toHaveAttribute('href','?intent=intent-a');
  expect(f.calls.find(c=>c.path.endsWith('/order'))?.body.replace_intent_id).toBe('intent-a');
});

test('server account change clears payment before queued reference mutation',async({page})=>{
  const f=await smoke(page);await page.goto('/');await expect(page.getByRole('img')).toBeVisible();f.switchAccount();
  await page.getByLabel('UPI transaction reference').fill('000000001234');
  await page.getByRole('button',{name:'Submit payment reference'}).click();
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByLabel('UPI transaction reference')).toHaveCount(0);
  expect(f.calls.some(c=>c.path.endsWith('/claim'))).toBeFalsy();
});

test('session remount clears reference and old URL; unmount prevents later polls',async({page})=>{
  const f=await smoke(page);await page.clock.install();await page.goto('/?intent=intent-a');
  await expect(page.getByRole('img')).toBeVisible();
  await page.getByLabel('UPI transaction reference').fill('000000001234');
  f.switchAccount();f.setIntent(null);
  await page.evaluate(()=>(window as any).__switchSession('account-b:session-b'));
  await expect(page.getByRole('button',{name:'Create ₹1 UPI QR'})).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0);await expect(page).toHaveURL('/');
  expect(f.calls.filter(c=>c.path.endsWith('/status'))).toHaveLength(1);
  await page.evaluate(()=>(window as any).__unmount());
  const count=f.calls.length;await page.clock.fastForward(60_000);expect(f.calls.length).toBe(count);
});

test('offline pause cannot extend QR expiry; explicit recovery does not recreate',async({page})=>{
  const f=await smoke(page,row({expires_at:Date.now()+5000}));
  await page.clock.install();await page.goto('/');await expect(page.getByRole('img')).toBeVisible();
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
    window.dispatchEvent(new Event('offline'));
  });
  const count=f.calls.length;await page.clock.fastForward(6000);
  await expect(page.getByRole('img')).toHaveCount(0);expect(f.calls.length).toBe(count);
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'onLine',{configurable:true,value:true});
    window.dispatchEvent(new Event('online'));
  });
  await page.getByRole('button',{name:'Check this payment again'}).click();
  await expect.poll(()=>f.calls.filter(c=>c.path.endsWith('/recheck')).length).toBe(1);
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
});

test('bank evidence without attribution never confirms; conflict allows explicit recheck',async({page})=>{
  const f=await smoke(page,row({reason_code:'reference_required'}));await page.goto('/');
  await expect(page.getByRole('heading',{name:'Bank evidence stored; reference required to link it to this test.'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Payment confirmed for this test'})).toHaveCount(0);
  f.conflict();await page.getByLabel('UPI transaction reference').fill('000000001234');
  await page.getByRole('button',{name:'Submit payment reference'}).click();
  await expect(page.getByRole('alert')).toContainText('Check this payment again');
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
  expect(await page.evaluate(()=>(window as any).__events)).not.toContain('confirmed');
});

test('unsupported reference explains limitation and legacy confirmed is unverified',async({page})=>{
  const f=await smoke(page,row({reason_code:'unsupported_reference'}));await page.goto('/');
  await expect(page.getByRole('heading')).toContainText(['UPI payment smoke test','no supported transaction reference']);
  f.setIntent(row({protocol_version:1,status:'confirmed',order_id:'hdfc_sms-order:legacy',smoke_test:false}));
  await page.reload();
  await expect(page.getByRole('heading',{name:'This earlier payment is unverified and needs review.'})).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__events)).not.toContain('confirmed');
});

test('confirmed test starts a fresh test without trying to replace its claimed intent',async({page})=>{
  const f=await smoke(page,row({status:'confirmed',claim_submitted:true,reference_revision:1}));
  await page.goto('/?intent=intent-a');
  await expect(page.getByRole('heading',{name:'Payment confirmed for this test'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Replace this QR explicitly'})).toHaveCount(0);
  await page.getByRole('button',{name:'Start new ₹1 test'}).click();
  await expect(page.getByRole('img',{name:'UPI payment QR code'})).toBeVisible();
  const body=f.calls.find(c=>c.path.endsWith('/order'))?.body;
  expect(body.listingId).toBe('avatok-upi-smoke-2026');
  expect(body.request_key).toEqual(expect.any(String));
  expect(body).not.toHaveProperty('replace_intent_id');
});

test('hung request ends after ten seconds; unmounted response cannot restore payment',async({page})=>{
  const f=await smoke(page);let release!:()=>void;
  await page.route('**/api/pay/hdfc-sms/current',async route=>{
    await new Promise<void>(resolve=>{release=resolve;});
    await route.fulfill({json:{account_id:'account-a',enabled:true,intent:row()}}).catch(()=>{});
  });
  await page.clock.install();await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Checking payment…');
  await expect.poll(()=>Boolean(release)).toBe(true);
  await page.clock.fastForward(10_001);
  await expect(page.getByRole('alert')).toContainText('Unable to check right now');
  await page.evaluate(()=>(window as any).__unmount());release();
  await expect(page.getByText('Unmounted')).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0);
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
});
