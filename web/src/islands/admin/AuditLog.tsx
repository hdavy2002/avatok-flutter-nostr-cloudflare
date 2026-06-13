/* §5.13 Audit log viewer — filter admin_audit by admin/action, paginate. R/O. */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getAudit, fmtTime, type AuditEntry } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

function Inner() {
  const [admin, setAdmin] = useState(''); const [action, setAction] = useState('');
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState<string | null>(null);

  const load = async (reset: boolean) => {
    setLoading(true); setErr(null);
    try {
      const r = await getAudit({ admin: admin.trim() || undefined, action: action.trim() || undefined, limit: 50, cursor: reset ? undefined : cursor ?? undefined });
      setRows(reset ? r.entries : [...rows, ...r.entries]); setCursor(r.next_cursor);
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } finally { setLoading(false); }
  };
  useEffect(() => { void load(true); /* eslint-disable-next-line */ }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Admin uid" value={admin} onChange={(e) => setAdmin(e.target.value)} />
        <Field label="Action" value={action} onChange={(e) => setAction(e.target.value)} />
        <Button variant="blue" loading={loading} onClick={() => load(true)}>Filter</Button>
      </div>
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <Card key={r.id} shadow="sm">
            <div className="flex items-center justify-between gap-2 p-1">
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-[12px] text-ink">{r.action} {r.target ? <span className="text-inkMute">→ {r.target}</span> : null}</span>
                <span className="font-mono text-[10px] text-inkMute truncate">{r.meta}</span>
              </div>
              <div className="flex flex-col items-end">
                <Pill kind="hint">{r.admin_id.slice(0, 12)}</Pill>
                <span className="font-mono text-[10px] text-inkMute">{fmtTime(r.created_at)}</span>
              </div>
            </div>
          </Card>
        ))}
        {rows.length === 0 && !loading && <p className="font-mono text-[12px] text-inkMute">No audit rows.</p>}
      </div>
      {cursor && <Button variant="ghost" loading={loading} onClick={() => load(false)}>Load more</Button>}
    </div>
  );
}

export default function AuditLog() { return <AdminGate><Inner /></AdminGate>; }
