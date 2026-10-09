/* [HF-LANE-VERIFY-1] `?lane=women|lgbtq`: shows only that lane's hosts to a signed-in caller who has joined it (fetched with their bearer token);
 * everyone else gets a short "Verify to see this space" panel. Lane cards carry data-lane-host so notebookHome.ts keeps them and hides samples. */
/* [HF-HOST-PLATFORM-1] Real hosts on Explore and the home page.
 * Loads late (client:visible), fetches GET /api/hosts/public and prepends one card per live host into the existing
 * `.people-grid`, with the same markup/classes as components/callvaal/ProfileCard.astro. Renders nothing if the API
 * answers 404 (flag hostsPublicEnabled off), is empty, or fails. The sample cards stay exactly as they are. */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE } from '../../lib/env';
import { request } from '../../lib/apiClient';
import { moods } from '../../lib/callvaalHomeReference';
import Icon from '../host-onboarding/Icon';
import HostCallActions from '../calls/HostCallActions';
import { callsEnabled, type HostPresence } from '../../lib/hfCallsApi';
import '../../styles/profile-card.css';
import '../../styles/live-hosts.css';

interface HostCard {
  slug: string; displayName: string; tagline: string | null; avatarUrl: string | null; languages: string[]; style: string | null; topics: string[];
  pricePerMin: number; lgbtqFriendly: boolean;
  /** [HF-LANE-VERIFY-1] Women-lane host: only verified eligible callers can call. */
  womenOnly?: boolean;
  /** [HF-VOICE-INTRO-1] The host's own recorded introduction (admin-approved). */
  introAudioUrl: string | null; introSeconds: number | null; introMime: string | null;
  /** [HF-CALLS-1] From presence (online | busy | offline); rating is the average of approved reviews. */
  status?: HostPresence; rating?: number | null; reviewCount?: number;
}
const STYLE_LABEL: Record<string, string> = {
  warm: 'Steady & encouraging', energetic: 'Cheerful & chatty', calm: 'Calm listener',
  playful: 'Funny & light', straightforward: 'Straight-talking', thoughtful: 'Gentle & patient',
};
const LazyClerkBridge = lazy(() => import('../../lib/clerk').then(m => ({ default: m.ClerkSessionBridge })));
type LaneName = 'women' | 'lgbtq';
const LANE_TITLE: Record<LaneName, string> = { women: 'women-only', lgbtq: 'LGBTQ+' };
function laneFromUrl(): LaneName | null {
  try { const v = new URLSearchParams(window.location.search).get('lane'); return v === 'women' || v === 'lgbtq' ? v : null; } catch { return null; }
}
function looksSignedOut(): boolean {
  try {
    const m = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
    if (m && m[1] && m[1] !== '0') return false;
    try { if (localStorage.getItem('saathum_guest_jwt')) return false; } catch { /* ignore */ }
    return true;
  } catch { return false; }
}
const moodLabel = (slug: string) => moods.find(m => m.slug === slug)?.label ?? slug;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** Only one card plays at a time. */
let playingNow: { audio: HTMLAudioElement; stop: () => void } | null = null;

function IntroButton({ h }: { h: HostCard }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { audioRef.current?.pause(); if (playingNow?.audio === audioRef.current) playingNow = null; }, []);
  const toggle = () => {
    if (!h.introAudioUrl) return;
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = 'none';
      a.src = h.introAudioUrl;
      a.onended = () => setPlaying(false);
      a.onpause = () => setPlaying(false);
      a.onerror = () => { setPlaying(false); setFailed(true); };
      audioRef.current = a;
    }
    const a = audioRef.current;
    if (!a.paused) { a.pause(); return; }
    if (playingNow && playingNow.audio !== a) playingNow.stop();
    playingNow = { audio: a, stop: () => { a.pause(); } };
    setFailed(false);
    a.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); setFailed(true); });
  };
  const first = h.displayName.split(' ')[0];
  return (
    <div className="hf-live-intro">
      <button type="button" className="hf-live-intro-btn" onClick={toggle} aria-pressed={playing}
        aria-label={`${playing ? 'Pause' : 'Play'} ${first}’s voice introduction`}>
        <Icon name={playing ? 'pause' : 'play'} size={22} />
        <span>{playing ? 'Pause' : 'Hear'} {first}{h.introSeconds ? ` · ${mmss(h.introSeconds)}` : ''}</span>
      </button>
      <small className="hf-live-clip-label">{failed ? 'This recording would not play. Please try again.' : 'Recorded by the host'}</small>
    </div>
  );
}

const STATUS_TEXT: Record<HostPresence, string> = { online: 'Online', busy: 'On a call', offline: 'Offline' };

function Card({ h, lane, callsOn }: { h: HostCard; lane?: LaneName | null; callsOn: boolean }) {
  const href = `/h/${h.slug}`;
  const status: HostPresence = h.status === 'online' || h.status === 'busy' ? h.status : 'offline';
  const reviews = h.reviewCount ?? 0;
  return (
    <article
      className="profile-card hf-live-card" data-live-host={h.slug} {...(lane ? { 'data-lane-host': lane } : {})} data-person data-profile-id={`live-${h.slug}`}
      data-moods={h.topics.join(' ')} data-languages={h.languages.join(', ')} data-price={h.pricePerMin} data-online={callsOn && status === 'online' ? 'true' : 'false'}
      data-search={`${h.displayName} ${h.languages.join(' ')} ${h.topics.map(moodLabel).join(' ')}`}
    >
      <div className="portrait-wrap">
        {h.avatarUrl && <img className="person-portrait" src={h.avatarUrl} alt={`${h.displayName}, an AI avatar chosen by the host`} width={1254} height={1254} loading="lazy" />}
        <span className="hf-live-ai">AI avatar chosen by the host</span>
        {callsOn
          ? <p className={`person-status ${status === 'online' ? '' : status === 'busy' ? 'is-busy' : 'is-offline'}`}><span aria-hidden="true" />{STATUS_TEXT[status]}</p>
          : <p className="person-status is-offline"><span aria-hidden="true" />Calls open soon</p>}
      </div>
      <div className="person-copy">
        <div className="profile-card-heading">
          <div className="person-heading"><h3><a className="person-detail-link" href={href}>{h.displayName}</a></h3></div>
        </div>
        <p className="hfc-rate">{reviews > 0 && h.rating != null ? <><span aria-hidden="true">★</span> <strong>{h.rating.toFixed(1)}</strong> <span>({reviews})</span><span className="sr-only"> rating from {reviews} reviews</span></> : <span className="hfc-new">New</span>}</p>
        <p className="person-tagline">{h.tagline || 'A little time for a good conversation'}</p>
        {h.introAudioUrl && <IntroButton h={h} />}
        <dl className="profile-card-facts">
          {h.languages.length > 0 && <div><dt><Icon name="globe" size={25} />Languages</dt><dd>{h.languages.join(', ')}</dd></div>}
          {h.style && <div><dt><Icon name="sparkle" size={25} />Conversation style</dt><dd>{STYLE_LABEL[h.style] ?? h.style}</dd></div>}
        </dl>
        {h.womenOnly && <ul className="person-moods"><li><Icon name="shield" size={18} /><span>Women-only</span></li></ul>}
        {h.lgbtqFriendly && <ul className="person-moods"><li><Icon name="sparkle" size={18} /><span>LGBTQ+ friendly</span></li></ul>}
        {h.topics.length > 0 && (
          <div className="profile-card-topics">
            <h4>Let’s talk about</h4>
            <ul className="person-moods">{h.topics.slice(0, 5).map(s => <li key={s}><Icon name="chat" size={18} /><span>{moodLabel(s)}</span></li>)}</ul>
          </div>
        )}
        <div className="profile-card-footer">
          <div className="person-actions">
            <div className="profile-card-price"><strong className="person-price">₹{h.pricePerMin}/min</strong><small>10 min ≈ ₹{h.pricePerMin * 10}</small></div>
            {h.womenOnly && !lane && !callsOn
              ? <a className="sample-call hf-lane-verify" href="/verify/lane?lane=women"><Icon name="shield" size={22} />Verify to call</a>
              : <HostCallActions variant="card" host={{ slug: h.slug, displayName: h.displayName, pricePerMin: h.pricePerMin, status, womenOnly: h.womenOnly }} />}
          </div>
          <a className="profile-card-link" href={href}>View full profile <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </article>
  );
}

function LanePanel({ lane }: { lane: LaneName }) {
  return (
    <section className="hf-lane-panel" aria-labelledby="hf-lane-panel-title">
      <h3 id="hf-lane-panel-title">Verify to see this space</h3>
      <p>The {LANE_TITLE[lane]} space is private. A short, one-time verification opens it for you.</p>
      <a className="hf-lane-panel-cta" href={`/verify/lane?lane=${lane}`}>Verify to enter</a>
    </section>
  );
}

export default function LiveHostCards() {
  const [hosts, setHosts] = useState<HostCard[]>([]);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const lane = useRef<LaneName | null>(laneFromUrl()).current;
  const [locked, setLocked] = useState(false);
  const [needBridge, setNeedBridge] = useState(false);

  const mountWrap = (): HTMLElement | null => {
    const grid = document.querySelector<HTMLElement>('#people .people-grid') ?? document.querySelector<HTMLElement>('.people-grid');
    if (!grid) return null;
    const wrap = document.createElement('div');
    wrap.className = 'hf-live-wrap';
    grid.insertBefore(wrap, grid.firstChild);
    return wrap;
  };

  // [HF-LANE-VERIFY-1] Lane view.
  useEffect(() => {
    if (!lane) return;
    let live = true;
    const state = (v: string) => { document.documentElement.dataset.laneState = v; document.dispatchEvent(new CustomEvent('hf:people-changed')); };
    const lock = () => { const w = mountWrap(); if (w) setMount(w); setLocked(true); state('locked'); };
    (async () => {
      state('checking');
      try {
        if (looksSignedOut()) { if (live) lock(); return; }
        setNeedBridge(true);
        const { getActiveTokenWaited } = await import('../../lib/clerk');
        const auth = await getActiveTokenWaited(8000);
        if (!live) return;
        if (!auth) { lock(); return; }
        const list = await request<HostCard[]>('/api/hosts/public', { auth, query: { lane, limit: 24 }, timeoutMs: 15000 });
        if (!live) return;
        const w = mountWrap();
        if (w) setMount(w);
        setHosts(Array.isArray(list) ? list : []);
        state('granted');
      } catch (e) {
        if (!live) return;
        const status = (e as { status?: number } | null)?.status;
        if (status === 403 || status === 401 || status === 404) lock();
        else state('error');
      }
    })();
    return () => { live = false; };
  }, [lane]);
  const [callsOn, setCallsOn] = useState(false);
  useEffect(() => { let live = true; void callsEnabled().then(v => { if (live) setCallsOn(v); }); return () => { live = false; }; }, []);

  useEffect(() => {
    if (lane) return;
    let live = true;
    (async () => {
      try {
        // Plain fetch, not apiClient: a flag-off 404 is normal here and must not be reported as an API error.
        const res = await fetch(`${API_BASE}/api/hosts/public?limit=24`, { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const list = (await res.json()) as HostCard[];
        if (!live || !Array.isArray(list) || list.length === 0) return;
        const grid = document.querySelector<HTMLElement>('#people .people-grid') ?? document.querySelector<HTMLElement>('.people-grid');
        if (!grid) return;
        const wrap = document.createElement('div');
        wrap.className = 'hf-live-wrap';
        grid.insertBefore(wrap, grid.firstChild);
        setMount(wrap);
        setHosts(list);
      } catch { /* offline or flag off: the sample cards stay */ }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => () => { mount?.remove(); }, [mount]);

  // Tell the page filters (notebookHome.ts) that real cards now exist so they apply the active filters to them.
  useEffect(() => {
    if (!mount || hosts.length === 0) return;
    document.dispatchEvent(new CustomEvent('hf:people-changed'));
  }, [mount, hosts, callsOn]);

  // The 1px sentinel gives client:visible something to watch before any card exists.
  return (
    <>
      <span className="hf-live-sentinel" aria-hidden="true" />
      {needBridge && <Suspense fallback={null}><LazyClerkBridge /></Suspense>}
      {mount && locked && lane ? createPortal(<LanePanel lane={lane} />, mount) : null}
      {mount && hosts.length > 0 ? createPortal(<>{hosts.map(h => <Card key={h.slug} h={h} lane={lane} callsOn={callsOn} />)}</>, mount) : null}
    </>
  );
}
