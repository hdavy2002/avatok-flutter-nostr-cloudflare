import { capture } from './analytics';
const root = document.querySelector<HTMLElement>('.fraands-blog-page');
if (root) {
  const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-idea-card]'));
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-category]'));
  const search = root.querySelector<HTMLInputElement>('#idea-search')!;
  const more = root.querySelector<HTMLButtonElement>('.idea-more')!;
  const empty = root.querySelector<HTMLElement>('.idea-empty')!;
  const requested = new URLSearchParams(location.search).get('category');
  let category = buttons.some(button => button.dataset.category === requested) ? requested! : 'all';
  let limit = 12;
  const update = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const matching = cards.filter(card => (category === 'all' || card.dataset.category === category) && (!query || (card.textContent + ' ' + (card.dataset.tags ?? '')).toLocaleLowerCase().includes(query)));
    const shown = new Set(matching.slice(0, limit));
    cards.forEach(card => { card.hidden = !shown.has(card); });
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === category)));
    root.querySelector('#idea-results')!.textContent = `${Math.min(limit, matching.length)} of ${matching.length} articles`;
    empty.hidden = matching.length !== 0;
    more.hidden = matching.length <= limit;
    more.textContent = `Show ${Math.min(12, Math.max(0, matching.length - limit))} more articles`;
  };
  root.querySelector<HTMLElement>('[data-idea-controls]')!.hidden = false;
  buttons.forEach(button => button.addEventListener('click', () => { category = button.dataset.category!; limit = 12; update(); capture('blog_filter', { category }); }));
  search.addEventListener('input', () => { limit = 12; update(); });
  more.addEventListener('click', () => { const previous = limit; limit += 12; update(); const heading = cards.filter(card => !card.hidden)[previous]?.querySelector<HTMLElement>('h3'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); });
  root.querySelector('#idea-reset')?.addEventListener('click', () => { category = 'all'; search.value = ''; limit = 12; update(); search.focus(); });
  root.querySelectorAll<HTMLAnchorElement>('[data-blog-open]').forEach(link => link.addEventListener('click', () => capture('blog_article_open', { article: link.dataset.blogOpen })));
  update();
}
