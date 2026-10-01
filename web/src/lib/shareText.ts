// [WEB-WA-SHARE-2 2026-09-29] OWNER DECISION: what our WhatsApp share buttons put
// in the MESSAGE BODY. WhatsApp prints a link preview's title/description in its
// own small grey type, and no website can change that size. The message body,
// though, shows at full chat size — so the pitch goes there, one idea per line,
// with the event name in WhatsApp *bold*. No leading emoji: WhatsApp Desktop on
// the Mac drew the old 🙏 as a broken "?" box.

const IST_DAY = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });

export function shareWhen(startsAt: number | null | undefined): string | null {
  const n = Number(startsAt);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return `${IST_DAY.format(d).replace(/,/g, '')}, ${IST_TIME.format(d).toUpperCase()} IST`;
}

export interface ShareInput {
  title: string;
  url: string;
  /** One-line pitch (the listing's ad hook). A leading "<title>:" is dropped. */
  hook?: string | null;
  startsAt?: number | null;
  place?: string | null;
  price?: number | null;
  free?: boolean;
  /** Havan/puja type (kept for callers; no longer changes the text on its own). */
  ritual?: boolean;
  /** [SAATHUM-SHARED-SANKALP-1 2026-09-30] Only a one-family ritual takes a personal
   *  sankalp, so only then does the share line promise "in your name & gotra". */
  personalSankalp?: boolean;
}

export function whatsappShareText(i: ShareInput): string {
  const title = i.title.replace(/\s+/g, ' ').trim();
  let hook = (i.hook ?? '').replace(/\s+/g, ' ').trim();
  if (hook.toLowerCase().startsWith(`${title.toLowerCase()}:`)) hook = hook.slice(title.length + 1).trim();
  if (hook && !/[.!?]$/.test(hook)) hook += '.';
  const when = shareWhen(i.startsAt);
  const amount = Number(i.price);
  const priceText = i.free || amount === 0 ? 'Free to join'
    : Number.isFinite(amount) && amount > 0 ? `From ₹${amount.toLocaleString('en-IN')}` : '';
  const facts = [i.personalSankalp ? 'Sankalp in your name & gotra' : '', priceText].filter(Boolean).join(' · ');
  const lines = [
    `*${title}${when ? ` – live ${when}` : ''}*`,
    hook,
    i.place ? `Live from ${i.place}` : '',
    facts,
  ].filter(Boolean);
  return `${lines.join('\n')}\n\nBook your place: ${i.url}`;
}

export function whatsappShareHref(i: ShareInput): string {
  return 'https://wa.me/?text=' + encodeURIComponent(whatsappShareText(i));
}

// [SAATHUM-FREEVIDEOS-WEB-1 2026-10-01] A free video is not an event: no date, price or booking,
// so it gets its own message instead of whatsappShareText's "Book your place".
export function whatsappShareVideoText(i: { title: string; url: string; categoryLabel?: string | null }): string {
  const title = i.title.replace(/\s+/g, ' ').trim();
  const kind = i.categoryLabel ? `${i.categoryLabel} · Free video` : 'Free video';
  return `*${title}*\n${kind}\n\nWatch free: ${i.url}`;
}

export function whatsappShareVideoHref(i: { title: string; url: string; categoryLabel?: string | null }): string {
  return 'https://wa.me/?text=' + encodeURIComponent(whatsappShareVideoText(i));
}
