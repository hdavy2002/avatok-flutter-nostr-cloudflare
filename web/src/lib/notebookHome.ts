// Keep established homepage events; never send search text or form PII.
import { capture, initAnalytics } from './analytics';
import { initImageTelemetry } from './imageTelemetry';
initAnalytics();
initImageTelemetry();
const surface = 'notebook-home';
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
