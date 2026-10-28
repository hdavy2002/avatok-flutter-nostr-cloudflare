/* [HF-INTRO-B4] "How do you take calls?" (D9/D16): Bookings only (A) or Bookings + live calls (B), saved with PUT /api/hosts/me/call-option.
 * Shown only while hfCallOptionEnabled is on. Also the intro-video banner (D18) for live influencers without an approved intro (needs hfIntroOnboardingEnabled).
 * The server's three-way presence switch keeps working underneath: with B the person only sees Online / Offline, and Offline is saved as
 * "bookings_only", which keeps bookings open (W2 table: Offline for A and B still takes bookings). */
import { useCallback, useEffect, useState } from 'react';
import { capture } from '../../../lib/analytics';
import { getCallOption, getIntroMe, introFlags, putCallOption, reasonText, type CallOption, type IntroMe } from '../../../lib/hfIntroDash';
import { HF_PLAY_URL } from '../../../lib/hfApp';
import { Marigold } from './ui';

const track = (e: string, p: Record<string, unknown>) => { try { capture(e, p as never); } catch { /* telemetry must never break the page */ } };

export interface CallOptionState { enabled: boolean; loaded: boolean; option: CallOption | null; busy: boolean; msg: string; choose: (o: CallOption) => Promise<void> }

export function useCallOption(isHost = true): CallOptionState {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [option, setOption] = useState<CallOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    if (!isHost) return;
    void (async () => {
      const f = await introFlags();
      if (!live || !f.callOption) return;
      const r = await getCallOption();
      if (!live) return;
      if (r.ok) { setOption(r.data.callOption ?? null); setEnabled(true); setLoaded(true); track('hf_call_option_ui', { option: r.data.callOption ?? 'none', action: 'view' }); }
      // 404 not_enabled / 409 not_host / network: stay hidden, today's dashboard
    })();
    return () => { live = false; };
  }, [isHost]);
  const choose = useCallback(async (o: CallOption) => {
    if (busy || o === option) return;
    setBusy(true); setMsg('');
    const r = await putCallOption(o);
    setBusy(false);
    if (r.ok) { setOption(r.data.callOption ?? o); track('hf_call_option_ui', { option: o, action: 'change' }); }
    else setMsg(r.message || 'We could not save that. Please try again.');
  }, [busy, option]);
  return { enabled, loaded, option, busy, msg, choose };
}

export function CallOptionCard({ st }: { st: CallOptionState }) {
  const { option, busy, msg, choose } = st;
  const items: Array<[CallOption, string, string]> = [
    ['A', 'Bookings only', 'Fans book a time with you.'],
    ['B', 'Bookings + live calls', 'Fans can also call you right now when you are Online.'],
  ];
  return <section className="h3-card" aria-labelledby="hf-call-option-h"><h2 id="hf-call-option-h"><Marigold size={20} />How do you take calls?</h2>
    <div className="h3-modes" role="radiogroup" aria-label="How you take calls" style={{ marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      {items.map(([o, label]) => <button key={o} type="button" role="radio" aria-checked={option === o} className={`h3-mode${option === o ? ' is-on' : ''}`} disabled={busy} onClick={() => void choose(o)}>{label}</button>)}
    </div>
    <p className="small muted" style={{ marginTop: 8 }}>{option ? items.find(i => i[0] === option)![2] : 'Pick one. You can change it any time.'}</p>
    {msg && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{msg}</p>}
    {option === 'A' && <p className="small" style={{ marginTop: 10 }}><b>Fans book a time with you — open slots in your calendar.</b>{' '}
      <a href="/dashboard/host/availability" onClick={() => track('hf_call_option_ui', { option: 'A', action: 'availability_link' })}>Open your availability →</a></p>}
  </section>;
}

/** D18: the intro-video banner. Renders nothing unless the flag is on and the server says this influencer needs (or is waiting on) an intro. */
export function IntroBanner() {
  const [me, setMe] = useState<IntroMe | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const f = await introFlags();
      if (!live || !f.intro) return;
      const r = await getIntroMe();
      if (live && r.ok) setMe(r.data);
    })();
    return () => { live = false; };
  }, []);
  return me ? <IntroBannerView me={me} /> : null;
}

export function IntroBannerView({ me }: { me: IntroMe }) {
  const status = me.introStatus ?? 'none';
  const click = () => track('hf_intro_banner_click', { status });
  if (status === 'submitted') {
    return <aside className="h3-safe" role="status" style={{ background: 'var(--goldtint)', borderColor: 'var(--line2)' }}><div><h3>Your intro is waiting for approval</h3>
      <p className="small">A person from our team is checking it. We will tell you on WhatsApp as soon as it is done.</p></div></aside>;
  }
  if (status === 'rejected' && me.needsIntroVideo !== false) {
    const reasons = (me.introRejectReasons ?? []).map(reasonText).filter(Boolean);
    return <aside className="h3-safe" role="alert" style={{ background: 'var(--goldtint)', borderColor: 'var(--rani)' }}><div><h3>Your intro video needs a fix</h3>
      {reasons.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{reasons.map(t => <li key={t}>{t}</li>)}</ul>}
      {me.introRejectNote && <p className="small" style={{ marginTop: 6 }}>{me.introRejectNote}</p>}
    </div><a className="h3-btn rani" href={HF_PLAY_URL} target="_blank" rel="noopener" onClick={click}>Fix it in the app</a></aside>;
  }
  if (me.needsIntroVideo) {
    return <aside className="h3-safe" style={{ background: 'var(--goldtint)', borderColor: 'var(--rani)' }}><div><h3>Record your 20-second intro video</h3>
      <p className="small">Fans now find you through it. Until a person approves it, you’re hidden from Reels. You record it in the Hello Fraands app.</p></div>
      <a className="h3-btn rani" href={HF_PLAY_URL} target="_blank" rel="noopener" onClick={click}>Record it in the app</a></aside>;
  }
  return null;
}
