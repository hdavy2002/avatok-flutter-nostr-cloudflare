const inrLocale = () => document.documentElement.lang === 'hi-Latn' ? 'en-IN' : document.documentElement.lang || 'en-IN';
const INR = () => { try { return new Intl.NumberFormat(inrLocale(), { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }); } catch { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }); } };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const eventProps = { environment: ['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'local-preview' : 'production', page_variant: 'india-creators' };
const track = (event: string, properties: Record<string, unknown> = {}) => {
  import('./analytics').then(({ capture }) => capture(event, { ...eventProps, ...properties })).catch(() => undefined);
};

function initCalculator(root: HTMLElement) {
  const input = (name: string) => root.querySelector<HTMLInputElement>(`[data-calc="${name}"]`);
  const output = (name: string) => root.querySelector<HTMLOutputElement>(`[data-calc-${name}]`);
  let telemetryTimer: number | undefined;
  const update = () => {
    const formatter = INR();
    const livePrice = clamp(Number(input('livePrice')?.value), 100, 50000);
    const audience = clamp(Number(input('audience')?.value), 0, 10000);
    const events = clamp(Number(input('events')?.value), 0, 31);
    const onePrice = clamp(Number(input('onePrice')?.value), 100, 50000);
    const bookings = clamp(Number(input('bookings')?.value), 0, 1000);
    output('live-price')?.replaceChildren(formatter.format(livePrice));
    output('audience')?.replaceChildren(String(audience));
    output('events')?.replaceChildren(String(events));
    output('one-price')?.replaceChildren(formatter.format(onePrice));
    output('bookings')?.replaceChildren(String(bookings));
    const liveTotal = livePrice * audience * events;
    const oneTotal = onePrice * bookings;
    output('live-total')?.replaceChildren(formatter.format(liveTotal));
    output('one-total')?.replaceChildren(formatter.format(oneTotal));
    output('total')?.replaceChildren(formatter.format(liveTotal + oneTotal));
    window.clearTimeout(telemetryTimer);
    telemetryTimer = window.setTimeout(() => track('india_calculator_change', { livePrice, audience, events, onePrice, bookings, locale: inrLocale() }), 250);
  };
  root.querySelectorAll('input').forEach((el) => el.addEventListener('input', update));
  update();
}

const calculators = [...document.querySelectorAll<HTMLElement>('[data-india-calculator]')];
calculators.forEach(initCalculator);
if (document.querySelector('[data-india-page]')) track('india_landing_ready', { locale: inrLocale() });
document.querySelectorAll<HTMLAnchorElement>('[data-india-cta], .india-button').forEach((link) => link.addEventListener('click', () => track('india_landing_cta', { cta: link.textContent?.trim(), locale: inrLocale() })));
document.querySelectorAll<HTMLDetailsElement>('.india-faq__list details').forEach((item) => item.addEventListener('toggle', () => { if (item.open) track('india_faq_open', { question: item.querySelector('summary')?.textContent?.trim(), locale: inrLocale() }); }));
window.addEventListener('india:languagechange', () => calculators.forEach((root) => root.querySelector('input')?.dispatchEvent(new Event('input'))));
