/* HfDesk — [HF-ADMIN-SWEEP-1] Members & activity: read-only lists of what people did on Hello Fraands.
 * Worker (admin only): GET /api/admin/hf/desk/{summary,members,bookings,topups,support,reports}, GET /api/admin/hf/money-audit.
 * Nothing here changes data. Money is rupees with paise. Times are IST. Nothing under 14px. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { adminCall } from '../peopleKit';
import { Banner, ConsultShell, Spinner, dateIST, fail } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis } from '../desi';

const T14 = { fontSize: 14 } as const;
const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const inr0 = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const who = (name: string | null | undefined, username?: string | null) => name || (username ? `@${username}` : 'No name yet');

type TabKey = 'members' | 'bookings' | 'topups' | 'support' | 'reports' | 'money';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'members', label: 'Sign-ups' }, { key: 'bookings', label: 'Bookings' }, { key: 'topups', label: 'Wallet top-ups' },
  { key: 'support', label: 'Support tickets' }, { key: 'reports', label: 'Reports & blocks' }, { key: 'money', label: 'Money alerts' },
];

interface Summary {
  members: { total: number; last24h: number; last7d: number; registered: number }; hosts: { live: number; pendingReview: number };
  bookingsOpen: number; ticketsOpen: number; payoutsOpen: number; refundsOpen: number; closingAccounts: number; incidents30d: number;
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
interface Ticket { id: string; uid: string; name: string | null; username: string | null; email: string | null; topic: string; message: string; status: string; createdAt: number; updatedAt: number }
interface Incident { id: string; callId: string; kind: string; reporterUid: string; reporterName: string | null; otherUid: string | null; otherName: string | null; at: number }
interface Block { blockerUid: string; blockerName: string | null; blockedUid: string; blockedName: string | null; callId: string | null; at: number }
interface MoneyCase { id: string; kind: string; subject_id: string; rule: string; status: string; uid: string | null; host_uid: string | null; expected_paise: number | null; actual_paise: number | null; created_at: number }

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
const uidNote = (uid: string) => <div className="hfa-note" style={{ wordBreak: 'break-all' }}>{uid}</div>;

/** Cursor-paged list loader. `path` already carries its query string. */
function usePagedList<T>(path: string, pick: (j: any) => T[]) {
  const [items, setItems] = useState<T[] | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sep = path.includes('?') ? '&' : '?';
  const load = useCallback(async (more: boolean, from: string | null) => {
    setBusy(true); setError(null);
    try {
      const j = await adminCall<any>(`${path}${more && from ? `${sep}cursor=${encodeURIComponent(from)}` : ''}`);
      setItems((old) => (more && old ? [...old, ...pick(j)] : pick(j)));
      setMeta(j); setCursor(j.nextCursor ?? j.next ?? null);
    } catch (e) { setError(fail('hf_desk_list', e, { path })); if (!more) setItems([]); }
    setBusy(false);
  }, [path, sep]); // eslint-disable-line react-hooks/exhaustive-deps
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

function Support() {
  const [st, setSt] = useState<string>('all');
  const l = usePagedList<Ticket>(`/api/admin/hf/desk/support?status=${st}`, (j) => j.items ?? []);
  const counts: Record<string, number> = l.meta?.counts ?? {};
  const keys = ['all', ...Object.keys(counts)];
  return (
    <div className="hfa-stack">
      <div className="hfa-pills">
        {keys.map((s) => <button key={s} type="button" className="hfa-pill" aria-pressed={st === s} onClick={() => setSt(s)}>{s === 'all' ? 'All' : s}{s !== 'all' ? ` (${counts[s]})` : ''}</button>)}
      </div>
      <p className="hfa-note" style={T14}>Each ticket is also emailed to the support inbox. Reply from there; this list is so nothing gets lost.</p>
      <Common l={l} label="Loading tickets…" empty="No support tickets." />
      <div style={{ display: 'grid', gap: 12 }}>
        {l.items?.map((t) => (
          <DesiCard key={t.id} tone="white" title={`${t.id} · ${t.topic}`} note={`${who(t.name, t.username)} · ${t.email || 'no email'} · ${dateIST(t.createdAt)}`} action={<DesiChip tone={t.status === 'open' ? 'gold' : 'tea'}>{t.status}</DesiChip>}>
            <p style={{ ...T14, whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{t.message}</p>
            {uidNote(t.uid)}
          </DesiCard>
        ))}
      </div>
      <Footer l={l} />
    </div>
  );
}

function Reports() {
  const l = usePagedList<Incident>('/api/admin/hf/desk/reports', (j) => j.incidents ?? []);
  const blocks: Block[] = l.meta?.blocks ?? [];
  return (
    <div className="hfa-stack">
      <Common l={l} label="Loading reports…" empty="No reports yet." />
      {l.items && l.items.length > 0 && (
        <DesiCard tone="white" title="Reports and call blocks" note="Someone reported or blocked the other person on a call (kind shows why).">
          <Table head={['When', 'Reported by', 'About', 'What', 'Call']}>
            {l.items.map((i) => (
              <tr key={i.id}>
                <td style={T14}>{dateIST(i.at)}</td>
                <td style={T14}>{who(i.reporterName)}{uidNote(i.reporterUid)}</td>
                <td style={T14}>{who(i.otherName)}{i.otherUid && uidNote(i.otherUid)}</td>
                <td style={T14}><DesiChip tone="rani">{i.kind.replace('dash_report:', 'report: ').replace('hash_block', 'blocked with #')}</DesiChip></td>
                <td style={T14} className="hfa-note">{i.callId}</td>
              </tr>
            ))}
          </Table>
        </DesiCard>
      )}
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

function Money() {
  const [st, setSt] = useState<'open' | 'fixed' | 'resolved' | 'all'>('open');
  const l = usePagedList<MoneyCase>(`/api/admin/hf/money-audit?status=${st}`, (j) => j.cases ?? []);
  const counts: Record<string, number> = l.meta?.counts ?? {};
  return (
    <div className="hfa-stack">
      <p className="hfa-note" style={T14}>Cases the call-money monitor could not fix by itself. "Open" means someone should look. Read-only here.</p>
      <div className="hfa-pills">
        {(['open', 'fixed', 'resolved', 'all'] as const).map((s) => <button key={s} type="button" className="hfa-pill" aria-pressed={st === s} onClick={() => setSt(s)}>{s}{s !== 'all' && counts[s] != null ? ` (${counts[s]})` : ''}</button>)}
      </div>
      <Common l={l} label="Loading money alerts…" empty="No money alerts here." />
      {l.items && l.items.length > 0 && (
        <Table head={['When', 'Rule', 'Subject', 'Expected', 'Actual', 'Status']}>
          {l.items.map((c) => (
            <tr key={c.id}>
              <td style={T14}>{dateIST(c.created_at)}</td>
              <td style={T14}>{c.rule}</td>
              <td style={T14}>{c.kind} {c.subject_id}{c.uid && uidNote(c.uid)}</td>
              <td style={T14}>{c.expected_paise == null ? '—' : inr(c.expected_paise / 100)}</td>
              <td style={T14}>{c.actual_paise == null ? '—' : inr(c.actual_paise / 100)}</td>
              <td style={T14}><DesiChip tone={c.status === 'open' ? 'rani' : 'tea'}>{c.status}</DesiChip></td>
            </tr>
          ))}
        </Table>
      )}
      <Footer l={l} />
    </div>
  );
}

export default function HfDesk() {
  const initial = (): TabKey => {
    try { const t = new URLSearchParams(window.location.search).get('tab'); if (TABS.some((x) => x.key === t)) return t as TabKey; } catch { /* ssr */ }
    return 'members';
  };
  const [tab, setTab] = useState<TabKey>('members');
  const [sum, setSum] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  useEffect(() => { setTab(initial()); }, []);
  useEffect(() => { adminCall<Summary>('/api/admin/hf/desk/summary').then(setSum).catch((e) => setSumErr(fail('hf_desk_summary', e))); }, []);
  const pick = (k: TabKey) => { setTab(k); try { const u = new URL(window.location.href); u.searchParams.set('tab', k); window.history.replaceState(null, '', u); } catch { /* ignore */ } };
  return (
    <ConsultShell className="hf-admin-operations">
      <div className="hfa-stack">
        {sumErr && <Banner tone="error">{sumErr}</Banner>}
        <DesiKpis>
          <DesiKpi tone="rani" label="Sign-ups" value={sum ? sum.members.total : '…'} sub={sum ? `${sum.members.last24h} in 24h · ${sum.members.last7d} in 7 days` : undefined} onClick={() => pick('members')} />
          <DesiKpi tone="tea" label="Influencers live" value={sum ? sum.hosts.live : '…'} sub={sum ? `${sum.hosts.pendingReview} waiting for review` : undefined} />
          <DesiKpi tone="gold" label="Open bookings" value={sum ? sum.bookingsOpen : '…'} onClick={() => pick('bookings')} />
          <DesiKpi tone="lav" label="Open tickets" value={sum ? sum.ticketsOpen : '…'} onClick={() => pick('support')} />
          <DesiKpi tone="plum" label="Payouts / refunds to act on" value={sum ? `${sum.payoutsOpen} / ${sum.refundsOpen}` : '…'} sub={sum ? `${sum.closingAccounts} accounts closing` : undefined} />
        </DesiKpis>
        <div role="tablist" aria-label="Members and activity" className="hfa-pills">
          {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="hfa-pill" onClick={() => pick(t.key)}>{t.label}</button>)}
        </div>
        {tab === 'members' && <Members />}
        {tab === 'bookings' && <Bookings />}
        {tab === 'topups' && <Topups />}
        {tab === 'support' && <Support />}
        {tab === 'reports' && <Reports />}
        {tab === 'money' && <Money />}
      </div>
    </ConsultShell>
  );
}
