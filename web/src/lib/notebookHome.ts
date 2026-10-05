// Keep established homepage events; never send search text or form PII.
import { capture, initAnalytics } from './analytics';
import { initImageTelemetry } from './imageTelemetry';
initAnalytics();
initImageTelemetry();
const surface = 'scrapbook-home';
const query = document.querySelector<HTMLInputElement>('#people-query');
const category = document.querySelector<HTMLSelectElement>('#category-filter');
const language = document.querySelector<HTMLSelectElement>('#language-filter');
const price = document.querySelector<HTMLSelectElement>('#price-filter');
const cards = [...document.querySelectorAll<HTMLElement>('[data-person]')];
const categoryButtons = [...document.querySelectorAll<HTMLButtonElement>('.category-card')];
const status = document.querySelector<HTMLElement>('#filter-status');
const noResults = document.querySelector<HTMLElement>('.no-results');
function filterPeople() {
  const terms = (query?.value || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  let count = 0;
  for (const card of cards) {
    const haystack = `${card.dataset.search} ${card.dataset.category} ${card.dataset.languages}`.toLocaleLowerCase();
    const match = (!category?.value || card.dataset.category === category.value)
      && (!language?.value || card.dataset.languages?.split(', ').includes(language.value))
      && (!price?.value || Number(card.dataset.price) <= Number(price.value))
      && terms.every(term => haystack.includes(term));
    card.hidden = !match;
    if (match) count += 1;
  }
  categoryButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === category?.value)));
  if (noResults) noResults.hidden = count > 0;
  if (status) status.textContent = `${count} sample ${count === 1 ? 'profile' : 'profiles'} shown. Calls are not available in this preview.`;
}
function showPeople() { document.querySelector('#people')?.scrollIntoView({ behavior: 'auto', block: 'start' }); }
document.querySelector('#people-search')?.addEventListener('submit', event => {
  event.preventDefault(); filterPeople(); showPeople();
  capture('cta_click', { surface, section: 'hero', label: 'Find your person', sample_profiles: true });
});
for (const select of [category, language, price]) select?.addEventListener('change', filterPeople);
categoryButtons.forEach(button => button.addEventListener('click', () => {
  if (category) category.value = button.dataset.category || '';
  if (query) query.value = '';
  filterPeople(); showPeople();
  capture('cta_click', { surface, section: 'categories', label: button.dataset.category, sample_profiles: true });
}));
document.querySelectorAll<HTMLButtonElement>('[data-reset-filters]').forEach(button => button.addEventListener('click', () => {
  for (const input of [query, category, language, price]) if (input) input.value = '';
  filterPeople();
}));
const dialog = document.querySelector<HTMLDialogElement>('#preview-dialog');
let dialogTrigger: HTMLButtonElement | null = null;
document.querySelectorAll<HTMLButtonElement>('[data-preview-action]').forEach(button => button.addEventListener('click', () => {
  if (!dialog) return;
  dialogTrigger = button;
  const label = button.dataset.previewLabel || button.textContent?.trim() || 'This feature';
  const title = dialog.querySelector('#preview-title');
  const description = dialog.querySelector('#preview-description');
  if (title) title.textContent = button.dataset.previewAction === 'call' ? `Call ${label}` : label;
  const descriptions: Record<string, string> = {
    call: 'This is an illustrative profile. Calls and payments are not available in this preview.',
    join: 'Partner registration is not available yet. This preview shows the intended joining experience.',
    download: `${label} downloads are not available yet. No app will be downloaded from this preview.`,
    privacy: 'The proposed connection calls both people separately and keeps their personal phone numbers hidden from each other. Calling is not available in this preview.',
    page: `${label} is not published for this service yet. This preview does not provide an active policy or support workflow.`,
  };
  if (description) description.textContent = descriptions[button.dataset.previewAction || 'page'] || descriptions.page;
  dialog.showModal();
  capture('cta_click', { surface, section: button.closest('section')?.id, label: button.dataset.previewAction, sample_profiles: true });
}));
dialog?.querySelector('[data-close-preview]')?.addEventListener('click', () => dialog.close());
dialog?.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
dialog?.addEventListener('close', () => { dialogTrigger?.focus(); dialogTrigger = null; });
document.querySelectorAll<HTMLButtonElement>('[data-favourite]').forEach(button => button.addEventListener('click', () => {
  button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
}));
const menuToggle = document.querySelector<HTMLButtonElement>('.menu-toggle');
const navigation = document.querySelector<HTMLElement>('#main-navigation');
function closeMenu(returnFocus = false) {
  menuToggle?.setAttribute('aria-expanded', 'false');
  menuToggle?.setAttribute('aria-label', 'Open navigation');
  if (navigation) navigation.dataset.open = 'false';
  if (returnFocus) menuToggle?.focus();
}
menuToggle?.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  if (navigation) navigation.dataset.open = String(open);
});
navigation?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => closeMenu()));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuToggle?.getAttribute('aria-expanded') === 'true') closeMenu(true);
});
const mobileQuery = window.matchMedia('(max-width: 599px)');
document.querySelectorAll('.footer-group summary').forEach(summary => summary.addEventListener('click', event => {
  if (!mobileQuery.matches) event.preventDefault();
}));
function updateResponsiveNavigation() {
  closeMenu();
  document.querySelectorAll<HTMLDetailsElement>('.footer-group').forEach(group => { group.open = !mobileQuery.matches; });
}
mobileQuery.addEventListener('change', updateResponsiveNavigation);
updateResponsiveNavigation();
document.querySelectorAll<HTMLAnchorElement>('.notebook-site a').forEach(link => link.addEventListener('click', () => {
  const section = link.closest<HTMLElement>('section, header, footer');
  capture(section?.tagName === 'HEADER' || section?.tagName === 'FOOTER' ? 'nav_click' : 'cta_click', {
    surface, section: section?.id || section?.tagName.toLowerCase(),
    label: link.textContent?.trim().replace(/\s+/g, ' ') || link.getAttribute('aria-label'),
    href: link.getAttribute('href'), sample_profiles: Boolean(link.closest('#people')),
  });
}));
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      capture('homepage_section_view', { surface, section: entry.target.id || 'hero' });
      observer.unobserve(entry.target);
    }
  }, { threshold: .2 });
  document.querySelectorAll('main section').forEach(section => observer.observe(section));
}
