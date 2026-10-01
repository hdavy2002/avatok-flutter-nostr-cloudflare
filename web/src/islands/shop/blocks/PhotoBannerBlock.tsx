// [SAATHUM-SHOP-EDITOR-1 2026-10-01] A full-width photo with an optional heading, text and button — an extra block for the editor.
// Uses only the shop's existing look (.sh-* tokens); the three heights are classes in shop.css.
import { photo } from '../../../lib/shopUi';
import type { BlockCtx, PhotoBannerProps } from './types';
import { has, safeHref, t } from './util';

export default function PhotoBannerBlock(p: PhotoBannerProps & { ctx?: BlockCtx }) {
  const src = photo(p.image, 1600);
  const copy = has(p.heading) || has(p.text) || has(p.ctaLabel);
  return (
    <section className="sh-sec">
      <div className={`sh-photo sh-photo--${p.height === 'short' || p.height === 'tall' ? p.height : 'medium'}`}>
        {src
          ? <img className="sh-photo-img" src={src} alt={typeof p.heading === 'string' ? p.heading : ''} loading="lazy" decoding="async" />
          : <div className="sh-ph sh-photo-ph"><span>Banner photo</span></div>}
        {copy && (
          <div className="sh-photo-copy">
            {has(p.heading) && <h2>{t(p.heading)}</h2>}
            {has(p.text) && <p>{t(p.text)}</p>}
            {has(p.ctaLabel) && <div><a className="sh-btn sh-btn--red" href={safeHref(p.ctaHref)}>{t(p.ctaLabel)}</a></div>}
          </div>
        )}
      </div>
    </section>
  );
}
