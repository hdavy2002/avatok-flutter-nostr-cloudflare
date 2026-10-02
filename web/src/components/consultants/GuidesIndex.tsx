// [AUMFE-CONSULT-F1-1 2026-10-02] /guides — simple list of every guide (same sticker cards as the homepage band).
// ADMIN-PREVIEW ONLY while dark: an empty list from the worker shows the calm "Opening soon" state, no data.
import { useEffect, useState } from 'react';
import '../../styles/consultants.css';
import './consultant-pages.css';
import PreviewRibbon from '../PreviewRibbon';
import { usePreview } from '../../lib/preview';
import { capture, captureException } from '../../lib/analytics';
import type { ConsultantCard } from '../../lib/consultTypes';
import { fetchList } from './api';
import { roleLine, stars } from './format';
import { OpeningSoon } from './ConsultantPage';
import PriceChip from './PriceChip';
import Sticker from './Sticker';
import WithAuth from './WithAuth';

export default function GuidesIndex() {
  return <WithAuth><Index /></WithAuth>;
}

function Index() {
  const { preview } = usePreview();
  const [list, setList] = useState<ConsultantCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetchList().then((l) => { if (alive) { setList(l); capture('consult_index_viewed', { count: l.length }); } })
      .catch((e) => { captureException(e, { where: 'consult_index' }); if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [preview, attempt]);

  if (failed) {
    return (
      <div className="consult-ui cp-page"><div className="toran cp-toran" />
        <div className="cp-state"><h1>We could not load the guides</h1><p>Please check your connection and try again.</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>
        <div className="ribbon" /></div>
    );
  }
  if (list === null) return <div className="consult-ui cp-page"><div className="toran cp-toran" /><p className="cp-state" aria-busy="true">Loading…</p><div className="ribbon" /></div>;
  if (!list.length) return <OpeningSoon />;

  return (
    <div className="consult-ui cp-page">
      <div className="toran cp-toran" />
      {preview ? <div className="cp-previewbar"><PreviewRibbon force /></div> : null}
      <section className="cp-sec tint cp-index">
        <div className="sec-h"><span className="deva">मार्गदर्शक</span><h1>Talk to a real guide</h1>
          <p>Book time with real people who can guide you — one-to-one, on a private audio call.</p></div>
        <ul className="cp-index-grid">
          {list.map((c) => (
            <li key={c.slug} className="card cp-index-card">
              <a href={`/guides/${c.slug}`} onClick={() => capture('consult_index_clicked', { slug: c.slug })}>
                <Sticker src={c.photo_url} alt={c.name} size={144} />
                <span className="cp-band-name">{c.name}</span>
                <span className="cp-band-role">{roleLine(c)}</span>
                {c.rating_count > 0 && c.rating_avg != null ? <span className="cp-band-meta"><span className="stars" aria-hidden="true">{stars(c.rating_avg)}</span> {c.rating_avg.toFixed(1)} · {c.rating_count}</span> : null}
                <span className="cp-band-meta">{[c.years ? `${c.years} yrs` : null, c.languages.join(', ') || null].filter(Boolean).join(' · ')}</span>
                <PriceChip total={c.price.total} minutes={c.slot_minutes} className="cp-band-chip" />
              </a>
            </li>
          ))}
        </ul>
        <p className="cp-band-note">Prices are per {list[0].slot_minutes}-minute session, GST included.</p>
      </section>
      <div className="ribbon" />
    </div>
  );
}
