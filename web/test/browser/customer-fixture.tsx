import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CustomerSession, takeCustomerInvitation, showCustomerInviteId } from '../../src/islands/checkout/UpiCustomerTestCheckout';
import type { CustomerDependencies } from '../../src/islands/checkout/upiCustomerTestController';
import { initAnalytics, capture } from '../../src/lib/analyticsCore';

// Deliberately initialize while the original fragment is still present.
initAnalytics();
(window as any).__captureAnalytics=capture;
const signedOut=new URLSearchParams(location.search).has('signedOut');
const invitation=takeCustomerInvitation();
(window as any).__inviteHandle=invitation;
async function send<T>(path:string,options:any={}):Promise<T>{
  const url=new URL(path,location.origin);
  for(const [key,value] of Object.entries(options.query??{}))url.searchParams.set(key,String(value));
  const response=await fetch(url,{method:options.method??'GET',signal:options.signal,
    headers:{'content-type':'application/json','authorization':'Bearer '+(options.auth??'')},
    ...(options.body?{body:JSON.stringify(options.body)}:{})});
  const body=await response.json();
  if(!response.ok)throw Object.assign(new Error('synthetic error'),{status:response.status,error:body.error});
  return body;
}
const deps:CustomerDependencies={
  token:async refresh=>(await send<{token:string|null}>('/fixture-token',{query:{refresh}})).token,
  request:send,redeemed:showCustomerInviteId,
  emit:(event,code)=>capture('hdfc_customer_test_'+event,{reason_code:code}),
};
function Fixture(){
  const [identity,setIdentity]=useState<string|null>(signedOut?null:'account-a:session-a');
  const [mounted,setMounted]=useState(true);
  (window as any).__switchSession=setIdentity;
  (window as any).__unmount=()=>setMounted(false);
  return mounted ? <CustomerSession identity={identity} isLoaded isSignedIn={Boolean(identity)}
    invitation={invitation} deps={deps} signIn={<button onClick={()=>setIdentity('account-a:session-a')}>Sign in</button>}/> : <p>Unmounted</p>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
