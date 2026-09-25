// [SAATHUM-GUIDE-1 2026-09-25] Search + filters for /rituals. Adapted from
// creatorIdeasPage.ts (same markup contract). Supports ?type=havan|puja and
// ?for=<category> so other pages can deep-link a pre-filtered list.
import { capture } from './analytics';
const root = document.querySelector<HTMLElement>('.ritual-guide-page');
if (root) {
 const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-idea-card]'));
 const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-format]'));
 const search = root.querySelector<HTMLInputElement>('#idea-search')!;
 const topic = root.querySelector<HTMLSelectElement>('#idea-topic')!;
 const more = root.querySelector<HTMLButtonElement>('.idea-more')!;
 const empty = root.querySelector<HTMLElement>('.idea-empty')!;
 const params = new URLSearchParams(location.search);
 let format = ['havan', 'puja'].includes(params.get('type') ?? '') ? params.get('type')! : 'all';
 if (params.get('for') && topic.querySelector(`option[value="${CSS.escape(params.get('for')!)}"]`)) topic.value = params.get('for')!;
 let limit = 12;
 const haystack = (card: HTMLElement) => (card.textContent + ' ' + (card.dataset.tags ?? '')).toLocaleLowerCase();
 const update = () => {
  const query = search.value.trim().toLocaleLowerCase();
  const matching = cards.filter(card => (format === 'all' || card.dataset.format === format) && (topic.value === 'all' || card.dataset.topic === topic.value) && (!query || haystack(card).includes(query)));
  const shown = new Set(matching.slice(0, limit));
  cards.forEach(card => { card.hidden = !shown.has(card); });
  buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.format === format)));
  root.querySelector('#idea-results')!.textContent = Math.min(limit, matching.length) + ' of ' + matching.length + ' rituals';
  empty.hidden = matching.length !== 0;
  more.hidden = matching.length <= limit;
  more.textContent = 'Show ' + Math.min(12, Math.max(0, matching.length - limit)) + ' more rituals';
 };
 const track = () => capture('ritual_guide_filter', { type: format, intention: topic.value });
 root.querySelector<HTMLElement>('[data-idea-controls]')!.hidden = false;
 buttons.forEach(button => button.addEventListener('click', () => { format = button.dataset.format!; limit = 12; update(); track(); }));
 search.addEventListener('input', () => { limit = 12; update(); });
 topic.addEventListener('change', () => { limit = 12; update(); track(); });
 more.addEventListener('click', () => { const previous = limit; limit += 12; update(); const visible = cards.filter(c => !c.hidden); const heading = visible[previous]?.querySelector<HTMLElement>('h3'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); });
 root.querySelector('#idea-reset')?.addEventListener('click', () => { format = 'all'; topic.value = 'all'; search.value = ''; limit = 12; update(); search.focus(); });
 root.querySelectorAll<HTMLAnchorElement>('[data-ritual-cta]').forEach(a => a.addEventListener('click', () => capture('ritual_guide_cta', { cta: a.dataset.ritualCta })));
 root.querySelectorAll<HTMLAnchorElement>('[data-ritual-guide]').forEach(a => a.addEventListener('click', () => capture('ritual_guide_open', { ritual: a.dataset.ritualGuide })));
 update();
}
