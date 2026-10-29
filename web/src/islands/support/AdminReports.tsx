// [HF-SUPPORT-DESK] Reports: number tiles + plain-SVG bar charts (no chart library). Range 7 / 30 / 90 days.
import { useEffect, useState } from 'react';
import { adminApi, errMessage } from './api';
import { categoryLabel } from './types';
import type { ReportData } from './types';
import { SubHeader } from './staff';
import { setQuery, useLoc } from './router';
import { ErrorBox, Spinner } from './ui';

const RANGES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']] as const;
const CREATED = '#6D4FD0';
const SOLVED = '#1F9D55';

function niceMax(n: number): number {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / p) * p;
}
const shortDay = (d: string): string => {
  const x = new Date(`${d}T00:00:00`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

function DayChart({ data }: { data: ReportData['perDay'] }) {
  const W = 760, H = 260, L = 34, B = 30, T = 10, R = 8;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => [d.created, d.solved])));
  const cw = (W - L - R) / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(18, cw * 0.36));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(data.length / 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tickets created and solved per day" className="hfs-svg">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="#E4D6C2" strokeWidth="1" />
          <text x={L - 6} y={y(max * f) + 4} textAnchor="end" fontSize="11" fill="#6F5B6F">{Math.round(max * f)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = L + cw * i + cw / 2;
        return (
          <g key={d.day}>
            <title>{`${shortDay(d.day)}: ${d.created} created, ${d.solved} solved`}</title>
            <rect x={x - bw - 1} y={y(d.created)} width={bw} height={Math.max(0, H - B - y(d.created))} rx="3" fill={CREATED} />
            <rect x={x + 1} y={y(d.solved)} width={bw} height={Math.max(0, H - B - y(d.solved))} rx="3" fill={SOLVED} />
            {i % every === 0 && <text x={x} y={H - 10} textAnchor="middle" fontSize="11" fill="#6F5B6F">{shortDay(d.day)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function CategoryChart({ data }: { data: ReportData['byCategory'] }) {
  const rows = [...data].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const RH = 34, W = 560, L = 150, H = rows.length * RH + 6;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tickets by category" className="hfs-svg">
      {rows.map((r, i) => {
        const w = ((W - L - 44) * r.count) / max;
        return (
          <g key={r.category}>
            <text x={L - 10} y={i * RH + 22} textAnchor="end" fontSize="13" fontWeight="700" fill="#2B1530">{categoryLabel(r.category)}</text>
            <rect x={L} y={i * RH + 8} width={Math.max(2, w)} height="20" rx="5" fill={CREATED} />
            <text x={L + Math.max(2, w) + 8} y={i * RH + 23} fontSize="13" fontWeight="800" fill="#2B1530">{r.count}</text>
          </g>
        );
      })}
    </svg>
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

  const tiles: [string, string, string][] = d ? [
    ['Created', String(d.totals.created), 'is-violet'],
    ['Solved', String(d.totals.solved), 'is-green'],
    ['Open right now', String(d.totals.open), 'is-amber'],
    ['Average first reply', mins(d.totals.firstReplyMinutes), 'is-teal'],
    ['Replied within target', d.totals.slaMetPct == null ? '–' : `${Math.round(d.totals.slaMetPct)}%`, 'is-rose'],
  ] : [];

  return (
    <div className="hfs hfs-admin">
      <SubHeader back="Support desk" backTo="/desk" title="Reports">
        <label className="hfs-sr" htmlFor="hfs-range">Date range</label>
        <select id="hfs-range" className="hfs-select" value={range} onChange={(e) => setQuery({ range: e.target.value })}>
          {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </SubHeader>
      <div className="hfs-wrap">
        {err && <ErrorBox message={err} onRetry={load} />}
        {!d && !err && <div className="hfs-center"><Spinner /></div>}
        {d && (
          <>
            <dl className="hfs-tiles">
              {tiles.map(([l, v, tone]) => (<div key={l} className={`hfs-tile ${tone}`}><dt>{l}</dt><dd>{v}</dd></div>))}
            </dl>
            <section className="hfs-card hfs-chartcard">
              <div className="hfs-chartcard__head">
                <h2>Tickets per day</h2>
                <span className="hfs-legend"><i style={{ background: CREATED }} />Created</span>
                <span className="hfs-legend"><i style={{ background: SOLVED }} />Solved</span>
              </div>
              {d.perDay.length ? <DayChart data={d.perDay} /> : <p className="hfs-fineprint">No tickets in this range.</p>}
            </section>
            <section className="hfs-card hfs-chartcard">
              <h2>By category</h2>
              {d.byCategory.length ? <CategoryChart data={d.byCategory} /> : <p className="hfs-fineprint">No tickets in this range.</p>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
