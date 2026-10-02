// [AUMFE-GUIDES-FRONT-1] Home "Talk to a guide" ad band — owner-approved mockups HomeAd (desktop) + HomeAdPhone.
//
// NOTE FOR AI:
//  - ADMIN-PREVIEW ONLY: renders NOTHING (no HTML at all) unless usePreview().guides === true. Customers and
//    signed-out visitors get an empty island mount that takes no space. Do not render static text server-side.
//  - Mounted with client:idle (owner speed rule: non-critical content hydrates late).
//  - Meera = the first astrology agent from GET /api/voice/agents; other subjects show "Coming soon" until the API returns them.
import { useRef } from 'react';
import PreviewRibbon from '../../components/PreviewRibbon';
import { usePreview } from '../../lib/preview';
import { isAstro, rupees, soonFor } from './api';
import { clicked, useGuides, useSeen } from './useGuides';
import './guides.css';

const MIC = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export default function HomeGuidesAd() {
  const { guides, preview } = usePreview();
  const data = useGuides(guides);
  const ref = useRef<HTMLElement>(null);
  useSeen(ref, 'home', guides);
  if (!guides) return null;

  const agents = data?.agents ?? [];
  const meera = agents.find(isAstro) ?? agents[0];
  const name = meera?.name ?? 'Meera';
  const price = meera?.price ?? data?.price ?? null;
  const priceLine = price != null ? `${rupees(price)} a minute from your wallet` : 'Paid by the minute from your wallet';
  const talkHref = '/talk?guide=' + encodeURIComponent(meera?.id ?? 'astrology');

  return (
    <section ref={ref} className="gd-home" aria-labelledby="gd-home-title" data-home-section="guides-ad">
      <div className="gd-inner">
        <div className="gd-ribbon"><PreviewRibbon force={preview} /></div>
        <div className="gd-card">
          <div className="gd-left">
            <div className="gd-eyebrow">New · Talk to a guide</div>
            <h2 id="gd-home-title">Your kundli, explained in your language. Just talk.</h2>
            <p className="gd-lead gd-lead-phone">Speak with {name}, our AI astrology guide. She reads your chart and remembers you next time.</p>
            <p className="gd-lead gd-lead-desk">Speak with {name}, our AI astrology guide, in Hindi, English or Hinglish. She reads your chart, remembers you next time, and tells you what tradition suggests.</p>
            <div className="gd-actions">
              <a className="gd-cta" href={talkHref} onClick={() => clicked('home', 'talk_' + (meera?.id ?? 'astrology'))}>{MIC}Talk to {name}</a>
              <a className="gd-all" href="/marketplace#guides" onClick={() => clicked('home', 'see_all')}>See all guides</a>
            </div>
            <div className="gd-price">
              <span className="gd-price-phone">{priceLine} · guidance only</span>
              <span className="gd-price-desk">{priceLine} · AI guide · guidance only, no guaranteed outcomes</span>
            </div>
          </div>
          <div className="gd-right">
            <div className="gd-feature">
              <div className="gd-avatar" aria-hidden="true">{meera?.initial ?? 'M'}</div>
              <div>
                <div className="gd-feature-name">{name} · Astrology</div>
                <div className="gd-feature-sub">Hindi · English · Hinglish</div>
                <div className="gd-quote">“Namaste ji. Tell me your date, time and place of birth, and we will look at your chart together.”</div>
              </div>
            </div>
            <div className="gd-soon-grid">
              {soonFor(agents).map((s) => (
                <div className="gd-soon-tile" key={s.subject}>
                  <div className="gd-dot" style={{ background: s.tint }} aria-hidden="true">{s.initial}</div>
                  <div><div className="gd-soon-name">{s.subject}</div><div className="gd-soon-tag">Coming soon</div></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
