import {test,expect} from '@playwright/test';
import {UPI_APPS,upiAppHref,upiPlatform} from '../../src/islands/checkout/upiAppLinks';
const upi='upi://pay?pa=synthetic%40example&pn=AvaTOK&am=1.00&cu=INR&tn=AvaTOK+test+payment';
const intentId='96a2a16d-aee0-409f-a8b1-673f98315bda';
function pending(overrides:Record<string,unknown>={}){return {intent_id:intentId,status:'pending',matching_mode:'bank_reference',reason_code:null,amount_paise:100,currency:'INR',created_at:Date.now(),expires_at:Date.now()+120000,recover_until:Date.now()+1800000,reference_revision:0,upi_url:upi,...overrides}}
async function route(page:any,handler?:any){await page.route('**/api/pay/hdfc-sms/public/**',handler??(r=>r.fulfill({json:{ok:true,enabled:true,intent:pending()}})))}
test('public visitor receives QR immediately and is asked for the payment reference',async({page})=>{
 const calls:any[]=[];
 await route(page,r=>{calls.push({url:r.request().url(),body:r.request().method()==='POST'?r.request().postDataJSON():null});return r.fulfill({json:{ok:true,enabled:true,intent:pending()}})});
 await page.goto('/plain-qr');
 await expect(page.getByRole('img',{name:'UPI payment QR code'})).toBeVisible();
 await expect(page.getByText('After you pay, save the 12-digit UPI payment reference.',{exact:false})).toBeVisible();
 expect(calls.find(c=>c.body)?.body).toEqual({request_key:expect.stringMatching(/^[0-9a-f-]{36}$/)});
 await expect(page.getByLabel('12-digit UPI payment reference (UTR)')).toBeVisible();
 await expect(page.getByLabel('UPI ID (VPA)')).toHaveCount(0);
 await expect(page.getByLabel('Phone number',{exact:true})).toHaveCount(0);
});
test('reference is submitted only after twelve digits and confirmation waits for bank verification',async({page})=>{
 let claim:any;
 await route(page,r=>{if(r.request().url().endsWith('/claim')){claim=r.request().postDataJSON();return r.fulfill({json:{ok:true,enabled:true,intent:pending({status:'confirmed',upi_url:undefined,confirmed_at:Date.now()})}})}return r.fulfill({json:{ok:true,enabled:true,intent:pending()}})});
 await page.goto('/plain-qr'); await page.getByLabel('12-digit UPI payment reference (UTR)').fill('123');
 await expect(page.getByRole('button',{name:'Check payment reference'})).toBeDisabled();
 await page.getByLabel('12-digit UPI payment reference (UTR)').fill('123456789012'); await page.getByRole('button',{name:'Check payment reference'}).click();
 await expect(page.getByRole('heading',{name:'Payment received'})).toBeVisible(); expect(claim).toEqual({intent_id:intentId,bank_reference:'123456789012',expected_reference_revision:0});
});
test('refresh resumes the same attempt and never creates another order',async({page})=>{
 let orders=0; const ids:string[]=[];
 await route(page,r=>{if(r.request().url().endsWith('/order')){orders++;ids.push(r.request().postDataJSON().request_key)}return r.fulfill({json:{ok:true,enabled:true,intent:pending()}})});
 await page.goto('/plain-qr'); await expect(page.getByRole('img',{name:'UPI payment QR code'})).toBeVisible(); await page.reload(); await expect(page.getByRole('img',{name:'UPI payment QR code'})).toBeVisible();
 expect(orders).toBe(1); expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
});
test('late SMS leaves a waiting message and does not report failure',async({page})=>{
 await route(page,r=>r.fulfill({json:{ok:true,enabled:true,intent:pending({reason_code:'awaiting_sms'})}})); await page.goto('/plain-qr');
 await expect(page.getByText('Waiting for your payment.',{exact:false})).toBeVisible(); await expect(page.getByRole('heading',{name:'Payment received'})).toHaveCount(0); await expect(page.getByText('If the SMS is delayed, this page will keep waiting.',{exact:false})).toBeVisible();
});
test('payment app links preserve the QR amount and package targets',async({page})=>{
 await route(page); await page.goto('/plain-qr'); const links=page.getByRole('navigation',{name:'Payment apps'}).getByRole('link'); await expect(links).toHaveCount(UPI_APPS.length);
 for(const app of UPI_APPS){const href=upiAppHref(app,upi,'android');expect(href).toContain('am=1.00');expect(href).toContain(app.androidPackage!)} expect(upiPlatform('Mozilla/5.0 (Linux; Android 14)',5)).toBe('android');
});
