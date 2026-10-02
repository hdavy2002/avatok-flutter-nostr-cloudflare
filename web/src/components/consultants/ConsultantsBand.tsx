// [AUMFE-CONSULT-F1-1 2026-10-02] Homepage "Talk to a real guide" band (Main.dc.html desktop / HomeMobile.dc.html mobile).
// ADMIN-PREVIEW ONLY: renders NOTHING unless the list API returns consultants — the worker returns an empty list to
// everyone but previewers while `consultantsEnabled` is off. Mounted with client:idle, one line under HomeGuidesAd.
// NOTE FOR AI: no HTML is shown (and no PostHog band event fires) while the list is empty.
import { useEffect, useRef, useState } from 'react';
import '../../styles/consultants.css';
import './consultant-pages.css';
import PreviewRibbon from '../PreviewRibbon';
import { usePreview } from '../../lib/preview';
import { capture, captureException } from '../../lib/analytics';
import type { ConsultantCard } from '../../lib/consultTypes';
import { fetchList } from './api';
import { roleLine } from './format';
import PriceChip from './PriceChip';
import Sticker from './Sticker';
import WithAuth from './WithAuth';

export default function ConsultantsBand() {
  return <WithAuth><Band /></WithAuth>;
}

function Band() {
  const { preview } = usePreview();
  const [list, setList] = useState<ConsultantCard[]>([]);
  const ref = useRef<HTMLElement>(null);
  const seen = useRef(false);

  useEffect(() => {
    let alive = true;
    fetchList().then((l) => { if (alive) setList(l); }).catch((e) => captureException(e, { where: 'consult_band' }));
    return () => { alive = false; };
  }, [preview]); // a previewer's sign-in resolving later re-asks with the token

  useEffect(() => {
    const el = ref.current;
    if (!el || seen.current || !list.length) return;
    const fire = () => { if (!seen.current) { seen.current = true; capture('consult_band_viewed', { count: list.length }); } };
    if (typeof IntersectionObserver === 'undefined') { fire(); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { fire(); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  if (!list.length) return null;
  const minutes = list[0].slot_minutes;

  return (
    <section ref={ref} className="consult-ui cp-band-wrap" aria-labelledby="cp-band-title" data-home-section="consultants-band">
      <div className="ribbon cp-band-topribbon" />
      <div className="band cp-band">
        {preview ? <div className="cp-previewbar"><PreviewRibbon force /></div> : null}
        <div className="cp-band-inner">
          <div className="cp-band-head">
            <h2 id="cp-band-title" className="caps">Talk to a<br className="cp-d" /> real guide</h2>
            <p>
              <span className="cp-d">Book time with real people who can guide you — one-to-one, on a private audio call.</span>
              <span className="cp-m">Book time with real people who can guide you — a private one-to-one audio call.</span>
            </p>
            <a className="cp-band-all cp-d" href="/guides" onClick={() => capture('consult_band_clicked', { target: 'see_all' })}>See all guides →</a>
          </div>
          <ol className="cp-band-list">
            {list.map((c) => (
              <li key={c.slug}>
                <a href={`/guides/${c.slug}`} onClick={() => capture('consult_band_clicked', { target: c.slug })}>
                  <Sticker src={c.photo_url} alt={c.name} size={168} />
                  <span className="cp-band-name">{c.name}</span>
                  <span className="cp-band-role">{roleLine(c)}</span>
                  {(c.years || c.languages.length) ? <span className="cp-band-meta cp-d">{[c.years ? `${c.years} yrs` : null, c.languages.join(', ') || null].filter(Boolean).join(' · ')}</span> : null}
                  <PriceChip total={c.price.total} minutes={c.slot_minutes} className="cp-band-chip" />
                </a>
              </li>
            ))}
          </ol>
          <p className="cp-band-note cp-m">Prices are per {minutes}-minute session, GST included.</p>
          <a className="btn ghost cp-band-btn cp-m" href="/guides" onClick={() => capture('consult_band_clicked', { target: 'see_all' })}>See all guides</a>
        </div>
      </div>
      <div className="ribbon" />
    </section>
  );
}
