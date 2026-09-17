import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const inviteId='00000000-0000-4000-8000-000000000001';
const rawToken='abcdef'.repeat(10)+'abcd';
const url='/test/upi#invite='+rawToken;
function intent(patch:Record<string,unknown>={}) {
  return {intent_id:'intent-a',status:'pending',protocol_version:2,amount_paise:100,
    expires_at:Date.now()+1_800_000,recover_until:Date.now()+88_200_000,updated_at:Date.now(),
    order_id:null,smoke_test:true,claim_submitted:false,reference_revision:0,reason_code:'awaiting_sms',
    upi_url:'upi://pay?pa=synthetic%40example&am=1&tn=AvaTOK%20test%20booking',...patch};
}
async function customer(page:Page,initial:ReturnType<typeof intent>|null=null) {
  let row=initial,account='account-a',authFailed=false,error:string|null=null,missing=false,canCreate=true;
  const calls:{url:string;path:string;body:any;auth:string|null;referrer:string|null}[]=[];
  const current=()=>({
    ok:true,protocol_version:2,account_id:account,enabled:true,reason_code:null,
    invite:{invite_id:inviteId,expires_at:Date.now()+86_400_000,can_create:canCreate},
    service:{id:'upi-demo-consultation',title:'Demo consultation',duration_minutes:15,test_mode:true,amount_paise:100,currency:'INR'},
    intent:row,booking:row?{booking_id:'booking-a',service_id:'upi-demo-consultation',service_title:'Demo consultation',
      duration_minutes:15,test_mode:true,status:row.status==='pending'?'awaiting_payment':row.status,
      created_at:Date.now()-1000,confirmed_at:row.status==='confirmed'?Date.now():null,amount_paise:100,currency:'INR'}:null,
  });
  await page.route('**/fixture-token?**',route=>route.fulfill({json:{token:authFailed?null:'ordinary-clerk-token'}}));
  await page.route('**/api/pay/hdfc-sms/customer/**',async route=>{
    const req=route.request(),u=new URL(req.url()),path=u.pathname;
    const body=req.method()==='POST'?req.postDataJSON():null;
    calls.push({url:req.url(),path,body,auth:req.headers()['authorization']??null,referrer:req.headers()['referer']??null});
    if(missing){await route.fulfill({status:404,json:{error:'invite_required'}});return;}
    if(error && (path.endsWith('/order')||path.endsWith('/claim'))){
      await route.fulfill({status:409,json:{error}});return;
    }
    if(path.endsWith('/redeem')){await route.fulfill({json:{ok:true,account_id:account,invite_id:inviteId,expires_at:Date.now()+86_400_000}});return;}
    if(path.endsWith('/order'))row=intent();
    if(path.endsWith('/claim'))row={...row!,claim_submitted:true,reference_revision:Number(row!.reference_revision)+1};
    await route.fulfill({json:current()});
  });
  return {calls,setRow:(value:ReturnType<typeof intent>|null)=>{row=value;},setError:(value:string|null)=>{error=value;},
    failAuth:()=>{authFailed=true;},missing:()=>{missing=true;},switchAccount:()=>{account='account-b';},
    disallowCreate:()=>{canCreate=false;},current};
}

test('ordinary customer signs in with retained invitation, sees real charge, pays once and resumes stable booking',async({page})=>{
  const f=await customer(page);
  await page.goto('/test/upi?signedOut=1#invite='+rawToken);
  await expect(page.getByText('This charges a real ₹1.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  expect(f.calls).toHaveLength(0);
  await expect(page).toHaveURL('/test/upi');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Demo consultation',exact:true})).toBeVisible();
  expect(f.calls[0].body).toEqual({invite_token:rawToken});
  expect(f.calls[0].auth).toBe('Bearer ordinary-clerk-token');
  await expect(page).toHaveURL('/test/upi?invite='+inviteId);
  expect(await page.evaluate(()=>(window as any).__inviteHandle.token)).toBeNull();
  await page.getByRole('button',{name:'Create ₹1 payment'}).click();
  await expect(page.getByRole('img',{name:'UPI payment QR code'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Pay ₹1 with UPI'})).toHaveAttribute('href',/^upi:\/\/pay/);
  await page.getByLabel('UPI transaction reference').fill('000000001234');
  await page.getByRole('button',{name:'Submit payment reference'}).click();
  await expect(page.getByRole('heading',{name:'Reference saved. Waiting for matching bank evidence.'})).toBeVisible();
  f.setRow(intent({status:'confirmed',claim_submitted:true,reference_revision:1}));
  await expect(page.getByRole('heading',{name:'Test booking confirmed',exact:true})).toBeVisible({timeout:10_000});
  await expect(page.getByText('booking-a',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Test booking confirmed',exact:true})).toBeVisible();
  expect(f.calls.filter(c=>c.path.endsWith('/order'))).toHaveLength(1);
  expect(f.calls.filter(c=>c.path.endsWith('/redeem'))).toHaveLength(1);
  expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(()=>Object.keys(sessionStorage))).toEqual([]);
});

test('first pageview and nested referrers redact invitation even before island bootstraps; replay and autocapture off',async({page})=>{
  const f=await customer(page);await page.goto(url);
  await expect(page.getByRole('button',{name:'Create ₹1 payment'})).toBeVisible();
  await page.evaluate((token)=>{
    (window as any).__captureAnalytics('synthetic_privacy',{
      $referrer:'https://avatok.ai/test/upi#invite='+token,
      nested:{items:[{url:'https://avatok.ai/test/upi#invite='+token}],invite_token:token},
      token:'https://avatok.ai/test/upi#invite='+token,
    });
  },rawToken);
  const events=await page.evaluate(()=>(window as any).__analytics);
  expect(events[0].event).toBe('$pageview');
  expect(events[0].properties.$current_url).toContain('#invite=[redacted]');
  expect(JSON.stringify(events)).not.toContain(rawToken);
  expect(JSON.stringify(events)).toContain('[redacted]');
  expect(await page.evaluate(()=>({
    replay:(window as any).__analyticsConfig.disable_session_recording,
    auto:(window as any).__analyticsConfig.autocapture,
    persistence:(window as any).__analyticsConfig.persistence,
    stopped:(window as any).__replayStopped,
  }))).toEqual({replay:true,auto:false,persistence:'memory',stopped:true});
  for(const call of f.calls){expect(call.url).not.toContain(rawToken);expect(call.referrer??'').not.toContain(rawToken);}
});

test('busy, reference conflict, missing invite and auth failure are distinct and never expose another QR',async({page})=>{
  const f=await customer(page);await page.goto(url);
  f.setError('intent_busy');await page.getByRole('button',{name:'Create ₹1 payment'}).click();
  await expect(page.getByRole('alert')).toContainText('Another test payment is in progress');
  await expect(page.getByRole('img')).toHaveCount(0);
  f.setError(null);await page.getByRole('button',{name:'Create ₹1 payment'}).click();
  await expect(page.getByRole('img')).toBeVisible();
  f.setError('reference_conflict');
  await page.getByLabel('UPI transaction reference').fill('000000001234');
  await page.getByRole('button',{name:'Submit payment reference'}).click();
  await expect(page.getByRole('alert')).toContainText('saved reference changed');
  f.failAuth();await page.getByRole('button',{name:'Refresh booking status'}).click();
  await expect(page.getByRole('alert')).toContainText('Sign in again');
  await expect(page.getByRole('img')).toHaveCount(0);
});

test('signed-in account without invitation sees customer help',async({page})=>{
  const f=await customer(page);f.missing();await page.goto('/test/upi');
  await expect(page.getByRole('alert')).toContainText('A private invitation is required');
  await expect(page.getByText('administrator',{exact:false})).toHaveCount(0);
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
});

test('receipt conflict demotes confirmed view on refresh without another order',async({page})=>{
  const f=await customer(page,intent({status:'confirmed',claim_submitted:true}));
  await page.goto('/test/upi?invite='+inviteId);
  await expect(page.getByRole('heading',{name:'Test booking confirmed',exact:true})).toBeVisible();
  f.setRow(intent({status:'review_pending',claim_submitted:true}));
  await page.getByRole('button',{name:'Refresh booking status'}).click();
  await expect(page.getByRole('heading',{name:'Bank evidence needs review. This test booking is not confirmed.'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Test booking confirmed',exact:true})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Pay ₹1 with UPI'})).toHaveCount(0);
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
});

test('expiry while offline hides both QR and deep link; recovery keeps same intent',async({page})=>{
  const f=await customer(page,intent({expires_at:Date.now()+5000}));
  await page.clock.install();await page.goto('/test/upi?invite='+inviteId);
  await expect(page.getByRole('img')).toBeVisible();
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'));
  });
  const count=f.calls.length;await page.clock.fastForward(6000);
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Pay ₹1 with UPI'})).toHaveCount(0);
  expect(f.calls.length).toBe(count);
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'onLine',{configurable:true,value:true});window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByRole('button',{name:'Check this payment again'})).toBeEnabled();
  await page.getByRole('button',{name:'Check this payment again'}).click();
  await expect.poll(()=>f.calls.filter(c=>c.path.endsWith('/recheck')).length).toBe(1);
  expect(f.calls.find(c=>c.path.endsWith('/recheck'))?.body).toEqual({invite_id:inviteId,intent_id:'intent-a'});
  expect(f.calls.some(c=>c.path.endsWith('/order'))).toBeFalsy();
});

test('account or session changes abort old response and clear reference, token and URL',async({page})=>{
  const f=await customer(page,intent());await page.goto(url);
  await expect(page.getByRole('img')).toBeVisible();
  await page.getByLabel('UPI transaction reference').fill('000000001234');
  let release!:(()=>void);
  await page.route('**/api/pay/hdfc-sms/customer/status?**',async route=>{
    const stale=f.current();
    await new Promise<void>(r=>{release=r;});
    await route.fulfill({json:stale}).catch(()=>{});
  });
  await expect.poll(()=>Boolean(release),{timeout:10_000}).toBe(true);
  f.switchAccount();f.setRow(null);
  await page.evaluate(()=>(window as any).__switchSession('account-b:session-b'));
  release();
  await expect(page.getByRole('button',{name:'Create ₹1 payment'})).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByLabel('UPI transaction reference')).toHaveCount(0);
  await page.evaluate(()=>(window as any).__switchSession(null));
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__inviteHandle.token)).toBeNull();
  await expect(page).toHaveURL('/test/upi');
});

test('QR renderer failure is visible and preserves valid deep link and same-payment recovery',async({page})=>{
  await customer(page,intent({upi_url:'upi://pay?pa=synthetic%40example&am=1&tn='+ 'x'.repeat(10_000)}));
  await page.goto('/test/upi?invite='+inviteId);
  await expect(page.getByRole('alert')).toContainText('QR image could not be displayed');
  await expect(page.getByRole('link',{name:'Pay ₹1 with UPI'})).toHaveAttribute('href',/^upi:\/\/pay/);
  await expect(page.getByRole('button',{name:'Check this payment again'})).toBeEnabled();
});

test('10 second deadline releases a hung read and unmount stops later updates',async({page})=>{
  await customer(page);let release!:(()=>void);
  await page.route('**/api/pay/hdfc-sms/customer/current*',async route=>{
    await new Promise<void>(r=>{release=r;});
    await route.fulfill({status:503,json:{error:'schema_not_ready'}}).catch(()=>{});
  });
  await page.clock.install();await page.goto('/test/upi?invite='+inviteId);
  await expect.poll(()=>Boolean(release)).toBe(true);
  await page.clock.fastForward(10_001);
  await expect(page.getByRole('alert')).toContainText('Unable to check');
  await page.evaluate(()=>(window as any).__unmount());release();
  await expect(page.getByText('Unmounted')).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0);
});

test('temporarily unavailable creation does not mislabel a valid invitation as expired',async({page})=>{
  const f=await customer(page);f.disallowCreate();await page.goto(url);
  await expect(page.getByRole('button',{name:'Create ₹1 payment'})).toBeDisabled();
  await expect(page.getByText('This invitation expired before a payment was created.',{exact:false})).toHaveCount(0);
});
