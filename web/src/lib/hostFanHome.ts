import { capture, initAnalytics } from './analytics';
import { initImageTelemetry } from './imageTelemetry';

initAnalytics();
initImageTelemetry();
const surface = 'host-fan-home';
const dialog = document.querySelector<HTMLDialogElement>('#preview-dialog');
let trigger: HTMLButtonElement | null = null;

document.querySelectorAll<HTMLButtonElement>('[data-preview-action]').forEach(button => {
  button.addEventListener('click', () => {
    if (!dialog || dialog.open) return;
    trigger = button;
    const voice = button.dataset.previewAction === 'voice';
    const title = dialog.querySelector('#preview-title');
    const description = dialog.querySelector('#preview-description');
    if (title) title.textContent = `${button.dataset.previewLabel} · illustrative ${voice ? 'voice' : 'booking'} preview`;
    if (description) description.textContent = voice
      ? 'This sample shows a 20-second voice introduction. No recording is playing. Explore hosts to see real profiles and availability.'
      : 'This is an illustrative sample profile. No call has been booked and no payment is made. Explore hosts to see real profiles and availability.';
    dialog.showModal();
    capture('cta_click', { surface, section: 'creators', action: voice ? 'voice_preview' : 'booking_preview', sample_profiles: true });
  });
});
dialog?.querySelector<HTMLButtonElement>('[data-close-preview]')?.addEventListener('click', () => dialog.close());
// Native modal Escape handling also reaches close, restoring the initiating control.
dialog?.addEventListener('close', () => { trigger?.focus(); trigger = null; });

document.querySelectorAll<HTMLAnchorElement>('[data-home-cta]').forEach(link => {
  link.addEventListener('click', () => capture('cta_click', {
    surface, section: link.closest<HTMLElement>('[data-home-section]')?.dataset.homeSection,
    action: link.dataset.homeCta,
  }));
});
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      capture('homepage_section_view', { surface, section: (entry.target as HTMLElement).dataset.homeSection });
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.15 });
  document.querySelectorAll('[data-home-section]').forEach(section => observer.observe(section));
}
document.documentElement.dataset.homepageReady = 'true';
