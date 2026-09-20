import { useEffect, useMemo, useRef, useState } from 'react';
import { SignInButton, useAuth } from '@clerk/clerk-react';
import type { ReactNode } from 'react';
import QRCode from 'qrcode';
import { ClerkIsland } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { UpiSmokeController } from './upiSmokeController';
import type { SmokeDependencies, SmokeSnapshot } from './upiSmokeController';

const initial: SmokeSnapshot = {current:null,intent:null,busy:false,message:'',authRequired:false,timedOut:false};
const date = (ms: number) => new Date(ms).toLocaleString();

/** Production view, also mounted by the synthetic CI browser fixture. */
export function UpiSmokeCheckoutView({deps, resumeFromUrl = true}: {deps: SmokeDependencies; resumeFromUrl?: boolean}) {
  const [snapshot,setSnapshot] = useState(initial);
  const [reference,setReference] = useState('');
  const [replacement,setReplacement] = useState(false);
  const [qr,setQr] = useState<string|null>(null);
  const [now,setNow] = useState(Date.now());
  const [previous,setPrevious] = useState<string|null>(null);
  const controller = useMemo(() => new UpiSmokeController(deps,setSnapshot),[deps]);
  const {intent,current,busy,message,authRequired,timedOut} = snapshot;
  useEffect(() => {
    const url = new URL(window.location.href);
    const id = resumeFromUrl ? url.searchParams.get('intent') ?? url.searchParams.get('intent_id') ?? undefined : undefined;
    if (!resumeFromUrl) {
      url.searchParams.delete('intent'); url.searchParams.delete('intent_id');
      window.history.replaceState(null,'',url);
    }
    const visibility = () => controller.setPaused(document.hidden || !navigator.onLine);
    visibility();
    void controller.resume(id);
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('online',visibility); window.addEventListener('offline',visibility);
    const timer = window.setInterval(() => setNow(Date.now()),1000);
    return () => {
      controller.cancel();
      clearInterval(timer);
      document.removeEventListener('visibilitychange',visibility);
      window.removeEventListener('online',visibility); window.removeEventListener('offline',visibility);
    };
  },[controller,resumeFromUrl]);
  useEffect(() => { setReference(''); setReplacement(false); setQr(null); },[intent?.intent_id,current?.account_id]);
  useEffect(() => { setReference(''); },[intent?.reference_revision]);
  useEffect(() => { setPrevious(null); },[current?.account_id]);
  useEffect(() => {
    if (!intent) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('intent_id'); url.searchParams.set('intent',intent.intent_id);
    window.history.replaceState(null,'',url);
  },[intent?.intent_id]);
  // A separate expiry timer hides a QR at the actual deadline, between countdown ticks.
  useEffect(() => {
    if (!intent || intent.expires_at <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()),intent.expires_at-Date.now());
    return () => clearTimeout(timer);
  },[intent?.expires_at]);
  const resumeSame = () => {
    const params = new URLSearchParams(window.location.search);
    void controller.resume(params.get('intent') ?? params.get('intent_id') ?? undefined);
  };
  const payable = !authRequired && current?.enabled && intent?.protocol_version === 2
    && intent.status === 'pending' && intent.expires_at > now && Boolean(intent.upi_url);
  useEffect(() => {
    let active = true; setQr(null);
    if (payable && intent?.upi_url) {
      void QRCode.toDataURL(intent.upi_url,{width:320,margin:2,errorCorrectionLevel:'M'})
        .then(value => { if(active) setQr(value); }).catch(() => { if(active) setQr(null); });
    }
    return () => { active=false; };
  },[intent?.upi_url,payable]);
  const canCreate = current?.enabled && !busy;
  const recoverable = intent?.protocol_version === 2 && intent.recover_until > now
    && !['superseded','confirmed','review_pending'].includes(intent.status);
  const remaining = Math.max(0,Math.ceil(((intent?.expires_at ?? now)-now)/1000));
  const countdown = Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0');
  const status = !intent ? '' : intent.protocol_version !== 2 ? 'This earlier payment is unverified and needs review.' :
    intent.status === 'confirmed' ? 'Payment confirmed for this test' :
    intent.status === 'superseded' ? 'This QR was replaced. Any earlier payment needs review.' :
    intent.status === 'review_pending' ? 'Bank evidence needs review. This payment is not confirmed.' :
    intent.reason_code === 'unsupported_reference' ? 'The stored bank message has no supported transaction reference. This payment cannot be confirmed here.' :
    intent.reason_code === 'reference_required' ? 'Bank evidence stored; reference required to link it to this test.' :
    intent.reason_code === 'no_match' ? 'No matching bank evidence for the saved reference. Check or correct it below.' :
    intent.status === 'expired' || intent.expires_at <= now ? 'The QR expired. You can still check evidence for this payment.' :
    !intent.claim_submitted ? 'After paying, enter the transaction reference from your UPI app.' :
    'Reference saved. Waiting for matching bank evidence.';
  return <section className="ph-no-capture ph-mask" data-ph-no-capture style={{width:'min(100%, 560px)',background:'#fff',border:'2px solid #171717',borderRadius:24,padding:28,fontFamily:'Nunito, sans-serif'}}>
    <p>Saathum internal test · administrators only</p>
    <h1>UPI payment smoke test</h1>
    <p>₹1 internal payment test. This does not create a booking.</p>
    {message && <p role="alert">{message}</p>}
    {authRequired && <button onClick={resumeSame}>Resume after signing in</button>}
    {!current && !busy && !authRequired && <button onClick={resumeSame}>Resume current payment</button>}
    {busy && <p role="status">Checking payment…</p>}
    {current && !current.enabled && <p>New QRs and reference matching are paused. Existing payment evidence remains available.</p>}
    {current && !intent && <button disabled={!canCreate} onClick={() => void controller.create()}>Create ₹1 UPI QR</button>}
    {intent && <>
      <p>Test amount: ₹{(intent.amount_paise/100).toFixed(2)}</p>
      <h2 aria-live="polite">{status}</h2>
      {intent.protocol_version === 2 && intent.status === 'confirmed' ? <p>The bank reference matches this test. No commercial order was created.</p> : <>
        {qr && payable && <div style={{textAlign:'center'}}>
          <img src={qr} alt="UPI payment QR code" style={{width:320,maxWidth:'100%'}}/>
          <p>QR expires in <span role="timer">{countdown}</span> · {date(intent.expires_at)}.</p>
        </div>}
        {!payable && intent.expires_at <= now && <p>The payable QR is no longer displayed.</p>}
        {recoverable && <p>Evidence recovery available until {date(intent.recover_until)}.</p>}
        {recoverable && <form onSubmit={event => { event.preventDefault(); void controller.claim(reference); }}>
          <label htmlFor="bank-reference">UPI transaction reference</label>
          <input id="bank-reference" className="ph-no-capture ph-mask" data-ph-no-capture
            autoComplete="off" inputMode="numeric" pattern="[0-9]{12}" minLength={12} maxLength={12}
            value={reference} onChange={event=>setReference(event.target.value)} required disabled={busy}/>
          <p>Enter the 12-digit reference from your UPI app to link bank evidence to this test.
            A matching ₹1 amount alone does not identify your payment. You can correct a typo until the payment is confirmed.</p>
          <button disabled={busy || !/^[0-9]{12}$/.test(reference) || !current?.enabled}>
            {intent.claim_submitted ? 'Correct payment reference' : 'Submit payment reference'}
          </button>
        </form>}
        <button disabled={busy || !current?.enabled || intent.protocol_version !== 2} onClick={() => void controller.recheck()}>Check this payment again</button>
        {timedOut && <p>Automatic checking has ended. Do not pay again. Use the same-payment check above.</p>}
      </>}
      {(intent.protocol_version !== 2 || ['confirmed','superseded'].includes(intent.status)) && <>
        <button disabled={!canCreate} onClick={() => void controller.create()}>Start new ₹1 test</button>
        <button disabled={busy} onClick={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('intent'); url.searchParams.delete('intent_id');
          window.history.replaceState(null,'',url);
          void controller.resume();
        }}>Resume current payment</button>
      </>}
      {intent.protocol_version === 2 && ['pending','expired'].includes(intent.status) && (
        !replacement ? <button disabled={!canCreate} onClick={()=>setReplacement(true)}>Replace this QR explicitly</button> :
          <div role="alert"><p>Replacing stops this QR from being automatically confirmed. If you already paid, check this payment first. This does not refund or cancel a bank payment.</p>
            <button disabled={!canCreate} onClick={()=>{ setPrevious(intent.intent_id); setReplacement(false); void controller.create(true); }}>Confirm replacement</button>
            <button onClick={()=>setReplacement(false)}>Keep this payment</button>
          </div>
      )}
    </>}
    {previous && <p><a href={'?intent='+encodeURIComponent(previous)}>View earlier payment</a></p>}
  </section>;
}

/** Shared session boundary: changing account/session unmounts all ephemeral state. */
export function SmokeSession({identity,isLoaded,isSignedIn,deps,signIn}: {
  identity:string|null; isLoaded:boolean; isSignedIn:boolean; deps:SmokeDependencies; signIn:ReactNode;
}) {
  const firstIdentity = useRef(identity);
  const switched = useRef(false);
  if (identity && firstIdentity.current && firstIdentity.current !== identity) switched.current = true;
  if (identity && !firstIdentity.current) firstIdentity.current = identity;
  if (!isLoaded) return <p>Loading account…</p>;
  if (!isSignedIn) return <section><h1>UPI payment smoke test</h1><p>Sign in with an authorized administrator account.</p>{signIn}</section>;
  return <UpiSmokeCheckoutView deps={deps} resumeFromUrl={!switched.current} key={identity}/>;
}

function AuthenticatedSmoke() {
  const {userId,sessionId,isLoaded,isSignedIn,getToken} = useAuth();
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const deps = useMemo<SmokeDependencies>(() => ({
    // Clerk only: the general auth helper can fall back to a stored guest JWT.
    token: refresh => tokenRef.current(refresh ? {skipCache:true} : undefined),
    request: (path,options) => request(path,options),
    emit: event => capture('hdfc_smoke_'+event,{protocol_version:2}),
  }),[]);
  return <SmokeSession identity={userId && sessionId ? userId+':'+sessionId : null}
    isLoaded={isLoaded} isSignedIn={Boolean(isSignedIn)} deps={deps}
    signIn={<SignInButton mode="modal"><button>Sign in</button></SignInButton>}/>;
}
export default function UpiSmokeCheckout() {
  if (!CLERK_PUBLISHABLE_KEY) return <p>Administrator sign-in is not configured.</p>;
  return <ClerkIsland><AuthenticatedSmoke/></ClerkIsland>;
}
