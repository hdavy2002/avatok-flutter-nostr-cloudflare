/* [HF-CREATOR-BADGES-1] My verifications: one card per badge (Phone, Channel, Video KYC, Space) plus "Who can call you".
 * Worker: GET /api/hf/spaces/me (badges, canGoLive, missing, callerLevel, callerLevelLocked), POST /api/hf/spaces/space,
 * POST /api/hf/spaces/caller-level. Channel and KYC steps happen in /hosts/onboarding (deep-linked with ?add=). */
import { useCallback, useEffect, useState } from 'react';
import { hfCall } from '../../../lib/hfCallsApi';
import { capture } from '../../../lib/analytics';
import { NEVER_SHARE } from '../../../lib/hfSpaces';
import SpaceBadges from '../../../components/hosts/SpaceBadges';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { FacebookLoginButton, FacebookReturnNote } from './SocialVerify'; // [HF-INTRO-B4]
import { Failed, Ic, PageHead, Skel, Sticker } from './ui';
import '../../../styles/hf-verifications.css';

type Space = 'women' | 'lgbtq';
type Level = 'everyone' | 'video_kyc';
interface Me {
  whatsappVerified?: boolean; aadhaarVerified?: boolean; gender?: 'F' | 'M' | 'T' | null;
  selfie?: { status: 'none' | 'pending' | 'approved' | 'rejected'; reason: string | null };
  badges?: { phone: boolean; channel: boolean; videoKyc: boolean; space: Space | null };
  canGoLive?: boolean; missing?: string[]; callerLevel?: Level; callerLevelLocked?: boolean; videoKycVerified?: boolean; hostStatus?: string | null;
}
const MISSING_TEXT: Record<string, string> = {
  channel_or_video_kyc: 'Finish social media verification or video KYC',
  space_video_kyc: 'Finish video KYC to open your special space',
};
// [HF-VERIF-WORDING-1] Kept word for word in step with the app (my_verifications.dart _liveTitle / _liveLine).
const liveTitle = (status?: string | null) => (status === 'live' ? 'You are live' : 'You can go live');
const liveLine = (status?: string | null) =>
  status === 'live' ? 'Your badges are in place and fans can find you.'
  : status === 'approved' || status === 'paused' ? 'Your badges are in place and your profile is approved.'
  : 'Your badges are in place. Our team checks your profile before fans can see it.';
const track = (e: string, p: Record<string, unknown> = {}) => { try { capture(e, p as never); } catch { /* telemetry must never break the page */ } };
const Chip = ({ tone, children }: { tone?: 'gold' | 'lav' | 'miss' | 'dec'; children: React.ReactNode }) => <span className={`h3-chip${tone ? ` ${tone}` : ''}`}>{children}</span>;

export default function Verifications({ account }: { account: DashboardAccount }) {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await hfCall<Me>('GET', '/api/hf/spaces/me');
    if (r.ok) { setMe(r.data); setFailed(false); } else setFailed(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (failed) return <><PageHead eyebrow="My verifications" title="Bharosa ke badge" /><Failed onRetry={() => { setFailed(false); void load(); }} /></>;
  if (!me) return <><PageHead eyebrow="My verifications" title="Bharosa ke badge" /><Skel h={360} /></>;

  const b = me.badges ?? { phone: !!me.whatsappVerified, channel: false, videoKyc: !!me.videoKycVerified, space: null };
  const missing = me.missing ?? [];
  const canGoLive = me.canGoLive ?? (missing.length === 0 && (b.channel || b.videoKyc));
  const closing = !!account.closing;
  return <>
    <PageHead eyebrow="My verifications" title="Bharosa ke badge" sub="Stack your badges so fans trust you. Add social media verification, video KYC, or both." art={<Sticker name="nazar" w={100} rot={5} />} />
    <FacebookReturnNote />
    <section className="hv-summary" aria-live="polite">
      <div className="hv-lead">
        <h2>{canGoLive ? liveTitle(me.hostStatus) : 'Not ready to go live yet'}</h2>
        {canGoLive
          ? <p>{liveLine(me.hostStatus)}</p>
          : <><p>Here is what is still missing:</p><ul className="hv-missing">{(missing.length ? missing : ['channel_or_video_kyc']).map(m => <li key={m}>{MISSING_TEXT[m] ?? m}</li>)}</ul></>}
      </div>
      <SpaceBadges videoKyc={b.videoKyc} space={b.space} surface="my_verifications" large />
    </section>
    <div className="hv-list">
      <PhoneCard done={b.phone} />
      <ChannelCard done={b.channel} closing={closing} />
      <KycCard me={me} done={b.videoKyc} closing={closing} />
      <SpaceCard me={me} current={b.space} kycDone={b.videoKyc} onChanged={load} />
      <CallerCard me={me} onChanged={load} />
    </div>
  </>;
}

function PhoneCard({ done }: { done: boolean }) {
  return <section className="hv-card">
    <div className="hv-head"><span className="hv-ico" aria-hidden="true"><Ic name="phone" className="" /></span>
      <div><h3>Phone verified</h3><p>Your WhatsApp number. Every creator needs it, and fans never see it.</p></div>
      <span className="hv-status">{done ? <Chip tone="lav">Verified</Chip> : <Chip tone="miss">Not yet</Chip>}</span></div>
    {!done && <div className="hv-acts"><a className="h3-btn rani" href="/hosts/onboarding?step=phone">Verify my number</a></div>}
  </section>;
}

export function ChannelCard({ done, closing }: { done: boolean; closing: boolean }) {
  return <section className="hv-card">
    <div className="hv-head"><span className="hv-ico" aria-hidden="true"><Ic name="star" className="" /></span>
      <div><h3>Social media verification</h3><p>Connect your YouTube, Instagram or Facebook so fans see your videos. Needs 20 followers and 1,000 YouTube views.</p></div>
      <span className="hv-status">{done ? <Chip tone="lav">Connected</Chip> : <Chip tone="dec">Not connected</Chip>}</span></div>
    {!closing && <div className="hv-acts"><a className="h3-btn rani" href="/hosts/onboarding?add=channel&step=channel" onClick={() => track('hf_verifications_action', { badge: 'channel' })}>{done ? 'Manage social media' : 'Connect my social media'}</a><FacebookLoginButton surface="verifications" /></div>}
  </section>;
}

function KycCard({ me, done, closing }: { me: Me; done: boolean; closing: boolean }) {
  const sf = me.selfie?.status ?? 'none';
  const aad = !!me.aadhaarVerified;
  const state = done ? 'verified' : sf === 'rejected' ? 'rejected' : sf === 'pending' ? 'pending' : 'start';
  const step = aad ? 'selfie' : 'aadhaar';
  return <section className="hv-card">
    <div className="hv-head"><span className="hv-ico" aria-hidden="true"><Ic name="shield" className="" /></span>
      <div><h3>Video KYC</h3><p>Aadhaar plus a 10-second selfie video. Perfect for chatting, company and sharing your day. No channel needed.</p></div>
      <span className="hv-status">{state === 'verified' ? <SpaceBadges videoKyc space={null} surface="my_verifications_card" /> : state === 'pending' ? <Chip tone="gold">Being checked</Chip> : state === 'rejected' ? <Chip tone="miss">Try again</Chip> : <Chip tone="dec">Not started</Chip>}</span></div>
    {state === 'pending' && <p className="hv-note"><Ic name="clock" className="" />Our team is checking your selfie video. We will message you on WhatsApp.</p>}
    {state === 'rejected' && <p className="hv-reason" role="alert">Your selfie video was not approved{me.selfie?.reason ? `: ${me.selfie.reason}` : '.'} Please record it again.</p>}
    {!closing && state !== 'verified' && state !== 'pending' && <div className="hv-acts"><a className="h3-btn rani" href={`/hosts/onboarding?add=kyc&step=${step}`} onClick={() => track('hf_verifications_action', { badge: 'video_kyc' })}>{state === 'rejected' ? 'Record my selfie again' : aad ? 'Record my selfie video' : 'Start video KYC'}</a></div>}
  </section>;
}

function SpaceCard({ me, current, kycDone, onChanged }: { me: Me; current: Space | null; kycDone: boolean; onChanged: () => Promise<void> }) {
  const [pick, setPick] = useState<Space | null>(null);
  const [declare, setDeclare] = useState(false);
  const [terms, setTerms] = useState(false);
  const [pub, setPub] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const skipDeclare = me.gender === 'T';
  const womenBlocked = !!me.gender && me.gender !== 'F';
  const lgbtqReady = pub && (skipDeclare || (declare && terms));
  const call = async (space: Space | null) => {
    setBusy(true); setErr('');
    const body = space === 'lgbtq'
      ? (skipDeclare ? { space, publicTagConsent: true } : { space, declare: true, acceptTerms: true, publicTagConsent: true })
      : { space };
    const r = await hfCall<{ ok: boolean }>('POST', '/api/hf/spaces/space', body);
    if (r.ok) { track(space ? 'hf_space_joined' : 'hf_space_left', space ? { space } : {}); setPick(null); setDeclare(false); setTerms(false); setPub(false); await onChanged(); }
    else setErr(r.message || 'We could not save this. Please try again.');
    setBusy(false);
  };
  const opts: { key: Space; title: string; sub: string }[] = [
    { key: 'women', title: 'Women-only', sub: womenBlocked ? 'Your Aadhaar does not show Female, so this space is not open to you.' : 'Only verified women can call you. Your Aadhaar must show Female.' },
    { key: 'lgbtq', title: 'LGBTQ+', sub: 'A friendly space for LGBTQ+ callers. The "LGBTQ+ channel" tag is shown publicly.' },
  ];
  return <section className="hv-card hv-wide">
    <div className="hv-head"><span className="hv-ico" aria-hidden="true"><Ic name="heart" className="" /></span>
      <div><h3>Special space</h3><p>Join one space at a time. Space creators are called only by customers with full video KYC. Needs your video KYC first.</p></div>
      <span className="hv-status">{current ? <SpaceBadges space={current} surface="my_verifications_card" /> : <Chip tone="dec">None</Chip>}</span></div>
    {!kycDone && <p className="hv-note"><Ic name="shield" className="" />Finish video KYC above to unlock this.</p>}
    {current ? <div className="hv-acts"><button type="button" className="h3-btn ghost" disabled={busy} onClick={() => void call(null)}>{busy ? 'Please wait…' : 'Leave this space'}</button></div> : <>
      <div className="hv-opts" role="radiogroup" aria-label="Special space">
        {opts.map(o => <button key={o.key} type="button" role="radio" aria-checked={pick === o.key} className="hv-opt" disabled={!kycDone || busy || (o.key === 'women' && womenBlocked)} onClick={() => { setPick(o.key); setErr(''); }}><span>{o.title}<small>{o.sub}</small></span></button>)}
      </div>
      {pick === 'lgbtq' && <div className="hv-opts">
        {!skipDeclare && <>
          <label className="hv-check"><input type="checkbox" checked={declare} onChange={e => setDeclare(e.target.checked)} /><span>I am LGBTQ+. <b>This is private and never shown.</b></span></label>
          <label className="hv-check"><input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} /><span>I accept the <a href="/lgbtq" target="_blank" rel="noopener">LGBTQ+ space terms</a>.</span></label>
        </>}
        <label className="hv-check"><input type="checkbox" checked={pub} onChange={e => setPub(e.target.checked)} /><span>I understand my profile will <b>publicly show "LGBTQ+ channel"</b>, including in search and on Google.</span></label>
      </div>}
      <div className="hv-acts"><button type="button" className="h3-btn rani" disabled={!kycDone || busy || !pick || (pick === 'lgbtq' && !lgbtqReady)} onClick={() => pick && void call(pick)}>{busy ? 'Please wait…' : 'Join this space'}</button></div>
    </>}
    {err && <p className="hv-err" role="alert">{err}</p>}
  </section>;
}

function CallerCard({ me, onChanged }: { me: Me; onChanged: () => Promise<void> }) {
  const locked = !!me.callerLevelLocked || !!me.badges?.space;
  const level: Level = locked ? 'video_kyc' : me.callerLevel ?? 'everyone';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = async (l: Level) => {
    if (locked || l === level) return;
    setBusy(true); setErr('');
    const r = await hfCall<{ ok: boolean }>('POST', '/api/hf/spaces/caller-level', { level: l });
    if (r.ok) { track('hf_caller_level_set', { level: l }); await onChanged(); }
    else setErr(r.code === 'space_locked' ? 'Because you are in a special space, only video-KYC customers can call you.' : r.message || 'We could not save this. Please try again.');
    setBusy(false);
  };
  const opts: { key: Level; title: string; sub: string }[] = [
    { key: 'everyone', title: 'Everyone with a verified phone', sub: 'The widest reach.' },
    { key: 'video_kyc', title: 'Only video-KYC customers', sub: 'Only customers who completed Aadhaar + selfie video KYC.' },
  ];
  return <section className="hv-card hv-wide">
    <div className="hv-head"><span className="hv-ico" aria-hidden="true"><Ic name="phone" className="" /></span>
      <div><h3>Who can call you</h3><p>Free for every creator. Applies to calls, bookings and the queue.</p></div></div>
    <div className="hv-opts" role="radiogroup" aria-label="Who can call you">
      {opts.map(o => <button key={o.key} type="button" role="radio" aria-checked={level === o.key} className="hv-opt" disabled={busy || (locked && o.key !== 'video_kyc')} onClick={() => void set(o.key)}><span>{o.title}<small>{o.sub}</small></span></button>)}
    </div>
    {locked && <p className="hv-note"><Ic name="shield" className="" />Locked: special-space creators are always called only by video-KYC customers.</p>}
    <p className="hv-note"><Ic name="shield" className="" />{NEVER_SHARE}</p>
    {err && <p className="hv-err" role="alert">{err}</p>}
  </section>;
}
