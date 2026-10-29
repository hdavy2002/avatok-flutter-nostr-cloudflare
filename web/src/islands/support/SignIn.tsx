// [HF-SUPPORT-DESK] Sign-in for the support desk (design: WebSignIn).
//   Left card:  email -> 6-digit code (existing account, Clerk email-code sign-in; staff and customers use the same door).
//   Right card: "New here?" -> email code -> WhatsApp code -> a normal fan account is created -> write the ticket.
// The guest path reuses the website's existing sign-up endpoints (no new ones):
//   POST /api/auth/signup/email/send + /verify   (email proof)
//   POST /api/auth/whatsapp/send  + /verify {signup:{name,email_proof}}  (creates the account, returns a Clerk ticket)
import { useCallback, useState, type FormEvent } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { BRAND, brandUrl } from '../../lib/brand';
import { COUNTRIES, DEFAULT_COUNTRY, toE164 } from '../../lib/countries';
import { clerkErrors, type PwlSignIn } from '../auth/passwordless';
import {
  redeemWhatsAppTicket, sendSignupEmailCode, sendWhatsAppCode, verifySignupEmailCode, verifyWhatsAppCode, waApiCode, waApiMessage,
} from '../auth/whatsappAuth';
import { MOCK } from './api';
import { mockSignedIn } from './auth';
import { navigate } from './router';
import { CodeBoxes, Gold, Lilac, Marigold, useCountdown } from './ui';

/** The few operations the forms need. Real = Clerk + the website's sign-up endpoints; mock = instant. */
interface Backend {
  signInSend(email: string): Promise<void>;
  signInVerify(email: string, code: string): Promise<void>;
  guestEmailSend(email: string): Promise<number>;
  guestEmailVerify(email: string, code: string): Promise<string>;
  guestWaSend(e164: string): Promise<{ masked: string; resendS: number }>;
  guestFinish(e164: string, code: string, name: string, proof: string): Promise<void>;
}

const wait = (ms = 450) => new Promise((r) => setTimeout(r, ms));

function mockBackend(): Backend {
  return {
    signInSend: async (email) => { await wait(); if (/nobody|unknown/i.test(email)) throw new Error('not_found'); },
    signInVerify: async (_e, code) => { await wait(); if (code === '000000') throw new Error('bad_code'); mockSignedIn(/davy|staff|support@/i.test(_e) ? 'staff' : 'customer'); },
    guestEmailSend: async () => { await wait(); return 45; },
    guestEmailVerify: async (_e, code) => { await wait(); if (code === '000000') throw new Error('bad_code'); return 'mock-proof'; },
    guestWaSend: async (e164) => { await wait(); return { masked: `${e164.slice(0, 5)}xxxxx${e164.slice(-2)}`, resendS: 30 }; },
    guestFinish: async (_n, code) => { await wait(); if (code === '000000') throw new Error('bad_code'); mockSignedIn('customer'); },
  };
}

function useBackend(): Backend {
  // MOCK is a build-time constant, so exactly one branch ever runs and the hook order never changes.
  if (MOCK) return mockBackend();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { isLoaded, signIn, setActive } = useSignIn();
  const si = signIn as unknown as PwlSignIn | undefined;
  const act = setActive as unknown as (p: { session: string }) => Promise<unknown>;
  const ready = () => { if (!isLoaded || !si) throw new Error('loading'); };
  return {
    async signInSend(email) {
      ready();
      const attempt = await si!.create({ identifier: email });
      const f = attempt.supportedFirstFactors?.find((x) => x.strategy === 'email_code' && x.emailAddressId);
      if (!f?.emailAddressId) throw new Error('no_email_code');
      await si!.prepareFirstFactor({ strategy: 'email_code', emailAddressId: f.emailAddressId });
    },
    async signInVerify(_email, code) {
      ready();
      const res = await si!.attemptFirstFactor({ strategy: 'email_code', code });
      if (res.status !== 'complete' || !res.createdSessionId) throw new Error('incomplete');
      await act({ session: res.createdSessionId });
    },
    async guestEmailSend(email) { const r = await sendSignupEmailCode(email); return r.resend_after_s ?? 60; },
    guestEmailVerify: (email, code) => verifySignupEmailCode(email, code),
    async guestWaSend(e164) { const r = await sendWhatsAppCode(e164); return { masked: r.phone_masked, resendS: r.resend_after_s ?? 30 }; },
    async guestFinish(e164, code, name, proof) {
      ready();
      const r = await verifyWhatsAppCode(e164, code, { name, email_proof: proof, age_confirmed: true });
      if (r.status !== 'signed_in') throw new Error('not_signed_in');
      await redeemWhatsAppTicket(si, act, r.ticket);
    },
  };
}

const validEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());

function signInMessage(e: unknown): string {
  const codes = clerkErrors(e).map((x) => x.code);
  if (codes.includes('form_identifier_not_found')) return 'We could not find an account with that email. New here? Use “Open a ticket” on the right.';
  if (codes.includes('form_code_incorrect') || codes.includes('verification_failed') || (e instanceof Error && e.message === 'bad_code')) return 'That code did not work. Check it and try again.';
  if (codes.includes('verification_expired')) return 'That code has expired. Ask for a new one.';
  if (codes.includes('too_many_requests') || clerkErrors(e).some((x) => /too many/i.test(x.message))) return 'Too many tries. Please wait a few minutes and try again.';
  if (e instanceof Error && e.message === 'not_found') return 'We could not find an account with that email. New here? Use “Open a ticket” on the right.';
  if (e instanceof Error && e.message === 'no_email_code') return 'This account cannot be sent a sign-in code right now. Please email ' + BRAND.emails.support + '.';
  if (e instanceof Error && e.message === 'loading') return 'Sign-in is still loading. Try again in a moment.';
  const first = clerkErrors(e)[0]?.message;
  return first || 'Something went wrong. Please try again.';
}

/* ── existing account ──────────────────────────────────────────────────── */
function EmailSignIn({ presetEmail }: { presetEmail?: string }) {
  const be = useBackend();
  const [email, setEmail] = useState(presetEmail ?? '');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const left = useCountdown(resendAt);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!validEmail(email)) { setErr('Enter the email on your Hello Fraands account.'); return; }
    setBusy(true); setErr(null);
    try { await be.signInSend(email.trim().toLowerCase()); setStage('code'); setCode(''); setResendAt(Date.now() + 45_000); }
    catch (x) { setErr(signInMessage(x)); }
    finally { setBusy(false); }
  };
  const verify = useCallback(async (c: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await be.signInVerify(email.trim().toLowerCase(), c); }
    catch (x) { setErr(signInMessage(x)); setCode(''); }
    finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, email]);

  return (
    <form onSubmit={stage === 'email' ? send : (e) => { e.preventDefault(); if (code.length === 6) void verify(code); }} noValidate>
      <label htmlFor="hfs-em" className="hfs-label">Email</label>
      <div className="hfs-row">
        <input id="hfs-em" className="hfs-input hfs-input--xl" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email}
          onChange={(e) => setEmail(e.target.value)} disabled={stage === 'code'} autoFocus={!presetEmail} />
        {stage === 'email'
          ? <button type="submit" className="hfs-btn hfs-btn--primary hfs-btn--xl" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
          : <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--xl" onClick={() => { setStage('email'); setCode(''); setErr(null); }}>Change</button>}
      </div>
      {stage === 'code' && (
        <div className="hfs-codecard">
          <p className="hfs-codecard__t">Enter the code sent to {email.trim()}</p>
          <CodeBoxes value={code} onChange={setCode} onComplete={(c) => void verify(c)} disabled={busy} autoFocus />
          <p className="hfs-note">
            Didn’t get it?{' '}
            {left > 0
              ? <span>Send again in 0:{String(left).padStart(2, '0')}</span>
              : <a href="#resend" onClick={(e) => { e.preventDefault(); void send(); }}>Send again</a>}
          </p>
          {!MOCK ? null : <p className="hfs-note">Preview: any 6 digits work (000000 fails).</p>}
        </div>
      )}
      {err && <p className="hfs-formerr" role="alert">{err}</p>}
      <p className="hfs-fineprint">We never ask for a password. The code is only good for a few minutes.</p>
    </form>
  );
}

/* ── guest path ────────────────────────────────────────────────────────── */
function GuestFlow({ onExisting }: { onExisting: (email: string) => void }) {
  const be = useBackend();
  const [stage, setStage] = useState<'email' | 'emailCode' | 'wa' | 'waCode'>('email');
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [proof, setProof] = useState('');
  const [name, setName] = useState('');
  const [country, setCountry] = useState(DEFAULT_COUNTRY.code);
  const [national, setNational] = useState('');
  const [agree, setAgree] = useState(false);
  const [waCode, setWaCode] = useState('');
  const [masked, setMasked] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const left = useCountdown(resendAt);
  const e164 = () => toE164(country, national);
  const cleanEmail = email.trim().toLowerCase();

  const fail = (x: unknown, fallback: string) => {
    const c = waApiCode(x);
    if (c === 'email_taken') { setErr('This email already has an account. Use the sign-in form on the left.'); return; }
    setErr(waApiMessage(x, x instanceof Error && x.message === 'bad_code' ? 'That code did not work. Check it and try again.' : fallback));
  };

  const sendEmail = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!validEmail(email)) { setErr('Enter a valid email address.'); return; }
    setBusy(true); setErr(null);
    try { const s = await be.guestEmailSend(cleanEmail); setStage('emailCode'); setEmailCode(''); setResendAt(Date.now() + s * 1000); }
    catch (x) { fail(x, 'We could not email a code just now. Please try again.'); if (waApiCode(x) === 'email_taken') setTimeout(() => onExisting(cleanEmail), 1400); }
    finally { setBusy(false); }
  };
  const verifyEmail = async (c: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { const p = await be.guestEmailVerify(cleanEmail, c); setProof(p); setStage('wa'); }
    catch (x) { setEmailCode(''); fail(x, 'That email code did not work. Check it and try again.'); }
    finally { setBusy(false); }
  };
  const sendWa = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (name.trim().length < 2) { setErr('Please enter your name.'); return; }
    if (national.replace(/\D/g, '').length < 6) { setErr('Enter your WhatsApp number.'); return; }
    if (!agree) { setErr('Please confirm that you are 18 or over and agree to the terms.'); return; }
    setBusy(true); setErr(null);
    try { const r = await be.guestWaSend(e164()); setMasked(r.masked); setStage('waCode'); setWaCode(''); setResendAt(Date.now() + r.resendS * 1000); }
    catch (x) { fail(x, 'We could not send the code on WhatsApp. Please try again.'); }
    finally { setBusy(false); }
  };
  const finish = async (c: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await be.guestFinish(e164(), c, name.trim(), proof); navigate('/new', { replace: true }); }
    catch (x) {
      setWaCode('');
      if (waApiCode(x) === 'email_proof_invalid') { setStage('email'); setErr('Your email check has expired. Please start again.'); }
      else fail(x, 'That WhatsApp code did not work. Check it and try again.');
    } finally { setBusy(false); }
  };

  const step = stage === 'email' || stage === 'emailCode' ? 1 : 2;
  return (
    <div>
      <p className="hfs-eyebrow">Step {step} of 2 · then your ticket</p>
      <h1 className="hfs-h1">{step === 1 ? 'Verify your email' : 'Verify your WhatsApp'}</h1>
      {stage === 'email' && (
        <form onSubmit={sendEmail} noValidate>
          <p className="hfs-lead">We’ll email you a 6-digit code first.</p>
          <label htmlFor="hfs-gem" className="hfs-label">Email</label>
          <div className="hfs-row">
            <input id="hfs-gem" className="hfs-input hfs-input--xl" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <button type="submit" className="hfs-btn hfs-btn--primary hfs-btn--xl" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
          </div>
        </form>
      )}
      {stage === 'emailCode' && (
        <div className="hfs-codecard">
          <p className="hfs-codecard__t">Enter the code sent to {cleanEmail}</p>
          <CodeBoxes value={emailCode} onChange={setEmailCode} onComplete={(c) => void verifyEmail(c)} disabled={busy} autoFocus />
          <p className="hfs-note">Didn’t get it? {left > 0 ? <span>Send again in 0:{String(left).padStart(2, '0')}</span> : <a href="#r" onClick={(e) => { e.preventDefault(); void sendEmail(); }}>Send again</a>}{' · '}<a href="#c" onClick={(e) => { e.preventDefault(); setStage('email'); setErr(null); }}>Change email</a></p>
        </div>
      )}
      {stage === 'wa' && (
        <form onSubmit={sendWa} noValidate>
          <p className="hfs-lead">Email checked. Now your WhatsApp number, so we can always reach you.</p>
          <label htmlFor="hfs-nm" className="hfs-label">Your name</label>
          <input id="hfs-nm" className="hfs-input hfs-input--xl" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <label htmlFor="hfs-wa" className="hfs-label hfs-label--gap">WhatsApp number</label>
          <div className="hfs-row hfs-row--nowrap">
            <select aria-label="Country code" className="hfs-input hfs-input--xl hfs-input--country" value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} +{c.dial.replace(/^\+/, '')}</option>)}
            </select>
            <input id="hfs-wa" className="hfs-input hfs-input--xl" inputMode="tel" autoComplete="tel-national" placeholder="98765 43210" value={national} onChange={(e) => setNational(e.target.value)} />
          </div>
          <label className="hfs-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I’m 18 or over and I agree to the <a href={brandUrl('/terms')} target="_blank" rel="noopener noreferrer">terms</a> and <a href={brandUrl('/community-guidelines')} target="_blank" rel="noopener noreferrer">safety rules</a>.</span>
          </label>
          <button type="submit" className="hfs-btn hfs-btn--primary hfs-btn--xl hfs-btn--block" disabled={busy}>{busy ? 'Sending…' : 'Send code on WhatsApp'}</button>
        </form>
      )}
      {stage === 'waCode' && (
        <div className="hfs-codecard">
          <p className="hfs-codecard__t">Enter the code sent on WhatsApp to {masked}</p>
          <CodeBoxes value={waCode} onChange={setWaCode} onComplete={(c) => void finish(c)} disabled={busy} autoFocus />
          <p className="hfs-note">Didn’t get it? {left > 0 ? <span>Send again in 0:{String(left).padStart(2, '0')}</span> : <a href="#r" onClick={(e) => { e.preventDefault(); void sendWa(); }}>Send again</a>}{' · '}<a href="#c" onClick={(e) => { e.preventDefault(); setStage('wa'); setErr(null); }}>Change number</a></p>
        </div>
      )}
      {err && <p className="hfs-formerr" role="alert">{err}</p>}
      {MOCK && <p className="hfs-note">Preview: any 6 digits work (000000 fails).</p>}
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────────── */
export default function SignIn() {
  const [mode, setMode] = useState<'signin' | 'guest'>('signin');
  const [preset, setPreset] = useState<string | undefined>();
  return (
    <div className="hfs hfs-customer hfs-signin">
      <header className="hfs-top">
        <div className="hfs-brand">
          <Marigold size={38} />
          <span className="hfs-wordmark">{BRAND.name} <em>Support</em></span>
        </div>
        <a className="hfs-toplink" href={brandUrl('/')}>Back to {BRAND.domain}</a>
      </header>
      <main className="hfs-signin__main">
        <section className="hfs-card hfs-card--lg hfs-signin__card">
          <Lilac size={48} className="hfs-flower--tr" />
          {mode === 'signin' ? (
            <>
              <p className="hfs-eyebrow">Your tickets, one place</p>
              <h1 className="hfs-h1 hfs-h1--xl">Sign in to Support</h1>
              <p className="hfs-lead">Use the email on your {BRAND.name} account. We’ll send you a 6-digit code.</p>
              <EmailSignIn presetEmail={preset} />
            </>
          ) : (
            <GuestFlow onExisting={(em) => { setPreset(em); setMode('signin'); }} />
          )}
        </section>
        <section className="hfs-card hfs-card--lg hfs-signin__new">
          <Gold size={48} className="hfs-flower--br" />
          <h2 className="hfs-h2">New here?</h2>
          <p>Anyone can open a ticket. We check two things first so we can always reach you, then your account is ready.</p>
          <ol className="hfs-steps">
            <li><span>1</span>Verify your email with a code</li>
            <li><span>2</span>Verify your WhatsApp number with a code</li>
            <li><span>3</span>Write your ticket. See every reply here and in the app</li>
          </ol>
          {mode === 'signin'
            ? <button type="button" className="hfs-btn hfs-btn--amber hfs-btn--xl" onClick={() => setMode('guest')}>Open a ticket</button>
            : <button type="button" className="hfs-btn hfs-btn--amber hfs-btn--xl" onClick={() => setMode('signin')}>I already have an account</button>}
        </section>
      </main>
    </div>
  );
}
