/* [HF-CHANNEL-WEB-1] Keeps the Bag count in the site header in step with the bag store. Runs on every page (the header is shared) and
 * does nothing unless the header was rendered with the Bag button (channel, product, bag and checkout pages). */
import { bagCount, readBag, subscribeBag } from './merchBag';

export function initBagBadge(): void {
  const badges = document.querySelectorAll<HTMLElement>('[data-bag-count]');
  if (!badges.length) return;
  const paint = () => {
    const n = bagCount(readBag());
    badges.forEach(b => {
      b.textContent = String(n);
      b.dataset.zero = n === 0 ? '1' : '0';
      const link = b.closest('a');
      if (link) link.setAttribute('aria-label', `Bag, ${n} ${n === 1 ? 'item' : 'items'}`);
    });
  };
  paint();
  subscribeBag(paint);
  window.addEventListener('pageshow', paint);
}
