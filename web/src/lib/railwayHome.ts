// [WEB-STATION-2] Static homepage: interaction telemetry only.
import { capture } from './analytics';

const homeDesign = document.querySelector<HTMLElement>('[data-design]')?.dataset.design ?? 'creator-marketplace-2026-09';

// Hero text is visible in CSS; telemetry never controls its rendering.
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
