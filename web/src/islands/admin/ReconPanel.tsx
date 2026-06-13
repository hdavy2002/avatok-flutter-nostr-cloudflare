/* §5.4 Reconciliation — recon_runs history (existing /api/admin/recon), red
 * banner on any nonzero diff, escrow spot-check by order id. */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getRecon, coins, fmtTime } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

function Inner() {
  const [runs, setRuns] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [order, setOrder] = useState(''); const [spot, setSpot] = useState<any>(null);

  const load = async () => { try { const r = await getRecon(); setRuns(r.runs ?? []); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setRuns([]); } };
  useEffect(() => { void load(); }, []);

  const checkOrder = async () => { if (!order.trim()) return; try { const r = await getRecon(order.trim()); setSpot(r.spot); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } };

  if (!runs) return <div className="flex items-center gap-3 p-6"><Spinner size={22} />{err && <span className="text-coral font-mono text-[12px]">{err}</span>}</div>;
  const bad = runs.filter((r) => !r.ok);

  return (
    <div className="flex flex-col gap-4">
      {bad.length > 0 && (
        <Card shadow="lg">
          <div className="flex items-center gap-2 p-1">
            <Pill kind="no">⚠ {bad.length} reconciliation run(s) with nonzero diff</Pill>
          </div>
        </Card>
      )}
      <section>
        <h2 className="mb-2 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Escrow spot-check</h2>
        <div className="flex items-end gap-2">
          <Field label="Order id" value={order} onChange={(e) => setOrder(e.target.value)} />
          <Button variant="blue" onClick={checkOrder}>Check</Button>
        </div>
        {spot && <p className="mt-2 font-mono text-[12px] text-inkSoft">escrow:{spot.order} balance = {coins(spot.escrow_balance)}</p>}
      </section>
      <section>
        <h2 className="mb-2 font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Recent recon runs</h2>
        <div className="flex flex-col gap-2">
          {runs.length === 0 ? <p className="font-mono text-[12px] text-inkMute">No recon runs recorded.</p> : runs.map((r) => (
            <Card key={r.date} shadow="sm">
              <div className="flex items-center justify-between p-1">
                <span className="font-mono text-[12px] text-ink">{r.date}</span>
                <div className="flex items-center gap-2">
                  <Pill kind={r.ok ? 'ok' : 'no'}>{r.ok ? 'balanced' : 'diff'}</Pill>
                  <span className="font-mono text-[10px] text-inkMute">{fmtTime(r.created_at)}</span>
                </div>
              </div>
              {!r.ok && r.diff_json && <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-coral">{String(r.diff_json).slice(0, 600)}</pre>}
            </Card>
          ))}
        </div>
        <p className="mt-2 font-mono text-[10px] text-inkMute">Manual "run recon now" → POST /api/admin/money/evaluate (existing).</p>
      </section>
    </div>
  );
}

export default function ReconPanel() { return <AdminGate><Inner /></AdminGate>; }
