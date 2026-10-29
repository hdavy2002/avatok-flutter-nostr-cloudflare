/* [HF-INTRO-B1] "Influencer sign-up happens in our app" (HF-INTRO-22, spec D22). Design: Specs/hf-intro-screens/Web1Record.dc.html.
 * Shown by OnboardingGate while hfIntroOnboardingEnabled is on. The site header/footer come from the Astro page. */
import { useEffect, useState } from 'react';
import { HF_PLAY_URL } from '../../lib/hfApp';
import { isAndroidPhone, openAppIntentUrl, trackDownloadApp } from '../../lib/introAppOnly';

const STEPS = ['Download the app', 'Open Me → Become an influencer', 'Record your 10–20 second intro and send it for approval'];

export default function DownloadAppPanel() {
  const [android, setAndroid] = useState(false);
  useEffect(() => {
    try { setAndroid(isAndroidPhone(navigator.userAgent)); } catch { /* ignore */ }
    try { const f = document.getElementById('hia-footer'); if (f) f.hidden = false; } catch { /* ignore */ }
    trackDownloadApp('panel_view');
  }, []);
  return (
    <main className="hia" id="main-content">
      <div className="hia-wrap">
        <section className="hia-copy" aria-labelledby="hia-h">
          <p className="hia-eyebrow">BECOME AN INFLUENCER</p>
          <h1 id="hia-h">Influencer sign-up happens in our app</h1>
          <p className="hia-lead">You record a short live intro video with your phone&apos;s camera, so it&apos;s done in the app. It takes about 5 minutes.</p>
          <ol className="hia-steps">
            {STEPS.map((s, i) => <li key={s}><span className="hia-num" aria-hidden="true">{i + 1}</span><span>{s}</span></li>)}
          </ol>
          <div className="hia-stores">
            <a className="hia-play" href={HF_PLAY_URL} rel="noopener" data-hia="play" onClick={() => trackDownloadApp('play')}>
              <img src="/assets/hf-desi/btn-google-play.webp" alt="Get it on Google Play" width="420" height="125" />
            </a>
            <span className="hia-soon">App Store — coming soon</span>
          </div>
          {android && (
            <p className="hia-open">
              <a className="hia-open-btn" href={openAppIntentUrl()} data-hia="open_app" onClick={() => trackDownloadApp('open_app')}>Already have the app? Open the app</a>
            </p>
          )}
        </section>
        <div className="hia-phone" aria-hidden="true"><span className="hia-rec">● REC 0:12</span></div>
      </div>
    </main>
  );
}

/** [HF-VERIFY-WEB-FLOW] /hosts/onboarding for someone who is ALREADY an influencer (HF-INTRO-22: the site never runs the old step wizard).
 * Social accounts are managed on My verifications; everything else (profile, phone, video KYC) lives in the app. */
export function AlreadyHostPanel() {
  useEffect(() => {
    try { const f = document.getElementById('hia-footer'); if (f) f.hidden = false; } catch { /* ignore */ }
    trackDownloadApp('host_panel_view');
  }, []);
  return (
    <main className="hia" id="main-content">
      <div className="hia-wrap">
        <section className="hia-copy" aria-labelledby="hia-h">
          <p className="hia-eyebrow">YOU ARE ALREADY AN INFLUENCER</p>
          <h1 id="hia-h">Manage your account</h1>
          <p className="hia-lead">Connect or remove your YouTube, Instagram and Facebook on My verifications. Your profile, intro video and video KYC are done in the app.</p>
          <p className="hia-open"><a className="hia-open-btn" href="/dashboard/verifications" data-hia="verifications">Go to My verifications</a></p>
          <div className="hia-stores">
            <a className="hia-play" href={HF_PLAY_URL} rel="noopener" data-hia="play" onClick={() => trackDownloadApp('play')}>
              <img src="/assets/hf-desi/btn-google-play.webp" alt="Get it on Google Play" width="420" height="125" />
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
