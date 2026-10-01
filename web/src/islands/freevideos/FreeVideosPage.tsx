// [SAATHUM-FREEVIDEOS-WEB-1 2026-10-01] /free-videos — every published free video as a card grid,
// with category filter chips. The first page of cards is rendered on the server (props
// `initial`) so it is in the HTML; picking a chip asks the API for that category.
//
// NOTE FOR AI: chips are real links (/free-videos?category=x) so the page works without JS and
// every filter is a shareable URL; the island intercepts the click when JS is on.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { FREE_VIDEO_CATEGORIES, getFreeVideos, type FreeVideoCardData } from './api';
import { FreeVideoCard } from './FreeVideoCard';
import '../home/BookNowShelf.css';
import './freevideos.css';

const PAGE_LIMIT = 48;

const hrefFor = (cat: string) => (cat ? `/free-videos?category=${encodeURIComponent(cat)}` : '/free-videos');

export default function FreeVideosPage({ initial, initialCategory = '' }: { initial: FreeVideoCardData[]; initialCategory?: string }) {
  const [category, setCategory] = useState(initialCategory);
  const [items, setItems] = useState<FreeVideoCardData[]>(initial);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    capture('free_videos_page_view', { category: initialCategory || 'all', count: initial.length });
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const ctrl = new AbortController();
    setLoading(true);
    setFailed(false);
    getFreeVideos({ limit: PAGE_LIMIT, category: category || undefined }, ctrl.signal)
      .then((list) => { setItems(list); setLoading(false); })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        captureException(err, { surface: 'free_videos_page', category });
        setFailed(true);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [category]);

  const pick = (e: MouseEvent<HTMLAnchorElement>, cat: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    capture('free_videos_filter', { category: cat || 'all' });
    setCategory(cat);
    try { window.history.replaceState(null, '', hrefFor(cat)); } catch { /* history can be blocked; the filter still works */ }
  };

  return (
    <div className="fv-page-inner">
      <nav className="fv-chips" aria-label="Filter free videos by category">
        <a className={'fv-chip' + (category === '' ? ' fv-chip--on' : '')} href={hrefFor('')} aria-current={category === '' ? 'true' : undefined} onClick={(e) => pick(e, '')}>All</a>
        {FREE_VIDEO_CATEGORIES.map((c) => (
          <a key={c.key} className={'fv-chip' + (category === c.key ? ' fv-chip--on' : '')} href={hrefFor(c.key)} aria-current={category === c.key ? 'true' : undefined} onClick={(e) => pick(e, c.key)}>{c.label}</a>
        ))}
      </nav>

      {items.length > 0 && (
        <div className={'bn-grid fv-grid' + (loading ? ' fv-grid--loading' : '')} aria-busy={loading}>
          {items.map((v, i) => <FreeVideoCard key={v.id} v={v} surface="free_videos_page" position={i} />)}
        </div>
      )}
      {items.length === 0 && !loading && (
        <p className="fv-empty" role="status">
          {failed ? 'We couldn’t load the videos just now. Please try again in a moment.'
            : category ? 'No free videos in this category yet. Please check back soon.'
              : 'New free videos are coming soon. Please check back soon.'}
        </p>
      )}
    </div>
  );
}
