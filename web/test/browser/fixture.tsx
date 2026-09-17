// CI-only Vite root; never an Astro page or part of the public app.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SmokeSession } from '../../src/islands/checkout/UpiSmokeCheckout';
import type { SmokeDependencies } from '../../src/islands/checkout/upiSmokeController';
async function send<T>(path:string,options:any={}):Promise<T>{
  const url=new URL(path,window.location.origin);
  for(const [key,value] of Object.entries(options.query??{}))url.searchParams.set(key,String(value));
  const response=await fetch(url,{method:options.method??'GET',signal:options.signal,
    headers:{'content-type':'application/json','authorization':options.auth??''},
    ...(options.body?{body:JSON.stringify(options.body)}:{})});
  if(!response.ok)throw Object.assign(new Error('synthetic error'),{status:response.status});
  return response.json();
}
const deps:SmokeDependencies={
  token:async refresh=>(await send<{token:string|null}>('/fixture-token',{query:{refresh}})).token,
  request:send,
  emit:event=>{(window as any).__events??=[];(window as any).__events.push(event);},
};
function Fixture(){
  const [identity,setIdentity]=useState<string|null>(
    new URLSearchParams(location.search).has('signedOut') ? null : 'account-a:session-a');
  const [mounted,setMounted]=useState(true);
  (window as any).__switchSession=setIdentity;
  (window as any).__unmount=()=>setMounted(false);
  return mounted ? <SmokeSession identity={identity} isLoaded isSignedIn={Boolean(identity)}
    deps={deps} signIn={<button>Sign in</button>}/> : <p>Unmounted</p>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
