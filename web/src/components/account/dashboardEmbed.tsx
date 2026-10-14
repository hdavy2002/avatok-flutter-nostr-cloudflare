/* [HF-DASH-SHELL-2] Lets an existing full-page island render as a panel inside the dashboard shell.
 * Standalone (default): the island renders its own <main> exactly as before. Embedded: a plain <div>, no own
 * session bridge, no "back to dashboard" links; the shell owns those. */
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { isAppMode } from '../../lib/nativeBridge';

export const DashboardEmbed = createContext(false);
export const useEmbedded = () => useContext(DashboardEmbed);

export function PageShell({ className, children, ...rest }: { className?: string; children?: ReactNode; 'aria-busy'?: boolean }) {
  const embedded = useEmbedded();
  return embedded
    ? <div className={`${className ?? ''} hfd-embedded`} {...rest}>{children}</div>
    : <main className={className} {...rest}>{children}</main>;
}

/** On the plain website, an old standalone page (/wallet, /bookings, ...) moves the visitor into the dashboard
 * screen that now holds it. Inside the app shell the standalone page stays, because the app opens it directly. */
export function useIntoDashboard(target: string | null) {
  const embedded = useEmbedded();
  useEffect(() => {
    if (embedded || !target) return;
    try { if (isAppMode()) return; } catch { return; }
    if (location.pathname === target.split('#')[0]) return;
    // Keep ?query (e.g. a top-up return_to) and, unless the target names its own section, the #hash.
    const [path, hash] = target.split('#');
    location.replace(`${path}${location.search}${hash ? `#${hash}` : hash === "" ? "" : location.hash}`);
  }, [embedded, target]);
}
