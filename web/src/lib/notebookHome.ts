// [CALLVAAL-NOTEBOOK-HOME-1] Keep the existing homepage event names for continuity.
import { capture, initAnalytics } from './analytics';
import { initImageTelemetry } from './imageTelemetry';

initAnalytics();
initImageTelemetry();

const surface = 'notebook-home';
document.querySelectorAll<HTMLAnchorElement>('.notebook-site a').forEach(link => {
  link.addEventListener('click', () => {
    const section = link.closest<HTMLElement>('section, aside, header, footer');
    capture(section?.tagName === 'HEADER' || section?.tagName === 'FOOTER' ? 'nav_click' : 'cta_click', {
      surface,
      section: section?.id || section?.tagName.toLowerCase(),
      label: link.textContent?.trim().replace(/\s+/g, ' '),
      href: link.getAttribute('href'),
      sample_profiles: Boolean(link.closest('.profile-stage')),
    });
  });
});

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      capture('homepage_section_view', { surface, section: entry.target.id || 'hero' });
      observer.unobserve(entry.target);
    }
  }, { threshold: .2 });
  document.querySelectorAll('main section, #launch-note').forEach(section => observer.observe(section));
}
