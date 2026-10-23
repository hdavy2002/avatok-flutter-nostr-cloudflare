/* HfDesk — [HF-ADMIN-SWEEP-1] Members & activity: lists of what people did on the call app. [HF-ADMIN-COMPLETE-1] now also wallets, a page per member,
 * and actions: reply / note / resolve on questions, review on reports, resolve on money alerts (each logged by the worker).
 * Worker (admin only): GET /api/admin/hf/desk/{summary,members,member,wallets,bookings,topups,support,reports}, POST /api/admin/hf/desk/{support,reports,incidents,member}/:id/..., /api/admin/hf/money-audit. Money is rupees with paise. Times are IST. Nothing under 14px. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { adminCall } from '../peopleKit';
import { capture } from '../../../lib/analytics';
import { Banner, ConsultShell, Spinner, dateIST, fail } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis } from '../desi';

const T14 = { fontSize: 14 } as const;
const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const inr0 = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const who = (name: string | null | undefined, username?: string | null) => name || (username ? `@${username}` : 'No name yet');

type TabKey = 'members' | 'wallets' | 'bookings' | 'topups' | 'support' | 'reports' | 'money';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'members', label: 'Sign-ups' }, { key: 'wallets', label: 'Wallets' }, { key: 'bookings', label: 'Bookings' }, { key: 'topups', label: 'Wallet top-ups' },
  { key: 'support', label: 'Support questions' }, { key: 'reports', label: 'Reports & blocks' }, { key: 'money', label: 'Money alerts' },
];

interface Summary {
  members: { total: number; last24h: number; today: number; last7d: number; registered: number }; hosts: { live: number; pendingReview: number };
  bookingsOpen: number; ticketsOpen: number; payoutsOpen: number; refundsOpen: number; closingAccounts: number; incidents30d: number; reportsOpen: number; moneyAlertsOpen: number;
}
interface Member {
  uid: string; name: string | null; username: string | null; email: string | null; phone: string | null; joinedAt: number | null; via: string | null; registeredAt: number | null;
  whatsappVerified: boolean; emailVerified: boolean; hostStatus: string | null; hostCategory: string | null; topups: number; topupRupees: number; bookings: number; calls: number;
  accountStatus: string | null; closing: string | null;
}
interface Booking {
  id: string; status: string; hostUid: string; hostName: string | null; hostSlug: string | null; customerUid: string; customerName: string; customerUsername: string | null;
  startsAt: number; endsAt: number; durationMin: number; reservedRupees: number; hostNetRupees: number; settlement: string; cancelReason: string | null;
  approvedAt: number | null; decidedBy: string | null; approvalDeadline: number | null; callId: string | null; topic: string | null; createdAt: number; cancelledAt: number | null; completedAt: number | null;
}
interface Topup {
  id: string; uid: string; name: string | null; username: string | null; amountRupees: number; gateway: string; status: string; credited: boolean; refundedRupees: number;
  walletRupees: number | null; gstRupees: number | null; paymentId: string | null; receipt: string | null; createdAt: number; paidAt: number | null;
}
interface Ticket { id: string; uid: string; name: string | null; username: string | null; email: string | null; topic: string; message: string; status: string; createdAt: number; updatedAt: number; actions?: Act[] }
interface Incident { id: string; callId: string; kind: string; reporterUid: string; reporterName: string | null; otherUid: string | null; otherName: string | null; at: number; state: string; actions?: Act[] }
interface UserReport { id: string; uid: string | null; contact: string; profile: string; call: string; details: string; status: string; createdAt: number; reportedUid: string | null; reportedName: string | null; actions?: Act[] }
interface WalletRow { uid: string; name: string | null; username: string | null; email: string | null; paidTopupRupees: number; lastTopupAt: number | null; balanceRupees: number | null; availableRupees: number | null; reservedRupees: number | null; debtRupees: number | null }
interface Block { blockerUid: string; blockerName: string | null; blockedUid: string; blockedName: string | null; callId: string | null; at: number }
interface MoneyCase { id: string; kind: string; subject_id: string; rule: string; status: string; uid: string | null; host_uid: string | null; expected_paise: number | null; actual_paise: number | null; created_at: number; detail?: unknown }

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="hfa-table" style={{ minWidth: 720 }}>
        <thead><tr>{head.map((h) => <th key={h} style={T14}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const OpenCtx = createContext<(uid: string) => void>(() => {});
/** A user id that opens that person's page (wallet, top-ups, bookings, calls, reports). */
function UidLink({ uid }: { uid: string }) {
  const open = useContext(OpenCtx);
  return <button type="button" className="hfa-note" title="Open this person" onClick={() => open(uid)} style={{ wordBreak: 'break-all', background: 'none', border: 0, padding: '4px 0', minHeight: 32, textAlign: 'left', cursor: 'pointer', textDecoration: 'underline', color: 'inherit' }}>{uid}</button>;
}
const uidNote = (uid: string) => <UidLink uid={uid} />;

/** Cursor-paged list loader. `path` already carries its query string. */
function usePagedList<T>(path: string, pick: (j: any) => T[], cursorParam = 'cursor') {
  const [items, setItems] = useState<T[] | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sep = path.includes('?') ? '&' : '?';
  const load = useCallback(async (more: boolean, from: string | null) => {
    setBusy(true); setError(null);
    try {
      const j = await adminCall<any>(`${path}${more && from ? `${sep}${cursorParam}=${encodeURIComponent(from)}` : ''}`);
      setItems((old) => (more && old ? [...old, ...pick(j)] : pick(j)));
      setMeta(j); setCursor(j.nextCursor ?? (j.next != null ? String(j.next) : null));
    } catch (e) { setError(fail('hf_desk_list', e, { path })); if (!more) setItems([]); }
    setBusy(false);
  }, [path, sep, cursorParam]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setItems(null); setMeta(null); void load(false, null); }, [load]);
  return { items, meta, cursor, error, busy, more: () => void load(true, cursor), reload: () => void load(false, null) };
}

function Footer({ l, shown }: { l: { cursor: string | null; busy: boolean; more: () => void; reload: () => void; items: unknown[] | null }; shown?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      {l.cursor && <button type="button" className="hfa-btn ghost" disabled={l.busy} onClick={l.more}>{l.busy ? 'Loading…' : 'Show more'}</button>}
      <button type="button" className="hfa-btn ghost" disabled={l.busy} onClick={l.reload}>Refresh</button>
      {shown !== false && l.items && <span className="hfa-note">{l.items.length} shown</span>}
    </div>
  );
}

function Common({ l, empty, label }: { l: { items: unknown[] | null; error: string | null }; empty: string; label: string }) {
  return (
    <>
      {l.error && <Banner tone="error">{l.error}</Banner>}
      {l.items === null && <Spinner label={label} />}
      {l.items && l.items.length === 0 && !l.error && <DesiCard tone="lav"><DesiEmpty text={empty} /></DesiCard>}
    </>
  );
}

function Members() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const l = usePagedList<Member>(`/api/admin/hf/desk/members${applied ? `?q=${encodeURIComponent(applied)}` : ''}`, (j) => j.items ?? []);
  return (
    <div className="hfa-stack">
      <form style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); }}>
        <input aria-label="Search sign-ups" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, @username, email, last 4 digits of WhatsApp, or user id" style={{ ...T14, flex: '1 1 280px', minHeight: 44, padding: 10, borderRadius: 10, border: '1px solid var(--hf-admin-line)' }} />
        <button type="submit" className="hfa-btn tea">Search</button>
        {applied && <button type="button" className="hfa-btn ghost" onClick={() => { setQ(''); setApplied(''); }}>Clear</button>}
      </form>
      <Common l={l} label="Loading sign-ups…" empty={applied ? 'Nobody matches that search.' : 'No sign-ups yet.'} />
      {l.items && l.items.length > 0 && (
        <Table head={['Person', 'Joined', 'Verified', 'Role', 'Activity', 'Status']}>
          {l.items.map((m) => (
            <tr key={m.uid}>
              <td style={T14}><strong>{who(m.name, m.username)}</strong>{m.username && <div className="hfa-note">@{m.username}</div>}
                <div className="hfa-note">{m.email || 'no email yet'}{m.phone ? ` · ${m.phone}` : ''}</div>{uidNote(m.uid)}</td>
              <td style={T14}>{dateIST(m.joinedAt)}<div className="hfa-note">via {m.via || 'app'}{m.registeredAt ? ' · profile done' : ' · profile not finished'}</div></td>
              <td style={T14}><DesiChip tone={m.whatsappVerified ? 'tea' : 'grey'}>WhatsApp {m.whatsappVerified ? 'yes' : 'no'}</DesiChip>{' '}<DesiChip tone={m.emailVerified ? 'tea' : 'grey'}>Email {m.emailVerified ? 'yes' : 'no'}</DesiChip></td>
              <td style={T14}>{m.hostStatus ? <DesiChip tone={m.hostStatus === 'live' ? 'tea' : m.hostStatus === 'pending_review' ? 'gold' : 'lav'}>{m.hostCategory === 'influencer' ? 'Influencer' : 'Host'} · {m.hostStatus.replace('_', ' ')}</DesiChip> : 'Caller'}</td>
              <td style={T14}>{m.topups} top-up{m.topups === 1 ? '' : 's'} ({inr0(m.topupRupees)})<div className="hfa-note">{m.bookings} booking{m.bookings === 1 ? '' : 's'} · {m.calls} call{m.calls === 1 ? '' : 's'}</div></td>
              <td style={T14}>{m.closing ? <DesiChip tone="plum">Closing: {m.closing.replace('_', ' ')}</DesiChip> : m.accountStatus && m.accountStatus !== 'active' ? <DesiChip tone="red">{m.accountStatus.replace('_', ' ')}</DesiChip> : <DesiChip tone="tea">Active</DesiChip>}</td>
            </tr>
          ))}
        </Table>
      )}
      <Footer l={l} />
    </div>
  );
}

const BOOKING_STATUSES = ['all', 'confirming', 'confirmed', 'completed', 'cancelled', 'failed'] as const;
function Bookings() {
  const [st, setSt] = useState<string>('all');
  const l = usePagedList<Booking>(`/api/admin/hf/desk/bookings?status=${st}`, (j) => j.items ?? []);
  const counts: Record<string, { n: number; rupees: number }> = l.meta?.counts ?? {};
  return (
    <div className="hfa-stack">
      <div className="hfa-pills">
        {BOOKING_STATUSES.map((s) => <button key={s} type="button" className="hfa-pill" aria-pressed={st === s} onClick={() => setSt(s)}>{s === 'all' ? 'All' : s}{s !== 'all' && counts[s] ? ` (${counts[s].n})` : ''}</button>)}
      </div>
      <Common l={l} label="Loading bookings…" empty="No bookings here." />
      {l.items && l.items.length > 0 && (
        <Table head={['When', 'Caller', 'Influencer / host', 'Money held', 'Status']}>
          {l.items.map((b) => (
            <tr key={b.id}>
              <td style={T14}>{dateIST(b.startsAt)}<div className="hfa-note">{b.durationMin} min · booked {dateIST(b.createdAt)}</div></td>
              <td style={T14}>{who(b.customerName, b.customerUsername)}{uidNote(b.customerUid)}</td>
              <td style={T14}>{b.hostName || b.hostSlug || 'Host'}{uidNote(b.hostUid)}</td>
              <td style={T14}>{inr(b.reservedRupees)}<div className="hfa-note">host net {inr(b.hostNetRupees)} · {b.settlement}</div></td>
              <td style={T14}><DesiChip tone={b.status === 'completed' ? 'tea' : b.status === 'cancelled' || b.status === 'failed' ? 'rani' : 'gold'}>{b.status}</DesiChip>
                {b.cancelReason && <div className="hfa-note">{b.cancelReason}</div>}{b.callId && <div className="hfa-note">call {b.callId}</div>}</td>
            </tr>
          ))}
        </Table>
      )}
      <Footer l={l} />
    </div>
  );
}

const TOPUP_STATUSES = ['all', 'paid', 'created', 'failed', 'refunded', 'expired'] as const;
function Topups() {
  const [st, setSt] = useState<string>('all');
  const l = usePagedList<Topup>(`/api/admin/hf/desk/topups?status=${st}`, (j) => j.items ?? []);
  const m = l.meta;
  return (
    <div className="hfa-stack">
      {m && <DesiKpis>
        <DesiKpi tone="tea" label="Paid today" value={inr0(m.today?.rupees)} sub={`${m.today?.n ?? 0} top-ups`} />
        <DesiKpi tone="gold" label="Paid this month" value={inr0(m.month?.rupees)} sub={`${m.month?.n ?? 0} top-ups`} />
      </DesiKpis>}
      <div className="hfa-pills">
        {TOPUP_STATUSES.map((s) => <button key={s} type="button" className="hfa-pill" aria-pressed={st === s} onClick={() => setSt(s)}>{s === 'all' ? 'All' : s}{s !== 'all' && m?.counts?.[s] ? ` (${m.counts[s].n})` : ''}</button>)}
      </div>
      <Common l={l} label="Loading top-ups…" empty="No top-ups here." />
      {l.items && l.items.length > 0 && (
        <Table head={['Paid', 'Person', 'Amount', 'Receipt', 'Status']}>
          {l.items.map((t) => (
            <tr key={t.id}>
              <td style={T14}>{dateIST(t.paidAt ?? t.createdAt)}<div className="hfa-note">{t.id}</div></td>
              <td style={T14}>{who(t.name, t.username)}{uidNote(t.uid)}</td>
              <td style={T14}><strong>{inr(t.amountRupees)}</strong><div className="hfa-note">{t.gateway}{t.walletRupees != null ? ` · wallet ${inr(t.walletRupees)}` : ''}{t.gstRupees != null ? ` · GST ${inr(t.gstRupees)}` : ''}{t.refundedRupees ? ` · refunded ${inr(t.refundedRupees)}` : ''}</div></td>
              <td style={T14}>{t.receipt || '—'}{t.paymentId && <div className="hfa-note">{t.paymentId}</div>}</td>
              <td style={T14}><DesiChip tone={t.status === 'paid' ? 'tea' : t.status === 'created' ? 'gold' : 'rani'}>{t.status}</DesiChip>{t.status === 'paid' && !t.credited && <div className="hfa-note">paid but wallet credit not recorded: check Reconciliation</div>}</td>
            </tr>
          ))}
        </Table>
      )}
      <Footer l={l} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- [HF-ADMIN-COMPLETE-1] actions
interface Act { id: string; action: string; body: string | null; channel: string | null; adminUid: string; at: number }
const ACT_LABEL: Record<string, string> = { note: 'Note', resolve: 'Marked resolved', reopen: 'Reopened', reviewed: 'Marked reviewed', actioned: 'Marked actioned', closed: 'Closed', open: 'Reopened', reply_email: 'Emailed', reply_whatsapp: 'WhatsApp sent' };

function Timeline({ acts }: { acts: Act[] | undefined }) {
  if (!acts || acts.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 4, borderLeft: '3px solid var(--hf-admin-line)', paddingLeft: 10 }}>
      {acts.map((a) => (
        <div key={a.id} style={T14}><strong>{ACT_LABEL[a.action] ?? a.action}</strong> <span className="hfa-note">{dateIST(a.at)} · {a.adminUid.slice(0, 10)}</span>
          {a.body && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.body}</div>}</div>
      ))}
    </div>
  );
}

const TEXT_STYLE = { ...T14, width: '100%', minHeight: 44, padding: 10, borderRadius: 10, border: '1px solid var(--hf-admin-line)', fontFamily: 'inherit' } as const;

/** One admin action against the worker: posts, tells PostHog, reloads the list, shows the error in plain words. */
function useActor(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (label: string, path: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setError(null); setDone(null);
    try { await adminCall(path, { method: 'POST', body }); capture('hf_admin_desk_action', { action: label, ok: true }); setDone('Done.'); reload(); return true; }
    catch (e) { setError(fail('hf_desk_action', e, { action: label })); return false; }
    finally { setBusy(false); }
  };
  return { busy, error, done, run };
}

type PanelKind = 'support' | 'reports' | 'incidents' | 'member';
/** Note / reply / resolve (questions) or reviewed-actioned-closed with a reason (reports) for one item, with its timeline. */
function ActionPanel({ kind, id, ticketOpen, state, acts, canReply, reload }: { kind: PanelKind; id: string; ticketOpen?: boolean; state?: string; acts: Act[] | undefined; canReply: boolean; reload: () => void }) {
  const [mode, setMode] = useState<null | 'note' | 'reply' | 'review'>(null);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email');
  const [status, setStatus] = useState<'reviewed' | 'actioned' | 'closed' | 'open'>('reviewed');
  const [alsoResolve, setAlsoResolve] = useState(false);
  const a = useActor(reload);
  const base = `/api/admin/hf/desk/${kind}/${encodeURIComponent(id)}`;
  const finish = async (ok: Promise<boolean>) => { if (await ok) { setText(''); setMode(null); setAlsoResolve(false); } };
  return (
    <div className="hfa-stack" style={{ gap: 10 }}>
      <Timeline acts={acts} />
      {a.error && <Banner tone="error">{a.error}</Banner>}
      {a.done && !mode && <span className="hfa-note" style={T14}>{a.done}</span>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canReply && <button type="button" className="hfa-btn ghost" aria-pressed={mode === 'reply'} onClick={() => setMode(mode === 'reply' ? null : 'reply')}>Reply</button>}
        <button type="button" className="hfa-btn ghost" aria-pressed={mode === 'note'} onClick={() => setMode(mode === 'note' ? null : 'note')}>Add note</button>
        {kind === 'support' && (ticketOpen
          ? <button type="button" className="hfa-btn tea" disabled={a.busy} onClick={() => void a.run('support_resolve', `${base}/resolve`, {})}>Mark resolved</button>
          : <button type="button" className="hfa-btn ghost" disabled={a.busy} onClick={() => void a.run('support_reopen', `${base}/reopen`, {})}>Reopen</button>)}
        {(kind === 'reports' || kind === 'incidents') && <button type="button" className="hfa-btn tea" aria-pressed={mode === 'review'} onClick={() => setMode(mode === 'review' ? null : 'review')}>{state && state !== 'open' ? `Change review (${state})` : 'Mark reviewed / actioned'}</button>}
      </div>
      {mode && (
        <div className="hfa-stack" style={{ gap: 8 }}>
          {mode === 'reply' && (
            <div className="hfa-pills" role="group" aria-label="Send by">
              <button type="button" className="hfa-pill" aria-pressed={channel === 'email'} onClick={() => setChannel('email')}>By email</button>
              <button type="button" className="hfa-pill" aria-pressed={channel === 'whatsapp'} onClick={() => setChannel('whatsapp')}>By WhatsApp</button>
            </div>
          )}
          {mode === 'review' && (
            <div className="hfa-pills" role="group" aria-label="Review result">
              {(['reviewed', 'actioned', 'closed', 'open'] as const).map((s) => <button key={s} type="button" className="hfa-pill" aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'open' ? 'Back to open' : s}</button>)}
            </div>
          )}
          <textarea aria-label={mode === 'reply' ? 'Message to send' : mode === 'review' ? 'Reason' : 'Internal note'} rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} style={TEXT_STYLE}
            placeholder={mode === 'reply' ? 'Your message. The person receives exactly this.' : mode === 'review' ? 'Why (required unless you are reopening). Kept in the audit log.' : 'Only the team sees this note.'} />
          {mode === 'reply' && kind === 'support' && <label style={T14}><input type="checkbox" checked={alsoResolve} onChange={(e) => setAlsoResolve(e.target.checked)} /> Also mark this question resolved</label>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="hfa-btn tea" disabled={a.busy || (text.trim().length < 2 && !(mode === 'review' && status === 'open'))} onClick={() => {
              if (mode === 'reply') void finish(a.run(`${kind}_reply_${channel}`, `${base}/reply`, { channel, message: text, alsoResolve }));
              else if (mode === 'review') void finish(a.run(`${kind}_review_${status}`, `${base}/review`, { status, reason: text }));
              else void finish(a.run(`${kind}_note`, `${base}/note`, { note: text }));
            }}>{a.busy ? 'Saving…' : mode === 'reply' ? `Send by ${channel === 'email' ? 'email' : 'WhatsApp'}` : mode === 'review' ? 'Save review' : 'Save note'}</button>
            <button type="button" className="hfa-btn ghost" onClick={() => { setMode(null); setText(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Support() {
  const [st, setSt] = useState<string>('open');
  const l = usePagedList<Ticket>(`/api/admin/hf/desk/support?status=${st}`, (j) => j.items ?? []);
  const counts: Record<string, number> = l.meta?.counts ?? {};
  const keys = ['open', 'closed', 'all'];
  return (
    <div className="hfa-stack">
      <div className="hfa-pills">
        {keys.map((s) => <button key={s} type="button" className="hfa-pill" aria-pressed={st === s} onClick={() => setSt(s)}>{s === 'all' ? 'All' : s}{s !== 'all' && counts[s] != null ? ` (${counts[s]})` : ''}</button>)}
      </div>
      <p className="hfa-note" style={T14}>Each question is also emailed to the support inbox. Reply here by email or WhatsApp, leave a note for the team, and mark it resolved when it is done. Everything you do is logged.</p>
      <Common l={l} label="Loading questions…" empty={st === 'open' ? 'Nothing waiting. All questions are answered.' : 'No support questions here.'} />
      <div style={{ display: 'grid', gap: 12 }}>
        {l.items?.map((t) => (
          <DesiCard key={t.id} tone="white" title={`${t.id} · ${t.topic}`} note={`${who(t.name, t.username)} · ${t.email || 'no email'} · ${dateIST(t.createdAt)}`} action={<DesiChip tone={t.status === 'open' ? 'gold' : 'tea'}>{t.status}</DesiChip>}>
            <p style={{ ...T14, whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{t.message}</p>
            {uidNote(t.uid)}
            <ActionPanel kind="support" id={t.id} ticketOpen={t.status === 'open'} acts={t.actions} canReply reload={l.reload} />
          </DesiCard>
        ))}
      </div>
      <Footer l={l} />
    </div>
  );
}

const stateTone = (s: string) => (s === 'open' ? 'gold' : s === 'actioned' ? 'rani' : 'tea') as 'gold' | 'rani' | 'tea';

function Reports() {
  const [onlyOpen, setOnlyOpen] = useState(true);
  const l = usePagedList<Incident>('/api/admin/hf/desk/reports', (j) => j.incidents ?? []);
  const blocks: Block[] = l.meta?.blocks ?? [];
  const forms: UserReport[] = l.meta?.userReports ?? [];
  const shownForms = onlyOpen ? forms.filter((r) => r.status === 'open') : forms;
  const shownInc = onlyOpen ? (l.items ?? []).filter((i) => i.state === 'open') : l.items ?? [];
  return (
    <div className="hfa-stack">
      <div className="hfa-pills">
        <button type="button" className="hfa-pill" aria-pressed={onlyOpen} onClick={() => setOnlyOpen(true)}>Needs a look ({forms.filter((r) => r.status === 'open').length + (l.items ?? []).filter((i) => i.state === 'open').length})</button>
        <button type="button" className="hfa-pill" aria-pressed={!onlyOpen} onClick={() => setOnlyOpen(false)}>Everything</button>
      </div>
      <Common l={l} label="Loading reports…" empty="No reports yet." />
      {shownForms.length > 0 && <h3 className="hfa-title" style={T14}>Reports sent from the report form</h3>}
      {shownForms.map((r) => (
        <DesiCard key={r.id} tone="white" title={`${r.id} · about ${r.profile}`} note={`From ${r.contact}${r.uid ? ' (signed in)' : ''} · call ${r.call} · ${dateIST(r.createdAt)}`} action={<DesiChip tone={stateTone(r.status)}>{r.status}</DesiChip>}>
          <p style={{ ...T14, whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{r.details}</p>
          <div style={T14}>Reported person: {r.reportedUid ? <>{who(r.reportedName)} {uidNote(r.reportedUid)}</> : <span className="hfa-note">could not be matched from the form, check the call</span>}</div>
          {r.uid && <div style={T14}>Reporter: {uidNote(r.uid)}</div>}
          <ActionPanel kind="reports" id={r.id} state={r.status} acts={r.actions} canReply reload={l.reload} />
        </DesiCard>
      ))}
      {shownInc.length > 0 && <h3 className="hfa-title" style={T14}>Reports and blocks made during calls</h3>}
      {shownInc.map((i) => (
        <DesiCard key={i.id} tone="white" title={`${i.kind.replace('dash_report:', 'Report: ').replace('hash_block', 'Blocked with #')}`} note={`${dateIST(i.at)} · call ${i.callId}`} action={<DesiChip tone={stateTone(i.state)}>{i.state}</DesiChip>}>
          <div style={T14}>Reported by {who(i.reporterName)} {uidNote(i.reporterUid)}</div>
          <div style={T14}>About {who(i.otherName)} {i.otherUid && uidNote(i.otherUid)}</div>
          <ActionPanel kind="incidents" id={i.id} state={i.state} acts={i.actions} canReply={false} reload={l.reload} />
        </DesiCard>
      ))}
      {l.items && forms.length + l.items.length > 0 && shownForms.length + shownInc.length === 0 && <DesiCard tone="lav"><DesiEmpty text="Nothing needs a look. Choose Everything to see past reports." /></DesiCard>}
      {blocks.length > 0 && (
        <DesiCard tone="white" title="Who blocked whom" note="Newest 100 blocks.">
          <Table head={['When', 'Blocked by', 'Blocked person']}>
            {blocks.map((b) => (
              <tr key={`${b.blockerUid}:${b.blockedUid}`}>
                <td style={T14}>{dateIST(b.at)}</td>
                <td style={T14}>{who(b.blockerName)}{uidNote(b.blockerUid)}</td>
                <td style={T14}>{who(b.blockedName)}{uidNote(b.blockedUid)}</td>
              </tr>
            ))}
          </Table>
        </DesiCard>
      )}
      <Footer l={l} shown={false} />
    </div>
  );
}

/** The money-audit route answers { cases, counts, next } (no `ok`; `next` is a created_at cursor sent back as `before`). */
function MoneyRow({ c, reload }: { c: MoneyCase; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const a = useActor(reload);
  const detail = c.detail && typeof c.detail === 'object' ? Object.entries(c.detail as Record<string, unknown>).slice(0, 8).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : c.detail ? String(c.detail) : '';
  return (
    <tr>
      <td style={T14}>{dateIST(c.created_at)}</td>
      <td style={T14}>{c.rule}{detail && <div className="hfa-note" style={{ overflowWrap: 'anywhere' }}>{detail}</div>}</td>
      <td style={T14}>{c.kind} {c.subject_id}{c.uid && uidNote(c.uid)}</td>
      <td style={T14}>{c.expected_paise == null ? '—' : inr(c.expected_paise / 100)}</td>
      <td style={T14}>{c.actual_paise == null ? '—' : inr(c.actual_paise / 100)}</td>
      <td style={T14}>
        <DesiChip tone={c.status === 'open' ? 'rani' : 'tea'}>{c.status}</DesiChip>
        {c.status === 'open' && (open ? (
          <div className="hfa-stack" style={{ gap: 6, marginTop: 8 }}>
            {a.error && <Banner tone="error">{a.error}</Banner>}
            <textarea aria-label="What you checked" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked or fixed by hand" style={TEXT_STYLE} />
            <button type="button" className="hfa-btn tea" disabled={a.busy} onClick={() => void a.run('money_resolve', `/api/admin/hf/money-audit/${encodeURIComponent(c.id)}/resolve`, { note })}>{a.busy ? 'Saving…' : 'Mark resolved'}</button>
          </div>
        ) : <div style={{ marginTop: 8 }}><button type="button" className="hfa-btn ghost" onClick={() => setOpen(true)}>Resolve…</button></div>)}
      </td>
    </tr>
  );
}

function Money() {
  const [st, setSt] = useState<'open' | 'fixed' | 'resolved' | 'all'>('open');
  const l = usePagedList<MoneyCase>(`/api/admin/hf/money-audit?status=${st}`, (j) => j.cases ?? [], 'before');
  const counts: Record<string, number> = l.meta?.counts ?? {};
  return (
    <div className="hfa-stack">
      <p className="hfa-note" style={T14}>Cases the call-money monitor could not fix by itself. "Open" means someone should look. Resolving closes the case and keeps your note; no money moves.</p>
      <div className="hfa-pills">
        {(['open', 'fixed', 'resolved', 'all'] as const).map((s) => <button key={s} type="button" className="hfa-pill" aria-pressed={st === s} onClick={() => setSt(s)}>{s}{s !== 'all' && counts[s] != null ? ` (${counts[s]})` : ''}</button>)}
      </div>
      <Common l={l} label="Loading money alerts…" empty="No money alerts here." />
      {l.items && l.items.length > 0 && (
        <Table head={['When', 'Rule', 'Subject', 'Expected', 'Actual', 'Status']}>
          {l.items.map((c) => <MoneyRow key={c.id} c={c} reload={l.reload} />)}
        </Table>
      )}
      <Footer l={l} />
    </div>
  );
}

function Wallets() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const l = usePagedList<WalletRow>(`/api/admin/hf/desk/wallets${applied ? `?q=${encodeURIComponent(applied)}` : ''}`, (j) => j.items ?? []);
  return (
    <div className="hfa-stack">
      <p className="hfa-note" style={T14}>Everyone who has paid in or holds money, newest top-up first. The balance is the same rupee figure the person sees in the app.</p>
      <form style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); }}>
        <input aria-label="Search wallets" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, @username, email or user id" style={{ ...T14, flex: '1 1 280px', minHeight: 44, padding: 10, borderRadius: 10, border: '1px solid var(--hf-admin-line)' }} />
        <button type="submit" className="hfa-btn tea">Search</button>
        {applied && <button type="button" className="hfa-btn ghost" onClick={() => { setQ(''); setApplied(''); }}>Clear</button>}
      </form>
      <Common l={l} label="Loading wallets…" empty={applied ? 'No wallet matches that search.' : 'No wallets with money yet.'} />
      {l.items && l.items.length > 0 && (
        <Table head={['Person', 'Balance', 'Available / held', 'Paid in', 'Last top-up']}>
          {l.items.map((w) => (
            <tr key={w.uid}>
              <td style={T14}><strong>{who(w.name, w.username)}</strong><div className="hfa-note">{w.email || 'no email yet'}</div>{uidNote(w.uid)}</td>
              <td style={T14}><strong>{inr(w.balanceRupees)}</strong>{!!w.debtRupees && <div className="hfa-note">owes {inr(w.debtRupees)}</div>}</td>
              <td style={T14}>{inr(w.availableRupees)}<div className="hfa-note">held {inr(w.reservedRupees)}</div></td>
              <td style={T14}>{inr(w.paidTopupRupees)}</td>
              <td style={T14}>{dateIST(w.lastTopupAt)}</td>
            </tr>
          ))}
        </Table>
      )}
      <Footer l={l} />
    </div>
  );
}

function MemberPage({ uid, onBack }: { uid: string; onBack: () => void }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    adminCall<any>(`/api/admin/hf/desk/member?uid=${encodeURIComponent(uid)}`).then((j) => { setD(j); setError(null); }).catch((e) => setError(fail('hf_desk_member', e, { uid })));
  }, [uid]);
  useEffect(() => { setD(null); load(); }, [load]);
  if (error) return <div className="hfa-stack"><button type="button" className="hfa-btn ghost" onClick={onBack}>Back to the list</button><Banner tone="error">{error}</Banner></div>;
  if (!d) return <Spinner label="Loading this person…" />;
  const m = d.member, w = d.wallet;
  const Sect = ({ title, n, children }: { title: string; n: number; children: ReactNode }) => (
    <DesiCard tone="white" title={`${title} (${n})`}>{n === 0 ? <DesiEmpty text="Nothing yet." /> : children}</DesiCard>
  );
  return (
    <div className="hfa-stack">
      <div><button type="button" className="hfa-btn ghost" onClick={onBack}>Back to the list</button></div>
      <DesiCard tone="lav" title={who(m.name, m.username)} note={`${m.email || 'no email'}${m.phone ? ` · ${m.phone}` : ''} · joined ${dateIST(m.joinedAt)} via ${m.via || 'app'}`}
        action={<span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {m.host && <DesiChip tone={m.host.status === 'live' ? 'tea' : 'gold'}>{m.host.category === 'influencer' ? 'Influencer' : 'Host'} · {String(m.host.status).replace('_', ' ')}</DesiChip>}
          <DesiChip tone={m.whatsappVerified ? 'tea' : 'grey'}>WhatsApp {m.whatsappVerified ? 'yes' : 'no'}</DesiChip>
          <DesiChip tone={m.emailVerified ? 'tea' : 'grey'}>Email {m.emailVerified ? 'yes' : 'no'}</DesiChip>
          {m.accountStatus && m.accountStatus !== 'active' && <DesiChip tone="red">{String(m.accountStatus).replace('_', ' ')}</DesiChip>}
        </span>}>
        {uidNote(m.uid)}
        {m.closure && <p style={{ ...T14, margin: 0 }}><DesiChip tone={m.closure.active ? 'plum' : 'grey'}>Account closure: {String(m.closure.status).replace('_', ' ')}</DesiChip> asked {dateIST(m.closure.requestedAt)}{m.closure.note ? ` · ${m.closure.note}` : ''}</p>}
      </DesiCard>
      {w ? (
        <DesiKpis>
          <DesiKpi tone="plum" label="Wallet balance" value={inr(w.balanceRupees)} sub={w.mode === 'rupees' ? 'same figure as the app' : 'older wallet'} />
          {w.availableRupees != null && <DesiKpi tone="tea" label="Available to spend" value={inr(w.availableRupees)} sub={w.reservedRupees ? `${inr(w.reservedRupees)} held for a call` : undefined} />}
          <DesiKpi tone="gold" label="Paid money" value={inr(w.paidRupees)} sub={`test credit ${inr(w.testRupees)}`} />
          {!!w.debtRupees && <DesiKpi tone="rani" label="Owes us" value={inr(w.debtRupees)} alert />}
          {w.host && <DesiKpi tone="lav" label="Earnings (influencer)" value={inr(w.host.availablePaise != null ? w.host.availablePaise / 100 : w.host.availableRupees)} sub={`total ${inr(w.host.totalEarnedPaise != null ? w.host.totalEarnedPaise / 100 : w.host.lifetimePaidEarnings)}`} />}
        </DesiKpis>
      ) : <Banner tone="error">The wallet could not be read just now. Refresh in a minute.</Banner>}
      <DesiCard tone="white" title="Notes for the team" note="Only the team sees these.">
        <ActionPanel kind="member" id={m.uid} acts={d.notes} canReply={false} reload={load} />
      </DesiCard>
      <Sect title="Top-ups" n={d.topups.length}>
        <Table head={['When', 'Amount', 'Status']}>{d.topups.map((t: any) => <tr key={t.id}><td style={T14}>{dateIST(t.paidAt ?? t.createdAt)}<div className="hfa-note">{t.id}</div></td><td style={T14}>{inr(t.amountRupees)}<div className="hfa-note">{t.gateway}{t.walletRupees != null ? ` · wallet ${inr(t.walletRupees)}` : ''}{t.refundedRupees ? ` · refunded ${inr(t.refundedRupees)}` : ''}</div></td><td style={T14}><DesiChip tone={t.status === 'paid' ? 'tea' : t.status === 'created' ? 'gold' : 'rani'}>{t.status}</DesiChip></td></tr>)}</Table>
      </Sect>
      <Sect title="Withdrawals" n={d.withdrawals.length}>
        <Table head={['Asked', 'Amount', 'Status']}>{d.withdrawals.map((x: any) => <tr key={x.id}><td style={T14}>{dateIST(x.createdAt)}<div className="hfa-note">{x.id}</div></td><td style={T14}>{inr(x.amountRupees)}{x.utr && <div className="hfa-note">UTR {x.utr}</div>}</td><td style={T14}><DesiChip tone={x.status === 'paid' ? 'tea' : x.status === 'rejected' || x.status === 'cancelled' ? 'rani' : 'gold'}>{x.status}</DesiChip>{x.rejectReason && <div className="hfa-note">{x.rejectReason}</div>}</td></tr>)}</Table>
      </Sect>
      {d.refunds.length > 0 && <Sect title="Wallet refunds" n={d.refunds.length}>
        <Table head={['Asked', 'Amount', 'Status']}>{d.refunds.map((x: any) => <tr key={x.id}><td style={T14}>{dateIST(x.createdAt)}<div className="hfa-note">{x.id}{x.exit ? ' · account closure' : ''}</div></td><td style={T14}>{inr(x.amountRupees)}</td><td style={T14}><DesiChip tone={x.status === 'refunded' ? 'tea' : x.status === 'rejected' || x.status === 'failed' ? 'rani' : 'gold'}>{x.status}</DesiChip>{x.reason && <div className="hfa-note">{x.reason}</div>}</td></tr>)}</Table>
      </Sect>}
      <Sect title="Bookings" n={d.bookings.length}>
        <Table head={['When', 'Role', 'Other person', 'Money held', 'Status']}>{d.bookings.map((b: any) => <tr key={b.id}><td style={T14}>{dateIST(b.startsAt)}<div className="hfa-note">{b.durationMin} min</div></td><td style={T14}>{b.role}</td><td style={T14}>{uidNote(b.otherUid)}</td><td style={T14}>{inr(b.reservedRupees)}</td><td style={T14}><DesiChip tone={b.status === 'completed' ? 'tea' : b.status === 'cancelled' || b.status === 'failed' ? 'rani' : 'gold'}>{b.status}</DesiChip>{b.cancelReason && <div className="hfa-note">{b.cancelReason}</div>}</td></tr>)}</Table>
      </Sect>
      <Sect title="Calls" n={d.calls.length}>
        <Table head={['When', 'Role', 'Other person', 'Length', 'Charged']}>{d.calls.map((c: any) => <tr key={c.id}><td style={T14}>{dateIST(c.createdAt)}<div className="hfa-note">{c.id} · {c.status}</div></td><td style={T14}>{c.role}</td><td style={T14}>{uidNote(c.otherUid)}</td><td style={T14}>{c.minutes != null ? `${c.minutes} min` : c.seconds ? `${Math.round(c.seconds / 60)} min` : '—'}</td><td style={T14}>{c.chargedRupees != null ? inr(c.chargedRupees) : '—'}</td></tr>)}</Table>
      </Sect>
      <Sect title="Blocks and reports" n={d.blocks.byMember.length + d.blocks.ofMember.length + d.incidents.length + d.reports.length}>
        <div className="hfa-stack" style={{ gap: 8 }}>
          {d.blocks.ofMember.map((b: any) => <div key={`o${b.uid}`} style={T14}>Blocked {who(b.name)} {uidNote(b.uid)} <span className="hfa-note">{dateIST(b.at)}</span></div>)}
          {d.blocks.byMember.map((b: any) => <div key={`b${b.uid}`} style={T14}>Was blocked by {who(b.name)} {uidNote(b.uid)} <span className="hfa-note">{dateIST(b.at)}</span></div>)}
          {d.incidents.map((i: any) => <div key={i.id} style={T14}>Call report {i.kind.replace('dash_report:', '')} on call {i.callId} <span className="hfa-note">{dateIST(i.at)}</span></div>)}
          {d.reports.map((r: any) => <div key={r.id} style={T14}>Report form {r.id} about {r.profile}: {r.details.slice(0, 160)} <DesiChip tone={stateTone(r.status)}>{r.status}</DesiChip></div>)}
        </div>
      </Sect>
      <Sect title="Support questions" n={d.tickets.length}>
        {d.tickets.map((t: any) => <div key={t.id} style={{ ...T14, marginBottom: 8 }}><strong>{t.id} · {t.topic}</strong> <DesiChip tone={t.status === 'open' ? 'gold' : 'tea'}>{t.status}</DesiChip><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.message}</div></div>)}
      </Sect>
    </div>
  );
}

export default function HfDesk() {
  const initial = (): TabKey => {
    try { const t = new URLSearchParams(window.location.search).get('tab'); if (TABS.some((x) => x.key === t)) return t as TabKey; } catch { /* ssr */ }
    return 'members';
  };
  const [tab, setTab] = useState<TabKey>('members');
  const [uid, setUid] = useState<string | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  useEffect(() => { setTab(initial()); try { setUid(new URLSearchParams(window.location.search).get('uid')); } catch { /* ssr */ } }, []);
  useEffect(() => { adminCall<Summary>('/api/admin/hf/desk/summary').then(setSum).catch((e) => setSumErr(fail('hf_desk_summary', e))); }, []);
  const setUrl = (k: TabKey | null, u: string | null) => { try { const x = new URL(window.location.href); if (k) x.searchParams.set('tab', k); if (u) x.searchParams.set('uid', u); else x.searchParams.delete('uid'); window.history.replaceState(null, '', x); } catch { /* ignore */ } };
  const pick = (k: TabKey) => { setTab(k); setUid(null); setUrl(k, null); };
  const openMember = useCallback((u: string) => { setUid(u); setUrl(null, u); window.scrollTo?.({ top: 0 }); }, []);
  return (
    <OpenCtx.Provider value={openMember}>
      <ConsultShell className="hf-admin-operations">
        <div className="hfa-stack">
          {sumErr && <Banner tone="error">{sumErr}</Banner>}
          <DesiKpis>
            <DesiKpi tone="rani" label="Sign-ups" value={sum ? sum.members.total : '…'} sub={sum ? `${sum.members.last24h} in 24h · ${sum.members.last7d} in 7 days` : undefined} onClick={() => pick('members')} />
            <DesiKpi tone="tea" label="Influencers live" value={sum ? sum.hosts.live : '…'} sub={sum ? `${sum.hosts.pendingReview} waiting for review` : undefined} />
            <DesiKpi tone="gold" label="Open bookings" value={sum ? sum.bookingsOpen : '…'} onClick={() => pick('bookings')} />
            <DesiKpi tone="lav" label="Open questions" value={sum ? sum.ticketsOpen : '…'} alert={!!sum && sum.ticketsOpen > 0} onClick={() => pick('support')} />
            <DesiKpi tone="saffron" label="Open reports" value={sum ? sum.reportsOpen : '…'} alert={!!sum && sum.reportsOpen > 0} onClick={() => pick('reports')} />
            <DesiKpi tone="plum" label="Money alerts" value={sum ? sum.moneyAlertsOpen : '…'} sub={sum ? `${sum.payoutsOpen} withdrawals / ${sum.refundsOpen} refunds waiting` : undefined} alert={!!sum && sum.moneyAlertsOpen > 0} onClick={() => pick('money')} />
          </DesiKpis>
          <div role="tablist" aria-label="Members and activity" className="hfa-pills">
            {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key && !uid} className="hfa-pill" onClick={() => pick(t.key)}>{t.label}</button>)}
          </div>
          {uid ? <MemberPage uid={uid} onBack={() => { setUid(null); setUrl(tab, null); }} /> : (<>
            {tab === 'members' && <Members />}
            {tab === 'wallets' && <Wallets />}
            {tab === 'bookings' && <Bookings />}
            {tab === 'topups' && <Topups />}
            {tab === 'support' && <Support />}
            {tab === 'reports' && <Reports />}
            {tab === 'money' && <Money />}
          </>)}
        </div>
      </ConsultShell>
    </OpenCtx.Provider>
  );
}
