// [WEB-STATION-2] Static homepage: interaction telemetry only.
import { capture } from './analytics';

const homeDesign = document.querySelector<HTMLElement>('[data-design]')?.dataset.design ?? 'creator-marketplace-2026-09';

// [UI-MOTION-1 2026-09-10] "texts-reveal" for the hero (motion.css `.t-stagger`).
// Fires on first paint, not on scroll — this is a hero, not a scrolling list.
// Wrapped in try/catch, and backed by a timeout safety net below, because the
// hero copy is real content: if this throws, the text must still end up
// visible rather than stuck at the CSS module's opacity:0 resting state.
try {
  const hero = document.querySelector('.t-stagger');
  if (hero) requestAnimationFrame(() => hero.classList.add('is-shown'));
} catch { /* the safety-net timeout below still reveals it */ }
setTimeout(() => {
  document.querySelectorAll('.t-stagger:not(.is-shown)').forEach((el) => el.classList.add('is-shown'));
}, 1200);

document.querySelectorAll<HTMLAnchorElement>('[data-home-cta], [data-home-idea]').forEach((link) => {
  link.addEventListener('click', () => {
    const idea = link.dataset.homeIdea;
    capture(idea ? 'homepage_idea_click' : 'cta_click', {
      design: homeDesign,
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
      capture('homepage_section_view', { design: homeDesign, section });
      seen.unobserve(entry.target);
    });
  }, { threshold: .15 });
  document.querySelectorAll('[data-home-section]').forEach((section) => seen.observe(section));
}
