// [HF-HOME-DESI-1] Landing page script: CTA and section-view analytics (design_version 'desi-v1'), the sidebar / bottom-tab
// scroll-spy (highlights the section you are reading), pauses the hero loop while it is off-screen, and keeps the sticky
// sidebar and anchors clear of the sticky site header.
import { capture, initAnalytics } from './analytics';
import { initImageTelemetry } from './imageTelemetry';

initAnalytics();
initImageTelemetry();
const surface = 'home';
const design_version = 'desi-v1';

document.querySelectorAll<HTMLAnchorElement>('[data-home-cta]').forEach(link => {
  link.addEventListener('click', () => capture('cta_click', {
    surface, design_version, section: link.closest<HTMLElement>('[data-home-section]')?.dataset.homeSection,
    action: link.dataset.homeCta,
  }));
});

const header = document.querySelector<HTMLElement>('.cv-header');
const syncHead = () => {
  const h = header ? Math.ceil(header.getBoundingClientRect().height) : 96;
  document.documentElement.style.setProperty('--hfl-head', `${h}px`);
  document.documentElement.style.setProperty('--hfh-header-offset', `${h + 24}px`);
};
syncHead();
if (header && 'ResizeObserver' in window) new ResizeObserver(syncHead).observe(header);

if ('IntersectionObserver' in window) {
  const seen = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      capture('homepage_section_view', { surface, design_version, section: (entry.target as HTMLElement).dataset.homeSection });
      seen.unobserve(entry.target);
    }
  }, { threshold: 0.15 });
  document.querySelectorAll('[data-home-section]').forEach(section => seen.observe(section));

  const stage = document.querySelector<HTMLElement>('.hfs');
  if (stage) new IntersectionObserver(([e]) => stage.classList.toggle('is-paused', !e.isIntersecting), { threshold: 0.05 }).observe(stage);

  // Scroll-spy: the last section whose top has passed ~35% of the viewport is "current".
  const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-spy]')];
  const ids = [...new Set(links.map(a => a.dataset.spy!))];
  const targets = ids.map(id => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
  let ticking = false;
  const spy = () => {
    ticking = false;
    const line = innerHeight * 0.35;
    let cur = ids[0];
    for (const el of targets) if (el.getBoundingClientRect().top <= line) cur = el.id;
    for (const a of links) {
      const on = a.dataset.spy === cur;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    }
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
  spy();
}
document.addEventListener('visibilitychange', () => document.querySelector('.hfs')?.classList.toggle('is-paused', document.hidden));
document.documentElement.dataset.homepageReady = 'true';
