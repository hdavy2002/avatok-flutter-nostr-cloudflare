// [SAATHUM-FREEVIDEOS-WEB-1 2026-10-01] The "Free videos" row — its OWN section under the paid
// events on the home page and the marketplace (never mixed into the event grid).
//
// NOTE FOR AI:
//  - Mounted with client:idle (home) / client:visible (marketplace): owner rule WEB-PERF —
//    non-critical content loads later, in the background.
//  - Renders NOTHING while loading, on error, or when there are no published free videos
//    (owner rule: no empty section, no placeholder cards).
//  - Same section/card styles as the "Book now" shelf (../home/BookNowShelf.css).
import { useEffect, useState } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { getFreeVideos, type FreeVideoCardData } from './api';
import { FreeVideoCard } from './FreeVideoCard';
import '../home/BookNowShelf.css';
import './freevideos.css';

const MAX = 4;

export default function FreeVideosRow({ surface = 'home' }: { surface?: string }) {
  const [items, setItems] = useState<FreeVideoCardData[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    const t0 = performance.now();
    getFreeVideos({ limit: MAX }, ctrl.signal)
      .then((list) => {
        const top = list.slice(0, MAX);
        setItems(top);
        capture('free_videos_row_loaded', { surface, count: top.length, ms: Math.round(performance.now() - t0) });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        captureException(err, { surface: 'free_videos_row', where: surface });
      });
    return () => ctrl.abort();
  }, [surface]);

  if (items.length === 0) return null;

  return (
    <section className="bn-section fv-section" id="free-videos" aria-labelledby="fv-title" data-home-section="free-videos">
      <div className="bn-inner">
        <div className="bn-head">
          <h2 id="fv-title"><span aria-hidden="true">✽</span> Free videos</h2>
          <p>Satsang, bhajan, aarti and more. Watch free with just your email.</p>
        </div>
        <div className={'bn-grid bn-grid--' + items.length}>
          {items.map((v, i) => <FreeVideoCard key={v.id} v={v} surface={surface} position={i} />)}
        </div>
        <div className="bn-more">
          <a className="bn-more-btn" href="/free-videos" data-home-cta="free-videos-all" onClick={() => capture('free_videos_see_all_click', { surface })}>See all free videos <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </section>
  );
}
