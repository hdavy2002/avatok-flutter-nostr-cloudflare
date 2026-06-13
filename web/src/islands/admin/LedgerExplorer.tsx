/* §5.4 Ledger explorer — search wallet_ledger by user/ref (existing
 * /api/admin/ledger), CSV export. Read-only. */
import { useState } from 'react';
import { AdminGate } from './AdminGate';
import { getLedger, coins, fmtTime } from './adminApi';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

function Inner() {
  const [user, setUser] = useState(''); const [ref, setRef] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!user.trim() && !ref.trim()) { setErr('user or ref required'); return; }
    setLoading(true); setErr(null);
    try { const r = await getLedger({ user: user.trim() || undefined, ref: ref.trim() || undefined, limit: 200 }); setRows(r.entries ?? []); }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setRows([]); }
    finally { setLoading(false); }
  };

  const exportCsv = () => {
    if (!rows?.length) return;
    const head = 'id,debit,credit,amount,type,ref,created_at';
    const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = rows.map((r) => [r.id, r.debit, r.credit, r.amount, r.type, r.ref, r.created_at].map(esc).join(',')).join('\n');
    const blob = new Blob([head + '\n' + body + '\n'], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ledger-export.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="User (uid)" value={user} onChange={(e) => setUser(e.target.value)} />
        <Field label="Ref / orderId" value={ref} onChange={(e) => setRef(e.target.value)} />
        <Button variant="blue" loading={loading} onClick={run}>Search</Button>
        {rows?.length ? <Button variant="ghost" onClick={exportCsv}>Export CSV</Button> : null}
      </div>
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      {loading && <Spinner size={22} />}
      {rows && (
        <Card shadow="sm">
          <div className="flex flex-col gap-1 p-1">
            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 border-b-zine border-inkMute pb-1 font-mono font-bold uppercase text-[10px] tracking-[0.06em] text-inkSoft">
              <span>debit</span><span>credit</span><span>amount</span><span>when</span>
            </div>
            {rows.length === 0 ? <p className="font-mono text-[12px] text-inkMute py-2">No rows.</p> : rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 font-mono text-[11px] text-inkSoft">
                <span className="truncate">{r.debit}</span><span className="truncate">{r.credit}</span><span>{coins(r.amount)}</span><span className="text-inkMute">{fmtTime(r.created_at)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export default function LedgerExplorer() { return <AdminGate><Inner /></AdminGate>; }
