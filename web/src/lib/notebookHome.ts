import { capture, initAnalytics } from './analytics';
import { initImageTelemetry } from './imageTelemetry';
import { meApi } from '../islands/dashboard2/accountApi';
initAnalytics();
initImageTelemetry();
const surface = 'scrapbook-home';
const mood = document.querySelector<HTMLSelectElement>('#mood-filter');
const language = document.querySelector<HTMLSelectElement>('#language-filter');
const price = document.querySelector<HTMLSelectElement>('#price-filter');
const online = document.querySelector<HTMLInputElement>('#online-filter');
const cards = [...document.querySelectorAll<HTMLElement>('[data-person]')];
const label = document.querySelector<HTMLElement>('[data-selected-mood-label]');
const status = document.querySelector<HTMLElement>('#filter-status');
const noResults = document.querySelector<HTMLElement>('.no-results');
function filterPeople() {
  let count = 0;
  for (const card of cards) {
    const match = (!mood?.value || card.dataset.moods?.split(' ').includes(mood.value))
      && (!language?.value || card.dataset.languages?.split(', ').includes(language.value))
      && (!price?.value || Number(card.dataset.price) <= Number(price.value))
      && (!online?.checked || card.dataset.online === 'true');
    card.hidden = !match;
    if (match) count++;
  }
  if (label) { label.hidden = !mood?.value; label.textContent = mood?.value ? `Mood: ${mood.selectedOptions[0]?.textContent ?? ''}` : ''; }
  if (noResults) noResults.hidden = count > 0;
  if (status) status.textContent = `${count} sample ${count === 1 ? 'profile' : 'profiles'} shown.`;
}
for (const select of [mood, language, price]) select?.addEventListener('change', filterPeople);
online?.addEventListener('change', filterPeople);
document.querySelectorAll<HTMLButtonElement>('[data-reset-filters]').forEach(button => button.addEventListener('click', () => {
  for (const select of [mood, language, price]) if (select) select.value = '';
  if (online) online.checked = false;
  filterPeople();
}));
const requestedMood = new URLSearchParams(location.search).get('mood');
if (mood && requestedMood && [...mood.options].some(option => option.value === requestedMood)) mood.value = requestedMood;
filterPeople();
// The static home page has no trusted gender state. Materialize the women-only
// section only after the authenticated account API explicitly returns F or T.
meApi<{ gender_verified?: string }>('/api/me/profile').then(profile => {
  if (profile.gender_verified !== 'F' && profile.gender_verified !== 'T') return;
  const template = document.querySelector<HTMLTemplateElement>('#women-space-template');
  const slot = document.querySelector('#women-space-slot');
  if (!template || !slot) return;
  slot.append(template.content.cloneNode(true));
  document.querySelectorAll<HTMLElement>('[data-women-nav]').forEach(link => { link.hidden = false; });
}).catch(() => { /* Signed out or unverified: section stays absent. */ });
const dialog = document.querySelector<HTMLDialogElement>('#preview-dialog');
let dialogTrigger: HTMLButtonElement | null = null;
document.querySelectorAll<HTMLButtonElement>('[data-preview-action]').forEach(button => button.addEventListener('click', () => {
  if (!dialog) return;
  dialogTrigger = button;
  const label = button.dataset.previewLabel || button.textContent?.trim() || 'This feature';
  const title = dialog.querySelector('#preview-title');
  const description = dialog.querySelector('#preview-description');
  if (title) title.textContent = button.dataset.previewAction === 'call' ? `Talk to ${label}` : label;
  const descriptions: Record<string, string> = {
    call: 'Yahan sirf baat hoti hai. No medical, legal or money advice. 18+ only. Calls and payments are unavailable in this illustrative preview.',
    join: 'Host registration is coming at launch. Your number stays private.',
    privacy: 'Calls are bridged so neither person sees the other’s number. Calling is unavailable in this preview.',
    page: `${label} is not published for this service yet.`,
  };
  if (description) description.textContent = descriptions[button.dataset.previewAction || 'page'] || descriptions.page;
  dialog.showModal();
  capture('cta_click', { surface, section: button.closest('section')?.id, label: button.dataset.previewAction, sample_profiles: true });
}));
dialog?.querySelector('[data-close-preview]')?.addEventListener('click', () => dialog.close());
dialog?.addEventListener('close', () => { dialogTrigger?.focus(); dialogTrigger = null; });
document.querySelectorAll<HTMLButtonElement>('[data-favourite]').forEach(button => button.addEventListener('click', () => {
  const saved = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(saved));
  capture('cta_click', { surface, section: 'people', label: 'save_profile', saved, sample_profiles: true });
}));
document.querySelectorAll<HTMLAnchorElement>('.notebook-site main a, .mobile-bottom-nav a').forEach(link => link.addEventListener('click', () => {
  const section = link.closest<HTMLElement>('section, header, footer');
  capture('cta_click', { surface, section: section?.id || section?.tagName.toLowerCase(), label: link.textContent?.trim().replace(/\s+/g, ' '), href: link.getAttribute('href') });
}));
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      capture('homepage_section_view', { surface, section: entry.target.id || 'hero' });
      observer.unobserve(entry.target);
    }
  }, { threshold: .2 });
  document.querySelectorAll('main section').forEach(section => observer.observe(section));
}
document.documentElement.dataset.homepageReady = 'true';
