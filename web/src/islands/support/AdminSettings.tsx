// [HF-SUPPORT-DESK] Settings: Signature, Saved replies, Team, Automations, Business hours + holidays, Alerts, Blocked senders.
// Each section saves on its own (PUT settings with only the keys it owns, so two people editing different sections do not collide).
import { useCallback, useEffect, useState } from 'react';
import { adminApi, errMessage } from './api';
import { fullDate } from './format';
import SignatureEditor from './SignatureEditor';
import { Link } from './router';
import { SubHeader, useStaff } from './staff';
import { CATEGORIES, PRIORITIES, categoryLabel, type AutomationRule, type BlockedSender, type BusinessHours, type CannedReply, type CategorySlug, type Holiday, type StaffMember, type StaffRole, type SupportSettings } from './types';
import { Empty, ErrorBox, Modal, PRIORITY_LABEL, Spinner, useToast } from './ui';

const SECTIONS: { key: string; label: string; hint: string }[] = [
  { key: 'signature', label: 'Email signature', hint: 'What goes under every reply' },
  { key: 'canned', label: 'Saved replies', hint: 'Ready-made answers' },
  { key: 'team', label: 'Team', hint: 'Who can use the desk' },
  { key: 'automations', label: 'Automations', hint: 'Who gets which tickets' },
  { key: 'hours', label: 'Business hours', hint: 'Working days and holidays' },
  { key: 'alerts', label: 'Alerts', hint: 'WhatsApp number for new tickets' },
  { key: 'blocked', label: 'Blocked senders', hint: 'Emails we ignore' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_HOURS: BusinessHours = { days: [1, 2, 3, 4, 5, 6], from: '10:00', to: '19:00', tz: 'Asia/Kolkata' };
const uid = () => Math.random().toString(36).slice(2, 10);

export default function AdminSettings({ section }: { section?: string }) {
  const sec = SECTIONS.find((s) => s.key === section)?.key ?? 'signature';
  return (
    <div className="hfs hfs-admin">
      <SubHeader back="Support desk" backTo="/desk" title="Settings" />
      <div className="hfs-wrap hfs-settings">
        <nav className="hfs-snav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <Link key={s.key} to={`/desk/settings/${s.key}`} className={sec === s.key ? 'is-on' : ''} aria-current={sec === s.key ? 'page' : undefined}>
              <strong>{s.label}</strong><span>{s.hint}</span>
            </Link>
          ))}
          <Link to="/desk/queues"><strong>WhatsApp speed</strong><span>On the Queues page</span></Link>
        </nav>
        <div className="hfs-spanel">
          {sec === 'signature' && <SignatureEditor embedded />}
          {sec === 'canned' && <Canned />}
          {sec === 'team' && <Team />}
          {sec === 'automations' && <Automations />}
          {sec === 'hours' && <Hours />}
          {sec === 'alerts' && <Alerts />}
          {sec === 'blocked' && <Blocked />}
        </div>
      </div>
    </div>
  );
}

/** Loads settings once, gives back a saver that merges only the keys passed. */
function useSettings() {
  const toast = useToast();
  const [s, setS] = useState<SupportSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { setErr(null); adminApi.settings().then(setS).catch((e) => setErr(errMessage(e, 'Could not load settings.'))); }, []);
  useEffect(load, [load]);
  const save = async (patch: Partial<SupportSettings>, done = 'Saved'): Promise<boolean> => {
    try { await adminApi.saveSettings(patch); setS((cur) => ({ ...(cur ?? {}), ...patch })); toast(done); return true; }
    catch (e) { toast(errMessage(e), 'error'); return false; }
  };
  return { s, err, load, save };
}

function Gate({ s, err, load, children }: { s: SupportSettings | null; err: string | null; load: () => void; children: React.ReactNode }) {
  if (err) return <ErrorBox message={err} onRetry={load} />;
  if (!s) return <div className="hfs-center"><Spinner /></div>;
  return <>{children}</>;
}

function Card({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section className="hfs-card hfs-scard">
      <h2>{title}</h2>
      {intro && <p className="hfs-fineprint">{intro}</p>}
      {children}
    </section>
  );
}

/* ── saved replies ─────────────────────────────────────────────────────── */
function Canned() {
  const me = useStaff();
  const toast = useToast();
  const [list, setList] = useState<CannedReply[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<CannedReply | null>(null);
  const load = useCallback(() => { adminApi.canned().then(setList).catch((e) => setErr(errMessage(e))); }, []);
  useEffect(load, [load]);
  const del = async (c: CannedReply) => {
    try { await adminApi.deleteCanned(c.id); setList((l) => (l ?? []).filter((x) => x.id !== c.id)); toast('Deleted'); } catch (e) { toast(errMessage(e), 'error'); }
  };
  return (
    <Card title="Saved replies" intro="Ready-made answers you can drop into a reply. Use {customer_name}, {ticket_number} and {agent_name} and they fill in on their own.">
      {err && <ErrorBox message={err} onRetry={load} />}
      {!list && !err && <div className="hfs-center"><Spinner /></div>}
      {list && (
        <>
          <button type="button" className="hfs-btn hfs-btn--primary" disabled={!me.canWrite} onClick={() => setEdit({ id: '', title: '', body: '' })}>New saved reply</button>
          {list.length === 0 ? <Empty title="No saved replies yet">Add the answers you type most often.</Empty> : (
            <ul className="hfs-simplelist">
              {list.map((c) => (
                <li key={c.id}>
                  <div><strong>{c.title}</strong><p className="hfs-fineprint hfs-clamp">{c.body}</p></div>
                  <div className="hfs-rowact">
                    <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={!me.canWrite} onClick={() => setEdit(c)}>Edit</button>
                    <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={!me.canWrite} onClick={() => void del(c)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {edit && <CannedModal item={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </Card>
  );
}
function CannedModal({ item, onClose, onSaved }: { item: CannedReply; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!title.trim() || !body.trim()) { toast('Give it a name and some text.', 'error'); return; }
    setBusy(true);
    try { await adminApi.saveCanned({ id: item.id || undefined, title: title.trim(), body: body.trim() }); toast('Saved'); onSaved(); }
    catch (e) { toast(errMessage(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={item.id ? 'Edit saved reply' : 'New saved reply'} onClose={onClose} wide>
      <label htmlFor="hfs-ct" className="hfs-label">Name</label>
      <input id="hfs-ct" className="hfs-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={80} />
      <label htmlFor="hfs-cb" className="hfs-label">Text</label>
      <textarea id="hfs-cb" className="hfs-textarea" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="hfs-modal__actions">
        <button type="button" className="hfs-btn hfs-btn--primary" disabled={busy} onClick={() => void go()}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="hfs-btn hfs-btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/* ── team ──────────────────────────────────────────────────────────────── */
function Team() {
  const me = useStaff();
  const toast = useToast();
  const [list, setList] = useState<StaffMember[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('agent');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { adminApi.staff().then(setList).catch((e) => setErr(errMessage(e))); }, []);
  useEffect(load, [load]);
  const isAdmin = me.role === 'admin';
  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { toast('Please enter a full email address.', 'error'); return; }
    setBusy(true);
    try { await adminApi.addStaff(e, role); setEmail(''); toast(`${e} added`); load(); } catch (x) { toast(errMessage(x), 'error'); } finally { setBusy(false); }
  };
  const remove = async (m: StaffMember) => {
    try { await adminApi.removeStaff(m.id); setList((l) => (l ?? []).filter((x) => x.id !== m.id)); toast('Removed'); } catch (x) { toast(errMessage(x), 'error'); }
  };
  return (
    <Card title="Team" intro="Admins can change everything. Agents answer tickets. Viewers can read but not change anything. People must sign in with the email address you add here.">
      {err && <ErrorBox message={err} onRetry={load} />}
      {!list && !err && <div className="hfs-center"><Spinner /></div>}
      {list && (
        <ul className="hfs-simplelist">
          {list.map((m) => (
            <li key={m.id}>
              <div><strong>{m.name || m.email}</strong><p className="hfs-fineprint">{m.name ? `${m.email} · ` : ''}{m.role === 'admin' ? 'Admin' : m.role === 'agent' ? 'Agent' : 'View only'}</p></div>
              <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={!isAdmin || m.uid === me.uid} onClick={() => void remove(m)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {isAdmin ? (
        <div className="hfs-addrow">
          <label className="hfs-sr" htmlFor="hfs-te">Email</label>
          <input id="hfs-te" type="email" className="hfs-input" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
          <label className="hfs-sr" htmlFor="hfs-tr">Role</label>
          <select id="hfs-tr" className="hfs-select" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            <option value="agent">Agent</option><option value="admin">Admin</option><option value="viewer">View only</option>
          </select>
          <button type="button" className="hfs-btn hfs-btn--primary" disabled={busy} onClick={() => void add()}>Add person</button>
        </div>
      ) : <p className="hfs-fineprint">Only admins can add or remove people.</p>}
    </Card>
  );
}

/* ── automations ───────────────────────────────────────────────────────── */
function Automations() {
  const me = useStaff();
  const { s, err, load, save } = useSettings();
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { me.loadTeam(); }, [me]);
  useEffect(() => { if (s && !rules) setRules(s.automations ?? []); }, [s, rules]);
  const set = (id: string, p: Partial<AutomationRule>) => { setRules((l) => (l ?? []).map((r) => (r.id === id ? { ...r, ...p } : r))); setDirty(true); };
  const used = new Set((rules ?? []).map((r) => r.category));
  const free = CATEGORIES.filter((c) => !used.has(c.slug));
  return (
    <Card title="Automations" intro="When a new ticket arrives in a category, give it to a person and set its priority. Tickets with no rule stay in Unassigned.">
      <Gate s={s} err={err} load={load}>
        {(rules ?? []).length === 0 && <Empty title="No rules yet">Add one below.</Empty>}
        <ul className="hfs-rules">
          {(rules ?? []).map((r) => (
            <li key={r.id}>
              <span className="hfs-rules__cat">{categoryLabel(r.category)}</span>
              <label className="hfs-sr" htmlFor={`as-${r.id}`}>Assign to</label>
              <select id={`as-${r.id}`} className="hfs-select" value={r.assigneeUid ?? ''} disabled={me.role !== 'admin'} onChange={(e) => set(r.id, { assigneeUid: e.target.value || null })}>
                <option value="">Leave unassigned</option>
                {me.team.filter((t) => t.uid).map((t) => <option key={t.id} value={t.uid ?? ''}>{t.name || t.email}</option>)}
              </select>
              <label className="hfs-sr" htmlFor={`pr-${r.id}`}>Priority</label>
              <select id={`pr-${r.id}`} className="hfs-select" value={r.priority ?? ''} disabled={me.role !== 'admin'} onChange={(e) => set(r.id, { priority: (e.target.value || null) as AutomationRule['priority'] })}>
                <option value="">Keep the usual priority</option>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
              <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={me.role !== 'admin'} onClick={() => { setRules((l) => (l ?? []).filter((x) => x.id !== r.id)); setDirty(true); }}>Remove</button>
            </li>
          ))}
        </ul>
        {me.role === 'admin' ? (
          <div className="hfs-actions">
            <select aria-label="Add a rule for" className="hfs-select" value="" disabled={free.length === 0} onChange={(e) => { if (e.target.value) { setRules((l) => [...(l ?? []), { id: uid(), category: e.target.value as CategorySlug, assigneeUid: null, priority: null }]); setDirty(true); } }}>
              <option value="">{free.length ? 'Add a rule for…' : 'Every category has a rule'}</option>
              {free.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
            </select>
            <button type="button" className="hfs-btn hfs-btn--primary" disabled={!dirty} onClick={() => void save({ automations: rules ?? [] }, 'Automations saved').then((ok) => { if (ok) setDirty(false); })}>Save automations</button>
          </div>
        ) : <p className="hfs-fineprint">Only admins can change automations.</p>}
      </Gate>
    </Card>
  );
}

/* ── business hours + holidays ─────────────────────────────────────────── */
function Hours() {
  const me = useStaff();
  const { s, err, load, save } = useSettings();
  const [h, setH] = useState<BusinessHours | null>(null);
  const [hol, setHol] = useState<Holiday[]>([]);
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (s && !h) { setH(s.business_hours ?? DEFAULT_HOURS); setHol(s.holidays ?? []); } }, [s, h]);
  const hh = h ?? DEFAULT_HOURS;
  const canEdit = me.role === 'admin';
  const toggle = (d: number) => { setH({ ...hh, days: hh.days.includes(d) ? hh.days.filter((x) => x !== d) : [...hh.days, d].sort() }); setDirty(true); };
  return (
    <Card title="Business hours" intro="Used for the 24-hour reply target, the 2-hour urgent target, and the out-of-hours line in the automatic first reply.">
      <Gate s={s} err={err} load={load}>
        <fieldset className="hfs-days" disabled={!canEdit}>
          <legend className="hfs-label">Working days</legend>
          {DAYS.map((n, d) => <button key={n} type="button" aria-pressed={hh.days.includes(d)} className={`hfs-pill${hh.days.includes(d) ? ' is-on' : ''}`} onClick={() => toggle(d)}>{n}</button>)}
        </fieldset>
        <div className="hfs-inline">
          <div><label className="hfs-label" htmlFor="hfs-hf">From</label><input id="hfs-hf" type="time" className="hfs-input" value={hh.from} disabled={!canEdit} onChange={(e) => { setH({ ...hh, from: e.target.value }); setDirty(true); }} /></div>
          <div><label className="hfs-label" htmlFor="hfs-ht">To</label><input id="hfs-ht" type="time" className="hfs-input" value={hh.to} disabled={!canEdit} onChange={(e) => { setH({ ...hh, to: e.target.value }); setDirty(true); }} /></div>
          <div><label className="hfs-label" htmlFor="hfs-hz">Time zone</label><select id="hfs-hz" className="hfs-select" value={hh.tz} disabled={!canEdit} onChange={(e) => { setH({ ...hh, tz: e.target.value }); setDirty(true); }}><option value="Asia/Kolkata">India (IST)</option></select></div>
        </div>
        <h3>Holidays</h3>
        {hol.length === 0 ? <p className="hfs-fineprint">No holidays added. The team works every working day.</p> : (
          <ul className="hfs-simplelist">
            {hol.map((x) => (
              <li key={x.date}><div><strong>{x.label || 'Holiday'}</strong><p className="hfs-fineprint">{new Date(`${x.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
                <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={!canEdit} onClick={() => { setHol(hol.filter((y) => y.date !== x.date)); setDirty(true); }}>Remove</button></li>
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="hfs-addrow">
            <label className="hfs-sr" htmlFor="hfs-hd">Holiday date</label>
            <input id="hfs-hd" type="date" className="hfs-input" value={date} onChange={(e) => setDate(e.target.value)} />
            <label className="hfs-sr" htmlFor="hfs-hn">Holiday name</label>
            <input id="hfs-hn" className="hfs-input" placeholder="Diwali" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button type="button" className="hfs-btn hfs-btn--ghost" disabled={!date} onClick={() => { if (!hol.some((x) => x.date === date)) setHol([...hol, { date, label: label.trim() }].sort((a, b) => a.date.localeCompare(b.date))); setDate(''); setLabel(''); setDirty(true); }}>Add holiday</button>
          </div>
        )}
        {canEdit ? <div className="hfs-actions"><button type="button" className="hfs-btn hfs-btn--primary" disabled={!dirty} onClick={() => void save({ business_hours: hh, holidays: hol }, 'Business hours saved').then((ok) => { if (ok) setDirty(false); })}>Save business hours</button></div> : <p className="hfs-fineprint">Only admins can change business hours.</p>}
      </Gate>
    </Card>
  );
}

/* ── alerts ────────────────────────────────────────────────────────────── */
function Alerts() {
  const me = useStaff();
  const toast = useToast();
  const { s, err, load, save } = useSettings();
  const [num, setNum] = useState<string | null>(null);
  useEffect(() => { if (s && num === null) setNum(s.alert_whatsapp ?? ''); }, [s, num]);
  const go = () => {
    const v = (num ?? '').replace(/[\s-]/g, '');
    if (v && !/^\+\d{8,15}$/.test(v)) { toast('Use the full number with country code, like +917817058560.', 'error'); return; }
    void save({ alert_whatsapp: v }, v ? 'Alert number saved' : 'Alerts switched off');
  };
  return (
    <Card title="Alerts" intro="This WhatsApp number is told about every new ticket and every customer reply. Above 10 tickets a minute you get one summary a minute instead. Urgent tickets always alert on their own.">
      <Gate s={s} err={err} load={load}>
        <label className="hfs-label" htmlFor="hfs-al">Alert WhatsApp number</label>
        <div className="hfs-inline">
          <input id="hfs-al" className="hfs-input" inputMode="tel" placeholder="+91…" value={num ?? ''} disabled={me.role !== 'admin'} onChange={(e) => setNum(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
          <button type="button" className="hfs-btn hfs-btn--primary" disabled={me.role !== 'admin'} onClick={go}>Save</button>
        </div>
        <p className="hfs-fineprint">Leave it empty to switch alerts off.{me.role !== 'admin' && ' Only admins can change this.'}</p>
      </Gate>
    </Card>
  );
}

/* ── blocked senders ───────────────────────────────────────────────────── */
function Blocked() {
  const me = useStaff();
  const toast = useToast();
  const [list, setList] = useState<BlockedSender[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [v, setV] = useState('');
  const load = useCallback(() => { adminApi.blocked().then(setList).catch((e) => setErr(errMessage(e))); }, []);
  useEffect(load, [load]);
  const add = async () => {
    const t = v.trim().toLowerCase();
    if (!t) return;
    const body = t.includes('@') ? { email: t } : { domain: t.replace(/^@/, '') };
    if (body.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(body.domain)) { toast('Enter an email address or a domain like example.com.', 'error'); return; }
    try { await adminApi.block(body); setV(''); toast('Blocked'); load(); } catch (e) { toast(errMessage(e), 'error'); }
  };
  const remove = async (b: BlockedSender) => {
    try { await adminApi.unblock(b.email ? { email: b.email } : { domain: b.domain }); setList((l) => (l ?? []).filter((x) => x !== b)); toast('Unblocked'); } catch (e) { toast(errMessage(e), 'error'); }
  };
  return (
    <Card title="Blocked senders" intro="Emails from these people or domains do not become tickets and get no reply.">
      {err && <ErrorBox message={err} onRetry={load} />}
      {!list && !err && <div className="hfs-center"><Spinner /></div>}
      {list && (list.length === 0 ? <p className="hfs-fineprint">Nobody is blocked.</p> : (
        <ul className="hfs-simplelist">
          {list.map((b, i) => (
            <li key={`${b.email ?? b.domain}-${i}`}>
              <div><strong>{b.email ?? `Everyone at ${b.domain}`}</strong>{b.at ? <p className="hfs-fineprint">Blocked {fullDate(b.at)}{b.by ? ` by ${b.by}` : ''}</p> : null}</div>
              <button type="button" className="hfs-btn hfs-btn--ghost hfs-btn--sm" disabled={!me.canWrite} onClick={() => void remove(b)}>Unblock</button>
            </li>
          ))}
        </ul>
      ))}
      {me.canWrite && (
        <div className="hfs-addrow">
          <label className="hfs-sr" htmlFor="hfs-bl">Email or domain to block</label>
          <input id="hfs-bl" className="hfs-input" placeholder="name@example.com or example.com" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
          <button type="button" className="hfs-btn hfs-btn--red" onClick={() => void add()}>Block</button>
        </div>
      )}
    </Card>
  );
}

