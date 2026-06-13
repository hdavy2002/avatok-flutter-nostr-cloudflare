/* §5.1 Overview — bird's-eye KPI cards, needs-attention strip, surface health.
 * Auto-refreshes ~10s. Read-only. */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getOverview, coins, type Overview } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Spinner } from '../../components/Spinner';

function Kpi({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card shadow="sm">
      <div className="flex flex-col gap-1 p-1">
        <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">{label}</span>
        <span className="font-display font-semibold text-[28px] leading-none text-ink">{value}</span>
        {sub && <span className="font-mono text-[11px] text-inkMute">{sub}</span>}
      </div>
    </Card>
  );
}

function Inner() {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await getOverview(); if (alive) { setData(r); setErr(null); } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'failed'); }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!data) return <div className="flex items-center gap-3 p-6"><Spinner size={22} />{err && <span className="text-coral font-mono text-[12px]">{err}</span>}</div>;

  const s = data.sessions; const m = data.money; const na = data.needs_attention;
  const naItems: Array<[string, number, string]> = [
    ['Failed settlements', na.failed_settlements, '/admin/money'],
    ['Recon diffs', na.recon_diffs, '/admin/money'],
    ['Pending payouts', na.pending_payouts, '/admin/money'],
    ['Open reports', na.open_reports, '/admin/creators'],
    ['CSAM hits', na.csam_hits, '/admin/creators'],
    ['Open alerts', na.open_alerts, '/admin/system'],
  ];

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-3 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Live now</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="Active sessions" value={s.total} sub={`${s.live_streams} live · ${s.consults} consult · ${s.voice_calls} voice · ${s.vision_calls} vision`} />
          <Kpi label="Coins in escrow" value={coins(m.escrow_coins)} />
          <Kpi label="Platform fees today" value={coins(m.fees_today_coins)} sub={`MTD ${coins(m.fees_mtd_coins)}`} />
          <Kpi label="GMV today" value={coins(m.gmv_today_coins)} />
          <Kpi label="New signups today" value={data.signups_today} />
          <Kpi label="Live streams" value={s.live_streams} />
          <Kpi label="Voice calls" value={s.voice_calls} />
          <Kpi label="Vision calls" value={s.vision_calls} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Needs attention</h2>
        <div className="flex flex-wrap gap-2">
          {naItems.map(([label, n, href]) => (
            <a key={label} href={href}>
              <Pill kind={n > 0 ? (label === 'CSAM hits' ? 'no' : 'plain') : 'hint'}>{label}: {n}</Pill>
            </a>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Surface health</h2>
        <div className="flex flex-wrap gap-2">
          {data.surfaces.map((sf) => (
            <Pill key={sf.key} kind={sf.enabled ? 'ok' : 'no'}>{sf.label}: {sf.enabled ? 'on' : 'off'}</Pill>
          ))}
        </div>
      </section>

      <span className="font-mono text-[10px] text-inkMute">updated {new Date(data.ts).toLocaleTimeString()} · auto-refresh 10s</span>
    </div>
  );
}

export default function OverviewCards() {
  return <AdminGate><Inner /></AdminGate>;
}
