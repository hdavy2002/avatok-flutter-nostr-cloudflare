/* [HF-APP-3] App mode runtime: Android back button, external links, telemetry. Runs only inside the app shell
 * (isAppMode()); on the plain web initAppMode() returns at once. Every plugin call is guarded: a missing plugin never throws. */
import { BRAND, isBrandHost } from './brand';
import { appPlugins, appShellVersion, isAppMode } from './nativeBridge';
import { capture, captureException, registerSuperProps } from './analytics';

let started = false;
let exitSheet: HTMLElement | null = null;

const OPEN_KEY = 'hf_app_open_sent';
let openSentInMemory = false;

/** hf_app_open once per session (sessionStorage; falls back to memory when storage is blocked). */
function sendOpenOnce(shell: number): void {
  let seen = openSentInMemory;
  try { seen = seen || sessionStorage.getItem(OPEN_KEY) === '1'; } catch { /* storage blocked: memory flag only */ }
  if (seen) return;
  openSentInMemory = true;
  try { sessionStorage.setItem(OPEN_KEY, '1'); } catch { /* ignore */ }
  capture('hf_app_open', { platform: 'android-app', shell_version: shell });
}

/* ── Exit sheet (no window.confirm / alert) ─────────────────────────────── */
function closeExitSheet(): void {
  exitSheet?.remove();
  exitSheet = null;
}

function showExitSheet(): void {
  if (exitSheet) return;
  const wrap = document.createElement('div');
  wrap.className = 'hf-exit-wrap';
  wrap.innerHTML =
    '<div class="hf-exit-sheet" role="alertdialog" aria-modal="true" aria-labelledby="hf-exit-title">' +
    '<h2 id="hf-exit-title"></h2>' +
    '<div class="hf-exit-actions"><button type="button" class="hf-exit-stay">Stay</button><button type="button" class="hf-exit-yes">Exit</button></div>' +
    '</div>';
  wrap.querySelector('#hf-exit-title')!.textContent = `Exit ${BRAND.name}?`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeExitSheet(); });
  wrap.querySelector('.hf-exit-stay')!.addEventListener('click', closeExitSheet);
  wrap.querySelector('.hf-exit-yes')!.addEventListener('click', () => {
    capture('hf_app_back_exit');
    closeExitSheet();
    try { void Promise.resolve(appPlugins().App?.exitApp?.()).catch(() => {}); } catch { /* ignore */ }
  });
  document.body.appendChild(wrap);
  exitSheet = wrap;
  (wrap.querySelector('.hf-exit-stay') as HTMLElement).focus();
}

function onBackButton(): void {
  if (exitSheet) { closeExitSheet(); return; }
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && history.length > 1) { history.back(); return; }
  showExitSheet();
}

/* ── External links ─────────────────────────────────────────────────────── */
const SYSTEM_SCHEMES = new Set(['tel:', 'sms:', 'mailto:', 'whatsapp:', 'intent:', 'geo:']);

function isWhatsAppHost(host: string): boolean {
  return host === 'wa.me' || host === 'whatsapp.com' || host.endsWith('.whatsapp.com');
}

function openOutside(url: string): void {
  const browser = appPlugins().Browser;
  if (browser?.open) {
    try { void Promise.resolve(browser.open({ url })).catch(() => { window.open(url, '_blank', 'noopener'); }); return; } catch { /* fall through */ }
  }
  window.open(url, '_blank', 'noopener');
}

function onLinkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || a.hasAttribute('download')) return;
  let u: URL;
  try { u = new URL(a.getAttribute('href') || '', location.href); } catch { return; }
  if (SYSTEM_SCHEMES.has(u.protocol)) {
    e.preventDefault();
    capture('hf_app_external_link', { host: u.protocol.replace(':', '') });
    location.href = u.href;
    return;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
  const host = u.hostname.toLowerCase();
  if (isBrandHost(host)) return; // site, api, auth and media hosts stay inside the app
  e.preventDefault();
  capture('hf_app_external_link', { host });
  if (isWhatsAppHost(host)) location.href = u.href; // the OS routes it to WhatsApp
  else openOutside(u.href);
}

/* ── [HF-APP-LINKS-1] Brand links open the app ──────────────────────────────
 * The manifest claims every https link on the site host (apex + www), so a link in an email, WhatsApp or SMS lands
 * here as App.appUrlOpen (app running) or App.getLaunchUrl() (cold start). The WebView then loads that page.
 * Same-site only: other hosts, other schemes and the DigiLocker return (dl=return, handled in nativeBridge.ts, which
 * closes the in-app browser) are ignored here, so nothing is handled twice. */
const DEEPLINK_DYNAMIC_FIRST = new Set(['review', 'h', 'people', 'verify', 'book', 'watch', 'l', 'c', 'e', 'i', 'j']);

/** Path safe to send to analytics: tokens, slugs and ids never leave the device (/review/<token> -> /review/:id). */
export function deepLinkTelemetryPath(path: string): string {
  const seg = path.split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (!seg.length) return '/';
  if (DEEPLINK_DYNAMIC_FIRST.has(seg[0])) return seg.length > 1 ? `/${seg[0]}/:id` : `/${seg[0]}`;
  return '/' + seg.slice(0, 2).join('/');
}

/** Path+query+hash to open for an incoming https link, or null when it is not ours to handle. www is folded onto
 * the apex so the WebView keeps one origin (and its sign-in). */
export function deepLinkTarget(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || (host !== BRAND.domain && host !== `www.${BRAND.domain}`)) return null;
  if (u.search.includes('dl=return')) return null; // DigiLocker return: nativeBridge.openAuthInApp owns it
  if (/^\/hosts\/kyc\/return(\/|$)/.test(u.pathname)) return null; // same flow, https form
  return u.pathname + u.search + u.hash;
}

function openDeepLink(raw: string | undefined | null, launch: 'cold' | 'warm'): void {
  try {
    const target = deepLinkTarget(raw);
    if (!target) return;
    const here = location.pathname + location.search + location.hash;
    capture('hf_app_deeplink_opened', { path: deepLinkTelemetryPath(target), launch });
    if (target === here || (launch === 'cold' && target === '/')) return;
    location.href = BRAND.webOrigin + target;
  } catch (err) {
    captureException(err, { where: 'hf_app_deeplink' });
  }
}

/** getLaunchUrl keeps returning the same URL on every page load of this app process; act on it only on the first
 * load (sessionStorage lives as long as the WebView). Storage blocked: skip, a missed cold link beats a redirect loop. */
function launchNotHandledYet(): boolean {
  try {
    if (sessionStorage.getItem('hf_launch_url_done') === '1') return false;
    sessionStorage.setItem('hf_launch_url_done', '1');
    return true;
  } catch { return false; }
}

function wireDeepLinks(): void {
  const app = appPlugins().App;
  if (app?.addListener) {
    void Promise.resolve(app.addListener('appUrlOpen', (d) => openDeepLink(d?.url, 'warm'))).catch((err: unknown) => captureException(err, { where: 'hf_app_deeplink_listener' }));
  }
  if (app?.getLaunchUrl && launchNotHandledYet()) {
    void Promise.resolve(app.getLaunchUrl()).then((r) => openDeepLink(r?.url, 'cold')).catch(() => {});
  }
}

/** Wire everything once. Safe to call on every page; does nothing outside the app. */
export function initAppMode(): void {
  if (started || typeof window === 'undefined' || !isAppMode()) return;
  started = true;
  try {
    const shell = appShellVersion();
    registerSuperProps({ platform: 'android-app', shell_version: shell });
    sendOpenOnce(shell);
    document.addEventListener('click', onLinkClick, true);
    void import('./appPush').then((m) => m.initAppPush()).catch((err: unknown) => captureException(err, { where: 'hf_app_init' })); // [HF-APP-4]
    wireDeepLinks(); // [HF-APP-LINKS-1]
    const add = appPlugins().App?.addListener;
    if (add) {
      void Promise.resolve(appPlugins().App!.addListener!('backButton', onBackButton)).catch((err: unknown) => captureException(err, { where: 'hf_app_back_listener' }));
    }
  } catch (err) {
    captureException(err, { where: 'hf_app_init' });
  }
}
