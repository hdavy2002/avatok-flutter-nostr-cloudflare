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
const categoryButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-category-select]')];
const selectedCategoryLabel = document.querySelector<HTMLElement>('[data-selected-category-label]');
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
  if (selectedCategoryLabel) {
    selectedCategoryLabel.hidden = !category?.value;
    selectedCategoryLabel.textContent = category?.value ? `Selected category: ${category.selectedOptions[0]?.textContent || ''}` : '';
  }
  if (noResults) noResults.hidden = count > 0;
  if (status) status.textContent = `${count} sample ${count === 1 ? 'profile' : 'profiles'} shown. Calls are not available in this preview.`;
}
function showPeople() { document.querySelector('#people')?.scrollIntoView({ behavior: 'auto', block: 'start' }); }
document.querySelector('#people-search')?.addEventListener('submit', event => {
  event.preventDefault(); filterPeople(); showPeople();
  capture('cta_click', { surface, section: 'hero', label: 'Find your person', sample_profiles: true });
});
for (const select of [category, language, price]) select?.addEventListener('change', filterPeople);
function selectCategory(button: HTMLButtonElement) {
  if (category) category.value = button.dataset.category || '';
  if (query) query.value = '';
  filterPeople(); showPeople();
  const isFooter = Boolean(button.closest('footer'));
  capture(isFooter ? 'nav_click' : 'cta_click', { surface, section: isFooter ? 'footer' : 'categories', label: button.dataset.category, sample_profiles: true });
}
categoryButtons.forEach(button => button.addEventListener('click', () => selectCategory(button)));
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
    call: 'This is an illustrative profile. Qualifications and verification badges are samples, not completed registry checks. Calls and payments are not available in this preview.',
    join: 'Partner registration is not available yet. This preview shows the intended joining experience.',
    download: `${label} downloads are not available yet. No app will be downloaded from this preview.`,
    privacy: 'The proposed connection calls both people separately and keeps their personal phone numbers hidden from each other. Calling is not available in this preview.',
    page: `${label} is not published for this service yet. This preview does not provide an active policy or support workflow.`,
  };
  if (description) description.textContent = descriptions[button.dataset.previewAction || 'page'] || descriptions.page;
  dialog.dataset.previewState = 'open';
  dialog.showModal();
  capture('cta_click', { surface, section: button.closest('section')?.id, label: button.dataset.previewAction, sample_profiles: true });
}));
dialog?.querySelector('[data-close-preview]')?.addEventListener('click', () => dialog.close());
dialog?.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
dialog?.addEventListener('close', () => {
  dialogTrigger?.focus();
  dialogTrigger = null;
  // Native close() updates .open before this queued focus-restoration callback.
  dialog.dataset.previewState = 'closed';
});
document.querySelectorAll<HTMLButtonElement>('[data-favourite]').forEach(button => button.addEventListener('click', () => {
  const saved = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(saved));
  capture('cta_click', { surface, section: 'people', label: 'save_profile', saved, sample_profiles: true });
}));
// Footer category links also work when arriving from a nested route.
const requestedCategory = new URLSearchParams(window.location.search).get('category');
if (category && requestedCategory && [...category.options].some(option => option.value === requestedCategory)) {
  category.value = requestedCategory;
  filterPeople();
}
document.querySelectorAll<HTMLAnchorElement>('.notebook-site main a, .mobile-bottom-nav a').forEach(link => link.addEventListener('click', () => {
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
// Browser checks wait for application listeners, not just the rendered HTML/assets.
document.documentElement.dataset.homepageReady = 'true';
