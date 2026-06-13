/* §5.4 Payouts queue + failed-settlements DLQ. Retry reuses the EXISTING
 * /api/admin/settlements/:id/retry endpoint (no new money primitive). */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getSettlements, retrySettlement, fmtTime } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/Spinner';

function Inner() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => { try { const r = await getSettlements('failed'); setRows(r.settlements ?? []); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setRows([]); } };
  useEffect(() => { void load(); }, []);

  const retry = async (id: string) => {
    setBusy(id);
    try { await retrySettlement(id); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'retry failed'); } finally { setBusy(null); }
  };

  if (!rows) return <div className="flex items-center gap-3 p-6"><Spinner size={22} />{err && <span className="text-coral font-mono text-[12px]">{err}</span>}</div>;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Failed settlements (DLQ) <span className="text-inkMute">({rows.length})</span></h2>
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      {rows.length === 0 ? <p className="font-mono text-[12px] text-inkMute">DLQ is empty ✓</p> : rows.map((r) => (
        <Card key={r.id} shadow="sm">
          <div className="flex items-center justify-between gap-3 p-1">
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-[12px] text-ink truncate">{r.id}</span>
              <span className="font-mono text-[11px] text-coral truncate">{r.error || 'no error recorded'}</span>
              <span className="font-mono text-[10px] text-inkMute">{fmtTime(r.created_at)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Pill kind="no">{r.status}</Pill>
              <Button variant="blue" loading={busy === r.id} onClick={() => retry(r.id)}>Retry</Button>
            </div>
          </div>
        </Card>
      ))}
      <p className="font-mono text-[10px] text-inkMute">Tax export + affiliate leaderboard available via /api/admin/tax-export and /api/admin/affiliates (existing endpoints).</p>
    </div>
  );
}

export default function PayoutsQueue() { return <AdminGate><Inner /></AdminGate>; }
