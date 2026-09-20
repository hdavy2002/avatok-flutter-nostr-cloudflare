import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { EmailCodeSignIn } from '../auth/EmailCodeSignIn';
import { Modal } from '../../components/Modal';
import QRCode from 'qrcode';
import { ClerkIsland } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { UpiCustomerTestController } from './upiCustomerTestController';
import type { CustomerDependencies, CustomerSnapshot, InvitationHandle } from './upiCustomerTestController';

const initial: CustomerSnapshot={current:null,busy:false,message:'',authRequired:false,timedOut:false};
const date=(ms:number)=>new Date(ms).toLocaleString();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Capture once, then remove the secret before Clerk or external auth can mount.
 * A full-page sign-in loses this memory: reopen the original invitation afterward.
 * No localStorage/sessionStorage, and no raw token is passed to a redirect URL. */
export function takeCustomerInvitation(): InvitationHandle {
  const url=new URL(window.location.href);
  const fragment=new URLSearchParams(url.hash.slice(1));
  const raw=fragment.get('invite');
  const query=url.searchParams.get('invite');
  const token=raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
  const inviteId=query && UUID.test(query) ? query : undefined;
  const invalid=(raw!==null && !token) || (query!==null && !inviteId);
  url.hash='';
  url.search='';
  if (inviteId && !raw) url.searchParams.set('invite',inviteId);
  window.history.replaceState(null,'',url.pathname+url.search);
  return {token,inviteId:raw ? undefined : inviteId,invalid};
}
export function showCustomerInviteId(inviteId: string) {
  if (!UUID.test(inviteId)) return;
  const url=new URL(window.location.href); url.hash=''; url.search='';
  url.searchParams.set('invite',inviteId);
  window.history.replaceState(null,'',url.pathname+url.search);
}

export function UpiCustomerTestCheckoutView({deps,invitation,signIn}: {
  deps:CustomerDependencies; invitation:InvitationHandle; signIn?:ReactNode;
}) {
  const [snapshot,setSnapshot]=useState(initial);
  const [reference,setReference]=useState('');
  const [qr,setQr]=useState<string|null>(null);
  const [qrFailed,setQrFailed]=useState(false);
  const [now,setNow]=useState(Date.now());
  const controller=useMemo(()=>new UpiCustomerTestController(deps,setSnapshot),[deps]);
  const {current,busy,message,authRequired,timedOut}=snapshot;
  const intent=current?.intent, booking=current?.booking;
  useEffect(()=>{
    const visibility=()=>controller.setPaused(document.hidden || !navigator.onLine);
    visibility(); void controller.resume(invitation);
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('online',visibility); window.addEventListener('offline',visibility);
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    return ()=>{
      controller.cancel(true); clearInterval(timer);
      document.removeEventListener('visibilitychange',visibility);
      window.removeEventListener('online',visibility); window.removeEventListener('offline',visibility);
    };
  },[controller,invitation]);
  useEffect(()=>{setReference('');setQr(null);},[current?.account_id,intent?.intent_id,intent?.reference_revision]);
  useEffect(()=>{
    if (current) showCustomerInviteId(current.invite.invite_id);
  },[current?.invite.invite_id]);
  useEffect(()=>{
    if (!intent || intent.expires_at<=Date.now()) return;
    const timer=window.setTimeout(()=>setNow(Date.now()),intent.expires_at-Date.now());
    return ()=>clearTimeout(timer);
  },[intent?.expires_at]);
  const payable=Boolean(!authRequired && current?.enabled && intent?.protocol_version===2
    && intent.status==='pending' && intent.expires_at>now && intent.upi_url);
  useEffect(()=>{
    let active=true; setQr(null); setQrFailed(false);
    if (payable && intent?.upi_url) {
      void QRCode.toDataURL(intent.upi_url,{width:320,margin:2,errorCorrectionLevel:'M'})
        .then(value=>{if(active)setQr(value);})
        .catch(()=>{if(active)setQrFailed(true);});
    }
    return ()=>{active=false;};
  },[payable,intent?.upi_url]);
  const recoverable=Boolean(intent?.protocol_version===2 && intent.recover_until>now
    && !['confirmed','review_pending','superseded'].includes(intent.status));
  const confirmed=booking?.status==='confirmed' && intent?.protocol_version===2 && intent.status==='confirmed';
  const status=confirmed ? 'Test booking confirmed' :
    booking?.status==='review_pending' || intent?.status==='review_pending' ? 'Bank evidence needs review. This test booking is not confirmed.' :
    intent?.status==='superseded' ? 'This test payment is unavailable. Ask for help with this same payment.' :
    intent?.reason_code==='unsupported_reference' ? 'The bank message has no supported transaction reference. This test booking cannot be confirmed here.' :
    intent && (intent.status==='expired' || intent.expires_at<=now) ? 'The QR expired. Check this same payment; do not pay again.' :
    intent?.reason_code==='no_match' ? 'No matching bank evidence for the saved reference. Check or correct the reference below.' :
    intent?.claim_submitted ? 'Reference saved. Waiting for matching bank evidence.' :
    'After paying, enter the 12-digit transaction reference from your UPI app.';
  return <div>
    {message && <p role="alert">{message}</p>}
    {busy && <p role="status">Checking your test booking…</p>}
    {authRequired && <>{signIn}<button disabled={busy} onClick={()=>void controller.resume()}>Resume after signing in</button></>}
    {!current && !busy && !authRequired && <button onClick={()=>void controller.resume()}>Resume invitation</button>}
    {current && !current.enabled && <p>Payments and reference matching are temporarily paused. Existing test booking evidence remains available.</p>}
    {current && !intent && <>
      <div style={{border:'1px solid #777',borderRadius:16,padding:16,margin:'16px 0'}}>
        <h2>Demo consultation</h2><p>15 simulated minutes · ₹1 · Test only</p>
        <p>This selection has no appointment time or real provider.</p>
      </div>
      {current.invite.expires_at<=now && <p>This invitation expired before a payment was created. Ask for a new invitation.</p>}
      <button disabled={busy || !current.enabled || !current.invite.can_create}
        onClick={()=>void controller.create()}>Create ₹1 payment</button>
    </>}
    {intent && <>
      <h2 aria-live="polite">{status}</h2>
      {booking && <dl>
        <dt>Test booking reference</dt><dd style={{overflowWrap:'anywhere'}}>{booking.booking_id}</dd>
        <dt>Service</dt><dd>{booking.service_title} · {booking.duration_minutes} simulated minutes</dd>
        <dt>Amount</dt><dd>₹1.00 INR</dd>
        {confirmed && booking.confirmed_at!==null && <><dt>Payment confirmed</dt><dd>{date(booking.confirmed_at)}</dd></>}
      </dl>}
      {confirmed && <p>Your real ₹1 payment is confirmed for this test-only booking. No real consultation is reserved.</p>}
      {payable && <>
        {qr && <img src={qr} alt="UPI payment QR code" style={{width:320,maxWidth:'100%'}}/>}
        {qrFailed && <p role="alert">The QR image could not be displayed. You can still use the UPI payment link below or check this same payment.</p>}
        <p><a href={intent.upi_url}>Pay ₹1 with UPI</a></p>
        <p>QR expires at {date(intent.expires_at)}.</p>
        <p>Pay only once. If you have already paid, submit your reference below.</p>
      </>}
      {!payable && intent.expires_at<=now && !confirmed && <p>The payable QR is no longer displayed.</p>}
      {recoverable && <>
        <p>Same-payment evidence recovery is available until {date(intent.recover_until)}.</p>
        <form onSubmit={event=>{event.preventDefault();void controller.claim(reference);}}>
          <label htmlFor="customer-bank-reference">UPI transaction reference</label>
          <input id="customer-bank-reference" className="ph-no-capture ph-mask" data-ph-no-capture
            autoComplete="off" inputMode="numeric" pattern="[0-9]{12}" minLength={12} maxLength={12}
            value={reference} onChange={event=>setReference(event.target.value)} required disabled={busy || authRequired}
            style={{display:'block',width:'100%',boxSizing:'border-box',padding:12,margin:'8px 0'}}/>
          <p>Use the 12-digit reference from your UPI app. A matching ₹1 amount alone does not identify your payment.</p>
          <button disabled={busy || !current?.enabled || !/^[0-9]{12}$/.test(reference)}>
            {intent.claim_submitted ? 'Correct payment reference' : 'Submit payment reference'}
          </button>
        </form>
      </>}
      {!confirmed && <button disabled={busy || !current?.enabled || intent.protocol_version!==2 || intent.recover_until<=now}
        onClick={()=>void controller.recheck()}>Check this payment again</button>}
      <button disabled={busy} onClick={()=>void controller.resume()}>Refresh booking status</button>
      {timedOut && <p>Automatic checking has ended. Do not pay again; use the same-payment check.</p>}
      {!confirmed && intent.recover_until<=now && <p>The recovery window has ended. Ask for help using your test booking reference; do not pay again.</p>}
    </>}
  </div>;
}

/** A changed user OR session unmounts pending requests, QR and reference input. */
export function CustomerSession({identity,isLoaded,isSignedIn,deps,invitation,signIn}: {
  identity:string|null; isLoaded:boolean; isSignedIn:boolean; deps:CustomerDependencies;
  invitation:InvitationHandle; signIn:ReactNode;
}) {
  const [mountedIdentity,setMountedIdentity]=useState(identity);
  const previousIdentity=useRef(identity);
  useEffect(()=>{
    if (!isLoaded) return;
    if (previousIdentity.current && previousIdentity.current!==identity) {
      invitation.token=null; invitation.inviteId=undefined; invitation.invalid=false;
      window.history.replaceState(null,'',window.location.pathname);
    }
    previousIdentity.current=identity; setMountedIdentity(identity);
  },[identity,isLoaded,invitation]);
  return <section className="ph-no-capture ph-mask" data-ph-no-capture
    style={{width:'min(100%, 580px)',boxSizing:'border-box',background:'#fff',border:'2px solid #171717',borderRadius:24,padding:24,fontFamily:'Nunito, sans-serif',lineHeight:1.5}}>
    <h1>Invited customer booking test</h1>
    <p><strong>This charges a real ₹1. The booking is a test only and does not reserve a real consultation.</strong></p>
    {!isLoaded || mountedIdentity!==identity ? <p>Loading account…</p> : !isSignedIn ? <>
      <p>Sign in with your normal Saathum account to use your private invitation.</p>
      {signIn}
      <p>If signing in opens a new page, reopen your original invitation link afterward.</p>
    </> : <UpiCustomerTestCheckoutView key={identity} deps={deps} invitation={invitation} signIn={signIn}/>}
  </section>;
}
function CustomerSignIn() {
  const [open,setOpen]=useState(false);
  return <><button onClick={()=>setOpen(true)}>Sign in</button>
    <Modal open={open} onClose={()=>setOpen(false)} title="Sign in to your test booking" className="ph-no-capture ph-mask">
      <EmailCodeSignIn reason="to use your private test invitation" onAuthed={()=>setOpen(false)} onCancel={()=>setOpen(false)}/>
    </Modal></>;
}
function AuthenticatedCustomer({invitation}:{invitation:InvitationHandle}) {
  const {userId,sessionId,isLoaded,isSignedIn,getToken}=useAuth();
  const tokenRef=useRef(getToken); tokenRef.current=getToken;
  const deps=useMemo<CustomerDependencies>(()=>({
    token:refresh=>tokenRef.current(refresh ? {skipCache:true} : undefined),
    request:(path,options)=>request(path,options),
    redeemed:showCustomerInviteId,
    emit:(event,code)=>capture('hdfc_customer_test_'+event,{protocol_version:2,...(code?{reason_code:code}:{})}),
  }),[]);
  return <CustomerSession identity={userId && sessionId ? userId+':'+sessionId : null}
    isLoaded={isLoaded} isSignedIn={Boolean(isSignedIn)} deps={deps} invitation={invitation}
    signIn={<CustomerSignIn/>}/>;
}
export default function UpiCustomerTestCheckout() {
  const [invitation,setInvitation]=useState<InvitationHandle|null>(null);
  useEffect(()=>{setInvitation(takeCustomerInvitation());},[]);
  if (!CLERK_PUBLISHABLE_KEY) return <p>Sign-in is temporarily unavailable. Please try this invitation again later.</p>;
  if (!invitation) return <p>Preparing your private invitation…</p>;
  return <ClerkIsland><AuthenticatedCustomer invitation={invitation}/></ClerkIsland>;
}
