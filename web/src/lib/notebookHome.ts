import { capture, initAnalytics } from './analytics';
import { initImageTelemetry } from './imageTelemetry';
initAnalytics();
initImageTelemetry();
const surface = 'scrapbook-home';
const mood = document.querySelector<HTMLSelectElement>('#mood-filter');
const language = document.querySelector<HTMLSelectElement>('#language-filter');
const price = document.querySelector<HTMLSelectElement>('#price-filter');
const online = document.querySelector<HTMLInputElement>('#online-filter');
// Read fresh every time: real host cards are portalled in late by LiveHostCards [HF-HOST-POLISH-1].
const getCards = () => [...document.querySelectorAll<HTMLElement>('[data-person]')];
// Preview samples are intentionally memory-only, reset on navigation/reload.
const favourites = new Set(getCards().filter(card => card.dataset.previewFavourite === 'true').map(card => card.dataset.profileId!));
const favouriteButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-favourite]')];
function renderFavouriteButtons() {
  for (const button of favouriteButtons) {
    const saved = favourites.has(button.dataset.favourite!);
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', `${saved ? 'Unfavourite' : 'Favourite'} ${button.dataset.profileName} for this visit`);
  }
}
renderFavouriteButtons();
const label = document.querySelector<HTMLElement>('[data-selected-mood-label]');
const status = document.querySelector<HTMLElement>('#filter-status');
const noResults = document.querySelector<HTMLElement>('.no-results');
const noResultsText = noResults?.querySelector<HTMLElement>('p');
// [HF-LANE-VERIFY-1] ?lane=women|lgbtq shows only that lane's hosts (cards LiveHostCards fetched for a verified caller); samples and ordinary hosts are hidden.
const laneParam = new URLSearchParams(location.search).get('lane');
let laneMode: 'women' | 'lgbtq' | null = laneParam === 'women' || laneParam === 'lgbtq' ? laneParam : null;
const laneTitle = { women: 'Women-only space', lgbtq: 'LGBTQ+ space' } as const;
function filterPeople() {
  let count = 0;
  let liveShown = 0;
  let liveExists = false;
  for (const card of getCards()) {
    const isLive = card.hasAttribute('data-live-host');
    if (isLive) liveExists = true;
    // In a lane, only cards fetched for a verified member (data-lane-host) are shown; the other filters still apply to them.
    const match = (!laneMode || card.hasAttribute('data-lane-host')) && (!mood?.value || card.dataset.moods?.split(' ').includes(mood.value))
      && (!language?.value || card.dataset.languages?.split(', ').includes(language.value))
      && (!price?.value || Number(card.dataset.price) <= Number(price.value))
      && (!online?.checked || card.dataset.online === 'true');
    card.hidden = !match;
    if (match) { count++; if (isLive) liveShown++; }
  }
  const laneState = document.documentElement.dataset.laneState || 'checking'; // set by LiveHostCards: checking | locked | granted | error
  if (label) { label.hidden = !laneMode && !mood?.value; label.textContent = laneMode ? laneTitle[laneMode] : mood?.value ? `Mood: ${mood.selectedOptions[0]?.textContent ?? ''}` : ''; }
  // While locked, LiveHostCards shows its own "Verify to see this space" panel instead of an empty-results message.
  if (noResults) noResults.hidden = count > 0 || (!!laneMode && (laneState === 'locked' || laneState === 'checking'));
  if (noResultsText) noResultsText.textContent = laneMode ? (laneState === 'error' ? 'We could not load this space just now. Please try again.' : 'No hosts are in this space yet. Please check back soon.') : liveExists ? 'No profiles match those filters.' : 'No sample profiles match those filters.';
  if (status) status.textContent = laneMode ? (laneState === 'locked' ? 'Verify to see this space.' : `${count} ${count === 1 ? 'host' : 'hosts'} shown.`) : liveShown > 0 ? `${count} ${count === 1 ? 'person' : 'people'} shown.` : `${count} sample ${count === 1 ? 'profile' : 'profiles'} shown.`;
}
for (const select of [mood, language, price]) select?.addEventListener('change', filterPeople);
online?.addEventListener('change', filterPeople);
document.addEventListener('hf:people-changed', filterPeople);
document.querySelectorAll<HTMLButtonElement>('[data-reset-filters]').forEach(button => button.addEventListener('click', () => {
  for (const select of [mood, language, price]) if (select) select.value = '';
  if (online) online.checked = false;
  if (laneMode) {
    laneMode = null;
    const url = new URL(location.href);
    url.searchParams.delete('lane');
    history.replaceState(null, '', url);
  }
  filterPeople();
}));
const requestedMood = new URLSearchParams(location.search).get('mood');
if (mood && requestedMood && [...mood.options].some(option => option.value === requestedMood)) mood.value = requestedMood;
filterPeople();
const dialog = document.querySelector<HTMLDialogElement>('#preview-dialog');
let dialogTrigger: HTMLButtonElement | null = null;
document.querySelectorAll<HTMLButtonElement>('[data-preview-action]').forEach(button => button.addEventListener('click', () => {
  if (!dialog) return;
  dialogTrigger = button;
  const label = button.dataset.previewLabel || button.textContent?.trim() || 'This feature';
  const title = dialog.querySelector('#preview-title');
  const description = dialog.querySelector('#preview-description');
  if (title) {
    const action = button.dataset.previewAction;
    title.textContent = action === 'call' ? `Talk to ${label}` : action === 'notify' ? `Notify me about ${label}` : label;
  }
  const descriptions: Record<string, string> = {
    call: 'Yahan sirf baat hoti hai. No medical, legal or money advice. 18+ only. Calls and payments are unavailable in this illustrative preview.',
    voice: 'This sample profile demonstrates a 20-second voice introduction. This is a visual demo; no recording is playing.',
    notify: 'This is an illustrative preview. No notification has been set. Availability alerts are not available yet.',
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
favouriteButtons.forEach(button => button.addEventListener('click', () => {
  const id = button.dataset.favourite!;
  const saved = !favourites.has(id);
  if (saved) favourites.add(id); else favourites.delete(id);
  renderFavouriteButtons();
  const announcement = document.querySelector<HTMLElement>('[data-favourites-status]');
  if (announcement) announcement.textContent = `${button.dataset.profileName} ${saved ? 'added to' : 'removed from'} your favourites for this visit.`;
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
