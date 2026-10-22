/* [HF-ADMIN-DESI-2] Admin desi kit — the dashboard's look (styles/hf-dash3.css) for every admin screen.
 * Coloured KPI tiles, flower-cornered cards, bank slips, bahi-khata paper, order journeys, people cards, ticker, lotus empty state.
 * Styles: styles/hf-admin-desi.css (all under .hf-admin). Flowers are the dashboard's SVGs. Owner rule: no green, no text under 14px,
 * fluid type, full width, never a plain white box: every card gets a tone, a flower or a pattern. */
import type { ReactNode } from 'react';
import { Hibiscus, Jasmine, Lotus, Marigold } from '../dashboard-hf/v3/ui';
import { cn } from '../../lib/utils';

export { Hibiscus, Jasmine, Lotus, Marigold };

export type Tone = 'white' | 'plum' | 'rani' | 'lav' | 'tea' | 'gold' | 'saffron' | 'cream';
export type Corner = 'marigold' | 'yellow' | 'hibiscus' | 'jasmine' | 'none';

function CornerArt({ corner, size = 78 }: { corner: Corner; size?: number }) {
  if (corner === 'none') return null;
  return (
    <span className="hfa-corner" aria-hidden="true">
      {corner === 'hibiscus' ? <Hibiscus size={size * 0.8} /> : corner === 'jasmine' ? <Jasmine size={size * 0.5} /> : <Marigold size={size} tone={corner === 'yellow' ? 1 : 0} />}
    </span>
  );
}

/** Section title with its marigold. */
export function DesiTitle({ children, tone = 0, as: As = 'h2' }: { children: ReactNode; tone?: 0 | 1; as?: 'h2' | 'h3' }) {
  return <As className="hfa-title"><Marigold size={22} tone={tone} />{children}</As>;
}

/** The workhorse card: tone wash, optional flower corner, title row with an action on the right. */
export function DesiCard({ title, note, action, tone = 'white', corner = 'none', children, className, id, pattern }: {
  title?: ReactNode; note?: ReactNode; action?: ReactNode; tone?: Tone; corner?: Corner; children?: ReactNode; className?: string; id?: string;
  /** Background texture: 'stripes' (safety/caution), 'dots' (rangoli dots), 'bahi' (ruled ledger paper). */
  pattern?: 'stripes' | 'dots' | 'bahi';
}) {
  return (
    <section id={id} className={cn('hfa-card', `hfa-t-${tone}`, pattern && `hfa-p-${pattern}`, className)}>
      <CornerArt corner={corner} />
      {(title || action) && (
        <div className="hfa-card-top">
          <div className="min-w-0">{title && <DesiTitle tone={tone === 'plum' ? 1 : 0}>{title}</DesiTitle>}{note && <div className="hfa-note">{note}</div>}</div>
          {action && <div className="hfa-card-act">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Coloured number tile. The first tile on a screen is usually tone="plum" (the hero number) with a marigold corner. */
export function DesiKpi({ label, value, sub, tone = 'rani', icon, corner, alert, onClick }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Exclude<Tone, 'white' | 'cream'>; icon?: ReactNode; corner?: boolean; alert?: boolean; onClick?: () => void;
}) {
  const body = (
    <>
      {(corner ?? tone === 'plum') && <CornerArt corner={tone === 'plum' ? 'yellow' : 'marigold'} size={64} />}
      {icon && <span className="hfa-kpi-ic" aria-hidden="true">{icon}</span>}
      <span className="hfa-kpi-lbl">{label}</span>
      <span className="hfa-kpi-big">{value}</span>
      {sub && <span className="hfa-kpi-sub">{sub}</span>}
    </>
  );
  const cls = cn('hfa-kpi', `hfa-k-${tone}`, alert && 'is-alert', onClick && 'is-btn');
  return onClick ? <button type="button" className={cls} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>;
}
export function DesiKpis({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('hfa-kpis', className)}>{children}</div>;
}

export function DesiChip({ tone = 'tea', children, className }: { tone?: 'tea' | 'gold' | 'rani' | 'lav' | 'grey' | 'plum' | 'red'; children: ReactNode; className?: string }) {
  return <span className={cn('hfa-chip', `hfa-c-${tone}`, className)}>{children}</span>;
}

export function DesiEmpty({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return <div className="hfa-empty"><Lotus size={84} /><p>{text}</p>{children}</div>;
}

/** Red "breaking news" strip like the dashboard's. Items scroll; hover pauses. */
export function DesiTicker({ label = 'Aaj ki khabar', items }: { label?: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div className="hfa-ticker" role="status">
      <span className="hfa-ticker-tag"><i aria-hidden="true" />{label}</span>
      <div className="hfa-ticker-lane"><div className="hfa-ticker-run">{items.map((t, i) => <span key={i}>{t}</span>)}{items.map((t, i) => <span key={`b${i}`} aria-hidden="true">{t}</span>)}</div></div>
    </div>
  );
}

/** A bank-slip / receipt card: striped header strip, punched sides, body, actions row. For money items waiting on a decision. */
export function DesiSlip({ strip, stripRight, tone = 'gold', children, actions, className }: {
  strip: ReactNode; stripRight?: ReactNode; tone?: 'gold' | 'tea' | 'rani' | 'lav'; children: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <article className={cn('hfa-slip', `hfa-slip-${tone}`, className)}>
      <div className="hfa-slip-strip"><b>{strip}</b>{stripRight}</div>
      <span className="hfa-punch l" aria-hidden="true" /><span className="hfa-punch r" aria-hidden="true" />
      <div className="hfa-slip-body">{children}</div>
      {actions && <div className="hfa-slip-acts">{actions}</div>}
    </article>
  );
}

/** Two-up "says" boxes inside a slip: who claims what vs what the record shows. */
export function DesiSays({ k, v, note, tone = 'lav' }: { k: ReactNode; v: ReactNode; note?: ReactNode; tone?: 'lav' | 'tea' | 'none' | 'gold' }) {
  return <div className={cn('hfa-says', `hfa-says-${tone}`)}><div className="k">{k}</div><div className="v">{v}</div>{note && <div className="hfa-note">{note}</div>}</div>;
}

/** Step track: round coloured medallions joined by a dashed thread (order journeys, payout steps, KYC steps). */
export function DesiJourney({ steps, label }: { label: string; steps: { title: ReactNode; note?: ReactNode; tone?: 'rani' | 'lav' | 'gold' | 'tea' | 'plum'; icon?: ReactNode; done?: boolean }[] }) {
  return (
    <ol className="hfa-journey" aria-label={label} style={{ ['--n' as string]: steps.length }}>
      {steps.map((s, i) => (
        <li key={i} className={cn('hfa-stop', `hfa-stop-${s.tone ?? 'lav'}`, s.done && 'is-done')}>
          <span className="hfa-stop-dot" aria-hidden="true">{s.icon ?? i + 1}</span>
          <b>{s.title}</b>{s.note && <span className="hfa-note">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Person card with a coloured band and a marigold-ringed avatar. */
const AV = ['#d81b72', '#6d4fd0', '#0e7c86', '#ea6a12', '#4a1747', '#b45309', '#c0262d'];
export const avatarColour = (s: string) => AV[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];
export function DesiAvatar({ name, seed, photo, size = 44 }: { name?: string | null; seed: string; photo?: string | null; size?: number }) {
  const ini = (String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => Array.from(w)[0] ?? '').join('') || '?').toUpperCase();
  if (photo) return <img className="hfa-av" src={photo} alt="" width={size} height={size} style={{ width: size, height: size }} loading="lazy" />;
  return <span className="hfa-av" style={{ width: size, height: size, background: avatarColour(seed), fontSize: size * 0.38 }} aria-hidden="true">{ini}</span>;
}
export function DesiPersonCard({ band = 'tea', avatar, title, sub, chips, meta, children, onClick, selected }: {
  band?: 'tea' | 'lav' | 'rani' | 'gold' | 'grey' | 'plum'; avatar: ReactNode; title: ReactNode; sub?: ReactNode; chips?: ReactNode; meta?: ReactNode; children?: ReactNode; onClick?: () => void; selected?: boolean;
}) {
  const inner = (
    <>
      <span className={cn('hfa-pc-band', `hfa-band-${band}`)} aria-hidden="true" />
      <span className="hfa-pc-in">
        <span className="hfa-pc-av">{avatar}</span>
        <b className="hfa-pc-title">{title}</b>
        {sub && <span className="hfa-note">{sub}</span>}
        {chips && <span className="hfa-pc-chips">{chips}</span>}
        {meta && <span className="hfa-pc-meta">{meta}</span>}
        {children}
      </span>
    </>
  );
  return onClick
    ? <button type="button" className={cn('hfa-pc', selected && 'is-sel')} onClick={onClick}>{inner}</button>
    : <article className={cn('hfa-pc', selected && 'is-sel')}>{inner}</article>;
}

/** Big plum/rani counter block (e.g. "2 payments waiting"). */
export function DesiCounter({ eyebrow, value, label, children, tone = 'plum' }: { eyebrow?: ReactNode; value: ReactNode; label: ReactNode; children?: ReactNode; tone?: 'plum' | 'rani' | 'tea' }) {
  return (
    <section className={cn('hfa-counter', `hfa-counter-${tone}`)}>
      <CornerArt corner="marigold" size={120} />
      {eyebrow && <div className="hfa-eyebrow">{eyebrow}</div>}
      <div className="hfa-counter-row"><span className="hfa-counter-num">{value}</span><span className="hfa-counter-lbl">{label}</span></div>
      {children}
    </section>
  );
}

/** Row of jasmine with a marigold every fourth — a soft divider. */
export function DesiMogra({ n = 11 }: { n?: number }) {
  return <div className="hfa-mogra" aria-hidden="true">{Array.from({ length: n }, (_, i) => i % 4 === 3 ? <Marigold key={i} size={18} tone={1} /> : <Jasmine key={i} size={18} />)}</div>;
}
