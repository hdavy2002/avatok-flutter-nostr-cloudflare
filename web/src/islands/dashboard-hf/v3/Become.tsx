/* [HF-DASH-V3-1] Become an influencer: perks, live onboarding progress (each step reads the real verification status) and an earnings
 * estimate that uses the published formula (we keep ₹2 a minute plus 40% of the rate above ₹2, HF-REEL-30; hosts set ₹5–₹1,000/min).
 * Worker: GET /api/hosts/me ({ host, kyc }), GET /api/hf/me (WhatsApp verified). The steps themselves happen in /hosts/onboarding. */
import { useEffect, useState } from 'react';
import { hfCall } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import { capture } from '../../../lib/analytics';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { STATUS_NOTE } from '../hostActivity';
import { Card, Ic, PageHead, Skel, Sticker, fmtInt } from './ui';

interface HostMe { host: { status: string; slug: string | null } | null; kyc: { aadhaar: { done: boolean }; selfie: { status: string }; payout: { done: boolean } } }
/** [HF-CREATOR-SPACES-1] GET /api/hf/spaces/me (subset). kind tells which path this person chose in /hosts/onboarding. */
interface SpacesMe { kind: 'channel' | 'women' | 'lgbtq' | null; aadhaarVerified: boolean; selfie: { status: 'none' | 'pending' | 'approved' | 'rejected' }; qualified: boolean; minFollowers?: number; minViews?: number }
const PRICES = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000];
/** Host earning per connected minute, in paise, for a price in rupees (rulebook HF-REEL-30: we keep ₹2 plus 40% of the rate above ₹2). */
export const hostPaisePerMin = (rupees: number) => Math.max(0, Math.round((rupees * 100 - 200) * 0.6));

export default function Become({ account }: { account: DashboardAccount }) {
  const [me, setMe] = useState<HostMe | null>(null);
  const [wa, setWa] = useState<boolean | null>(null);
  const [sp, setSp] = useState<SpacesMe | null>(null);
  const [pi, setPi] = useState(3);
  const [mins, setMins] = useState(300);
  useEffect(() => {
    void hfCall<HostMe>('GET', '/api/hosts/me').then(r => setMe(r.ok ? r.data : { host: null, kyc: { aadhaar: { done: false }, selfie: { status: 'none' }, payout: { done: false } } }));
    void hfCall<{ whatsappVerified: boolean }>('GET', '/api/hf/me').then(r => setWa(r.ok ? r.data.whatsappVerified : false));
    void hfCall<SpacesMe>('GET', '/api/hf/spaces/me').then(r => setSp(r.ok ? r.data : null)); // missing/failed -> show the channel steps
  }, []);
  const st = me?.host?.status ?? null;
  const profileDone = !!st && !['draft', 'generating'].includes(st);
  const space = sp?.kind === 'women' || sp?.kind === 'lgbtq' ? sp.kind : null;
  const spaceName = space === 'women' ? 'Women-only' : 'LGBTQ+';
  const selfie = sp?.selfie?.status ?? 'none';
  const steps: [string, string, boolean][] = [
    ['Verify your WhatsApp', 'An OTP on the Indian number you’ll take calls on.', !!wa],
    ...(space ? [
      ['Verify your Aadhaar', space === 'women' ? 'Aadhaar OTP or DigiLocker. For a Women-only channel it must show Female.' : 'Aadhaar OTP or DigiLocker, plus your LGBTQ+ channel details.', !!sp?.aadhaarVerified] as [string, string, boolean],
      ['Video KYC', selfie === 'pending' ? 'Our team is checking your selfie video.' : selfie === 'rejected' ? 'Please record your selfie video again.' : 'A 10-second selfie video reading a code.', selfie === 'approved'] as [string, string, boolean],
    ] : [
      ['Connect your channel', sp ? `YouTube or Instagram with at least ${sp.minFollowers ?? 20} followers${sp.minViews ? ` and ${sp.minViews} views on YouTube` : ''}.` : 'YouTube or Instagram, checked automatically.', !!sp?.qualified || profileDone] as [string, string, boolean],
    ]),
    // [HF-IDV-WHATSAPP-1 2026-10-24] Channel creators need no Aadhaar or selfie video to go live. Withdrawal details (UPI + Aadhaar) come later, in the wallet.
    ['Your profile', 'Avatar, about, languages, up to 6 topics, your price per minute and your hours.', profileDone],
    ['Review & go live', space ? `You approve your profile, our team approves it with your video KYC, and your ${spaceName} channel is live.` : 'You approve your profile, our team approves it, and you’re live.', st === 'live'],
  ];
  const doneN = steps.filter(s => s[2]).length;
  const cur = steps.findIndex(s => !s[2]);
  const price = PRICES[pi], per = hostPaisePerMin(price), month = Math.round(per * mins * 4.3);
  return <>
    <PageHead eyebrow="Become an influencer" title="Apni baatein, apni kamaai" sub="Create content on YouTube, Instagram or Facebook? Let your fans call you privately — and earn from every connected minute." art={<Sticker name="girlboss" w={100} rot={5} />} />
    <section className="h3-kpis">{([['🔒', 'Number hidden', 'Fans never see your real number.'], ['🕐', 'Your hours', 'Go online or offline any time. Decline any call.'], ['💸', 'Real money', 'Paid to your own UPI, no minimum withdrawal, 7 days after the call.'], ['🛡️', 'Safety first', 'Press # to end, block and report.']] as const)
      .map(([e, t, d]) => <div key={t} className="h3-card"><div style={{ fontSize: 28 }} aria-hidden="true">{e}</div><h3 style={{ marginTop: 6 }}>{t}</h3><p className="small muted">{d}</p></div>)}</section>
    <section className="h3-row c21">
      <Card title="Get verified" note={st ? (STATUS_NOTE[st] ?? (st === 'live' ? 'Your profile is live 🎉' : 'Your profile is on its way.')) : 'About 10 minutes, start to finish'}>
        {!me || wa === null ? <Skel h={360} /> : <>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}><b className="small">{doneN} of {steps.length} done</b><b className="small">{Math.round((doneN / steps.length) * 100)}%</b></div>
          <div className="h3-progress" style={{ marginBottom: 14 }}><i style={{ width: `${(doneN / steps.length) * 100}%` }} /></div>
          <div className="h3-steps">{steps.map(([t, d, done], i) => <div key={t} className={`h3-step${done ? ' done' : i === cur ? ' cur' : ''}`}>
            <div className="n">{done ? '✓' : i + 1}</div><div><b>{t}</b><div className="small muted">{d}</div></div></div>)}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            {st === 'live' ? <a className="h3-btn rani" href="/dashboard/host">Open my influencer profile</a>
              : account.closing ? <span className="small muted">Your account is closing, so you can’t start this now.</span>
              : <a className="h3-btn rani" href={profileDone ? '/dashboard/host' : '/hosts/onboarding'} onClick={() => capture('hf_dash3_become_start', { step: cur })}>{doneN ? 'Continue' : 'Start now'} <Ic name="right" className="" /></a>}
            <a className="h3-btn ghost" href="/hosts/rules">Rules for influencers</a>
          </div></>}
      </Card>
      <Card title="Kitna kamaoge?" note="Move the sliders — a rough estimate" tone={1}>
        <label className="f">Your price per minute: ₹{fmtInt(price)}<input type="range" min={0} max={PRICES.length - 1} step={1} value={pi} onChange={e => setPi(Number(e.target.value))} aria-valuetext={`₹${price} per minute`} /></label>
        <label className="f" style={{ marginTop: 10 }}>Minutes of calls per week: {fmtInt(mins)}<input type="range" min={30} max={1200} step={30} value={mins} onChange={e => setMins(Number(e.target.value))} /></label>
        <div className="h3-break" style={{ marginTop: 12 }}>
          <div><span>Fans pay</span><b>₹{fmtInt(price)}/min</b></div>
          <div><span>You keep per minute</span><b>{formatPaise(per)}</b></div>
          <div className="tot"><span>About per month</span><span>{formatPaise(month)}</span></div>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>We keep ₹2 a minute plus 40% of the rate above ₹2. You keep the rest. Earnings are paid by the minute spoken. Estimates only — real earnings depend on your calls.</p>
        <div style={{ marginTop: 10, textAlign: 'center' }}><Sticker name="kyabaat" w={100} rot={-5} /></div>
      </Card>
    </section>
  </>;
}
