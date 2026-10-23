/* [HF-DASH-V3-1] Profile: ID card with profile strength, edit form (names, the name influencers see, city, languages, what you like to
 * talk about), the "Notify me on WhatsApp" switch, phone & login facts, and people you blocked.
 * Worker: GET/PATCH /api/hf/me, GET/PUT /api/hf/me/profile, GET/PUT /api/hf/me/prefs, GET /api/hf/blocks, DELETE /api/hf/blocks/:key. */
import { useEffect, useState } from 'react';
import { hfCall } from '../../../lib/hfCallsApi';
import { capture } from '../../../lib/analytics';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { getBlocks, getPrefs, putPrefs, putProfile, unblock, useDash, type BlockItem } from './data';
import { Avatar, Card, Failed, Hibiscus, Marigold, PageHead, Skel, Sticker, istDay, useToast } from './ui';

export const DASH_LANGUAGES = ['Hindi', 'English', 'Hinglish', 'Bengali', 'Marathi', 'Telugu', 'Tamil', 'Gujarati', 'Urdu', 'Kannada', 'Odia', 'Malayalam', 'Punjabi', 'Assamese', 'Garhwali', 'Kumaoni', 'Bhojpuri', 'Konkani'];
interface Me { displayName: string | null; username: string | null; phoneMasked: string | null; whatsappVerified: boolean; age18ConfirmedAt: number | null; registrationComplete?: boolean }

export default function Profile({ account }: { account: DashboardAccount }) {
  const { profile, reload } = useDash();
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const p = profile.data;
  const [f, setF] = useState({ firstName: '', lastName: '', displayName: '', city: '', talkAbout: '' });
  const [langs, setLangs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  useEffect(() => { void hfCall<Me>('GET', '/api/hf/me').then(r => { if (r.ok) setMe(r.data); }); }, []);
  useEffect(() => { if (p) { setF({ firstName: p.firstName ?? '', lastName: p.lastName ?? '', displayName: p.displayName ?? '', city: p.city ?? '', talkAbout: p.talkAbout ?? '' }); setLangs(p.languages); } }, [p]);
  const locked = account.closing;
  const filled = [p?.firstName, p?.lastName, p?.username, p?.city, p?.languages.length ? 'x' : '', p?.talkAbout, p?.displayName].filter(Boolean).length + (me?.whatsappVerified ? 1 : 0) + (me?.age18ConfirmedAt ? 1 : 0);
  const strength = Math.round((filled / 9) * 100);

  const save = async () => {
    if (!p || saving || locked) return;
    setSaving(true); setErr(null);
    const body: Record<string, unknown> = { city: f.city || null, languages: langs, talkAbout: f.talkAbout || null };
    // [HF-FIX-PROFILE-NAME-1] Send a name whenever it differs from what is saved, including a first-time name (saved value null).
    if (f.firstName.trim() !== (p.firstName ?? '')) body.firstName = f.firstName;
    if (f.lastName.trim() !== (p.lastName ?? '')) body.lastName = f.lastName;
    const r = await putProfile(body);
    if (!r.ok) { setSaving(false); setErr({ field: String(r.body?.field ?? ''), text: r.message || 'We could not save your profile. Please try again.' }); return; }
    // The names must really have come back, otherwise say so instead of pretending.
    if ((body.firstName !== undefined && r.data.firstName !== String(body.firstName).normalize('NFKC').trim().replace(/\s+/g, ' ')) || (body.lastName !== undefined && r.data.lastName !== String(body.lastName).normalize('NFKC').trim().replace(/\s+/g, ' '))) {
      setSaving(false); setErr({ field: 'firstName', text: 'Your name did not save. Please try again.' }); return;
    }
    // "Name influencers see" falls back to the first name when it was never set, so influencers never just hear "a fan".
    const wantDisplay = f.displayName.trim() || (!p.displayName && f.firstName.trim() ? f.firstName.trim() : '');
    if (wantDisplay && wantDisplay !== (p.displayName ?? '')) {
      const n = await hfCall<{ ok: boolean; displayName: string }>('PATCH', '/api/hf/me', { displayName: wantDisplay });
      if (!n.ok) { setSaving(false); setErr({ field: 'displayName', text: n.message || 'We could not save that name.' }); return; }
    }
    setSaving(false); toast('Profile saved ✓'); capture('hf_dash3_profile_saved', { strength }); reload('profile');
  };
  const field = (k: keyof typeof f, label: string, opts: { max?: number; help?: string } = {}) => <label className="f">{label}
    <input value={f[k]} maxLength={opts.max ?? 40} disabled={locked || saving} aria-invalid={err?.field === k} onChange={e => { setF(v => ({ ...v, [k]: e.target.value })); setErr(null); }} />
    {opts.help && <span className="small muted" style={{ fontWeight: 400 }}>{opts.help}</span>}</label>;

  return <>
    <PageHead eyebrow="Profile" title="Main apni favourite hoon" sub="How you show up — your handle, languages and what you like to talk about. Influencers never see your number." />
    {profile.failed && <Failed onRetry={() => reload('profile')} />}
    <section className="h3-row c12">
      <section className="h3-card" style={{ textAlign: 'center', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: -30, top: -34 }}><Marigold size={110} tone={1} /></div><div style={{ position: 'absolute', right: -20, top: -26 }}><Hibiscus size={80} /></div>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}><Avatar name={p?.firstName || p?.displayName} seed={p?.username || account.uid} size="lg" /></div>
        <h2 style={{ justifyContent: 'center', marginTop: 12, fontSize: '1.5rem' }}>{p ? [p.firstName, p.lastName].filter(Boolean).join(' ') || p.displayName || 'You' : '—'}</h2>
        {p?.username && <div className="muted">@{p.username}</div>}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          {me?.whatsappVerified && <span className="h3-chip">✓ WhatsApp verified</span>}
          {me?.age18ConfirmedAt && <span className="h3-chip lav">✓ 18+ confirmed</span>}
          {p?.city && <span className="h3-chip gold">📍 {p.city}</span>}
          {account.host?.status === 'live' && <span className="h3-chip">★ Influencer</span>}
        </div>
        <div style={{ marginTop: 16, textAlign: 'left' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><b className="small">Profile strength</b><b className="small">{p ? `${strength}%` : '—'}</b></div>
          <div className="h3-progress" style={{ marginTop: 6 }}><i style={{ width: `${p ? strength : 0}%` }} /></div>
          <p className="small muted" style={{ marginTop: 6 }}>{strength < 100 ? 'Add your languages and what you like to talk about — influencers love context.' : 'Ekdum full! 💯'}</p></div>
        <div style={{ marginTop: 14 }}><Sticker name="fav" w={150} rot={-4} wiggle /></div>
      </section>
      <Card title="Edit profile" note="Influencers only see the name below and your handle">
        {!p ? <Skel h={320} /> : <div style={{ display: 'grid', gap: 12 }}>
          {locked && <p className="small" style={{ color: 'var(--amber)' }}>Your account is closing, so editing is paused.</p>}
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(12rem,1fr))' }}>{field('firstName', 'First name', { max: 30 })}{field('lastName', 'Last name', { max: 30 })}</div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(12rem,1fr))' }}>{field('displayName', 'Name influencers see', { help: '2–40 letters, no numbers or links' })}{field('city', 'City')}</div>
          <label className="f">Handle<input value={p.username ? `@${p.username}` : 'Setting up your handle…'} readOnly disabled aria-readonly="true" style={{ background: 'var(--line, #eee)', color: 'var(--muted, #777)', borderStyle: 'dashed', cursor: 'not-allowed' }} /><span className="small muted" style={{ fontWeight: 400 }}>{p.username ? '🔒 Locked. Your handle can’t be changed.' : 'This appears in a moment. Refresh if it does not.'}</span></label>
          <div><div className="small muted" style={{ fontWeight: 700, marginBottom: 6 }}>Languages you speak</div>
            <div className="h3-amounts">{DASH_LANGUAGES.map(l => <button key={l} type="button" disabled={locked} aria-pressed={langs.includes(l)} className={langs.includes(l) ? 'on' : ''} onClick={() => setLangs(v => v.includes(l) ? v.filter(x => x !== l) : v.length >= 8 ? v : [...v, l])}>{l}</button>)}</div></div>
          <label className="f">What do you like to talk about?<textarea rows={3} maxLength={200} disabled={locked} placeholder="Cricket, career, music, bas time pass…" value={f.talkAbout} onChange={e => setF(v => ({ ...v, talkAbout: e.target.value }))} /></label>
          {err && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{err.text}</p>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button type="button" className="h3-btn rani" disabled={saving || locked} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button type="button" className="h3-btn ghost" disabled={saving} onClick={() => { reload('profile'); setErr(null); }}>Reset</button></div>
        </div>}
      </Card>
    </section>
    <section className="h3-row c3">
      <Card title="Notifications" note="How we reach you" tone={1}><NotifyPref /></Card>
      <Card title="Phone & login" note="Your number is only used to connect calls">
        <div className="h3-break">
          <div><span>Phone</span><b>{me?.phoneMasked ?? '—'}</b></div>
          <div><span>WhatsApp</span><b>{me ? (me.whatsappVerified ? 'Verified' : 'Not verified') : '—'}</b></div>
          <div><span>Member since</span><b>{p?.joinedAt ? istDay(p.joinedAt) : '—'}</b></div>
        </div>
        {me?.registrationComplete && <div style={{ marginTop: 14 }}><b className="small">Policies you accepted when you signed up</b>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{[['Terms', '/terms'], ['Privacy', '/privacy'], ['Disclaimer', '/disclaimer'], ['Community rules', '/community-guidelines'], ['Rules of engagement', '/rules-of-engagement']].map(([t, h]) => <a key={t} className="h3-chip dec" href={h}>✓ {t}</a>)}</div></div>}
      </Card>
      <Card title="Blocked" note="Unblock anyone, any time"><Blocked /></Card>
    </section>
  </>;
}

function NotifyPref() {
  const toast = useToast();
  const [p, setP] = useState<{ notifyWhatsapp: boolean; apptReminders: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getPrefs().then(r => setP(r.ok ? r.data : { notifyWhatsapp: true, apptReminders: true })); }, []);
  const flip = async (k: 'notifyWhatsapp' | 'apptReminders', v: boolean, on: string, off: string) => {
    setBusy(true); const r = await putPrefs({ [k]: v }); setBusy(false);
    if (r.ok) { setP({ notifyWhatsapp: r.data.notifyWhatsapp, apptReminders: r.data.apptReminders }); toast(v ? on : off); capture('hf_dash3_notify_pref', { key: k, on: v }); }
    else toast(r.message || 'We could not change that. Please try again.');
  };
  const row = (k: 'notifyWhatsapp' | 'apptReminders', title: string, sub: string, on: string, off: string) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '12px 0', borderBottom: '1px dashed var(--line)' }}>
    <div><b>{title}</b><div className="small muted">{sub}</div></div>
    <label className="h3-toggle"><span className="sr">{title}</span><input type="checkbox" role="switch" checked={!!p?.[k]} disabled={!p || busy} onChange={e => void flip(k, e.target.checked, on, off)} /></label>
  </div>;
  return <div>
    {row('notifyWhatsapp', 'Notify me on WhatsApp', 'One message when an influencer you asked about is free. Off pauses them all.', 'Notify me is on 🌼', 'Notify me paused. Aram karo.')}
    {row('apptReminders', 'Appointment reminders', 'WhatsApp (and app) reminder 1 hour and 10 minutes before a booked call.', 'Reminders on ⏰', 'Appointment reminders off.')}
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '12px 0', borderBottom: '1px dashed var(--line)' }}>
      <div><b>Top-up receipts</b><div className="small muted">Always sent on WhatsApp and email after you add money.</div></div><span className="h3-chip">Always on</span></div>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '12px 0' }}>
      <div><b>Show my number</b><div className="small muted">Never. Influencers only see your handle.</div></div><span className="h3-chip">Always hidden</span></div>
  </div>;
}

function Blocked() {
  const toast = useToast();
  const [items, setItems] = useState<BlockItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => { setFailed(false); void getBlocks().then(r => { if (r.ok) setItems(r.data.items); else { setFailed(true); setItems([]); } }); };
  useEffect(load, []);
  if (!items) return <Skel h={80} />;
  if (failed) return <Failed onRetry={load} />;
  if (!items.length) return <div style={{ textAlign: 'center' }}><Sticker name="nazar" w={90} rot={-4} /><p className="small muted" style={{ marginTop: 8 }}>Nobody blocked. Nazar na lage! You can block anyone from a call’s details.</p></div>;
  return <div>{items.map(b => <div key={b.key} className="h3-rcpt"><span><b>{b.name}</b><div className="small muted">Blocked {istDay(b.at)}</div></span>
    <button type="button" className="h3-btn sm ghost" onClick={async () => { const r = await unblock(b.key); if (r.ok) { toast(`Unblocked ${b.name}`); load(); } else toast(r.message || 'We could not unblock. Please try again.'); }}>Unblock</button></div>)}</div>;
}
