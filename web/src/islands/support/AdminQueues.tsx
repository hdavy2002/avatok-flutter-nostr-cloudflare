// [HF-SUPPORT-DESK] Queues page (design: AdminQueues). Six cards that refresh every 15 s, failed jobs with Retry / Discard,
// the WhatsApp speed setting, and the do-not-send list. No Pause button: the owner decided against one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, errMessage } from './api';
import { fullDate, plural } from './format';
import { SubHeader, useStaff } from './staff';
import type { FailedJob, QueueStat, Suppression } from './types';
import { Empty, ErrorBox, Modal, Spinner, useInterval, usePageVisible, useToast } from './ui';

const WHAT: Record<string, string> = {
  'support-inbound': 'Incoming emails becoming tickets',
  'email-priority': 'Login codes and staff replies',
  'email-bulk': 'Acknowledgements, reminders, receipts',
  'whatsapp-priority': 'WhatsApp login codes',
  'whatsapp-normal': 'Support nudges and admin alerts',
  'support-jobs': 'Reminders, auto-close, search, clean-up',
};

export const queueState = (q: QueueStat): 'ok' | 'busy' | 'bad' => (q.failed24h > 5 || (q.oldestSec ?? 0) > 900 ? 'bad' : q.waiting > 500 || (q.oldestSec ?? 0) > 60 || q.failed24h > 0 ? 'busy' : 'ok');
export const allHealthy = (qs: QueueStat[]): boolean => qs.every((q) => queueState(q) === 'ok');

function oldest(sec: number | null): string {
  if (sec == null || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} m ${Math.round(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} m`;
}

export default function AdminQueues() {
  const me = useStaff();
  const toast = useToast();
  const visible = usePageVisible();
  const [qs, setQs] = useState<QueueStat[] | null>(null);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [supp, setSupp] = useState<Suppression[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [secs, setSecs] = useState('1.0');
  const [saved, setSaved] = useState('1.0');
  const [suppOpen, setSuppOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    try {
      const [q, f] = await Promise.all([adminApi.queues(c.signal), adminApi.failed()]);
      if (c.signal.aborted) return;
      setQs(q); setFailed(f); setUpdated(Date.now()); setErr(null);
    } catch (e) {
      if (c.signal.aborted) return;
      setErr(errMessage(e, 'Could not load the queues.'));
    }
  }, []);

  useEffect(() => {
    void load();
    adminApi.settings().then((s) => {
      const v = ((s.whatsapp_min_interval_ms ?? 1000) / 1000).toFixed(1);
      setSecs(v); setSaved(v);
    }).catch(() => undefined);
    adminApi.suppressions().then(setSupp).catch(() => setSupp([]));
    return () => ctl.current?.abort();
  }, [load]);
  useInterval(() => void load(), visible ? 15_000 : null);
  useInterval(() => setNow(Date.now()), 1000);

  const act = async (id: string, kind: 'retry' | 'discard') => {
    if (!me.canWrite) { toast('You have view-only access.', 'error'); return; }
    setBusyId(id);
    try {
      await (kind === 'retry' ? adminApi.retry(id) : adminApi.discard(id));
      setFailed((l) => l.filter((x) => x.id !== id));
      toast(kind === 'retry' ? 'Put back in the queue' : 'Discarded');
    } catch (e) { toast(errMessage(e), 'error'); } finally { setBusyId(null); }
  };

  const saveSpeed = async () => {
    const n = Number(secs);
    if (!Number.isFinite(n) || n < 0.2 || n > 60) { toast('Enter a number of seconds between 0.2 and 60.', 'error'); return; }
    try { await adminApi.saveSettings({ whatsapp_min_interval_ms: Math.round(n * 1000) }); setSaved(String(n.toFixed(1))); toast('WhatsApp speed saved'); }
    catch (e) { toast(errMessage(e), 'error'); }
  };

  const healthy = qs ? allHealthy(qs) : true;
  const age = updated ? Math.max(0, Math.round((now - updated) / 1000)) : 0;

  return (
    <div className="hfs hfs-admin">
      <SubHeader back="Support desk" backTo="/desk" title="Queues">
        {qs && <span className={`hfs-pillstat ${healthy ? 'is-ok' : 'is-warn'}`} role="status">{healthy ? 'All queues healthy' : 'Some queues are busy'} · updated {age} s ago</span>}
      </SubHeader>
      <div className="hfs-wrap">
        {err && <ErrorBox message={err} onRetry={() => void load()} />}
        {!qs && !err && <div className="hfs-center"><Spinner /></div>}
        {qs && (
          <div className="hfs-qgrid">
            {qs.map((q) => {
              const s = queueState(q);
              return (
                <section key={q.name} className="hfs-card hfs-qcard">
                  <div className="hfs-qcard__head">
                    <h2>{q.name}</h2>
                    <span className={`hfs-chip hfs-chip--${s}`}>{s === 'ok' ? 'Healthy' : s === 'busy' ? 'Busy' : 'Needs a look'}</span>
                  </div>
                  <p className="hfs-qcard__what">{q.what ?? WHAT[q.name] ?? ''}</p>
                  <dl className="hfs-qcard__stats">
                    <div><dt>Waiting</dt><dd>{q.waiting.toLocaleString('en-IN')}</dd></div>
                    <div><dt>Done / min</dt><dd>{q.perMin.toLocaleString('en-IN')}</dd></div>
                    <div><dt>Failed (24 h)</dt><dd className={q.failed24h ? 'is-bad' : ''}>{q.failed24h}</dd></div>
                    <div><dt>Oldest waiting</dt><dd>{oldest(q.oldestSec)}</dd></div>
                  </dl>
                </section>
              );
            })}
          </div>
        )}

        <div className="hfs-qrow">
          <section className="hfs-card hfs-qfailed">
            <h2>Failed after every retry</h2>
            {failed.length === 0 ? <Empty title="Nothing has failed">Every message went through.</Empty> : (
              <>
                <table className="hfs-table">
                  <thead><tr><th>Queue</th><th>What</th><th>Why it failed</th><th>When</th><th /></tr></thead>
                  <tbody>
                    {failed.map((f) => (
                      <tr key={f.id}>
                        <td data-l="Queue"><strong>{f.queue}</strong></td>
                        <td data-l="What">{f.what}</td>
                        <td data-l="Why" className="is-bad">{f.reason}</td>
                        <td data-l="When">{fullDate(f.at)}</td>
                        <td className="hfs-table__act">
                          <button type="button" className="hfs-btn hfs-btn--primary hfs-btn--sm" disabled={busyId === f.id || !me.canWrite} onClick={() => void act(f.id, 'retry')}>Retry</button>
                          <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={busyId === f.id || !me.canWrite} onClick={() => void act(f.id, 'discard')}>Discard</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section className="hfs-card hfs-qside">
            <h2>WhatsApp speed</h2>
            <div>
              <label htmlFor="hfs-wa" className="hfs-label">Hello Fraands number · 1 message every</label>
              <div className="hfs-inline">
                <input id="hfs-wa" className="hfs-input hfs-input--short" inputMode="decimal" value={secs} onChange={(e) => setSecs(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveSpeed(); }} />
                <span className="hfs-strong">seconds</span>
                <button type="button" className="hfs-btn hfs-btn--primary hfs-btn--sm" disabled={secs === saved || me.role !== 'admin'} onClick={() => void saveSpeed()}>Save</button>
              </div>
              <p className="hfs-fineprint">Going faster risks WhatsApp banning the number.{me.role !== 'admin' && ' Only admins can change this.'}</p>
            </div>
            <div className="hfs-infobox">
              <strong>Admin alerts</strong>
              <span>One per ticket below 10 a minute, then a summary every minute. Urgent always alerts.</span>
            </div>
            <div className="hfs-infobox">
              <strong>Do-not-send list</strong>
              <span>{supp ? plural(supp.length, 'bounced address', 'bounced addresses') : 'Loading…'} · <button type="button" className="hfs-linkbtn" onClick={() => setSuppOpen(true)}>view and remove</button></span>
            </div>
            <div className="hfs-infobox">
              <strong>Support storage (R2)</strong>
              <span>Raw emails, attachments and email bodies</span>
            </div>
          </section>
        </div>
      </div>
      {suppOpen && <SuppressionModal list={supp ?? []} canWrite={me.canWrite} onChange={setSupp} onClose={() => setSuppOpen(false)} />}
    </div>
  );
}

function SuppressionModal({ list, canWrite, onChange, onClose }: { list: Suppression[]; canWrite: boolean; onChange: (l: Suppression[]) => void; onClose: () => void }) {
  const toast = useToast();
  const remove = async (email: string) => {
    try { await adminApi.removeSuppression(email); onChange(list.filter((s) => s.email !== email)); toast(`${email} can receive email again`); }
    catch (e) { toast(errMessage(e), 'error'); }
  };
  return (
    <Modal title="Do-not-send list" onClose={onClose}>
      <p>We stopped emailing these addresses because they bounced or complained. Remove one only if you know the address is fixed.</p>
      {list.length === 0 ? <p className="hfs-fineprint">The list is empty.</p> : (
        <ul className="hfs-simplelist">
          {list.map((s) => (
            <li key={s.email}>
              <div><strong>{s.email}</strong>{s.reason && <span className="hfs-fineprint"> · {s.reason}</span>}</div>
              <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={!canWrite} onClick={() => void remove(s.email)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
