/* §5.2 Live Operations — auto-refreshing feeds (12s) across every surface.
 * Read-only here; force-end actions hit existing surface endpoints (left as
 * deep-links to keep this island free of money/state primitives). */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getLive, coins, minsAgo, type LiveSnapshot } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Spinner } from '../../components/Spinner';

function Feed({ title, rows, render, empty }: { title: string; rows: any[]; render: (r: any) => React.ReactNode; empty?: string }) {
  return (
    <section>
      <h2 className="mb-2 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">{title} <span className="text-inkMute">({rows.length})</span></h2>
      {rows.length === 0 ? (
        <p className="font-mono text-[12px] text-inkMute">{empty ?? 'None active.'}</p>
      ) : (
        <div className="flex flex-col gap-2">{rows.map((r, i) => <Card key={r.id ?? r.listing_id ?? i} shadow="sm">{render(r)}</Card>)}</div>
      )}
    </section>
  );
}

function Inner() {
  const [d, setD] = useState<LiveSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => { try { const r = await getLive(); if (alive) { setD(r); setErr(null); } } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'failed'); } };
    void load(); const t = setInterval(load, 12_000); return () => { alive = false; clearInterval(t); };
  }, []);
  if (!d) return <div className="flex items-center gap-3 p-6"><Spinner size={22} />{err && <span className="text-coral font-mono text-[12px]">{err}</span>}</div>;

  return (
    <div className="flex flex-col gap-6">
      <Feed title="Live streams" rows={d.live_streams} render={(r) => (
        <div className="flex items-center justify-between p-1"><span className="font-body font-bold text-[14px] text-ink">{r.listing_id}</span><Pill kind="ok">live · {r.started_at ? minsAgo(r.started_at) : '—'}</Pill></div>
      )} />
      <Feed title="Active consults" rows={d.consults} render={(r) => (
        <div className="flex items-center justify-between p-1">
          <div className="flex flex-col"><span className="font-body font-bold text-[14px] text-ink">{r.kind}</span><span className="font-mono text-[11px] text-inkMute">{r.creator_id} ← {r.buyer_id}</span></div>
          <Pill>{coins(r.price)}</Pill>
        </div>
      )} />
      <Feed title="Voice agent calls" rows={d.voice_calls} render={(r) => (
        <div className="flex items-center justify-between p-1">
          <div className="flex flex-col"><span className="font-body font-bold text-[14px] text-ink">{r.agent_id}</span><span className="font-mono text-[11px] text-inkMute">caller {r.user_id} · {r.billed_minutes}/{r.limit_minutes}m</span></div>
          <Pill>{coins(r.gross_coins)}</Pill>
        </div>
      )} />
      <Feed title="Vision agent calls" rows={d.vision_calls} empty={d.vision_available ? 'None active.' : 'AvaVision: not yet deployed'} render={(r) => (
        <div className="flex items-center justify-between p-1">
          <div className="flex flex-col"><span className="font-body font-bold text-[14px] text-ink">{r.agent_id}</span><span className="font-mono text-[11px] text-inkMute">caller {r.user_id} · {r.billed_minutes}/{r.limit_minutes}m · score {r.avg_score ?? '—'} · frames {r.frames_streamed} · snaps {r.snapshot_calls}</span></div>
          <Pill>{coins(r.gross_coins)}</Pill>
        </div>
      )} />

      <section>
        <h2 className="mb-2 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Conference rooms</h2>
        <p className="font-mono text-[12px] text-inkMute">{d.conference_rooms.count == null ? 'LiveKit room count not wired (≤25 cap) — see glue note.' : `${d.conference_rooms.count} rooms`}</p>
      </section>

      <section>
        <h2 className="mb-2 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Per-agent slot utilization (X/{d.slot_utilization.cap})</h2>
        {d.slot_utilization.voice.length === 0 ? <p className="font-mono text-[12px] text-inkMute">No busy agents.</p> : (
          <div className="flex flex-wrap gap-2">{d.slot_utilization.voice.map((a) => (
            <Pill key={a.agent_id} kind={a.active >= d.slot_utilization.cap ? 'no' : 'plain'}>{a.agent_id}: {a.active}/{d.slot_utilization.cap}</Pill>
          ))}</div>
        )}
      </section>

      <span className="font-mono text-[10px] text-inkMute">updated {new Date(d.ts).toLocaleTimeString()} · auto-refresh 12s</span>
    </div>
  );
}

export default function LiveFeed() { return <AdminGate><Inner /></AdminGate>; }
