/* [HF-HOST-POLISH-1] Bridge to the future Capacitor app wrapper. No npm deps: plugins are read from window.Capacitor.
 * Everything here is safe on the plain web: nothing throws when Capacitor or a plugin is missing.
 * See Specs/HF-APP-DEEPLINK.md for what the app project must configure. */
import { BRAND } from './brand';

interface Handle { remove?: () => unknown }
export interface CapPlugins {
  Browser?: {
    open?: (o: { url: string; presentationStyle?: string }) => unknown;
    close?: () => unknown;
    addListener?: (e: string, cb: () => void) => unknown;
  };
  App?: {
    addListener?: (e: string, cb: (d: { url?: string; canGoBack?: boolean }) => void) => unknown;
    exitApp?: () => unknown;
  };
}
interface CapacitorGlobal { isNativePlatform?: () => boolean; Plugins?: CapPlugins }
const cap = (): CapacitorGlobal | undefined => {
  try { return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor; } catch { return undefined; }
};

export function isNativeApp(): boolean {
  try { return !!cap()?.isNativePlatform?.(); } catch { return false; }
}

/** Custom URL scheme of the app: first label of the domain, e.g. "<name>://". */
export function appScheme(): string {
  return `${BRAND.domain.split('.')[0]}://`;
}

/** Open an auth page (DigiLocker) in the in-app browser and call onDone once when it hands back to the app.
 * Returns a cleanup. Falls back to a normal full-page redirect when the Browser plugin is missing. */
export function openAuthInApp(url: string, onDone: () => void): () => void {
  const plugins = cap()?.Plugins;
  const browser = plugins?.Browser;
  if (!browser?.open) { window.location.assign(url); return () => {}; }
  let finished = false;
  const handles: Promise<Handle | undefined>[] = [];
  const cleanup = () => {
    for (const h of handles) void h.then(x => { try { x?.remove?.(); } catch { /* ignore */ } }, () => {});
    handles.length = 0;
  };
  const done = () => { if (finished) return; finished = true; cleanup(); try { onDone(); } catch { /* ignore */ } };
  const listen = (add: unknown) => { handles.push(Promise.resolve(add).catch(() => undefined) as Promise<Handle | undefined>); };
  try {
    listen(browser.addListener?.('browserFinished', done));
    listen(plugins?.App?.addListener?.('appUrlOpen', ({ url: u }) => {
      if (u && u.includes('dl=return')) {
        try { void Promise.resolve(browser.close?.()).catch(() => {}); } catch { /* ignore */ }
        done();
      }
    }));
    void Promise.resolve(browser.open({ url, presentationStyle: 'fullscreen' })).catch(() => { cleanup(); window.location.assign(url); });
  } catch {
    cleanup();
    window.location.assign(url);
  }
  return cleanup;
}

/* [HF-APP-3] App mode: the site running inside the Android shell (Capacitor wrapper that loads this site).
 * The shell appends " HelloFraandsApp/<shellVersion>" to the user agent. Everything here is safe on the plain web. */

/** User-agent marker the shell appends. Also read by the inline boot script in the site header (before first paint). */
export const APP_UA_MARKER = 'HelloFraandsApp/';

const ua = (): string => {
  try { return navigator.userAgent || ''; } catch { return ''; }
};

/** True inside the app shell: Capacitor native platform OR the shell's user-agent marker. */
export function isAppMode(): boolean {
  return isNativeApp() || ua().includes(APP_UA_MARKER);
}

/** Shell version from the user agent ("HelloFraandsApp/3" -> 3). 0 when unknown (older shell or plain web). */
export function appShellVersion(): number {
  const m = ua().match(/HelloFraandsApp\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Native plugin handles used by app mode (all optional; callers must guard). */
export function appPlugins(): CapPlugins {
  return cap()?.Plugins ?? {};
}
