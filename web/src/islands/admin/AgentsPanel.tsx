/* §5.6 AI agents focus — Voice + Vision aggregates + AI-spend (last 14d). */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getAgents, coins, type AgentsSnapshot } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Spinner } from '../../components/Spinner';

function Block({ title, available, rows }: { title: string; available: boolean; rows: Array<[string, string | number]> }) {
  return (
    <Card shadow="sm">
      <div className="flex flex-col gap-2 p-1">
        <div className="flex items-center justify-between">
          <span className="font-display font-semibold text-[18px] text-ink">{title}</span>
          <Pill kind={available ? 'ok' : 'hint'}>{available ? 'live' : 'not deployed'}</Pill>
        </div>
        {available && (
          <div className="grid grid-cols-2 gap-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex flex-col">
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-inkMute">{k}</span>
                <span className="font-display font-semibold text-[18px] text-ink">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function Inner() {
  const [d, setD] = useState<AgentsSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let alive = true; const load = async () => { try { const r = await getAgents(); if (alive) { setD(r); setErr(null); } } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'failed'); } }; void load(); const t = setInterval(load, 30_000); return () => { alive = false; clearInterval(t); }; }, []);
  if (!d) return <div className="flex items-center gap-3 p-6"><Spinner size={22} />{err && <span className="text-coral font-mono text-[12px]">{err}</span>}</div>;

  const maxMs = Math.max(1, ...d.ai_spend_14d.map((s) => s.ms));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Block title="AvaVoice" available rows={[['Agents', d.voice.total_agents], ['Active now', d.voice.active_sessions], ['Calls 7d', d.voice.calls_7d], ['Gross 7d', coins(d.voice.gross_7d_coins)]]} />
        <Block title="AvaVision" available={d.vision.available} rows={[['Agents', d.vision.total_agents ?? 0], ['Active now', d.vision.active_sessions ?? 0], ['Calls 7d', d.vision.calls_7d ?? 0], ['Gross 7d', coins(d.vision.gross_7d_coins ?? 0)], ['Snapshots 7d', d.vision.snapshots_7d ?? 0], ['Avg score', d.vision.avg_score ?? '—']]} />
      </div>
      <section>
        <h2 className="mb-2 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">AI spend (latency proxy, 14d)</h2>
        <Card shadow="sm">
          <div className="flex items-end gap-1 p-2" style={{ height: 120 }}>
            {d.ai_spend_14d.slice().reverse().map((s) => (
              <div key={s.day} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${s.day}: ${s.calls} calls, ${s.ms}ms`}>
                <div className="w-full bg-blue border-zine border-ink" style={{ height: `${Math.max(2, (s.ms / maxMs) * 100)}%` }} />
                <span className="font-mono text-[8px] text-inkMute">{s.day.slice(5)}</span>
              </div>
            ))}
            {d.ai_spend_14d.length === 0 && <span className="font-mono text-[12px] text-inkMute">No ai_spend rows yet.</span>}
          </div>
        </Card>
      </section>
    </div>
  );
}

export default function AgentsPanel() { return <AdminGate><Inner /></AdminGate>; }
