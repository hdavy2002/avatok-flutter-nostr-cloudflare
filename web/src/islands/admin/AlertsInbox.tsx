/* §5.12 Alerts inbox + alert-rule CRUD, and §5.14 admin-roles management.
 * Ack/resolve/evaluate and role changes are audited server-side. Role-gated:
 * the Worker fails closed (403) for actions a role can't perform. */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import {
  getAlerts, ackAlert, resolveAlert, evaluateAlerts,
  getAlertRules, createAlertRule, updateAlertRule, deleteAlertRule,
  getRoles, setRole, fmtTime, ALERT_METRICS, COMPARATORS,
  type Alert, type AlertRule, type RoleRow,
} from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

const ROLES = ['super', 'finance', 'analyst', 'readonly'];

function AlertsSection() {
  const [status, setStatus] = useState('open');
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => { try { const r = await getAlerts(status); setAlerts(r.alerts ?? []); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setAlerts([]); } };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [status]);

  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); } };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Alerts inbox</h2>
        <div className="flex items-center gap-2">
          {['open', 'acknowledged', 'resolved'].map((s) => <Pill key={s} kind={status === s ? 'ok' : 'hint'} onClick={() => setStatus(s)}>{s}</Pill>)}
          <Button variant="blue" loading={busy} onClick={() => act(evaluateAlerts)}>Evaluate now</Button>
        </div>
      </div>
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      {!alerts ? <Spinner size={20} /> : alerts.length === 0 ? <p className="font-mono text-[12px] text-inkMute">No {status} alerts.</p> : alerts.map((a) => (
        <Card key={a.id} shadow="sm">
          <div className="flex items-center justify-between gap-2 p-1">
            <div className="flex min-w-0 flex-col">
              <span className="font-body font-bold text-[14px] text-ink">{a.message}</span>
              <span className="font-mono text-[10px] text-inkMute">{fmtTime(a.created_at)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Pill kind={a.severity === 'critical' ? 'no' : 'plain'}>{a.severity}</Pill>
              {a.status === 'open' && <Button variant="ghost" onClick={() => act(() => ackAlert(a.id))}>Ack</Button>}
              {a.status !== 'resolved' && <Button variant="lime" onClick={() => act(() => resolveAlert(a.id))}>Resolve</Button>}
            </div>
          </div>
        </Card>
      ))}
    </section>
  );
}

function RulesSection() {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState(ALERT_METRICS[0]); const [comparator, setComparator] = useState('gt'); const [threshold, setThreshold] = useState('1');
  const [chEmail, setChEmail] = useState(true); const [chSlack, setChSlack] = useState(false);

  const load = async () => { try { const r = await getAlertRules(); setRules(r.rules ?? []); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); setRules([]); } };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    const channels = [chEmail && 'email', chSlack && 'slack'].filter(Boolean) as string[];
    try { await createAlertRule({ metric, comparator, threshold: Number(threshold), channels }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'create failed'); }
  };
  const toggle = async (r: AlertRule) => { try { await updateAlertRule(r.id, { enabled: !r.enabled }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } };
  const remove = async (r: AlertRule) => { if (!confirm('Delete rule?')) return; try { await deleteAlertRule(r.id); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Alert rules</h2>
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      <Card shadow="sm">
        <div className="flex flex-wrap items-end gap-2 p-1">
          <label className="flex flex-col gap-1"><span className="font-mono text-[10px] uppercase text-inkSoft">Metric</span>
            <select className="border-zine border-ink rounded-md bg-card px-2 py-1 font-mono text-[12px]" value={metric} onChange={(e) => setMetric(e.target.value as any)}>{ALERT_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label className="flex flex-col gap-1"><span className="font-mono text-[10px] uppercase text-inkSoft">Cmp</span>
            <select className="border-zine border-ink rounded-md bg-card px-2 py-1 font-mono text-[12px]" value={comparator} onChange={(e) => setComparator(e.target.value)}>{COMPARATORS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <Field label="Threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          <label className="flex items-center gap-1 font-mono text-[12px]"><input type="checkbox" checked={chEmail} onChange={(e) => setChEmail(e.target.checked)} />email</label>
          <label className="flex items-center gap-1 font-mono text-[12px]"><input type="checkbox" checked={chSlack} onChange={(e) => setChSlack(e.target.checked)} />slack</label>
          <Button variant="lime" onClick={create}>Add rule</Button>
        </div>
      </Card>
      {!rules ? <Spinner size={20} /> : rules.length === 0 ? <p className="font-mono text-[12px] text-inkMute">No rules.</p> : rules.map((r) => (
        <Card key={r.id} shadow="sm">
          <div className="flex items-center justify-between gap-2 p-1">
            <span className="font-mono text-[12px] text-ink">{r.metric} {r.comparator} {r.threshold} · [{(r.channels || []).join(',') || 'no channels'}]</span>
            <div className="flex items-center gap-2">
              <Pill kind={r.enabled ? 'ok' : 'hint'}>{r.enabled ? 'enabled' : 'off'}</Pill>
              <Button variant="ghost" onClick={() => toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</Button>
              <Button variant="coral" onClick={() => remove(r)}>Delete</Button>
            </div>
          </div>
        </Card>
      ))}
    </section>
  );
}

function RolesSection() {
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [uid, setUid] = useState(''); const [role, setRoleV] = useState('analyst');

  const load = async () => { try { const r = await getRoles(); setRoles(r.roles ?? []); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'forbidden (super only)'); setRoles([]); } };
  useEffect(() => { void load(); }, []);
  const assign = async () => { if (!uid.trim()) return; try { await setRole(uid.trim(), role); setUid(''); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Admin roles <span className="text-inkMute">(super only)</span></h2>
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      <Card shadow="sm">
        <div className="flex flex-wrap items-end gap-2 p-1">
          <div className="min-w-[220px] flex-1"><Field label="Clerk uid" value={uid} onChange={(e) => setUid(e.target.value)} /></div>
          <label className="flex flex-col gap-1"><span className="font-mono text-[10px] uppercase text-inkSoft">Role</span>
            <select className="border-zine border-ink rounded-md bg-card px-2 py-1 font-mono text-[12px]" value={role} onChange={(e) => setRoleV(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          <Button variant="blue" onClick={assign}>Set role</Button>
        </div>
      </Card>
      {!roles ? <Spinner size={20} /> : roles.map((r) => (
        <div key={r.uid} className="flex items-center justify-between font-mono text-[12px] text-inkSoft">
          <span className="truncate">{r.uid}{r.implicit ? ' (implicit)' : ''}</span><Pill kind={r.role === 'super' ? 'ok' : 'plain'}>{r.role}</Pill>
        </div>
      ))}
    </section>
  );
}

function Inner() {
  return (
    <div className="flex flex-col gap-8">
      <AlertsSection />
      <RulesSection />
      <RolesSection />
    </div>
  );
}

export default function AlertsInbox() { return <AdminGate><Inner /></AdminGate>; }
