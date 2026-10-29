// [HF-SUPPORT-DESK] Reports: number tiles + plain-SVG bar charts (no chart library). Range 7 / 30 / 90 days.
// [HF-SUPPORT-SKIN] Colour hero, tinted number tiles, flower-cornered chart cards. The charts measure their own box, so their
// text keeps a real 13 px size on a phone instead of shrinking with the picture.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { adminApi, errMessage } from './api';
import { DeskCard, Kpi, PageHero } from './desi';
import { categoryLabel } from './types';
import type { ReportData } from './types';
import { SubHeader } from './staff';
import { setQuery, useLoc } from './router';
import { ErrorBox, Spinner } from './ui';

const RANGES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']] as const;
const CREATED = '#6D4FD0';
const SOLVED = '#0E7C86';

function niceMax(n: number): number {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / p) * p;
}
const shortDay = (d: string): string => {
  const x = new Date(`${d}T00:00:00`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/** The pixel width of a box, kept up to date (so a chart can draw itself at 1:1 and keep its text readable). */
function useBoxWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(260, Math.floor(el.getBoundingClientRect().width)));
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function DayChart({ data }: { data: ReportData['perDay'] }) {
  const [box, W] = useBoxWidth();
  const H = W < 480 ? 230 : 280, L = 36, B = 34, T = 12, R = 8;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => [d.created, d.solved])));
  const cw = (W - L - R) / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(18, cw * 0.36));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor((W - L) / 64))));
  return (
    <div ref={box} className="hfs-chartbox">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tickets created and solved per day" className="hfs-svg">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="#E9DCC9" strokeWidth="1" strokeDasharray={f === 0 ? undefined : '4 5'} />
            <text x={L - 6} y={y(max * f) + 4} textAnchor="end" fontSize="13" fill="#6F5B6F">{Math.round(max * f)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = L + cw * i + cw / 2;
          return (
            <g key={d.day}>
              <title>{`${shortDay(d.day)}: ${d.created} created, ${d.solved} solved`}</title>
              <rect x={x - bw - 1} y={y(d.created)} width={bw} height={Math.max(0, H - B - y(d.created))} rx="4" fill={CREATED} />
              <rect x={x + 1} y={y(d.solved)} width={bw} height={Math.max(0, H - B - y(d.solved))} rx="4" fill={SOLVED} />
              {i % every === 0 && <text x={x} y={H - 10} textAnchor="middle" fontSize="13" fill="#6F5B6F">{shortDay(d.day)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const BAR_COLOURS = ['#6D4FD0', '#0E7C86', '#D81B72', '#F59E0B', '#EA6A12', '#4A1747', '#8A6BE0', '#16A3AD'];

function CategoryChart({ data }: { data: ReportData['byCategory'] }) {
  const [box, W] = useBoxWidth();
  const rows = [...data].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const RH = 38;
  const L = W < 420 ? 112 : 150;
  const H = rows.length * RH + 6;
  return (
    <div ref={box} className="hfs-chartbox">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tickets by category" className="hfs-svg">
        {rows.map((r, i) => {
          const w = ((W - L - 44) * r.count) / max;
          return (
            <g key={r.category}>
              <text x={L - 10} y={i * RH + 24} textAnchor="end" fontSize="14" fontWeight="700" fill="#2B1530">{categoryLabel(r.category)}</text>
              <rect x={L} y={i * RH + 8} width={Math.max(3, w)} height="22" rx="8" fill={BAR_COLOURS[i % BAR_COLOURS.length]} />
              <text x={L + Math.max(3, w) + 8} y={i * RH + 25} fontSize="14" fontWeight="800" fill="#2B1530">{r.count}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function mins(n: number | null): string {
  if (n == null) return '–';
  if (n < 60) return `${Math.round(n)} min`;
  const h = n / 60;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

export default function AdminReports() {
  const loc = useLoc();
  const range = (RANGES.find((r) => r[0] === loc.params.get('range'))?.[0]) ?? '30d';
  const [d, setD] = useState<ReportData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setD(null); setErr(null);
    adminApi.reports(range).then(setD).catch((e) => setErr(errMessage(e, 'Could not load the report.')));
  };
  useEffect(load, [range]);

  const tiles: { label: string; value: string; tone: 'lav' | 'tea' | 'gold' | 'rani' | 'plum'; icon: 'inbox' | 'check' | 'layers' | 'clock' | 'star' }[] = d ? [
    { label: 'Created', value: String(d.totals.created), tone: 'plum', icon: 'inbox' },
    { label: 'Solved', value: String(d.totals.solved), tone: 'tea', icon: 'check' },
    { label: 'Open right now', value: String(d.totals.open), tone: 'gold', icon: 'layers' },
    { label: 'Average first reply', value: mins(d.totals.firstReplyMinutes), tone: 'lav', icon: 'clock' },
    { label: 'Replied within target', value: d.totals.slaMetPct == null ? '–' : `${Math.round(d.totals.slaMetPct)}%`, tone: 'rani', icon: 'star' },
  ] : [];

  return (
    <div className="hfs hfs-admin">
      <SubHeader back="Support desk" backTo="/desk" title="Reports" />
      <div className="hfs-wrap hfs-in">
        <PageHero tone="gold" eyebrow="Support desk" title="Reports" ghost="Hisaab" sticker="kyabaat" rot={5} sub="Hisaab-kitaab, ek nazar mein">
          <label className="hfs-sr" htmlFor="hfs-range">Date range</label>
          <label className="hfs-select is-set">
            <select id="hfs-range" value={range} onChange={(e) => setQuery({ range: e.target.value })}>
              {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </PageHero>
        {err && <ErrorBox message={err} onRetry={load} />}
        {!d && !err && <div className="hfs-center"><Spinner /></div>}
        {d && (
          <>
            <div className="hfs-kpis hfs-kpis--five">
              {tiles.map((t) => (<Kpi key={t.label} tone={t.tone} icon={t.icon} label={t.label} value={t.value} />))}
            </div>
            <div className="hfs-reportgrid">
              <DeskCard tone="lav" corner="genda" className="hfs-chartcard" title="Tickets per day" action={<>
                <span className="hfs-legend"><i style={{ background: CREATED }} />Created</span>
                <span className="hfs-legend"><i style={{ background: SOLVED }} />Solved</span>
              </>}>
                {d.perDay.length ? <DayChart data={d.perDay} /> : <p className="hfs-fineprint">No tickets in this range.</p>}
              </DeskCard>
              <DeskCard tone="gold" corner="hibiscus" className="hfs-chartcard" title="By category">
                {d.byCategory.length ? <CategoryChart data={d.byCategory} /> : <p className="hfs-fineprint">No tickets in this range.</p>}
              </DeskCard>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
