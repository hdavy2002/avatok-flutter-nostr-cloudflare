/* [HF-HOME-DESI-1] The landing page, laid out like the customer dashboard (owner 2026-10-16: "a completely new layout — keep the
 * same sections and themes as the user dashboard"). Rendered to static HTML by Astro (no client JS); the live bits are separate
 * islands passed in as slots: <LiveCreators> (real hosts from /api/hosts/public) and <EarnCalc> (earnings estimate).
 * Shell = the dashboard's: sidebar (sections of this page) on wide screens, icon rail on tablets, bottom tabs on phones.
 * Everything is inside .hf3 so it uses styles/hf-dash3.css; landing-only bits (hero animation .hfs, sidebar offset) are in hf-landing.css. */
import type { ReactNode } from 'react';
import { BRAND } from '../../lib/brand';
import { Card, FlowerCluster, Hibiscus, Ic, Jasmine, Lotus, Marigold, Mogra, Sticker } from '../dashboard-hf/v3/ui';

const NAV: [string, string, string][] = [
  ['top', 'Home', 'home'], ['people', 'Creators', 'heart'], ['how-it-works', 'How it works', 'phone'], ['safety', 'Your privacy', 'shield'],
  ['pricing', 'Pricing', 'wallet'], ['spaces', 'Safe spaces', 'user'], ['earn', 'For creators', 'star'], ['faq', 'Questions', 'help'],
];
const BOTTOM: [string, string, string][] = [['top', 'Home', 'home'], ['people', 'Creators', 'heart'], ['how-it-works', 'How', 'phone'], ['safety', 'Safety', 'shield'], ['earn', 'Earn', 'star']];
export const HEADLINES = [
  'Ab sirf like nahi — seedhi baat 📞',
  'Number hidden on both sides 🔒',
  'Ringing, missed or declined? ₹0 💸',
  'Pay by the second, only for connected time ⏱️',
  'Press # to end, block and report 🛡️',
  'Creators keep 60% of every connected call 💰',
];
export const FAQ: [string, string][] = [
  ['Do I need the creator’s number?', `No. ${BRAND.name} rings the creator first. If they accept, we ring you and join the two calls. Both calls come from a ${BRAND.name} number, so neither of you sees the other’s personal number.`],
  ['How much does a call cost?', 'Each creator sets their own per-minute price, shown on their profile before you call. You pay by the second, only for connected time. Ringing, declined, missed or failed calls cost ₹0. You need at least 2 minutes of balance to start.'],
  ['How do I add money?', 'Add any whole amount to your wallet with UPI, card or netbanking. Top-ups include 18% GST, and unused top-up money can be refunded to your original payment within 180 days.'],
  ['Can I book a time instead?', 'Yes. Pick a free slot on a creator’s profile. The amount is held from your wallet until the call, and you get a WhatsApp reminder about an hour and again about 10 minutes before.'],
  ['What if someone makes me uncomfortable?', 'Press # during the call to end it, block the person and report it. Calls are not recorded. Our team reviews every report.'],
];
const REELS: [string, string, string, string][] = [
  ['chai', '@chai_pe_charcha', 'Monsoon + adrak chai = 💯', 'r1'],
  ['kachori', '@kachori_king', 'Best kachori in Jaipur? 🤤', 'r2'],
  ['girlboss', '@desi_diva', 'Sunday GRWM, desi style ✨', 'r3'],
  ['auto', '@auto_wala_comedy', 'Bhaiya, meter se chalo 😂', 'r4'],
];
const st = (n: string) => `/hf/stickers/${n}.webp`;

/** The hero animation: phone scrolls short videos → heart → creator card pops out → call connects, numbers hidden (CSS in hf-landing.css). */
function HeroStage() {
  return <div className="hfs" role="img" aria-label="Illustration: a phone scrolls short videos, a heart is tapped, the creator's card pops out, and a private call connects with both numbers hidden.">
    <div className="hfs-glow" aria-hidden="true" />
    <span className="hfs-f hfs-f1"><Marigold size={84} /></span><span className="hfs-f hfs-f2"><Lotus size={100} /></span>
    <span className="hfs-f hfs-f3"><Hibiscus size={52} /></span><span className="hfs-f hfs-f4"><Marigold size={48} tone={1} /></span>
    <span className="hfs-f hfs-f5"><Jasmine size={26} /></span>
    <img className="hfs-stk hfs-stk1" src={st('kyabaat')} alt="" width={120} height={120} />
    <div className="hfs-phone" aria-hidden="true"><div className="hfs-screen">
      <div className="hfs-feed">{REELS.map(([s, handle, cap, cls]) => <div key={cls} className={`hfs-reel ${cls}`}><img src={st(s)} alt="" width={220} height={220} /><div className="hfs-cap"><b>{handle}</b><span>{cap}</span></div></div>)}</div>
      <div className="hfs-top"><span>Reels</span><span className="hfs-dot" /></div>
      <div className="hfs-rail">
        <span className="hfs-ic hfs-heart"><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.5 5c2 0 3.4 1.1 4.1 2.4h2.8C14.1 6.1 15.5 5 17.5 5 21 5 23 8.6 21.6 11.8 19.5 16.4 12 21 12 21Z" /></svg></span>
        <span className="hfs-ic"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4Z" /></svg></span>
        <span className="hfs-ic"><svg viewBox="0 0 24 24"><path d="M4 12 20 4l-5 16-3-7Z" /></svg></span>
      </div>
      <div className="hfs-burst"><i /><i /><i /><i /><i /></div>
      <span className="hfs-tap hfs-tap1" />
      <div className="hfs-hint">Ab sirf like nahi…</div>
    </div></div>
    <div className="hfs-card" aria-hidden="true">
      <div className="hfs-card-top"><span className="hfs-av"><img src={st('girlboss')} alt="" width={64} height={64} /></span><div><b>@desi_diva</b><span className="hfs-pill"><i />Online</span></div></div>
      <p>Fashion, college life &amp; filmy gossip</p>
      <span className="hfs-call">📞 Call · ₹10/min<span className="hfs-tap hfs-tap2" /></span>
      <span className="hfs-book">Book a time</span>
    </div>
    <div className="hfs-oncall" aria-hidden="true">
      <span className="hfs-ring"><img src={st('girlboss')} alt="" width={72} height={72} /></span>
      <b>@desi_diva</b>
      <span className="hfs-state"><span className="hfs-s1">Ringing…</span><span className="hfs-s2">Connected · seedhi baat ✨</span></span>
      <span className="hfs-wave"><i /><i /><i /><i /><i /><i /><i /></span>
      <span className="hfs-lock">🔒 Both numbers hidden</span>
    </div>
    <span className="hfs-note">Illustration</span>
  </div>;
}

export default function DesiLanding({ creators, calc }: { creators?: ReactNode; calc?: ReactNode }) {
  const name = BRAND.name;
  const nav = <nav className="h3-nav" aria-label="On this page">
    <div className="h3-group"><Marigold size={14} tone={1} />Is page par</div>
    {NAV.map(([id, label, icon]) => <a key={id} className={`h3-item${id === 'top' ? ' on' : ''}`} href={`#${id}`} data-spy={id} aria-label={label}><Ic name={icon} /><span className="lbl">{label}</span></a>)}
    <div className="h3-sidecard">
      <b style={{ fontFamily: 'var(--head)', fontSize: 16 }}>Got followers?</b><br />
      <span>Apni baatein, apni kamaai. Verify once and take paid calls.</span><br />
      <a className="h3-btn sm gold" style={{ marginTop: 10 }} href="/hosts/join" data-home-cta="sidebar-join">Shuru karo →</a>
      <Sticker name="girlboss" w={70} rot={8} />
    </div>
    <Mogra n={9} />
    <div className="small muted" style={{ textAlign: 'center', padding: '0 8px' }}>Feeling low? Tele-MANAS <b>14416</b> · free, 24×7</div>
  </nav>;

  return <div className="hf3 hfl3">
    <div className="h3-shell">
      <aside className="h3-side">{nav}</aside>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <main className="h3-main" id="main-content">
          <span id="top" className="hfl3-anchor" aria-hidden="true" />
          <div className="hfl3-top" data-home-section="hero">
            <section className="h3-hero hfl3-hero" aria-labelledby="hero-title">
              <FlowerCluster />
              <div className="text">
                <div className="hello">Reels se real baat tak 🙏</div>
                <h1 id="hero-title" style={{ marginTop: 6 }}>Your favourite creators. <em>One conversation away.</em></h1>
                <p className="take">Love their <b>Reels</b> and <b>Shorts</b>? Go beyond likes and comments. Book a <b>private, one-on-one call</b> with the creators you follow, and enjoy a real conversation.</p>
                <div className="acts">
                  <a className="h3-btn rani" href="/marketplace" data-home-cta="explore-hosts"><Ic name="search" className="" />Find a creator</a>
                  <a className="h3-btn ghost" href="/hosts/join" data-home-cta="become-host"><Ic name="star" className="" />I’m a creator</a>
                </div>
                <ul className="hfl3-proof" aria-label="Call safeguards">
                  <li><Ic name="shield" className="" />Video-KYC verified creators</li>
                  <li><Ic name="phone" className="" />Number hidden, both sides</li>
                  <li><Ic name="clock" className="" />Pay by the second</li>
                </ul>
              </div>
            </section>
            <section className="h3-card hfl3-stage" aria-label="How a call starts"><HeroStage /></section>
          </div>

          <div className="h3-ticker" role="region" aria-label="Headlines" data-home-section="ticker">
            <div className="tag"><i />Breaking</div>
            <div className="lane"><div className="run">{[0, 1].map(k => HEADLINES.map(t => <span key={`${k}${t}`} aria-hidden={k === 1 ? true : undefined}>{t}</span>))}</div></div>
          </div>

          <section className="h3-kpis" id="pricing" aria-label="Pricing at a glance" data-home-section="pricing">
            <div className="h3-card h3-kpi k1"><div className="ic"><Ic name="wallet" className="" /></div><div className="lbl">If it doesn’t connect</div><div className="big num">₹0</div><div className="sub">Ringing, declined, missed or failed</div></div>
            <div className="h3-card h3-kpi"><div className="ic" style={{ background: 'var(--blush)', color: 'var(--rani)' }}><Ic name="clock" className="" /></div><div className="lbl">Billed by the</div><div className="big num">second</div><div className="sub">Only connected time, at their rate</div></div>
            <div className="h3-card h3-kpi"><div className="ic" style={{ background: 'var(--lavtint)', color: 'var(--lav)' }}><Ic name="phone" className="" /></div><div className="lbl">Numbers shared</div><div className="big num">0</div><div className="sub">Both sides stay hidden</div></div>
            <div className="h3-card h3-kpi"><div className="ic" style={{ background: 'var(--goldtint)', color: 'var(--amber)' }}><Ic name="down" className="" /></div><div className="lbl">Refund window</div><div className="big num">180 d</div><div className="sub">Unused top-ups · incl. 18% GST</div></div>
            <div className="h3-card h3-kpi"><div className="ic" style={{ background: 'var(--teatint)', color: 'var(--peacock)' }}><Ic name="money" className="" /></div><div className="lbl">Creators keep</div><div className="big num">60%</div><div className="sub">minus ₹2 per connected minute</div></div>
          </section>

          <section className="h3-row c21">
            <Card id="people" title="Creators you can talk to" note="Real, verified creators · a rose dot means they’re free right now" link={{ label: 'See everyone', href: '/marketplace' }}>
              <span id="moods" className="hfl3-anchor" aria-hidden="true" /><span id="naye-dost" className="hfl3-anchor" aria-hidden="true" />
              <div data-home-section="creators">{creators}</div>
            </Card>
            <Card id="how-it-works" title="Scroll kam, baat zyada" note="From scrolling to a real conversation" tone={1}>
              <ol className="h3-steps hfl3-steps" data-home-section="how-it-works">
                <li className="h3-step done"><div className="n">1</div><div><b>Find who you love</b><div className="small muted">The creator from your favourite Reels and Shorts? Search for them here, or discover someone new.</div></div></li>
                <li className="h3-step cur"><div className="n">2</div><div><b>Call now or book a time</b><div className="small muted">Online? Tap Call. Busy? Book a slot, or tap Notify me and we’ll WhatsApp you once they’re free.</div></div></li>
                <li className="h3-step"><div className="n">3</div><div><b>Talk, privately</b><div className="small muted">We ring them first. If they accept, we ring you and join the calls. You pay their rate, by the second.</div></div></li>
              </ol>
              <div style={{ textAlign: 'center', marginTop: 10 }}><Sticker name="pco" w={110} rot={-4} /></div>
            </Card>
          </section>

          <section className="h3-row c12">
            <Card id="safety" title="Your number stays yours." note="Baat private, number private">
              <div data-home-section="privacy">
                <p id="privacy-note">We ring the creator first. If they accept, we ring you and join the two calls. Both calls come from a {name} number, so neither person ever sees the other’s personal number.</p>
                <figure className="hfl3-bridge" aria-label={`You and the creator connect through ${name}. Both personal numbers stay private.`}>
                  <div className="node"><Sticker name="yaari" w={84} rot={-4} /><b>You</b><small>+91 ●●●●● ●●●●●</small></div>
                  <div className="wire" aria-hidden="true"><i /></div>
                  <div className="hub"><Lotus size={58} /><b>{name}</b><small>connects</small></div>
                  <div className="wire" aria-hidden="true"><i /></div>
                  <div className="node"><Sticker name="girlboss" w={84} rot={4} /><b>Creator</b><small>+91 ●●●●● ●●●●●</small></div>
                  <figcaption>Two private calls. One conversation.</figcaption>
                </figure>
                <aside className="h3-safe" style={{ marginTop: 14 }}><div><h3>Safety, built in</h3>
                  <ul><li>Calls are never recorded</li><li>Press # to end, block and report</li><li>Aadhaar + selfie-video checked creators</li></ul></div>
                  <a className="h3-btn sm ghost" href="/talk-safely">How to talk safely</a></aside>
              </div>
            </Card>
            <Card id="earn" title="Kitna kamaoge?" note="For the people behind the posts · move the sliders" tone={1} link={{ label: 'Rules for creators', href: '/hosts/rules' }}>
              <div data-home-section="host-cta">
                <p className="muted" style={{ marginBottom: 12 }}>Make Reels, Shorts or videos? Set your own per-minute price, choose your hours and decline any call. Paid to your own UPI or bank: minimum ₹500, 7 days after the call.</p>
                {calc}
                <div className="acts hfl3-acts"><a className="h3-btn rani" href="/hosts/join" data-home-cta="apply-host"><Ic name="star" className="" />Become a creator on {name}</a></div>
                <div className="hfl3-share"><span className="small muted">Your personal page</span><b>{`${BRAND.domain}/`}<wbr />yourname</b></div>
              </div>
            </Card>
          </section>

          <section className="h3-row c2" id="spaces" data-home-section="lanes">
            <section className="h3-card hfl3-lane women" id="women-only" aria-labelledby="women-title">
              <Sticker name="girlboss" w={110} rot={-6} />
              <div><div className="hfl3-eyebrow">Comfort in shared experiences</div><h2 id="women-title">Women talking to women</h2>
                <p className="muted">A private space for women to talk with verified women creators.</p>
                <span className="h3-chip" aria-describedby="community-eligibility">🛡️ Video KYC required</span>
                <div className="acts hfl3-acts"><a className="h3-btn rani" href="/marketplace?lane=women#people" data-home-cta="women-hosts">Explore women creators →</a></div></div>
            </section>
            <section className="h3-card hfl3-lane lgbtq" id="lgbtq" aria-labelledby="lgbtq-title">
              <Sticker name="peace" w={110} rot={6} />
              <div><div className="hfl3-eyebrow">Come as you are</div><h2 id="lgbtq-title">Connect within the LGBTQ+ community</h2>
                <p className="muted">A respectful space for LGBTQ+ fans to talk with creators from the community.</p>
                <span className="h3-chip" aria-describedby="community-eligibility">🛡️ Video KYC required</span>
                <div className="acts hfl3-acts"><a className="h3-btn" href="/marketplace?lane=lgbtq#people" data-home-cta="lgbtq-hosts">Explore LGBTQ+ creators →</a></div></div>
            </section>
          </section>
          <p className="sr-only" id="community-eligibility">Video KYC verifies the person, not their gender or sexual orientation. Community access follows each space’s eligibility and safety rules.</p>

          <section className="h3-row c21">
            <Card id="faq" title="Sawaal-jawaab" note="Questions, answered" link={{ label: 'Help Center', href: '/help' }}>
              <div className="h3-faq" data-home-section="faq">{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
            </Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <section className="h3-hero hfl3-final" aria-labelledby="final-title" data-home-section="final-cta">
                <div className="text" style={{ maxWidth: '100%' }}>
                  <div className="hello">Only on {name}</div>
                  <h2 id="final-title">Watch what you love. <em>Talk to who you love.</em></h2>
                  <div className="acts"><a className="h3-btn rani" href="/marketplace" data-home-cta="final-explore">Find a creator →</a><a className="h3-btn ghost" href="/hosts/join" data-home-cta="final-join">Join as a creator</a></div>
                </div>
                <div className="hfl3-final-art"><Sticker name="chai" w={120} rot={-8} wiggle /></div>
              </section>
              <section className="h3-safe"><div style={{ flex: 1, minWidth: '14rem' }}><h3>Feeling low?</h3>
                <p className="small" style={{ marginTop: 4 }}>{name} is a friendly chat for adults (18+), not counselling. Tele-MANAS is free, confidential and open 24×7: call <b>14416</b>.</p></div>
                <Sticker name="mohmaya" w={80} rot={-6} /></section>
            </div>
          </section>
        </main>
        <nav className="h3-bottom" aria-label="Quick navigation">{BOTTOM.map(([id, l, i]) => <a key={id} href={`#${id}`} data-spy={id} className={id === 'top' ? 'on' : ''}><Ic name={i} className="" />{l}</a>)}</nav>
      </div>
    </div>
  </div>;
}
