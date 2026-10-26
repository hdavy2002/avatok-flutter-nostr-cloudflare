/* [HF-EXPLORE-PUBLIC-1] Web version of the app's InviteProfileScreen: /i/<platform>/<handle>, a creator who is NOT on the app yet.
 * "VOTE TO INVITE" (POST /api/hf/invites/:platform/:handle; logged out -> the same sign-in card as Explore), and the creator's videos as a grid
 * that plays in place in a small dialog (official embed shown as it is, no crop - HF-REEL-RAW-WEB-1). */
import { useEffect, useRef, useState } from 'react';
import { ClerkIsland, activeSessionSignedOut, getActiveToken, getActiveTokenWaited } from '../../lib/clerk';
import { hfCall } from '../../lib/hfCallsApi';
import { capture } from '../../lib/analytics';
import { GATE_COPY, compactCount, playerFor, signInHref, sizeFor, tapBoxFor, whatsappGateHref, ytCmd, type ReelCreator, type ReelItem } from '../../lib/hfExplore';

const PLATFORM: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram' };
interface Props { creator: ReelCreator; reels: ReelItem[] }

export default function InviteProfile(props: Props) {
  return <ClerkIsland><Profile {...props} /></ClerkIsland>;
}

function Profile({ creator, reels }: Props) {
  const handle = creator.handle.replace(/^@/, '');
  const name = creator.name || `@${handle}`;
  const back = `/i/${creator.platform}/${handle}`;
  const [votes, setVotes] = useState(creator.votes);
  const [voted, setVoted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<ReelItem | null>(null);
  const [paused, setPaused] = useState(false);
  const [box, setBox] = useState({ w: 360, h: 640 });
  const dlg = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLIFrameElement>(null);
  const items = reels.filter(r => !!playerFor(r));

  useEffect(() => { void capture('invite_profile_view', { platform: creator.platform, handle }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const vote = async () => {
    if (busy || voted) return;
    let ok = false;
    const t = await getActiveToken().catch(() => null);
    ok = !!t;
    if (!ok && !activeSessionSignedOut()) ok = !!(await getActiveTokenWaited(1500).catch(() => null));
    if (!ok) { capture('explore_signin_prompt', { action: 'vote' }); setGate(true); return; }
    setBusy(true); setMsg('');
    const r = await hfCall<{ ok: true; votes: number }>('POST', `/api/hf/invites/${encodeURIComponent(creator.platform)}/${encodeURIComponent(handle)}`);
    setBusy(false);
    if (r.ok) { setVoted(true); setVotes(r.data.votes); capture('invite_vote', { platform: creator.platform, handle }); }
    else if (r.code === 'not_verified') window.location.href = whatsappGateHref(back);
    else if (r.status === 401) setGate(true);
    else setMsg(r.code === 'already_on_network' ? 'Good news: they have just joined. Refresh this page.' : 'Could not save your vote. Please try again.');
  };

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
    if (!open && d.open) d.close();
    setPaused(false);
  }, [open]);
  useEffect(() => {
    const el = frame.current;
    if (!el || !open) return;
    const read = () => setBox({ w: el.clientWidth || 360, h: el.clientHeight || 640 });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const spec = open ? playerFor(open) : null;
  const sz = spec ? sizeFor(box.w, box.h, spec.platform) : null;
  const tap = () => {
    if (!spec || spec.platform !== 'youtube') return;
    if (paused) { ytCmd(player.current, 'playVideo'); setPaused(false); } else { ytCmd(player.current, 'pauseVideo'); setPaused(true); }
  };
  const tb = spec && sz ? tapBoxFor(sz, spec.platform) : null;
  const copy = gate ? GATE_COPY.vote : null;

  return <div className="xi-wrap">
    <section className="xi-hero">
      <div className="xi-photo">{creator.avatar ? <img src={creator.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{name.slice(0, 1).toUpperCase()}</span>}</div>
      <h1>{name}</h1>
      <p className="xi-sub">@{handle} · {PLATFORM[creator.platform] ?? creator.platform}</p>
      <span className="xi-chip">Vote to invite</span>
      <div className="xi-stats">
        <div><b>{creator.followers > 0 ? compactCount(creator.followers) : '-'}</b><span>followers</span></div>
        <div><b>{items.length}</b><span>videos</span></div>
        <div><b>{compactCount(votes)}</b><span>votes</span></div>
      </div>
      <button type="button" className="xi-vote" disabled={busy || voted} onClick={vote}>{voted ? 'VOTED' : 'VOTE TO INVITE'}</button>
      <p className="xi-help">{name} isn't on this app yet. Your vote tells us to invite them.</p>
      {msg && <p className="xi-help" role="alert">{msg}</p>}
    </section>
    <h2>Videos</h2>
    {items.length === 0 ? <p className="xi-note">No videos to show yet.</p> : <div className="xi-grid">
      {items.map(r => <button type="button" className="xi-tile" key={r.id} aria-label={`Play: ${r.caption || 'video'}`} onClick={() => { setOpen(r); capture('explore_reel_view', { reel_id: r.id, kind: 'invite', surface: 'invite_profile' }); }}>
        {r.thumbUrl && <img src={r.thumbUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />}
        <span>{PLATFORM[r.platform] ?? 'Video'}</span>
      </button>)}
    </div>}

    <dialog ref={dlg} className="xi-dlg" aria-label="Video" onClose={() => setOpen(null)} onClick={e => { if (e.target === dlg.current) setOpen(null); }}>
      <button type="button" className="xi-x" aria-label="Close video" onClick={() => setOpen(null)}>✕</button>
      <div className="ex" style={{ minHeight: 0, overflow: 'visible', background: 'none', height: '100%' }}>
        <div className="ex-frame" ref={frame}>
          {open && spec && sz && <div className="ex-slide" data-active="1">
            {open.thumbUrl && <img className="ex-poster" src={open.thumbUrl} alt="" referrerPolicy="no-referrer" style={{ width: sz.width, height: sz.height, left: sz.left, top: sz.top, inset: 'auto' }} />}
            <iframe ref={player} key={open.id} title="" tabIndex={-1} aria-hidden="true" allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin"
              src={spec.platform === 'youtube' ? spec.src(true, location.origin) : spec.src}
              style={{ width: sz.width, height: sz.height, left: sz.left, top: sz.top, pointerEvents: spec.platform === 'instagram' ? 'auto' : 'none' }} />
          </div>}
          {spec?.platform === 'youtube' && tb && <div className="ex-tap" role="button" tabIndex={0} aria-label={paused ? 'Play' : 'Pause'} style={{ left: tb.left, top: tb.top, width: tb.width, height: tb.height }} onClick={tap} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); } }} />}
          {paused && <div className="ex-playglyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></div>}
        </div>
      </div>
    </dialog>

    {copy && <div className="ex ex-inline"><div className="ex-gate" role="dialog" aria-modal="true" aria-label={copy.title} onClick={e => { if (e.target === e.currentTarget) setGate(false); }}>
      <div className="ex-card">
        <button type="button" className="ex-x" aria-label="Close" onClick={() => setGate(false)}>✕</button>
        <div className="ex-cphoto">{creator.avatar ? <img src={creator.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{name.slice(0, 1).toUpperCase()}</span>}</div>
        <h2>{copy.title}</h2>
        <p>{copy.line}</p>
        <a className="ex-b-wa" href={signInHref(back)}>Continue with WhatsApp</a>
        <a className="ex-b-g" href={signInHref(back, true)}>Continue with Google</a>
        <small>New or returning, the same button signs you in.</small>
      </div>
    </div></div>}
  </div>;
}
