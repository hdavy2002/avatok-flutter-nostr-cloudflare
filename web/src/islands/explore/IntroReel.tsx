/* [HF-INTRO-B3] Intro-video reels on /explore and /r/<id> (feed items with kind 'intro', flag hfIntroReelsEnabled).
 * IntroVideo = the native <video> of one slide (poster first, loop, muted autoplay is driven by ExploreReels, tap layer = play / pause).
 * IntroOverlay = bottom-left details: name + green tick, verified social icons, Women only tag, categories, one line, rate, ONE main button
 * (mainAction: call | queue_or_book | book | none), the (i) "Verified owner of" sheet and the women-only pop-ups.
 * The call / queue / booking flows are the existing ones (CallSheet, QueueSheet, /bookings); nothing here starts a call by itself.
 * Women-only gate (HF-INTRO-17): guest -> the sign-in card; signed in -> GET /api/hf/lanes/me first (no call is placed to find out), and a 403
 * lane_required {need} from the call itself lands in the same pop-up. need 'aadhaar' -> Verify now / Not now; need 'female_only' -> OK.
 * Telemetry: hf_social_link_open {platform}, hf_women_gate {result}, hf_reel_info_open. (hf_reel_start / hf_reel_share are sent by ExploreReels.) */
import { useEffect, useRef, useState } from 'react';
import { capture } from '../../lib/analytics';
import { fetchSpaceMe, verifyHref } from '../../lib/hfSpaces';
import { callModeFlags, NO_FLAGS, type CallModeFlags } from '../../lib/hfCallModes';
import { bookingsEnabled } from '../../lib/hfBookingsApi';
import { isAppMode } from '../../lib/nativeBridge';
import { HF_PLAY_URL, trackWebBlocked } from '../../lib/hfApp';
import { compactCount, introRate, mainActionOf, safeSocialUrl, PLATFORM_NAME, type IntroSocial, type ReelItem } from '../../lib/hfExplore';
import { CallSheet, webHasTestCredits } from '../calls/HostCallActions';
import QueueSheet from '../calls/QueueSheet';
import SessionBridge from '../calls/SessionBridge';
import '../../styles/hf-spaces.css';

export type WomenNeed = 'aadhaar' | 'female_only';
type Eligibility = 'ok' | 'guest' | 'unknown' | WomenNeed;

/** Can this signed-in fan talk to a women-only channel? Reads GET /api/hf/lanes/me; never places a call. */
async function womenEligibility(): Promise<Eligibility> {
  const r = await fetchSpaceMe();
  if (r.signedOut) return 'guest';
  const me = r.me;
  if (!me) return 'unknown'; // could not load: let the real action decide (the server answers 403 lane_required)
  if (me.lanes?.women?.granted === true) return 'ok';
  if (!me.aadhaarVerified) return 'aadhaar';
  if (me.gender && me.gender !== 'F') return 'female_only';
  return 'aadhaar'; // Aadhaar done and Female, but the lane is not granted yet: the verify page finishes it
}

/* ── icons ─────────────────────────────────────────────────────────────── */
const I = {
  phone: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.6 21 3 13.4 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.57 3.6a1 1 0 0 1-.25 1z" /></svg>,
  cal: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>,
  info: <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6" /><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 12.5 4 4 8-9" /></svg>,
  close: <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>,
  open: <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
};
export const SoundIcon = ({ on }: { on: boolean }) => on
  ? <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></svg>;

function SocialGlyph({ platform }: { platform: string }) {
  if (platform === 'youtube') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4" fill="#d6332f" /><path d="M10 9l5 3-5 3z" fill="#fff" /></svg>;
  if (platform === 'instagram') return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#fff" stroke="#be246e" strokeWidth="2.2" /><circle cx="12" cy="12" r="4" stroke="#be246e" strokeWidth="2.2" /><circle cx="17.2" cy="6.8" r="1.3" fill="#be246e" /></svg>;
  if (platform === 'facebook') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#2f5fd0" /><path d="M13.2 20v-6.2h2.1l.3-2.5h-2.4V9.8c0-.7.2-1.2 1.2-1.2h1.3V6.4a17 17 0 0 0-1.9-.1c-1.9 0-3.2 1.1-3.2 3.3v1.7H8.5v2.5h2.1V20z" fill="#fff" /></svg>;
  return null;
}
const handleOf = (s: IntroSocial): string => { const h = (s.handle || '').replace(/^@/, ''); return h ? `@${h}` : PLATFORM_NAME[s.platform] ?? 'Account'; };

/* ── the slide's video ─────────────────────────────────────────────────── */
export function IntroVideo({ item, active, paused, register, onPlaying, onTap }: {
  item: ReelItem; active: boolean; paused: boolean; register: (el: HTMLVideoElement | null) => void; onPlaying: () => void; onTap: () => void;
}) {
  return <>
    <video ref={register} className="ex-vid" src={item.videoUrl ?? undefined} poster={item.posterUrl ?? undefined}
      muted loop playsInline preload="auto" disablePictureInPicture onPlaying={onPlaying} aria-label={`Intro video of ${item.host?.name ?? 'this creator'}`} />
    {active && <div className="ex-vtap" role="button" tabIndex={0} aria-label={paused ? 'Play' : 'Pause'} onClick={onTap}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onTap(); } }} />}
  </>;
}

/* ── overlay ───────────────────────────────────────────────────────────── */
interface OverlayProps {
  item: ReelItem;
  /** ExploreReels' sign-in check: true = signed in, false = the sign-in card was opened */
  needAuth: () => Promise<boolean>;
  /** the page path to come back to after verifying (/r/<id>) */
  back: string;
  /** the (i) sheet lives in ExploreReels (its button sits in the rail) */
  info: boolean;
  setInfo: (v: boolean) => void;
  /** local preview page: skip the network checks. ?sim=aadhaar|female|ok picks the women-gate answer, ?auto=info|aadhaar|female opens a sheet */
  preview?: boolean;
}

export const InfoIcon = I.info;

export function IntroOverlay({ item, needAuth, back, info, setInfo, preview = false }: OverlayProps) {
  const host = item.host;
  const slug = host?.slug ?? '';
  const name = host?.name || 'this creator';
  const action = mainActionOf(item);
  const rate = introRate(item.ratePaise ?? host?.ratePaise);
  const socials = (item.socials ?? []).filter(s => safeSocialUrl(s.url));
  const cats = item.categories ?? [];
  const women = item.womenOnly === true;
  const [wgate, setWgate] = useState<WomenNeed | null>(null);
  const [callOpen, setCallOpen] = useState(false);
  const [callEver, setCallEver] = useState(false);
  const [flags, setFlags] = useState<CallModeFlags>(NO_FLAGS);
  const [bookingOn, setBookingOn] = useState(false);
  const bypass = useRef(false);

  useEffect(() => {
    if (preview) { setBookingOn(true); return; }
    let live = true;
    void callModeFlags().then(f => { if (live) setFlags(f); });
    void bookingsEnabled().then(v => { if (live) setBookingOn(v); });
    return () => { live = false; };
  }, [preview]);

  // preview only: open a sheet straight away so it can be photographed
  useEffect(() => {
    if (!preview) return;
    const auto = new URLSearchParams(location.search).get('auto');
    if (auto === 'info') setInfo(true);
    if (women && (auto === 'aadhaar' || auto === 'female')) setWgate(auto === 'female' ? 'female_only' : 'aadhaar');
  }, [preview, women]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setInfo(false); setWgate(null); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showWomen = (need: WomenNeed) => { setWgate(need); capture('hf_women_gate', { result: need, reel_id: item.id, host: slug }); };

  /** Guest -> sign-in card. Women-only -> eligibility first. true = go ahead with the real action. */
  const allowed = async (): Promise<boolean> => {
    if (!(await needAuth())) { if (women) capture('hf_women_gate', { result: 'guest', reel_id: item.id, host: slug }); return false; }
    if (!women) return true;
    let res: Eligibility;
    if (preview) { const s = new URLSearchParams(location.search).get('sim'); res = s === 'ok' ? 'ok' : s === 'female' ? 'female_only' : 'aadhaar'; }
    else res = await womenEligibility();
    if (res === 'aadhaar' || res === 'female_only') { showWomen(res); return false; }
    capture('hf_women_gate', { result: res === 'ok' ? 'pass' : 'unchecked', reel_id: item.id, host: slug });
    return true;
  };

  const callNow = async () => {
    if (!(await allowed())) return;
    if (!preview && !isAppMode() && !(await webHasTestCredits())) { trackWebBlocked('call'); window.location.assign(HF_PLAY_URL); return; } // same web rule as the channel page
    setCallEver(true); setCallOpen(true);
  };
  const bookTime = async () => {
    if (!(await allowed())) return;
    if (preview) return;
    window.location.assign(`/bookings?host=${encodeURIComponent(slug)}`);
  };
  /** Wrap the QueueSheet: its own "Join queue" button is intercepted until the gate says yes, then clicked again. */
  const onQueueCapture = (e: React.MouseEvent) => {
    if (bypass.current) { bypass.current = false; return; }
    const btn = (e.target as HTMLElement).closest('button.hfc-queue') as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation(); e.preventDefault();
    void allowed().then(ok => { if (ok) { bypass.current = true; btn.click(); } });
  };

  const shown = cats.slice(0, 3);
  const more = cats.length - shown.length;
  const waiting = host?.queue?.waiting ?? 0;
  const status = action === 'call' ? { dot: 'on', text: 'Online' }
    : action === 'queue_or_book' ? { dot: 'busy', text: waiting > 0 ? `On a call · ${waiting} waiting` : 'On a call' }
      : null;
  const callHost = { slug, displayName: name, pricePerMin: (item.ratePaise ?? 0) / 100, pricePaisePerMin: item.ratePaise, status: (host?.presence as 'online' | 'busy' | 'offline' | undefined) ?? 'online', womenOnly: women };
  const ticked = (item.greenTick ?? host?.greenTick) === true;

  return <>
    <div className="ex-introshade" aria-hidden="true" />
    <div className="ex-intro" data-action={action}>
      <div className="ex-itext">
        <div className="ex-iname">
          <span className="ex-iav" aria-hidden="true">{host?.avatar ? <img src={host.avatar} alt="" loading="lazy" /> : name.slice(0, 1).toUpperCase()}</span>
          <h2>{name}</h2>
          {ticked && <span className="hf-vt hf-vt-kyc hf-vt-md" role="img" aria-label="Verified by our team" title="Verified by our team">{I.check}</span>}
          {socials.map(s => <a key={s.platform + s.url} className="ex-soc" data-p={s.platform} href={safeSocialUrl(s.url)!} target="_blank" rel="noopener noreferrer"
            aria-label={`${name} on ${PLATFORM_NAME[s.platform] ?? s.platform} (opens in a new tab)`}
            onClick={() => capture('hf_social_link_open', { platform: s.platform, reel_id: item.id, surface: 'overlay' })}><SocialGlyph platform={s.platform} /></a>)}
          {women && <span className="ex-wtag">♀ Women only</span>}
        </div>
        {(shown.length > 0 || status) && <div className="ex-ichips">
          {shown.map(c => <span key={c.id} className="ex-chip">{c.label}</span>)}
          {more > 0 && <span className="ex-chip ex-more">+{more}</span>}
          {status && <span className="ex-stat"><i data-s={status.dot} aria-hidden="true" />{status.text}</span>}
        </div>}
        {item.description && <p className="ex-idesc">{item.description}</p>}
      </div>

      {action === 'call' && <button type="button" className="ex-main" onClick={callNow}>{I.phone}<span>Call now · {rate}</span></button>}
      {action === 'book' && <>
        <button type="button" className="ex-main" onClick={bookTime}>{I.cal}<span>Book a time · {rate}</span></button>
        <p className="ex-bonly">Takes bookings only</p>
      </>}
      {action === 'queue_or_book' && <div className="ex-busy">
        <p className="ex-busyl">Busy right now · {rate}</p>
        <div className="ex-brow">
          <div className="ex-qwrap" onClickCapture={onQueueCapture}>
            <QueueSheet host={{ slug, displayName: name }} variant="rail" waiting={0} bookingHref={`/bookings?host=${encodeURIComponent(slug)}`} bookingOn={bookingOn} idleLabel="Join queue" />
          </div>
          <button type="button" className="ex-main ex-alt" onClick={bookTime}><span>Book a time</span></button>
        </div>
      </div>}
    </div>

    {callEver && <>
      <SessionBridge on />
      <CallSheet host={callHost} open={callOpen} onClose={() => setCallOpen(false)} flags={flags} bookingOn={bookingOn} onLane={need => showWomen(need === 'female_only' ? 'female_only' : 'aadhaar')} />
    </>}

    {info && <div className="ex-shwrap" onClick={e => { if (e.target === e.currentTarget) setInfo(false); }}>
      <section className="ex-sheet" role="dialog" aria-modal="true" aria-label="Verified owner of">
        <button type="button" className="ex-x" aria-label="Close" onClick={() => setInfo(false)}>{I.close}</button>
        <div className="ex-shteam"><span className="hf-vt hf-vt-kyc hf-vt-md" aria-hidden="true">{I.check}</span><b>Approved by our team</b></div>
        {socials.length > 0 && <>
          <h2 className="ex-shh">Verified owner of</h2>
          <ul className="ex-shlist">{socials.map(s => <li key={s.platform + s.url}>
            <span className="ex-shic" data-p={s.platform}><SocialGlyph platform={s.platform} /></span>
            <span className="ex-shtx"><b>{PLATFORM_NAME[s.platform] ?? s.platform}</b><small>{handleOf(s)}{typeof s.followers === 'number' && s.followers > 0 ? ` · ${compactCount(s.followers)} ${s.platform === 'youtube' ? 'subscribers' : 'followers'}` : ''}</small></span>
            <a className="ex-shopen" href={safeSocialUrl(s.url)!} target="_blank" rel="noopener noreferrer" aria-label={`Open ${handleOf(s)} on ${PLATFORM_NAME[s.platform] ?? s.platform} (new tab)`}
              onClick={() => capture('hf_social_link_open', { platform: s.platform, reel_id: item.id, surface: 'sheet' })}>Open</a>
          </li>)}</ul>
          <p className="ex-shnote">They logged in to each account to prove it’s theirs. Links open in a new tab.</p>
        </>}
      </section>
    </div>}

    {wgate === 'aadhaar' && <div className="ex-gate ex-wgate" role="dialog" aria-modal="true" aria-label="Women-only channel" onClick={e => { if (e.target === e.currentTarget) { setWgate(null); } }}>
      <div className="ex-card ex-wcard">
        <span className="ex-wmark" aria-hidden="true">♀</span>
        <h2>This is a women-only channel</h2>
        <p>Only Aadhaar-verified women can talk to {name}. It takes about a minute — your Aadhaar number is never shown to anyone.</p>
        <a className="ex-b-wa" href={verifyHref('women', back)}>Verify now</a>
        <button type="button" className="ex-b-n" onClick={() => setWgate(null)}>Not now</button>
      </div>
    </div>}
    {wgate === 'female_only' && <div className="ex-gate ex-wgate ex-wgate-b" role="dialog" aria-modal="true" aria-label="Women only" onClick={e => { if (e.target === e.currentTarget) setWgate(null); }}>
      <div className="ex-card ex-wsmall">
        <h2>Sorry, this channel is for women only.</h2>
        <button type="button" className="ex-b-ok" onClick={() => setWgate(null)}>OK</button>
      </div>
    </div>}
  </>;
}
