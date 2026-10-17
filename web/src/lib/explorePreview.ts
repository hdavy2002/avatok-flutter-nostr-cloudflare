import { capture } from './analytics';

const root = document.querySelector<HTMLElement>('.ex-preview');
const cards = [...document.querySelectorAll<HTMLElement>('[data-ex-card]')];
const originalOrder = new Map(cards.map((card, index) => [card, index]));
const query = document.querySelector<HTMLInputElement>('#ex-query');
const suggestions = document.querySelector<HTMLElement>('#ex-suggestions');
const searchForm = document.querySelector<HTMLFormElement>('.ex-search');
const results = document.querySelector<HTMLElement>('#ex-results');
const empty = document.querySelector<HTMLElement>('#ex-empty');
const market = document.querySelector<HTMLElement>('.ex-market');
const sections = [...document.querySelectorAll<HTMLElement>('[data-ex-section]')];
const controls = {
  platform: document.querySelector<HTMLSelectElement>('#ex-platform'),
  language: document.querySelector<HTMLSelectElement>('#ex-language'),
  gender: document.querySelector<HTMLSelectElement>('#ex-gender'),
  availability: document.querySelector<HTMLSelectElement>('#ex-availability'),
  minPrice: document.querySelector<HTMLSelectElement>('#ex-min-price'),
  price: document.querySelector<HTMLSelectElement>('#ex-price'),
  sort: document.querySelector<HTMLSelectElement>('#ex-sort'),
};
let activeCategory = '';

function matches(card: HTMLElement): boolean {
  const term = query?.value.trim().toLowerCase() ?? '';
  return (!term || (card.dataset.search ?? '').includes(term))
    && (!activeCategory || card.dataset.category === activeCategory)
    && (!controls.platform?.value || card.dataset.platform === controls.platform.value.toLowerCase())
    && (!controls.language?.value || (card.dataset.language ?? '').includes(controls.language.value.toLowerCase()))
    && (!controls.gender?.value || card.dataset.gender === controls.gender.value)
    && (!controls.availability?.value || card.dataset.availability === controls.availability.value)
    && (!controls.minPrice?.value || Number(card.dataset.price) >= Number(controls.minPrice.value))
    && (!controls.price?.value || Number(card.dataset.price) <= Number(controls.price.value));
}

function render(): void {
  const seen = new Set<string>();
  cards.forEach(card => {
    const visible = matches(card);
    card.hidden = !visible;
    if (visible && card.dataset.id) seen.add(card.dataset.id);
  });
  sections.forEach(section => {
    const grid = section.querySelector<HTMLElement>('[data-ex-grid]');
    if (!grid) return;
    const sectionCards = [...grid.querySelectorAll<HTMLElement>('[data-ex-card]')];
    const sort = controls.sort?.value ?? 'recommended';
    sectionCards.sort((a, b) => sort === 'name'
      ? (a.dataset.name ?? '').localeCompare(b.dataset.name ?? '')
      : sort === 'price-low' || sort === 'price-high'
        ? (Number(a.dataset.price) - Number(b.dataset.price)) * (sort === 'price-high' ? -1 : 1)
        : (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));
    sectionCards.forEach(card => grid.append(card));
    section.hidden = !sectionCards.some(card => !card.hidden);
  });
  if (results) results.textContent = `${seen.size} sample creator${seen.size === 1 ? '' : 's'}`;
  if (empty) empty.hidden = seen.size !== 0;
}

function chooseCategory(value: string): void {
  activeCategory = value === 'all' ? '' : value;
  document.querySelectorAll<HTMLButtonElement>('[data-category-button]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.categoryButton === (value || 'all')));
  });
  render();
  capture('explore_preview_filter', { filter: 'category', value: activeCategory || 'all' });
}

function hideSuggestions(): void {
  if (suggestions) suggestions.hidden = true;
  query?.setAttribute('aria-expanded', 'false');
}

function updateSuggestions(): void {
  if (!suggestions || !query) return;
  suggestions.replaceChildren();
  const term = query.value.trim().toLowerCase();
  if (term.length < 2) { hideSuggestions(); return; }
  const matched = cards.filter(card => (card.dataset.search ?? '').includes(term)).slice(0, 4);
  const unique = new Set<string>();
  matched.forEach(card => {
    const name = card.dataset.name ?? '';
    if (unique.has(name)) return;
    unique.add(name);
    const button = document.createElement('button');
    button.type = 'button';
    const label = document.createElement('strong');
    label.textContent = name;
    const detail = document.createElement('small');
    detail.textContent = `${card.dataset.platform ?? ''} · ₹${card.dataset.price ?? ''}/min`;
    button.append(label, detail);
    button.addEventListener('click', () => {
      query.value = name;
      hideSuggestions();
      render();
      document.querySelector('#people')?.scrollIntoView({ behavior: 'smooth' });
      capture('explore_preview_search', { match: 'suggestion' });
    });
    suggestions.append(button);
  });
  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = `Search for “${query.value.trim()}” in all sample creators`;
  all.addEventListener('click', () => {
    hideSuggestions();
    render();
    document.querySelector('#people')?.scrollIntoView({ behavior: 'smooth' });
    capture('explore_preview_search', { match: 'all' });
  });
  suggestions.append(all);
  suggestions.hidden = false;
  query.setAttribute('aria-expanded', 'true');
}

if (root) {
  query?.addEventListener('input', () => { updateSuggestions(); render(); });
  query?.addEventListener('keydown', event => { if (event.key === 'Escape') hideSuggestions(); });
  searchForm?.addEventListener('submit', event => {
    event.preventDefault();
    hideSuggestions();
    render();
    document.querySelector('#people')?.scrollIntoView({ behavior: 'smooth' });
    capture('explore_preview_search', { match: 'all' });
  });
  document.addEventListener('click', event => {
    if (event.target instanceof Node && !searchForm?.contains(event.target)) hideSuggestions();
  });
  Object.entries(controls).forEach(([name, control]) => control?.addEventListener('change', () => {
    render();
    capture('explore_preview_filter', { filter: name, value: control.value || 'all' });
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-category-button]').forEach(button => button.addEventListener('click', () => {
    chooseCategory(button.dataset.categoryButton ?? 'all');
    document.querySelector('#people')?.scrollIntoView({ behavior: 'smooth' });
  }));
  document.querySelector<HTMLButtonElement>('#ex-clear')?.addEventListener('click', () => {
    if (query) query.value = '';
    Object.values(controls).forEach(control => { if (control) control.selectedIndex = 0; });
    chooseCategory('all');
    hideSuggestions();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
    const view = button.dataset.view ?? 'grid';
    if (market) market.dataset.view = view;
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    capture('explore_preview_view', { view });
  }));
  document.querySelector<HTMLButtonElement>('#ex-show-online')?.addEventListener('click', () => {
    if (controls.availability) controls.availability.value = 'online';
    render();
    document.querySelector('#people')?.scrollIntoView({ behavior: 'smooth' });
  });
  document.querySelector<HTMLButtonElement>('#ex-show-new')?.addEventListener('click', () => {
    document.querySelector('#people')?.scrollIntoView({ behavior: 'smooth' });
  });
  render();
  capture('explore_preview_impression', { surface: 'local-concept' });
}

const videoDialog = document.querySelector<HTMLDialogElement>('#ex-video-dialog');
document.querySelectorAll<HTMLButtonElement>('[data-demo-video]').forEach(button => button.addEventListener('click', () => {
  const copy = document.querySelector<HTMLElement>('#ex-video-copy');
  if (copy) copy.textContent = `${button.dataset.demoVideo ?? 'This creator'}’s sample portrait is not a video. A connected creator’s authorized Instagram, YouTube or Facebook embed would play here with its original platform controls.`;
  videoDialog?.showModal();
  capture('explore_preview_video', { state: 'placeholder' });
}));
document.querySelectorAll<HTMLButtonElement>('[data-close-video]').forEach(button => button.addEventListener('click', () => videoDialog?.close()));

const booking = document.querySelector<HTMLDialogElement>('#ex-booking');
const bookingName = document.querySelector<HTMLElement>('#ex-booking-name');
const review = document.querySelector<HTMLElement>('#ex-review');
const duration = document.querySelector<HTMLSelectElement>('#ex-duration');
const scheduleLabel = document.querySelector<HTMLElement>('#ex-schedule-label');
const scheduleTime = document.querySelector<HTMLInputElement>('#ex-schedule-time');
let selectedName = '';
let selectedPrice = 0;
let selectedAvailability = '';
let choice: 'now' | 'schedule' = 'schedule';
let step = 1;

function setStep(value: number): void {
  step = value;
  document.querySelectorAll<HTMLElement>('[data-booking-step]').forEach(panel => { panel.hidden = Number(panel.dataset.bookingStep) !== step; });
  document.querySelectorAll<HTMLElement>('[data-step-indicator]').forEach(item => { item.dataset.active = String(Number(item.dataset.stepIndicator) === step); });
  if (scheduleLabel) scheduleLabel.hidden = choice !== 'schedule';
  if (step === 2 && review) {
    const minutes = Number(duration?.value ?? 10);
    const when = choice === 'now' ? 'Call now' : scheduleTime?.value ? `Schedule ${scheduleTime.value.replace('T', ' ')}` : 'Schedule · time to be chosen';
    review.textContent = `${selectedName} · ${when} · ${minutes} min × ₹${selectedPrice}/min = ₹${minutes * selectedPrice} sample subtotal.`;
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-book]').forEach(button => button.addEventListener('click', () => {
  selectedName = button.dataset.name ?? 'a creator';
  selectedPrice = Number(button.dataset.price ?? 0);
  selectedAvailability = button.dataset.availability ?? 'offline';
  choice = selectedAvailability === 'online' ? 'now' : 'schedule';
  if (scheduleTime) scheduleTime.value = '';
  if (bookingName) bookingName.textContent = selectedName;
  document.querySelectorAll<HTMLButtonElement>('[data-call-choice]').forEach(option => {
    const nowUnavailable = option.dataset.callChoice === 'now' && selectedAvailability !== 'online';
    option.disabled = nowUnavailable;
    option.dataset.selected = String(option.dataset.callChoice === choice);
  });
  setStep(1);
  booking?.showModal();
  capture('explore_preview_booking_open', { creator: button.dataset.book, availability: selectedAvailability });
}));
document.querySelectorAll<HTMLButtonElement>('[data-call-choice]').forEach(button => button.addEventListener('click', () => {
  choice = button.dataset.callChoice === 'now' ? 'now' : 'schedule';
  document.querySelectorAll<HTMLButtonElement>('[data-call-choice]').forEach(item => { item.dataset.selected = String(item === button); });
}));
document.querySelectorAll<HTMLButtonElement>('[data-booking-next]').forEach(button => button.addEventListener('click', () => {
  if (step < 3) setStep(step + 1);
}));
document.querySelector<HTMLButtonElement>('[data-booking-back]')?.addEventListener('click', () => setStep(1));
duration?.addEventListener('change', () => setStep(2));
scheduleTime?.addEventListener('change', () => setStep(2));
document.querySelectorAll<HTMLButtonElement>('[data-close-booking]').forEach(button => button.addEventListener('click', () => booking?.close()));
