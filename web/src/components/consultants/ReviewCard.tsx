// [AUMFE-CONSULT-F1-1 2026-10-02] One review (name, stars, text, topic). Text is rendered as text, never HTML.
import { DISCIPLINE_LABEL, type ReviewDTO } from '../../lib/consultTypes';
import { stars } from './format';

export default function ReviewCard({ r }: { r: ReviewDTO }) {
  return (
    <div className="card cp-review">
      <div className="cp-review-top"><strong>{r.display_name}</strong><span className="stars" aria-label={`${r.stars} out of 5`}>{stars(r.stars)}</span></div>
      {r.text ? <p>{r.text}</p> : null}
      <span className="hint">{DISCIPLINE_LABEL[r.discipline]?.en ?? ''}</span>
    </div>
  );
}
