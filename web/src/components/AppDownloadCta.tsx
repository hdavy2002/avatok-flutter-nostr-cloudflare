/* AppDownloadCta — the "get the app" band used across the public funnel
 * (booking confirmation, event/watch pages, creator pages).
 *
 * Product stance (web = public top-of-funnel, app = full experience): fans can
 * already watch in the browser, so this is framed as an UPGRADE, not a gate. A
 * store button only renders when its URL is configured (see config.ts), so the
 * component degrades cleanly to nothing while listings are still private —
 * no dead links to the Play/App Store before they're public.
 */
import { PLAY_STORE_URL, APP_STORE_URL, HAS_NATIVE_APP } from '../lib/config';

export interface AppDownloadCtaProps {
  /** Headline; defaults to the watch-focused copy. */
  title?: string;
  /** Sub-line under the headline. */
  subtitle?: string;
  /** Tighter, borderless variant for inline use under a viewer link. */
  compact?: boolean;
  className?: string;
}

function StoreLink({ href, store }: { href: string; store: 'play' | 'app' }) {
  const label = store === 'play' ? 'Get it on Google Play' : 'Download on the App Store';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-zine border-zine border-ink bg-ink px-4 py-2.5 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-paper shadow-zine-sm transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
    >
      {store === 'play' ? '▶' : ''} {label}
    </a>
  );
}

export function AppDownloadCta({
  title = 'Get the app for the full experience',
  subtitle = 'Watch right here in your browser — or download the app for live chat, reminders and the best viewing.',
  compact = false,
  className = '',
}: AppDownloadCtaProps) {
  // Nothing to link to yet → render nothing rather than a dead button.
  if (!HAS_NATIVE_APP) return null;

  const wrap = compact
    ? 'flex flex-col gap-3'
    : 'flex flex-col gap-3 rounded-zine border-zine border-ink bg-card p-[18px] shadow-zine-sm';

  return (
    <div className={[wrap, className].join(' ')}>
      {!compact && (
        <div className="flex flex-col gap-1">
          <h3 className="font-display font-semibold text-[18px] text-ink">{title}</h3>
          <p className="font-body font-bold text-[14px] text-inkSoft">{subtitle}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {PLAY_STORE_URL && <StoreLink href={PLAY_STORE_URL} store="play" />}
        {APP_STORE_URL && <StoreLink href={APP_STORE_URL} store="app" />}
      </div>
    </div>
  );
}

export default AppDownloadCta;
