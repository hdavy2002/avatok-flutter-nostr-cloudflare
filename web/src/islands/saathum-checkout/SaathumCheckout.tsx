/* [SAATHUM-CHECKOUT-UI 2026-09-26] The Saa Thum live-event checkout island —
 * You -> Sankalp -> Offerings -> Review -> Pay -> Done, against the HTTP
 * contract in Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md. Mounted by
 * pages/book/[id]/checkout.astro ONLY for listing.kind === 'live_event';
 * every other kind keeps rendering the existing checkout/BookingFlow.tsx
 * island unchanged.
 *
 * Reuses, rather than reinvents: ClerkIsland/getActiveToken (lib/clerk),
 * EmailCodeSignIn + passwordless.ts's phone OTP calls (islands/auth), the
 * UPI QR/app-link building in islands/checkout/upiAppLinks.ts, and the
 * profile GET/PUT shape from dashboard2/Profile.tsx for prefill.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { getPhoneStatus } from '../auth/passwordless';
import { captureException } from '../../lib/analytics';
import { ApiError } from '../../lib/apiClient';
import { createCheckout, getCheckout, getCheckoutConfig, getQuote } from './api';
import { getProfile, sankalpFromProfile, addressFromProfile } from './profile';
import { YouStep } from './YouStep';
import { SankalpStep } from './SankalpStep';
import { OfferingsStep } from './OfferingsStep';
import { ReviewStep } from './ReviewStep';
import { PayStep } from './PayStep';
import { DoneStep } from './DoneStep';
import type { Address, CheckoutConfig, CheckoutStep, Checkout, OfferingsState, Quote, Sankalp } from './types';
import './checkout.css';

function requestKeyFor(listingId: string): string {
  const key = `sthc:request_key:${listingId}`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
function storedCheckoutId(listingId: string): string | null {
  try { return window.sessionStorage.getItem(`sthc:checkout_id:${listingId}`); } catch { return null; }
}
function storeCheckoutId(listingId: string, id: string) {
  try { window.sessionStorage.setItem(`sthc:checkout_id:${listingId}`, id); } catch { /* best-effort */ }
}
function clearRequestKey(listingId: string) {
  try { window.sessionStorage.removeItem(`sthc:request_key:${listingId}`); } catch { /* best-effort */ }
}

function Inner({ listingId }: { listingId: string }) {
  const { user, isLoaded: userLoaded } = useUser();
  const [step, setStep] = useState<CheckoutStep>('you');
  const [config, setConfig] = useState<CheckoutConfig | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const [sankalp, setSankalp] = useState<Sankalp>({ name: '' });
  const [offerings, setOfferings] = useState<OfferingsState>({ chadhava: [], dakshina_rupees: 0, prasad: false });
  const [address, setAddress] = useState<Address | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);

  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [paying, setPaying] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);

  const gateChecked = useRef(false);
  const resumeChecked = useRef(false);
  const [resumeDone, setResumeDone] = useState(false);

  // ── config (public, no auth) ──────────────────────────────────────────
  useEffect(() => {
    let active = true;
    getCheckoutConfig(listingId)
      .then((c) => { if (active) setConfig(c); })
      .catch((e) => {
        captureException(e, { where: 'saathum_checkout_config' });
        if (active) setConfigErr(e instanceof ApiError && e.body && typeof e.body === 'object' && (e.body as { message?: string }).message
          ? (e.body as { message?: string }).message!
          : 'This event couldn’t be loaded. Please refresh the page.');
      });
    return () => { active = false; };
  }, [listingId]);

  // ── resume: ?checkout=<id> or a stored id for this listing ───────────
  useEffect(() => {
    if (resumeChecked.current || !userLoaded) return;
    resumeChecked.current = true;
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('checkout');
    const id = fromQuery || storedCheckoutId(listingId);
    if (!id) { setResumeDone(true); return; }
    (async () => {
      try {
        const t = await getActiveToken();
        if (!t) return; // not signed in — nothing to resume yet, checkGate will run once they are
        setToken(t);
        const c = await getCheckout(id, t);
        setCheckout(c);
        storeCheckoutId(listingId, c.checkout_id);
        setStep(c.status === 'confirmed' ? 'done' : 'pay');
        if (fromQuery) { url.searchParams.delete('checkout'); window.history.replaceState(null, '', url.pathname + url.search); }
      } catch {
        /* the stored/linked checkout is gone or not this account's — start fresh */
      } finally {
        setResumeDone(true);
      }
    })();
  }, [listingId, userLoaded]);

  // ── auth + phone gate (skips "you" once satisfied) ────────────────────
  const checkGate = useCallback(async () => {
    if (!user) return;
    const t = await getActiveToken();
    if (!t) return;
    setToken(t);
    try {
      const status = await getPhoneStatus();
      if (status.verified) advancePastYou();
    } catch (e) {
      captureException(e, { where: 'saathum_checkout_phone_status' });
    }
    try {
      const profile = await getProfile(t);
      setSankalp((s) => (s.name ? s : sankalpFromProfile(profile)));
      setAddress((a) => a ?? addressFromProfile(profile));
    } catch (e) {
      captureException(e, { where: 'saathum_checkout_profile_prefill' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!userLoaded || !resumeDone || gateChecked.current || checkout) return;
    if (user) {
      gateChecked.current = true;
      void checkGate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoaded, resumeDone, user, checkout]);

  function advancePastYou() {
    setStep((s) => (s === 'you' ? 'sankalp' : s));
  }

  // ── live quote (debounced) once config is known ───────────────────────
  useEffect(() => {
    if (!config || step === 'you' || checkout) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getQuote(
        { listing_id: listingId, chadhava: offerings.chadhava, dakshina_rupees: offerings.dakshina_rupees, prasad: offerings.prasad },
        controller.signal,
      )
        .then((q) => { setQuote(q); setQuoteErr(null); })
        .catch((e) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          captureException(e, { where: 'saathum_checkout_quote' });
          setQuoteErr(e instanceof ApiError && e.body && typeof e.body === 'object' && (e.body as { message?: string }).message
            ? (e.body as { message?: string }).message!
            : 'Couldn’t calculate the total. Please try again.');
        });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, listingId, offerings.chadhava, offerings.dakshina_rupees, offerings.prasad, step, checkout]);

  async function onPay() {
    if (!token) { setStep('you'); return; }
    setPaying(true);
    setPayErr(null);
    const requestKey = requestKeyFor(listingId);
    try {
      const c = await createCheckout(
        {
          listing_id: listingId,
          request_key: requestKey,
          chadhava: offerings.chadhava,
          dakshina_rupees: offerings.dakshina_rupees,
          prasad: offerings.prasad,
          sankalp,
          address: offerings.prasad && address ? address : undefined,
          accept_terms: true,
          accept_refund: true,
        },
        token,
      );
      storeCheckoutId(listingId, c.checkout_id);
      setCheckout(c);
      setStep('pay');
    } catch (e) {
      captureException(e, { where: 'saathum_checkout_create' });
      setPayErr(e instanceof ApiError && e.body && typeof e.body === 'object' && (e.body as { message?: string }).message
        ? (e.body as { message?: string }).message!
        : 'Couldn’t start your payment. Please try again.');
    } finally {
      setPaying(false);
    }
  }

  function onCheckoutUpdate(c: Checkout) {
    setCheckout(c);
    if (c.status === 'confirmed') {
      clearRequestKey(listingId);
      setStep('done');
    }
  }

  function onStartAgain() {
    clearRequestKey(listingId);
    setCheckout(null);
    setStep('review');
  }

  if (configErr) {
    return <div className="sthc"><div className="sthc-card"><p className="sthc-err" role="alert">{configErr}</p></div></div>;
  }
  if (!config) {
    return <div className="sthc"><div className="sthc-card"><p role="status">Loading checkout…</p></div></div>;
  }
  if (!config.bookable) {
    return <div className="sthc"><div className="sthc-card"><p role="alert">{config.reason || 'This event can no longer be booked.'}</p></div></div>;
  }

  return (
    <div className="sthc">
      <div className="sthc-step-col">
        {step === 'you' && (
          <YouStep
            signedIn={Boolean(user)}
            listingId={listingId}
            onSignedIn={() => void checkGate()}
            onVerified={() => advancePastYou()}
          />
        )}
        {step === 'sankalp' && (
          <SankalpStep
            value={sankalp}
            listingId={listingId}
            onBack={() => setStep('you')}
            onContinue={(s) => { setSankalp(s); setStep('offerings'); }}
          />
        )}
        {step === 'offerings' && (
          <OfferingsStep
            chadhavaCatalog={config.chadhava}
            dakshinaPresets={config.dakshina_presets}
            prasadAvailable={config.listing.prasad_available}
            prasadPriceRupees={config.listing.prasad_price_rupees}
            state={offerings}
            onChange={setOfferings}
            address={address}
            onAddressChange={setAddress}
            quote={quote}
            quoteError={quoteErr}
            listingId={listingId}
            onBack={() => setStep('sankalp')}
            onContinue={() => setStep('review')}
          />
        )}
        {step === 'review' && (
          <>
            <ReviewStep
              quote={quote}
              quoteError={quoteErr}
              gstEnabled={config.gst.enabled}
              listingId={listingId}
              onBack={() => setStep('offerings')}
              onPay={() => void onPay()}
              paying={paying}
            />
            {payErr && <p className="sthc-err" role="alert" style={{ marginTop: 10 }}>{payErr}</p>}
          </>
        )}
        {step === 'pay' && checkout && token && (
          <PayStep
            checkout={checkout}
            auth={token}
            listingId={listingId}
            onUpdate={onCheckoutUpdate}
            onDone={() => setStep('done')}
            onStartAgain={onStartAgain}
          />
        )}
        {step === 'done' && checkout && token && (
          <DoneStep checkout={checkout} auth={token} listingId={listingId} />
        )}
      </div>
    </div>
  );
}

export interface SaathumCheckoutProps {
  listingId: string;
}

export function SaathumCheckout({ listingId }: SaathumCheckoutProps) {
  return (
    <IslandBoundary island="saathum-checkout">
      <ClerkIsland>
        <Inner listingId={listingId} />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default SaathumCheckout;
