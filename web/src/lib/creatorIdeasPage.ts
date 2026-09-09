import { capture } from './analytics';
const root = document.querySelector<HTMLElement>('.idea-page');
if (root) {
 const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-idea-card]'));
 const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-format]'));
 const search = root.querySelector<HTMLInputElement>('#idea-search')!;
 const topic = root.querySelector<HTMLSelectElement>('#idea-topic')!;
 const home = root.querySelector<HTMLInputElement>('#idea-home')!;
 const more = root.querySelector<HTMLButtonElement>('.idea-more')!;
 const empty = root.querySelector<HTMLElement>('.idea-empty')!;
 let format = 'all';
 let limit = 12;
 const update = () => {
  const query = search.value.trim().toLocaleLowerCase();
  const matching = cards.filter(card => (format === 'all' || card.dataset.format === format) && (topic.value === 'all' || card.dataset.topic === topic.value) && (!home.checked || card.dataset.setting === 'home') && (!query || card.textContent!.toLocaleLowerCase().includes(query)));
  const shown = new Set(matching.slice(0,limit));
  cards.forEach(card => { card.hidden = !shown.has(card); });
  buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.format === format)));
  root.querySelector('#idea-results')!.textContent = Math.min(limit, matching.length) + ' of ' + matching.length + ' ideas';
  empty.hidden = matching.length !== 0;
  more.hidden = matching.length <= limit;
  more.textContent = 'Show ' + Math.min(12, Math.max(0,matching.length - limit)) + ' more ideas';
 };
 const track = () => capture('creator_ideas_filter',{format,topic:topic.value,from_home:home.checked});
 root.querySelector<HTMLElement>('[data-idea-controls]')!.hidden = false;
 buttons.forEach(button => button.addEventListener('click', () => {format = button.dataset.format!;limit=12;update();track();}));
 search.addEventListener('input',()=>{limit=12;update();});
 topic.addEventListener('change',()=>{limit=12;update();track();});
 home.addEventListener('change',()=>{limit=12;update();track();});
 more.addEventListener('click',()=>{const previous=limit;limit+=12;update();const visible=cards.filter(c=>!c.hidden);const heading=visible[previous]?.querySelector<HTMLElement>('h3');heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});});
 root.querySelector('#idea-reset')?.addEventListener('click',()=>{format='all';topic.value='all';home.checked=false;search.value='';limit=12;update();search.focus();});
 root.querySelector('[data-daily-link]')?.addEventListener('click',()=>{format='live';topic.value='daily';home.checked=false;search.value='';limit=12;update();track();});
 root.querySelectorAll<HTMLAnchorElement>('[data-ideas-cta]').forEach(a=>a.addEventListener('click',()=>capture('creator_ideas_cta',{cta:a.dataset.ideasCta})));
 update();
}
