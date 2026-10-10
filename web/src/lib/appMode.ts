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
    const add = appPlugins().App?.addListener;
    if (add) {
      void Promise.resolve(appPlugins().App!.addListener!('backButton', onBackButton)).catch((err: unknown) => captureException(err, { where: 'hf_app_back_listener' }));
    }
  } catch (err) {
    captureException(err, { where: 'hf_app_init' });
  }
}
