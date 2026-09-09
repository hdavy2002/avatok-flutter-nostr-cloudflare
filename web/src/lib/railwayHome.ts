// [WEB-RAILWAY-1] Lightweight progressive enhancement; no scroll hijacking.
import { capture } from './analytics';

const home = document.querySelector<HTMLElement>('.rail-home');
const hero = document.querySelector<HTMLElement>('[data-rail-hero]');
const train = document.querySelector<HTMLElement>('[data-rail-train]');
const toggle = document.querySelector<HTMLButtonElement>('[data-motion-toggle]');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let paused = reduced.matches;
let visible = true;
let frame = 0;
let active = 0;
let manualStop = false;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-stop-button]'));

function selectStop(index: number, source: 'scroll' | 'button') {
  if (index === active && source !== 'button') return;
  active = index;
  buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  document.querySelectorAll<HTMLElement>('[data-rail-stop], [data-rail-window]').forEach((el) => {
    const number = el.dataset.railStop ?? el.dataset.railWindow;
    el.classList.toggle('is-active', Number(number) === index);
  });
  if (source === 'button') capture('homepage_hero_stop', { design: 'railway-2026-09', stop: index + 1 });
}

function update() {
  frame = 0;
  if (!hero || !train || paused || !visible) return;
  const rect = hero.getBoundingClientRect();
  const progress = Math.max(0, Math.min(1, -rect.top / Math.max(1, rect.height * .62)));
  train.style.setProperty('--rail-shift', (progress * -24).toFixed(1) + 'px');
  if (!manualStop) selectStop(Math.min(2, Math.floor(progress * 3)), 'scroll');
}

function requestUpdate() {
  if (!frame && !paused && visible) frame = window.requestAnimationFrame(update);
}

function syncMotion() {
  home?.toggleAttribute('data-motion-paused', paused);
  if (toggle) {
    toggle.hidden = false;
    toggle.textContent = paused ? 'Play animation' : 'Pause animation';
    toggle.setAttribute('aria-pressed', String(paused));
  }
  if (!paused) requestUpdate();
}

buttons.forEach((button, index) => button.addEventListener('click', () => {
  manualStop = true;
  selectStop(index, 'button');
}));
toggle?.addEventListener('click', () => {
  paused = !paused;
  syncMotion();
  capture('homepage_motion_toggle', { design: 'railway-2026-09', paused, reduced_motion: reduced.matches });
});
reduced.addEventListener('change', () => { paused = reduced.matches; syncMotion(); });
window.addEventListener('scroll', requestUpdate, { passive: true });
window.addEventListener('resize', requestUpdate, { passive: true });
document.addEventListener('visibilitychange', () => {
  home?.toggleAttribute('data-offscreen', document.hidden || !visible);
  if (!document.hidden) requestUpdate();
});
if (hero && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    home?.toggleAttribute('data-offscreen', !visible || document.hidden);
    if (visible) requestUpdate();
  });
  observer.observe(hero);
}

document.querySelectorAll<HTMLAnchorElement>('[data-home-cta], [data-home-idea]').forEach((link) => {
  link.addEventListener('click', () => {
    const idea = link.dataset.homeIdea;
    capture(idea ? 'homepage_idea_click' : 'cta_click', {
      design: 'railway-2026-09',
      location: 'homepage',
      cta: idea ?? link.dataset.homeCta,
      destination: link.getAttribute('href'),
    });
  });
});
if ('IntersectionObserver' in window) {
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const section = (entry.target as HTMLElement).dataset.homeSection;
      capture('homepage_section_view', { design: 'railway-2026-09', section });
      seen.unobserve(entry.target);
    });
  }, { threshold: .15 });
  document.querySelectorAll('[data-home-section]').forEach((section) => seen.observe(section));
}
syncMotion();

