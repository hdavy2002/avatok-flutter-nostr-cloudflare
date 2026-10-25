/* [HF-CHANNEL-WEB-1] "Now Showing": the influencer's own videos, played INLINE in the official YouTube / Instagram player (we never host video).
 * Featured player + list of the other YouTube videos + a Reels & Shorts row (Instagram reels open in a small player box; anything without an
 * embeddable player is left out — [HF-WEB-NOOUT-1] never a link out). The section is not rendered at all when the influencer has no reels.
 * Telemetry: channel_video_played. */
import { useEffect, useRef, useState } from 'react';
import { capture } from '../../lib/analytics';
import { PLATFORM_LABEL, compact, embedFor, isShort, type ChannelReel } from '../../lib/channelKit';

const label = (r: ChannelReel) => PLATFORM_LABEL[r.platform] ?? 'Reel';
const metaLine = (r: ChannelReel) => `${label(r)}${typeof r.views === 'number' && r.views > 0 ? ` · ${compact(r.views)} views` : ''}`;
const titleOf = (r: ChannelReel) => (r.title && r.title.trim()) || `${label(r)} video`;

export default function VideoPlayer({ hostSlug, hostName, reels: all }: { hostSlug: string; hostName: string; reels: ChannelReel[] }) {
  // [HF-WEB-NOOUT-1] owner: fans never leave for YouTube / Instagram. Only videos that play right here are listed.
  const reels = all.filter(r => !!embedFor(r));
  const long = reels.filter(r => r.platform === 'youtube' && !isShort(r));
  const short = reels.filter(r => !(r.platform === 'youtube' && !isShort(r)));
  const [active, setActive] = useState<ChannelReel | null>(long[0] ?? null);
  const [playing, setPlaying] = useState(false);
  const [box, setBox] = useState<ChannelReel | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);

  const played = (r: ChannelReel) => capture('channel_video_played', { host_slug: hostSlug, platform: r.platform, reel_id: r.id, surface: r === active ? 'featured' : 'row' });
  const play = (r: ChannelReel) => { setActive(r); setPlaying(true); played(r); };
  const openReel = (r: ChannelReel) => {
    if (!embedFor(r)) return;
    setBox(r); played(r);
  };
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (box && !d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
    if (!box && d.open) d.close();
  }, [box]);

  const emb = active ? embedFor(active) : null;
  const rest = long.filter(r => r !== active).slice(0, 5);
  const boxEmbed = box ? embedFor(box) : null;

  return <>
    {active && <div className="vid-grid">
      <div className="player">
        {playing && emb
          ? <iframe src={emb.src} title={titleOf(active)} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
          : <>
            {active.thumbUrl && <img src={active.thumbUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />}
            {emb && <button type="button" className="big" aria-label={`Play: ${titleOf(active)}`} onClick={() => play(active)}><svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg></button>}
            <div className="meta"><span>{titleOf(active)}</span><span>{metaLine(active)}</span></div>
          </>}
      </div>
      {rest.length > 0 && <div className="vlist">
        {rest.map(r => <button type="button" className="vrow" key={r.id} onClick={() => play(r)} aria-label={`Play: ${titleOf(r)}`}>
          <span className="th">{r.thumbUrl && <img src={r.thumbUrl} alt="" referrerPolicy="no-referrer" loading="lazy" width="150" height="94" />}</span>
          <span><b>{titleOf(r)}</b><span>{metaLine(r)}</span></span>
        </button>)}
      </div>}
    </div>}
    {short.length > 0 && <>
      <p className="nun reels-h" style={active ? undefined : { marginTop: 0 }}>Reels &amp; Shorts</p>
      <div className="reels">
        {short.slice(0, 12).map((r, i) => {
          const tone = ['linear-gradient(160deg,#FFD400,#E2231A)', 'linear-gradient(160deg,#9fb2f0,#1B3FA0)', 'linear-gradient(160deg,#FDE7F1,#E0157A)', 'linear-gradient(160deg,#FFF1CC,#FFB000)', 'linear-gradient(160deg,#cfc8e0,#3b2b6e)', 'linear-gradient(160deg,#ffb4ae,#B3170F)'][i % 6];
          const inner = <>{r.thumbUrl && <img src={r.thumbUrl} alt="" referrerPolicy="no-referrer" loading="lazy" width="180" height="320" />}<span>{label(r)}</span></>;
          return <button type="button" className="reel" key={r.id} style={{ background: tone }} aria-label={`Play ${label(r)}: ${titleOf(r)}`} onClick={() => openReel(r)}>{inner}</button>;
        })}
      </div>
    </>}
    <p className="foot">Videos play right here, from {hostName}’s own channels.</p>
    <dialog ref={dlg} className="reelbox" aria-label="Reel" onClose={() => setBox(null)} onClick={e => { if (e.target === dlg.current) setBox(null); }}>
      <button type="button" className="x" aria-label="Close video" onClick={() => setBox(null)}>✕</button>
      {box && boxEmbed && <iframe src={boxEmbed.src} title={titleOf(box)} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
    </dialog>
  </>;
}
