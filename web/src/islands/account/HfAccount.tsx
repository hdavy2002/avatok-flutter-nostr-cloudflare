// [HF-DASHBOARD-SHELL-1] Account data belongs to /api/hf/me, never the retired dashboard APIs.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import SessionBridge from '../calls/SessionBridge';
import { hfCall, signInUrl } from '../../lib/hfCallsApi';
import { BRAND } from '../../lib/brand';
import '../../styles/hf-account.css';
import DashboardNav from '../../components/account/DashboardNav';
import { useEmbedded } from '../../components/account/dashboardEmbed';
import { bookingsEnabled } from '../../lib/hfBookingsApi';

interface Account {
  uid: string;
  displayName: string | null;
  username?: string | null;
  phoneMasked: string | null;
  whatsappVerified: boolean;
  isHost: boolean;
  host: { status: string; slug: string | null } | null;
  closing: boolean;
}
export default function HfAccount() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'signedout' | 'error'>('loading');
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const back = '/dashboard/profile';
  const embedded = useEmbedded();
  const [bookingOn, setBookingOn] = useState(false);

  useEffect(() => {
    let disposed = false;
    async function load() {
      const run = ++generation.current;
      setBookingOn(false); setAccount(null); setName(''); setError(''); setSaved(''); setSaving(false); setPhase('loading');
      try {
        const result = await hfCall<Account>('GET', '/api/hf/me');
        if (disposed || run !== generation.current) return;
        if (!result.ok) { setPhase(result.status === 401 ? 'signedout' : 'error'); return; }
        setAccount(result.data); setName(result.data.displayName ?? ''); setPhase('ready');
        const enabled = await bookingsEnabled();
        if (!disposed && run === generation.current) setBookingOn(enabled);
      } catch {
        if (!disposed && run === generation.current) setPhase('error');
      }
    }
    void load();
    const changed = () => { void load(); };
    window.addEventListener('site:active-session-changed', changed);
    return () => {
      disposed = true; ++generation.current;
      window.removeEventListener('site:active-session-changed', changed);
    };
  }, [retry]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || account.closing || saving) return;
    const run = generation.current;
    setSaving(true); setError(''); setSaved('');
    try {
      const result = await hfCall<{ ok: boolean; displayName: string }>('PATCH', '/api/hf/me', { displayName: name }, { isCurrent: () => run === generation.current });
      if (run !== generation.current) return;
      if (!result.ok) {
        if (result.status === 401) { setAccount(null); setName(''); setPhase('signedout'); }
        else setError(result.message || 'We could not save your name. Please try again.');
        return;
      }
      setAccount(current => current ? { ...current, displayName: result.data.displayName } : null);
      setName(result.data.displayName);
      setSaved('Your display name has been saved.');
    } catch {
      if (run === generation.current) setError('We could not reach the server. Please try again.');
    } finally {
      if (run === generation.current) setSaving(false);
    }
  }

  const Wrap = embedded ? 'div' : 'main';
  return <Wrap className={embedded ? 'hfa-page hfd-embedded' : 'hfa-page hfd-page'}>
    {!embedded && <SessionBridge on />}
    <header className="hfa-heading">
      <p className="hfa-eyebrow">{BRAND.name}</p>
      <h1>Your profile</h1>
      <p>Manage the name people see on your account.</p>
    </header>
    {phase === 'loading' && <section className="hfa-card" aria-busy="true"><p role="status">Loading your account…</p></section>}
    {phase === 'signedout' && <section className="hfa-card"><h2>Sign in to your account</h2><p>See your profile, wallet and bookings after signing in.</p><a className="hfa-button" href={signInUrl(back)}>Sign in</a></section>}
    {phase === 'error' && <section className="hfa-card"><h2>Account unavailable</h2><p role="alert">We could not load your account. Check your connection and try again.</p><button className="hfa-button" type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></section>}
    {phase === 'ready' && account && <>
      <div className={embedded ? undefined : 'hfd-layout'}>{!embedded && <DashboardNav account={account} bookingOn={bookingOn} active="profile" />}<div className={embedded ? undefined : 'hfd-content'}>
      {account.closing && <aside className="hfa-notice" role="status"><strong>Your account is being closed.</strong> Profile editing is paused. <a href="/dashboard/close">Manage account closure</a></aside>}
      <section className="hfa-card">
        <h2>Profile details</h2>
        <form onSubmit={save}>
          <label htmlFor="hfa-name">Display name</label>
          <p id="hfa-name-help" className="hfa-muted">Use 2–40 characters, with no numbers, phone numbers, links or handles.</p>
          <input id="hfa-name" name="displayName" autoComplete="name" value={name} required disabled={saving || account.closing}
            aria-describedby={error ? 'hfa-name-help hfa-name-error' : 'hfa-name-help'} aria-invalid={!!error}
            onChange={event => { setName(event.target.value); setError(''); setSaved(''); }} />
          {error && <p id="hfa-name-error" className="hfa-error" role="alert">{error}</p>}
          {saved && <p className="hfa-success" role="status">{saved}</p>}
          <button className="hfa-button" type="submit" disabled={saving || account.closing || name === (account.displayName ?? '')}>{saving ? 'Saving…' : 'Save name'}</button>
        </form>
        <dl className="hfa-facts">
          {account.username && <div><dt>Username</dt><dd>{account.username}</dd></div>}
          <div><dt>Phone</dt><dd>{account.phoneMasked || 'Not available'}</dd></div>
          <div><dt>WhatsApp verification</dt><dd>{account.whatsappVerified ? 'Verified' : 'Not verified'}</dd></div>
          {account.isHost && <div><dt>Influencer status</dt><dd>{account.host?.status?.replaceAll('_', ' ') || 'Not available'}</dd></div>}
        </dl>
      </section>
      </div></div>
    </>}
  </Wrap>;
}
