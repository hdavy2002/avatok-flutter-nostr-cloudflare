/* §5.9 Analytics — PostHog-backed cards via the Worker HogQL proxy (the
 * personal key NEVER reaches the browser). Trend rendered with Chart.js (the
 * allowed CDN), with an inline-bar fallback if the CDN is blocked. */
import { useEffect, useRef, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getAnalytics, type AnalyticsResult } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Spinner } from '../../components/Spinner';

const CHART_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
function loadChart(): Promise<any> {
  return new Promise((resolve) => {
    const w = window as any;
    if (w.Chart) return resolve(w.Chart);
    const existing = document.querySelector(`script[src="${CHART_CDN}"]`);
    if (existing) { existing.addEventListener('load', () => resolve((window as any).Chart)); existing.addEventListener('error', () => resolve(null)); return; }
    const s = document.createElement('script'); s.src = CHART_CDN; s.async = true;
    s.onload = () => resolve((window as any).Chart); s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

function num(r: AnalyticsResult): string {
  if (r.disabled) return 'n/a';
  const v = r.results?.[0]?.[0];
  return v == null ? '—' : Number(v).toLocaleString();
}

function Inner() {
  const [range, setRange] = useState(7);
  const [dau, setDau] = useState<AnalyticsResult | null>(null);
  const [activeNow, setActiveNow] = useState<AnalyticsResult | null>(null);
  const [errors, setErrors] = useState<AnalyticsResult | null>(null);
  const [trend, setTrend] = useState<AnalyticsResult | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const [a, b, c, t] = await Promise.all([
        getAnalytics('dau', range).catch(() => ({ error: 'x' } as AnalyticsResult)),
        getAnalytics('active_now').catch(() => ({ error: 'x' } as AnalyticsResult)),
        getAnalytics('errors', 1).catch(() => ({ error: 'x' } as AnalyticsResult)),
        getAnalytics('trend_daily', range).catch(() => ({ error: 'x' } as AnalyticsResult)),
      ]);
      if (!alive) return;
      setDau(a); setActiveNow(b); setErrors(c); setTrend(t);
      setDisabled(!!a.disabled);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [range]);

  useEffect(() => {
    if (!trend?.results?.length || !canvasRef.current) return;
    void (async () => {
      const Chart = await loadChart();
      if (!Chart || !canvasRef.current) return;
      const labels = trend.results!.map((r) => String(r[0]));
      const data = trend.results!.map((r) => Number(r[1]));
      chartRef.current?.destroy();
      chartRef.current = new Chart(canvasRef.current.getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'events/day', data, borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.1)', tension: 0.2, fill: true }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    })();
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [trend]);

  if (loading) return <div className="flex items-center gap-3 p-6"><Spinner size={22} /></div>;
  if (disabled) return <Card shadow="sm"><p className="font-body font-bold text-[15px] text-inkSoft p-2">PostHog key not configured — set POSTHOG_PERSONAL_API_KEY as a Worker secret to enable analytics cards.</p></Card>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase text-inkSoft">Range:</span>
        {[1, 7, 30].map((r) => <Pill key={r} kind={range === r ? 'ok' : 'hint'} onClick={() => setRange(r)}>{r}d</Pill>)}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Card shadow="sm"><div className="flex flex-col gap-1 p-1"><span className="font-mono text-[10px] uppercase text-inkMute">Active now (5m)</span><span className="font-display font-semibold text-[26px] text-ink">{activeNow ? num(activeNow) : '—'}</span></div></Card>
        <Card shadow="sm"><div className="flex flex-col gap-1 p-1"><span className="font-mono text-[10px] uppercase text-inkMute">Unique users ({range}d)</span><span className="font-display font-semibold text-[26px] text-ink">{dau ? num(dau) : '—'}</span></div></Card>
        <Card shadow="sm"><div className="flex flex-col gap-1 p-1"><span className="font-mono text-[10px] uppercase text-inkMute">API errors (24h)</span><span className="font-display font-semibold text-[26px] text-ink">{errors ? num(errors) : '—'}</span></div></Card>
      </div>
      <section>
        <h2 className="mb-2 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Events trend</h2>
        <Card shadow="sm">
          <div className="p-2" style={{ height: 220 }}>
            {trend?.results?.length ? <canvas ref={canvasRef} /> : <p className="font-mono text-[12px] text-inkMute">No trend data.</p>}
          </div>
        </Card>
      </section>
      <p className="font-mono text-[10px] text-inkMute">All queries run through the Worker HogQL proxy (allow-listed). Session-replay deep-links open in PostHog.</p>
    </div>
  );
}

export default function AnalyticsCards() { return <AdminGate><Inner /></AdminGate>; }
