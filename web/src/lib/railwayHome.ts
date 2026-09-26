// [WEB-STATION-2, SHV2-S10] Saa Thum attendee homepage (and, if imported,
// /organisers): interaction telemetry only, never controls rendering.
//
// Route-aware rather than hardcoded to "homepage" — contracts.md §6 mounts
// the same kind of CTA (`data-home-cta`) and section (`data-home-section`)
// markers on both `/` and `/organisers`. A second page importing this module
// gets working telemetry for free instead of a copy-pasted duplicate
// handler (S10 brief, Specs/saathum-home-v2/briefs/S10.md). Event names are
// kept as-is for continuity with existing PostHog dashboards; `route`
// disambiguates which page fired them.
import { capture } from './analytics';

const homeDesign = document.querySelector<HTMLElement>('[data-design]')?.dataset.design;
const route = location.pathname === '/' ? 'homepage' : (location.pathname.replace(/^\/|\/$/g, '') || 'homepage');

document.querySelectorAll<HTMLAnchorElement>('[data-home-cta]').forEach((link) => {
  link.addEventListener('click', () => {
    // Aggregate/structural fields only — route, section, cta id and
    // destination href. Never religious profile data, contact details or
    // joining tokens (A8).
    capture('cta_click', {
      route,
      design: homeDesign,
      location: route,
      section: link.closest<HTMLElement>('[data-home-section]')?.dataset.homeSection ?? link.dataset.homeSection,
      cta: link.dataset.homeCta,
      destination: link.getAttribute('href'),
    });
  });
});

if ('IntersectionObserver' in window) {
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const section = (entry.target as HTMLElement).dataset.homeSection;
      capture('homepage_section_view', { route, design: homeDesign, section });
      seen.unobserve(entry.target);
    });
  }, { threshold: .15 });
  document.querySelectorAll('[data-home-section]').forEach((section) => seen.observe(section));
}
