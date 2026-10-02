// [AUMFE-CONSULT-F1-1 2026-10-02] "Other guides" row — one tile per (consultant, discipline) from the list API,
// excluding the page being viewed. Links to /guides/<slug>?d=<discipline> (no ?d for the consultant's first discipline).
import type { ConsultantCard, Discipline } from '../../lib/consultTypes';
import { OTHER_LABEL, OTHER_SHORT } from './categoryContent';
import Sticker from './Sticker';

export function guideHref(slug: string, first: Discipline, d: Discipline): string {
  return d === first ? `/guides/${slug}` : `/guides/${slug}?d=${d}`;
}

export default function OtherGuides({ list, slug, disc }: { list: ConsultantCard[]; slug: string; disc: Discipline }) {
  const tiles = list.flatMap((c) => c.disciplines.map((d) => ({ c, d }))).filter(({ c, d }) => !(c.slug === slug && d === disc));
  if (!tiles.length) return null;
  return (
    <section className="cp-sec cp-other" aria-labelledby="cp-other-h">
      <div className="sec-h cp-other-h"><span className="deva">अन्य मार्गदर्शक</span><h2 id="cp-other-h">Other guides</h2></div>
      <div className="cp-other-grid">
        {tiles.map(({ c, d }) => (
          <a key={`${c.slug}:${d}`} className="mini-guide cp-mini" href={guideHref(c.slug, c.disciplines[0], d)}>
            <Sticker src={c.photo_url} alt="" size={120} />
            <strong className="cp-d">{c.name}</strong>
            <span className="cp-d">{OTHER_LABEL[d]}</span>
            <strong className="cp-m">{OTHER_SHORT[d]}</strong>
          </a>
        ))}
      </div>
    </section>
  );
}
