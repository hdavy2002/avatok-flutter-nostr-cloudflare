// [HF-SUPPORT-SKIN] The Indian look of the support desk. Nothing new is drawn here: the flowers and the stickers are the
// site's own (islands/dashboard-hf/v3/ui.tsx, /public/hf/stickers), the page hero and the tinted number tiles follow the
// admin kit (islands/admin2/desi.tsx + styles/hf-admin-desi.css) with solid-colour buttons. Art sits in corners and never covers text.
import type { CSSProperties, ReactNode } from 'react';
import { Hibiscus, Jasmine, Lotus, Marigold as Genda, type StickerName } from '../dashboard-hf/v3/ui';
import { POSTER_STICKERS } from '../admin2/adminDesi';
import { Link } from './router';

export { Hibiscus, Jasmine, Lotus, Genda };
export type { StickerName };

export type Tone = 'rani' | 'lav' | 'gold' | 'tea' | 'plum' | 'saffron' | 'green' | 'grey';

/* ── stickers (the owner's art) ────────────────────────────────────────── */
export function Sticker({ name, w = 140, rot = -5, wiggle = false }: { name: StickerName; w?: number; rot?: number; wiggle?: boolean }) {
  // The stickers are 5-50 KB webp files, so they are served as they are (no image-resizing hop on the support host).
  const src = `/hf/stickers/${name}.webp`;
  return (
    <img
      className={`hfs-stk${POSTER_STICKERS.has(name) ? ' is-poster' : ''}${wiggle ? ' is-wiggle' : ''}`}
      src={src} alt="" width={w} loading="lazy" decoding="async" draggable={false}
      style={{ width: w, ['--rot' as string]: `${rot}deg` } as CSSProperties}
    />
  );
}

/* ── flower in a card corner ───────────────────────────────────────────── */
export type CornerKind = 'genda' | 'yellow' | 'hibiscus' | 'jasmine' | 'lotus';
export function Corner({ kind = 'genda', size = 64 }: { kind?: CornerKind; size?: number }) {
  return (
    <span className="hfs-corner" aria-hidden="true">
      {kind === 'hibiscus' ? <Hibiscus size={size * 0.8} /> : kind === 'jasmine' ? <Jasmine size={size * 0.5} /> : kind === 'lotus' ? <Lotus size={size * 1.1} /> : <Genda size={size} tone={kind === 'yellow' ? 1 : 0} />}
    </span>
  );
}

/* ── small stroke icons (24 grid) ──────────────────────────────────────── */
const PATHS = {
  inbox: 'M4 13l2-7a2 2 0 0 1 2-1.5h8a2 2 0 0 1 2 1.5l2 7v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 13h5l1 2.5h4L15 13h5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  hourglass: 'M6 3h12M6 21h12M7 3c0 6 5 6 5 9s-5 3-5 9M17 3c0 6-5 6-5 9s5 3 5 9',
  pause: 'M9 5v14M15 5v14',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16 9.5',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  spam: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9.5 9.5l5 5M14.5 9.5l-5 5',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  queue: 'M4 6h16M4 12h16M4 18h10',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  pen: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  chat: 'M4 5h16v11H9l-5 4z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 21c.8-3.5 3.5-5.5 7-5.5s6.2 2 7 5.5M17 11a3 3 0 1 0 0-6M22 21c-.6-3-2.8-5-6-5.4',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  clock: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l3 2',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  speed: 'M5 12a7 7 0 0 1 14 0M12 12l4-4M4 18h16',
  plus: 'M12 5v14M5 12h14',
  mail: 'M3 6h18v12H3zM3 7l9 7 9-7',
  star: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z',
  back: 'M19 12H5M11 6l-6 6 6 6',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
} as const;
export type IconName = keyof typeof PATHS;
export function NavIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={PATHS[name]} /></svg>;
}
/** A tinted square with an icon in it (the dashboard's "icon tile"). */
export function IconTile({ name, tone = 'lav', size = 20 }: { name: IconName; tone?: Tone; size?: number }) {
  return <span className={`hfs-ic hfs-ic--${tone}`} aria-hidden="true"><NavIcon name={name} size={size} /></span>;
}

/* ── page hero: tinted wash, ghost word, flowers and one sticker ───────── */
export function PageHero({ tone = 'lav', eyebrow, title, sub, ghost, sticker, rot = -5, children }: {
  tone?: 'saffron' | 'rani' | 'lav' | 'tea' | 'gold' | 'plum'; eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; ghost?: string; sticker?: StickerName; rot?: number; children?: ReactNode;
}) {
  return (
    <section className="hfs-hero" data-tone={tone}>
      {ghost && <span className="hfs-hero__ghost" aria-hidden="true">{ghost}</span>}
      <div className="hfs-hero__text">
        {eyebrow && <p className="hfs-hero__eyebrow">{eyebrow}</p>}
        <h1 className="hfs-hero__h1">{title}</h1>
        {sub && <p className="hfs-hero__sub">{sub}</p>}
        {children && <div className="hfs-hero__acts">{children}</div>}
      </div>
      <div className="hfs-hero__art" aria-hidden="true">
        <span className="f1"><Genda size={120} /></span>
        <span className="f2"><Genda size={70} tone={1} /></span>
        <span className="f3"><Hibiscus size={60} /></span>
        {sticker && <Sticker name={sticker} w={150} rot={rot} wiggle />}
      </div>
    </section>
  );
}

/* ── coloured number tile ──────────────────────────────────────────────── */
export function Kpi({ tone = 'rani', label, value, sub, icon, to, corner = true, alert }: {
  tone?: Exclude<Tone, 'saffron' | 'green' | 'grey'>; label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: IconName; to?: string; corner?: boolean; alert?: boolean;
}) {
  const body = (
    <>
      {corner && <Corner kind={tone === 'plum' ? 'yellow' : 'genda'} size={58} />}
      {icon && <IconTile name={icon} tone={tone === 'plum' ? 'saffron' : tone} />}
      <span className="hfs-kpi__lbl">{label}</span>
      <span className="hfs-kpi__big">{value}</span>
      {sub && <span className="hfs-kpi__sub">{sub}</span>}
    </>
  );
  const cls = `hfs-kpi hfs-k-${tone}${alert ? ' is-alert' : ''}${to ? ' is-link' : ''}`;
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

/* ── a card with a flower in the corner and an optional coloured wash ──── */
export function DeskCard({ tone, corner, title, note, action, className = '', children, id }: {
  tone?: 'rani' | 'lav' | 'gold' | 'tea' | 'cream'; corner?: CornerKind; title?: ReactNode; note?: ReactNode; action?: ReactNode; className?: string; children?: ReactNode; id?: string;
}) {
  return (
    <section id={id} className={`hfs-card${tone ? ` hfs-t-${tone}` : ''}${corner ? ' has-corner' : ''} ${className}`.trim()}>
      {corner && <Corner kind={corner} />}
      {(title || action) && (
        <div className="hfs-card__top">
          <div>{title && <h2 className="hfs-card__title">{title}</h2>}{note && <p className="hfs-card__note">{note}</p>}</div>
          {action && <div className="hfs-card__act">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The marigold garland (toran) that hangs under the sign-in header. */
export function Toran() {
  return <div className="hfs-toran" aria-hidden="true" />;
}
