// [MEERA-HOME-DESIGN] Static haveli-inspired homepage ad; never a live conversation UI.
// ADMIN-PREVIEW ONLY: no HTML or data fetch until usePreview().guides is true.
// Keep the parent client:idle mount and the existing guide impression/click telemetry.
import { useEffect, useRef, useState } from 'react';
import { ClerkSessionBridge } from '../../lib/clerk';
import { hasClerkSessionHint } from '../../lib/sessionHint';
import PreviewRibbon from '../../components/PreviewRibbon';
import { usePreview } from '../../lib/preview';
import { ARTWORK_QUALITY, publicImage, publicImageSrcSet } from '../../lib/config';
import { isAstro, rupees, soonFor } from './api';
import { clicked, useGuides, useSeen } from './useGuides';
import './home-guides-ad.css';

const ASSETS = '/assets/meera-home/';
const PORTRAIT = `${ASSETS}meera-jharokha.png`;
const PORTRAIT_OPTIONS = { quality: ARTWORK_QUALITY, fit: 'scale-down' };
const MIC = <svg width="22" height="26" viewBox="0 0 24 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="8" y="2" width="8" height="15" rx="4" /><path d="M4 12v2a8 8 0 0 0 16 0v-2M12 22v4m-4 0h8" /></svg>;
const WAVE_HEIGHTS = [6, 11, 18, 26, 16, 32, 23, 39, 24, 16, 31, 21, 10, 5, 12, 22, 30, 19, 36, 43, 29, 20, 14, 27, 35, 21, 12, 18, 10, 8, 16, 24, 36, 23, 17, 27, 18, 12, 9, 5];

function Lotus() {
  return (
    <svg className="mg-lotus" viewBox="0 0 48 36" fill="none" aria-hidden="true">
      <path d="M24 3c-8 9-9 17 0 24 9-7 8-15 0-24Z" fill="currentColor" />
      <path d="M8 9c0 12 4 18 15 20C22 18 17 12 8 9Zm32 0c0 12-4 18-15 20 1-11 6-17 15-20ZM2 22c4 8 11 11 21 9-7-6-13-8-21-9Zm44 0c-4 8-11 11-21 9 7-6 13-8 21-9Z" fill="currentColor" />
      <path d="M12 34h24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function HomeGuidesAd() {
  const [withClerk, setWithClerk] = useState(false);
  useEffect(() => { setWithClerk(hasClerkSessionHint()); }, []);
  // Own auth readiness instead of depending on Preeti's independent hydration.
  // The shared bridge de-duplicates its provider with the other homepage islands.
  return <>{withClerk && <ClerkSessionBridge />}<HomeGuidesContent /></>;
}

function HomeGuidesContent() {
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
  const upcoming = soonFor(agents);

  return (
    <section ref={ref} className="mg-home" aria-labelledby="mg-home-title" data-home-section="guides-ad">
      <div className="mg-inner">
        <div className="mg-preview"><PreviewRibbon force={preview} /></div>
        <div className="mg-frame">
          <div className="mg-floral-border" aria-hidden="true" />
          <div className="mg-content">
            <div className="mg-main">
              <div className="mg-copy">
                <div className="mg-eyebrow"><span>Talk to a guide</span><span className="mg-rule" /><Lotus /></div>
                <h2 id="mg-home-title">A little clarity.<span>A conversation away.</span></h2>
                <p className="mg-intro">Meet {name}, your AI guide. Explore your birth chart through a conversation in Hindi, English or Hinglish.</p>
                <div className="mg-actions">
                  <a className="mg-cta" href={talkHref} onClick={() => clicked('home', 'talk_' + (meera?.id ?? 'astrology'))}>{MIC}Talk to {name}</a>
                  <a className="mg-all" href="/marketplace#guides" onClick={() => clicked('home', 'see_all')}>See all guides <span aria-hidden="true">→</span></a>
                </div>
                <p className="mg-price">{priceLine}</p>
                <p className="mg-guidance-note">AI guidance · No guaranteed outcomes</p>
              </div>
              <div className="mg-visual">
                <img className="mg-portrait" src={publicImage(PORTRAIT, { ...PORTRAIT_OPTIONS, width: 900 })} srcSet={publicImageSrcSet(PORTRAIT, [420, 640, 900, 1200], PORTRAIT_OPTIONS)} sizes="(max-width: 760px) calc(100vw - 56px), (max-width: 1340px) 43vw, 580px" width="1254" height="1254" alt={`${name}, your AI guide, in a carved Indian jharokha window`} loading="lazy" decoding="async" />
                <div className="mg-example" role="group" aria-label="Example conversation">
                  <div className="mg-example-top"><div><p className="mg-name">{name}</p><p className="mg-role">Your AI guide</p></div><span className="mg-example-label">Example conversation</span></div>
                  <svg className="mg-waveform" viewBox="0 0 292 46" fill="none" aria-hidden="true">
                    {WAVE_HEIGHTS.map((height, i) => <path key={i} d={`M${9 + i * 7} ${(46 - height) / 2}v${height}`} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />)}
                  </svg>
                  <p className="mg-quote">“Namaste. Let’s explore your chart together.”</p>
                </div>
              </div>
            </div>
            {upcoming.length > 0 && <div className="mg-more">
              <div className="mg-divider" aria-hidden="true"><span /><Lotus /><span /></div>
              <h3>More ways to find guidance</h3>
              <div className="mg-guides-grid">
                {upcoming.map((guide) => (
                  <div className={`mg-guide mg-guide-${guide.subject.toLowerCase()}`} key={guide.subject}>
                    <img className="mg-guide-art" src={`${ASSETS}${guide.subject.toLowerCase()}.svg`} width="120" height="120" alt="" loading="lazy" decoding="async" />
                    <div className="mg-guide-copy"><h4>{guide.subject}</h4><p>Coming soon</p></div>
                  </div>
                ))}
              </div>
            </div>}
          </div>
          <div className="mg-floral-border mg-floral-border-bottom" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
