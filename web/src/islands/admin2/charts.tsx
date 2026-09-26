/* [ADMIN2-ANALYTICS 2026-09-26] Hand-rolled SVG/HTML chart pieces for the Admin 2
 * Analytics page. No chart library. Follows the dataviz method:
 *  - Colours are tokens (saathum-tokens.css --chart-1 teal / --chart-2 gold, validated
 *    against --card in light and dark); text always wears text tokens, never a series colour.
 *  - 2px lines, <=24px bars with a 4px rounded data-end and a 2px surface gap, recessive
 *    hairline grid, legends for >=2 series, a hover/focus tooltip on every chart, and a
 *    table view (<details>) so no value is hover-only.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { cn } from '../../lib/utils';

export const C1 = 'hsl(var(--chart-1, 190 100% 30%))';
export const C2 = 'hsl(var(--chart-2, 40 71% 42%))';
export const INK_MUTED = 'hsl(var(--muted-foreground, 193 20% 36%))';
export const GRID = 'hsl(var(--border, 38 51% 63%) / 0.35)';
export const SURFACE = 'hsl(var(--card, 42 100% 98.5%))';

const nf = new Intl.NumberFormat('en-IN');
export const fmtCount = (n: number) => nf.format(n);

/** Paise → compact rupees for axes: ₹950 · ₹1.2K · ₹3.4L · ₹1.1Cr. */
export function compactPaise(p: number): string {
  const r = p / 100;
  const a = Math.abs(r);
  const f = (v: number, s: string) => `₹${(Math.round(v * 10) / 10).toLocaleString('en-IN')}${s}`;
  if (a >= 1e7) return f(r / 1e7, 'Cr');
  if (a >= 1e5) return f(r / 1e5, 'L');
  if (a >= 1e3) return f(r / 1e3, 'K');
  return `₹${Math.round(r).toLocaleString('en-IN')}`;
}

const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLongFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
/** "2026-09-26" → "26 Sep" (the string is already an IST calendar day). */
export const shortDay = (d: string) => dayFmt.format(Date.parse(`${d}T00:00:00Z`));
export const longDay = (d: string) => dayLongFmt.format(Date.parse(`${d}T00:00:00Z`));

/** Clean axis ticks from 0 to >= max. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((e) => setW(Math.round(e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Every 1/2/7/… day so at most ~6 labels fit. */
function labelEvery(n: number, width: number): number {
  const fit = Math.max(2, Math.floor(width / 72));
  return Math.max(1, Math.ceil(n / fit));
}

/** Rounded data-end (top), square baseline. */
function colPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 90), Math.max(90, width - 90));
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-1 z-10 min-w-[150px] -translate-x-1/2 rounded-lg border border-border/60 bg-popover px-3 py-2 text-[12.5px] text-popover-foreground shadow-[var(--dash-shadow,none)]"
      style={{ left }}
    >
      {children}
    </div>
  );
}

function TipRow({ keyStyle, label, value }: { keyStyle: CSSProperties; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span aria-hidden className="h-0 w-3 shrink-0 border-t-2" style={keyStyle} />
      <span className="font-dash text-[14px] font-bold text-foreground">{value}</span>
      <span className="font-semibold text-muted-foreground">{label}</span>
    </div>
  );
}

export function LegendKey({ kind, color, dashed, label }: { kind: 'line' | 'rect'; color: string; dashed?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
      {kind === 'line'
        ? <span aria-hidden className={cn('h-0 w-4 border-t-2', dashed && 'border-dashed')} style={{ borderColor: color }} />
        : <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />}
      {label}
    </span>
  );
}

/* ── Sparkline (stat tiles) ──────────────────────────────────────────────── */

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={cn('h-7', className)} aria-hidden />;
  const max = Math.max(...values, 0) || 1;
  const n = values.length - 1;
  const pts = values.map((v, i) => `${(i / n) * 100},${28 - 2 - (v / max) * 24}`);
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cn('h-7 w-full overflow-visible', className)} aria-hidden>
      <polygon points={`0,28 ${pts.join(' ')} 100,28`} style={{ fill: C1, opacity: 0.1 }} />
      <polyline points={pts.join(' ')} vectorEffect="non-scaling-stroke"
        style={{ fill: 'none', stroke: C1, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
    </svg>
  );
}

/* ── shared keyboard/pointer index ───────────────────────────────────────── */

function useIndex(n: number, x0: number, step: number) {
  const [idx, setIdx] = useState<number | null>(null);
  const fromX = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round((clientX - r.left - x0) / step)));
  };
  const onKey = (e: KeyboardEvent, pick?: (i: number) => void) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); setIdx((i) => Math.min(n - 1, (i ?? -1) + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setIdx((i) => Math.max(0, (i ?? n) - 1)); }
    else if ((e.key === 'Enter' || e.key === ' ') && idx != null && pick) { e.preventDefault(); pick(idx); }
    else if (e.key === 'Escape') setIdx(null);
  };
  // Touch: the first tap on a day shows its tooltip, a second tap on the same day opens it.
  const tapFirst = (pointerType: string, i: number) => {
    if (pointerType !== 'touch' || idx === i) return true;
    setIdx(i);
    return false;
  };
  return { idx, setIdx, fromX, onKey, tapFirst };
}

const H = 220;
const M = { top: 12, right: 12, bottom: 26, left: 52 };

/* ── Line: this period vs previous (dashed) ─────────────────────────────── */

export function TrendLine({ days, cur, prev, format, axisFormat, label, onPick }: {
  days: string[]; cur: number[]; prev?: number[]; format: (v: number) => string; axisFormat: (v: number) => string;
  label: string; onPick?: (day: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = days.length;
  const iw = Math.max(0, width - M.left - M.right), ih = H - M.top - M.bottom;
  const ticks = useMemo(() => niceTicks(Math.max(...cur, ...(prev ?? []), 0)), [cur, prev]);
  const top = ticks[ticks.length - 1] || 1;
  const step = n > 1 ? iw / (n - 1) : 0;
  const X = (i: number) => M.left + (n > 1 ? i * step : iw / 2);
  const Y = (v: number) => M.top + ih - (v / top) * ih;
  const { idx, setIdx, fromX, onKey, tapFirst } = useIndex(n, M.left, step || 1);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${X(i)},${Y(v)}`).join('');
  const every = labelEvery(n, iw);

  return (
    <div ref={ref} className="relative w-full" style={{ height: H }}>
      {width > 0 && (
        <svg
          width={width} height={H} role="img" aria-label={label} tabIndex={0}
          className={cn('block touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md', onPick && 'cursor-pointer')}
          onPointerMove={(e) => { if (e.pointerType !== 'touch') setIdx(fromX(e.clientX, e.currentTarget)); }}
          onPointerLeave={(e) => { if (e.pointerType !== 'touch') setIdx(null); }}
          onPointerUp={(e) => { const i = fromX(e.clientX, e.currentTarget); if (tapFirst(e.pointerType, i)) onPick?.(days[i]); }}
          onKeyDown={(e) => onKey(e, onPick ? (i) => onPick(days[i]) : undefined)}
          onBlur={() => setIdx(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={Y(t)} y2={Y(t)} style={{ stroke: GRID, strokeWidth: 1 }} />
              <text x={M.left - 8} y={Y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] font-semibold tabular-nums">{axisFormat(t)}</text>
            </g>
          ))}
          {days.map((d, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2) ? (
            <text key={d} x={X(i)} y={H - 6} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'} className="fill-muted-foreground text-[11px] font-semibold">{shortDay(d)}</text>
          ) : null)}
          {n > 1 && <path d={`${line(cur)}L${X(n - 1)},${Y(0)}L${X(0)},${Y(0)}Z`} style={{ fill: C1, opacity: 0.1 }} />}
          {prev && n > 1 && <path d={line(prev)} style={{ fill: 'none', stroke: INK_MUTED, strokeWidth: 1.5, strokeDasharray: '4 4', strokeLinejoin: 'round' }} />}
          {n > 1 && <path d={line(cur)} style={{ fill: 'none', stroke: C1, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }} />}
          {idx != null && <line x1={X(idx)} x2={X(idx)} y1={M.top} y2={M.top + ih} style={{ stroke: INK_MUTED, strokeWidth: 1 }} />}
          {(idx != null ? [idx] : [n - 1]).filter((i) => i >= 0).map((i) => (
            <circle key={i} cx={X(i)} cy={Y(cur[i] ?? 0)} r={4} style={{ fill: C1, stroke: SURFACE, strokeWidth: 2 }} />
          ))}
        </svg>
      )}
      {idx != null && width > 0 && (
        <Tip x={X(idx)} width={width}>
          <div className="mb-1 font-bold text-muted-foreground">{longDay(days[idx])}</div>
          <TipRow keyStyle={{ borderColor: C1 }} label="this period" value={format(cur[idx] ?? 0)} />
          {prev && <TipRow keyStyle={{ borderColor: INK_MUTED, borderStyle: 'dashed' }} label="previous" value={format(prev[idx] ?? 0)} />}
          {onPick && <div className="mt-1 text-[11.5px] font-semibold text-muted-foreground">Click (or tap again) to open that day</div>}
        </Tip>
      )}
    </div>
  );
}

/* ── Columns by day (optionally stacked) ─────────────────────────────────── */

export interface ColSeries { key: string; label: string; color: string; values: number[] }

export function DayColumns({ days, series, format, label, onPick }: {
  days: string[]; series: ColSeries[]; format: (v: number) => string; label: string; onPick?: (day: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = days.length;
  const iw = Math.max(0, width - M.left - M.right), ih = H - M.top - M.bottom;
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const ticks = useMemo(() => niceTicks(Math.max(...totals, 0)), [totals.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = ticks[ticks.length - 1] || 1;
  const band = n ? iw / n : 0;
  const bw = Math.max(1, Math.min(24, band - 2));
  const X = (i: number) => M.left + i * band + (band - bw) / 2;
  const Y = (v: number) => M.top + ih - (v / top) * ih;
  const { idx, setIdx, onKey, tapFirst } = useIndex(n, M.left, band || 1);
  const pickAt = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor((clientX - r.left - M.left) / (band || 1))));
  };
  const every = labelEvery(n, iw);

  return (
    <div ref={ref} className="relative w-full" style={{ height: H }}>
      {width > 0 && (
        <svg
          width={width} height={H} role="img" aria-label={label} tabIndex={0}
          className={cn('block touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md', onPick && 'cursor-pointer')}
          onPointerMove={(e) => { if (e.pointerType !== 'touch') setIdx(pickAt(e.clientX, e.currentTarget)); }}
          onPointerLeave={(e) => { if (e.pointerType !== 'touch') setIdx(null); }}
          onPointerUp={(e) => { const i = pickAt(e.clientX, e.currentTarget); if (tapFirst(e.pointerType, i)) onPick?.(days[i]); }}
          onKeyDown={(e) => onKey(e, onPick ? (i) => onPick(days[i]) : undefined)}
          onBlur={() => setIdx(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={Y(t)} y2={Y(t)} style={{ stroke: GRID, strokeWidth: 1 }} />
              <text x={M.left - 8} y={Y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] font-semibold tabular-nums">{format(t)}</text>
            </g>
          ))}
          {idx != null && <rect x={M.left + idx * band} y={M.top} width={band} height={ih} style={{ fill: INK_MUTED, opacity: 0.08 }} />}
          {days.map((d, i) => {
            let base = 0;
            const segs = series.map((s, si) => {
              const v = s.values[i] ?? 0;
              if (v <= 0) return null;
              const y0 = Y(base), y1 = Y(base + v);
              base += v;
              const isTop = series.slice(si + 1).every((o) => (o.values[i] ?? 0) <= 0);
              const gap = si > 0 ? 2 : 0; // 2px surface gap between stacked segments
              const h = Math.max(0, y0 - y1 - gap);
              return isTop
                ? <path key={s.key} d={colPath(X(i), y1, bw, h)} style={{ fill: s.color }} />
                : <rect key={s.key} x={X(i)} y={y1} width={bw} height={h} style={{ fill: s.color }} />;
            });
            return <g key={d}>{segs}</g>;
          })}
          <line x1={M.left} x2={width - M.right} y1={Y(0)} y2={Y(0)} style={{ stroke: INK_MUTED, strokeWidth: 1, opacity: 0.5 }} />
          {days.map((d, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2) ? (
            <text key={d} x={X(i) + bw / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[11px] font-semibold">{shortDay(d)}</text>
          ) : null)}
        </svg>
      )}
      {idx != null && width > 0 && (
        <Tip x={X(idx) + bw / 2} width={width}>
          <div className="mb-1 font-bold text-muted-foreground">{longDay(days[idx])}</div>
          {series.length > 1 && <div className="font-dash text-[14px] font-bold text-foreground">{format(totals[idx])} total</div>}
          {series.map((s) => <TipRow key={s.key} keyStyle={{ borderColor: s.color }} label={s.label} value={format(s.values[idx] ?? 0)} />)}
          {onPick && <div className="mt-1 text-[11.5px] font-semibold text-muted-foreground">Click (or tap again) to open that day</div>}
        </Tip>
      )}
    </div>
  );
}

/* ── Horizontal bars (HTML, each row a link) ─────────────────────────────── */

export interface HBarRow { key: string; label: ReactNode; value: number; valueText: string; sub?: string; href?: string; title?: string }

export function HBars({ rows, color = C1 }: { rows: HBarRow[]; color?: string }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <ul className="grid gap-1">
      {rows.map((r) => {
        const body = (
          <div className="grid grid-cols-[minmax(84px,34%)_1fr] items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted">
            <div className="min-w-0">
              <div className="truncate text-[14px] font-bold text-foreground" title={r.title}>{r.label}</div>
              {r.sub && <div className="truncate text-[12px] font-semibold text-muted-foreground">{r.sub}</div>}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-3 min-w-[2px] rounded-r-[4px]" style={{ width: `${Math.max(1, (r.value / max) * 100) * 0.78}%`, background: color }} aria-hidden />
              <span className="shrink-0 font-dash text-[13.5px] font-bold tabular-nums text-foreground">{r.valueText}</span>
            </div>
          </div>
        );
        return <li key={r.key}>{r.href ? <a href={r.href} className="block no-underline">{body}</a> : body}</li>;
      })}
    </ul>
  );
}

/** Per-day table view (the accessible twin of a chart). */
export function DayTable({ days, cols, summary = 'Show as a table' }: {
  days: string[]; cols: { label: string; values: number[]; format: (v: number) => string }[]; summary?: string;
}) {
  return (
    <details className="mt-2 text-[13px]">
      <summary className="cursor-pointer select-none font-bold text-muted-foreground hover:text-foreground">{summary}</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border/50">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-card">
            <tr>
              <th className="px-3 py-2 font-bold text-muted-foreground">Day</th>
              {cols.map((c) => <th key={c.label} className="px-3 py-2 text-right font-bold text-muted-foreground">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d} className="border-t border-border/40">
                <td className="px-3 py-1.5 font-semibold">{longDay(d)}</td>
                {cols.map((c) => <td key={c.label} className="px-3 py-1.5 text-right font-semibold tabular-nums">{c.format(c.values[i] ?? 0)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
