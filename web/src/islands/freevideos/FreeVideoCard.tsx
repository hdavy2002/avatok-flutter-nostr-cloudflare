// [SAATHUM-FREEVIDEOS-WEB-1 2026-10-01] The Free video card — the SAME card frame as the event
// card (BookCard.tsx) so the site keeps one look: the bn-* classes come from
// ../home/BookNowShelf.css (imported by the callers). Owner rule: NO price, reviews, date,
// booked count or performer here — a free video is not an event.
//
// NOTE FOR AI:
//  - Badge: "Streaming live now" only when the API says the YouTube video is live right now
//    (is_live), otherwise "Free video".
//  - Click (card, art, title or button): signed in (Clerk session cookie hint) -> straight to
//    /watch/<id>?freewatch=1; signed out -> the email sign-in, which returns there and plays.
//    Same rule as freeWatchDest/goFreeWatch in ../home/BookCard.tsx. The href is the sign-in
//    URL so the card also works with JS off.
import type { MouseEvent } from 'react';
import { hasClerkSessionHint } from '../../lib/sessionHint';
import { FREE_WATCH_PARAM, signInUrlForFreeWatchPath } from '../../lib/authRedirect';
import { cfImage } from '../../lib/config';
import { capture } from '../../lib/analytics';
import type { FreeVideoCardData } from './api';

export const watchPath = (id: string): string => `/watch/${encodeURIComponent(id)}`;

/** Where a click on this card goes right now (browser only; the sign-in URL is the SSR default). */
function dest(id: string): string {
  return hasClerkSessionHint() ? `${watchPath(id)}?${FREE_WATCH_PARAM}=1` : signInUrlForFreeWatchPath(watchPath(id));
}

export function FreeVideoCard({ v, surface, position }: { v: FreeVideoCardData; surface: string; position?: number }) {
  const href = signInUrlForFreeWatchPath(watchPath(v.id));
  const go = (e: MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const target = e.target as Element | null;
    const onLink = Boolean(target?.closest('a'));
    // A click on the card body (not on a link) behaves like the button; links handle themselves below.
    if (!onLink) {
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    }
    capture('free_video_card_click', { id: v.id, surface, position });
    const to = dest(v.id);
    if (e.metaKey || e.ctrlKey || e.shiftKey) { if (!onLink) window.open(to, '_blank', 'noopener'); return; }
    e.preventDefault();
    window.location.assign(to);
  };
  const img = v.cover_url ? cfImage(v.cover_url, { width: 900 }) : null;
  return (
    <article className="bn-card bn-card--click fv-card" data-free-video-id={v.id} onClick={go}>
      <a className="bn-art bn-art--watch" href={href} tabIndex={-1} aria-hidden="true" onClick={go}>
        {img ? <img src={img} alt="" loading="lazy" decoding="async" /> : <span className="bn-art-empty" />}
        <span className="bn-top">
          <span className="bn-top-left">
            {v.is_live
              ? <span className="bn-pill bn-pill--live"><i />Streaming live now</span>
              : <span className="bn-type-badge fv-badge">Free video</span>}
          </span>
          <span className="bn-pill bn-pill--soft">{v.category_label}</span>
        </span>
      </a>
      <div className="bn-body">
        <h3 className="bn-title"><a href={href} onClick={go}>{v.title}</a></h3>
        {v.description && <p className="bn-desc">{v.description}</p>}
        <div className="fv-btns">
          <a className="bn-btn bn-btn--book" href={href} onClick={go}>Watch free <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </article>
  );
}
