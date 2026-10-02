// [AUMFE-CONSULT-F1-1 2026-10-02] Category hero: plain category colour, big round portrait (no garland / arch / pattern),
// discipline pill(s), name, blurb, rating/years/languages, and (desktop) the price + book card.
import type { CSSProperties } from 'react';
import type { ConsultantDetail, Discipline } from '../../lib/consultTypes';
import { catOf, type CategoryContent } from './categoryContent';
import { nextFreeLabel, rupees, stars } from './format';
import Sticker from './Sticker';

interface Props {
  c: ConsultantDetail;
  disc: Discipline;
  cat: CategoryContent;
  onDisc: (d: Discipline) => void;
  bookHref: string;
  onBook: () => void;
}

export default function CategoryHero({ c, disc, cat, onDisc, bookHref, onBook }: Props) {
  const blurb = c.tagline || c.bio || cat.fallbackBlurb;
  const multi = c.disciplines.length > 1;
  const sub = c.lineage
    ? (cat.key === 'astro' ? `Parampara: ${c.lineage}` : c.lineage)
    : (multi && (cat.key === 'palm' || cat.key === 'face') ? cat.fallbackSub : '');
  const nextFree = c.next_free_ms ? nextFreeLabel(c.next_free_ms) : null;
  return (
    <section className="hero-cat cp-hero" style={{ ['--hb' as string]: cat.heroBlurb, ['--hm' as string]: cat.heroMeta, ['--hs' as string]: cat.heroSub } as CSSProperties}>
      <div className="cp-hero-photo"><Sticker className="cp-portrait" src={c.photo_hero_url || c.photo_url} alt={c.name} eager /></div>
      <div className="cp-hero-text">
        {multi ? (
          <div className="cp-pills">
            {c.disciplines.map((d) => {
              const k = catOf(d);
              return d === disc
                ? <span key={d} className="sa-pill"><span className="deva">{k.deva}</span> {k.label}</span>
                : <a key={d} className="sa-pill cp-pill-off" href={`?d=${d}`} onClick={(e) => { e.preventDefault(); onDisc(d); }}><span className="deva">{k.deva}</span> {k.label}</a>;
            })}
          </div>
        ) : (
          <span className="sa-pill cp-pill-one"><span className="deva">{cat.deva}</span> {cat.label}</span>
        )}
        <h1>{c.name}</h1>
        <p className="cp-blurb">{blurb}</p>
        <div className="cp-meta">
          {c.rating_count > 0 && c.rating_avg != null
            ? <span><span className="cp-stars" aria-hidden="true">{stars(c.rating_avg)}</span> {c.rating_avg.toFixed(1)} · {c.rating_count}<span className="cp-d"> review{c.rating_count === 1 ? '' : 's'}</span></span>
            : null}
          {c.years ? <span>{c.years} years</span> : null}
          {c.languages.length ? <span>{c.languages.join(' · ')}</span> : null}
        </div>
        {sub ? <span className="cp-sub">{sub}</span> : null}
      </div>
      <div className="card frame cp-bookcard">
        <span className="label">{c.slot_minutes}-minute audio consultation</span>
        <div className="cp-price"><span>{rupees(c.price.total)}</span><span className="muted">incl. GST</span></div>
        {nextFree ? <span className="cp-nextfree">Next free: <strong>{nextFree}</strong></span> : <span className="cp-nextfree">No free time in the next few weeks.</span>}
        <a className="btn cat" href={bookHref} onClick={onBook} style={{ width: '100%' }}>{cat.bookLabel}</a>
        <span className="hint">{cat.cardHint}</span>
      </div>
    </section>
  );
}
