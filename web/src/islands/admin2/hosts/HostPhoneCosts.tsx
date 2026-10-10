/* HostPhoneCosts — [HF-VOBIZ-SPEND-1] Admin "Phone costs": every rupee Vobiz takes, live, with a PDF/CSV report.
 * Worker (all admin): GET /api/admin/hf/vobiz/{summary,legs,users,calls/:id,balance,alerts,recharges,report.pdf,report.csv},
 * POST /api/admin/hf/vobiz/{alerts/:id/ack,recharges,recharges/:id/confirm,sync}. Money arrives as paise. Times shown in IST.
 * Owner design rules: full width, Nunito headlines, Comfortaa text, nothing under 14px, no green. */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { adminCall } from '../peopleKit';
import { adminBlob, saveBlob } from '../adminApi';
import { Banner, ConsultShell, fail } from '../consultants/kit';

const IST = 19_800_000;
const DAY = 86_400_000;
const T14: CSSProperties = { fontSize: 14 };
const field: CSSProperties = { ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1', minHeight: 44, fontFamily: 'inherit' };
const H: CSSProperties = { fontFamily: "'Nunito', system-ui, sans-serif", fontSize: 20, margin: '0 0 10px' };
const WARN_BG = '#fdf0cf', WARN_FG = '#6b4e12', BAD_BG = '#fbe1dc', BAD_FG = '#9a1f19', OK_BG = '#dfe2f3', OK_FG = '#2f3a7a';

/* Scoped overrides: Comfortaa text, 14px floor, purple instead of the kit's teal. */
const CSS = `
.pc-ui{font-family:'Comfortaa',system-ui,sans-serif;font-size:14px;--teal:#4a2c7a;width:100%}
.pc-ui .chip{font-size:14px}.pc-ui .btn{font-family:'Nunito',sans-serif}.pc-ui .label{font-size:14px}
.pc-ui table.t{width:100%;border-collapse:collapse;font-size:14px}.pc-ui table.t th{font-size:14px}
.pc-ui .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.pc-ui .two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px}
.pc-ui .tile{padding:14px}.pc-ui .tile b{display:block;font-family:'Nunito',sans-serif;font-size:22px;color:var(--teal);margin-top:4px;word-break:break-word}
.pc-ui tr.click{cursor:pointer}.pc-ui tr.click:hover{background:#f4eef8}
.pc-ui button.link{background:none;border:0;padding:0;font:inherit;font-size:14px;font-weight:800;color:var(--teal);text-decoration:underline;cursor:pointer}
`;

type Rec = Record<string, any>;
interface Leg {
  seq: number; legUuid: string; callId: string | null; role: string; userUid: string | null; userName: string | null; userPhone: string | null; callerUid: string | null;
  direction: string | null; from: string | null; to: string | null; startAt: number | null; answerAt: number | null; endAt: number | null; durationSec: number | null; billsec: number | null;
  costPaise: number | null; streamingCostPaise: number | null; totalCostPaise: number | null; hangupCause: string | null; hangupSource: string | null; mos: number | null;
  source: string; cdrCheckedAt: number | null; mismatch: string | null; createdAt: number;
}
interface LegDetail extends Leg { webhook: Rec | null; cdr: Rec | null }
interface CallInfo { id: string; status: string; callerUid: string; callerName: string | null; callerPhone: string | null; hostUid: string; hostName: string | null; hostPhone: string | null; ratePaise: number; createdAt: number; connectedAt: number | null; endedAt: number | null; billedMinutes: number | null; chargedPaise: number | null; hostEarningPaise: number | null; endReason: string | null; hostLegUuid: string | null; callerLegUuid: string | null }
const inr = (paise: number | null | undefined) => (paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const tm = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '—');
const hms = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
const istDate = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const dayStart = (d: string) => new Date(`${d}T00:00:00+05:30`).getTime();
const mins = (sec: number | null) => (sec == null ? '—' : `${Math.floor(sec / 60)}m ${sec % 60}s`);

interface Summary {
  live: { balanceAt: number | null; balancePaise: number | null; availablePaise: number | null; reservedPaise: number | null; at: number | null; ok: boolean; accountActive: boolean | null };
  today: { costPaise: number; legs: number; minutes: number }; month: { costPaise: number; legs: number; minutes: number };
  unexplainedTodayPaise: number; unexplainedMonthPaise: number; chargedUsersTodayPaise: number; chargedUsersMonthPaise: number;
  openAlerts: number; pendingCdr: number; chainOk: boolean;
}
interface UserRow { uid: string; name: string | null; phone: string | null; asCaller: Rec; asHost: Rec; paidPaise: number; vobizCostPaise: number; diffPaise: number }
interface Recharge { id: string; at: number; amountPaise: number; kind: string; utr: string | null; invoiceNo: string | null; note: string | null; confirmed: boolean; createdBy: string | null; createdAt: number }
interface Alert { id: string; dedupeKey: string; kind: string; severity: string; message: string; amountPaise: number | null; meta: unknown; createdAt: number; sentWhatsapp: boolean | number; sentEmail: boolean | number; ackedAt: number | null; ackedBy: string | null }
interface BalPoint { at: number; balancePaise: number | null; availablePaise: number | null; ok: boolean | number }

type RangeKey = 'today' | 'yesterday' | 'month' | 'lastmonth' | 'custom';
function rangeOf(k: RangeKey, cFrom: string, cTo: string): { from: number; to: number; label: string } {
  const now = Date.now(), t0 = dayStart(istDate(now));
  if (k === 'today') return { from: t0, to: t0 + DAY - 1, label: istDate(t0) };
  if (k === 'yesterday') return { from: t0 - DAY, to: t0 - 1, label: istDate(t0 - DAY) };
  const ym = istDate(now).slice(0, 7);
  if (k === 'month') return { from: dayStart(`${ym}-01`), to: now, label: ym };
  if (k === 'lastmonth') {
    const first = dayStart(`${ym}-01`); const prev = istDate(first - DAY).slice(0, 7);
    return { from: dayStart(`${prev}-01`), to: first - 1, label: prev };
  }
  const f = dayStart(cFrom || istDate(now)), t = dayStart(cTo || istDate(now)) + DAY - 1;
  return { from: f, to: t, label: `${istDate(f)}-${istDate(t)}` };
}

function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'bad' | 'ok' }) {
  const bg = tone === 'bad' ? BAD_BG : tone === 'warn' ? WARN_BG : tone === 'ok' ? OK_BG : '#fff';
  return <div className="card tile" style={{ background: bg }}><div className="label">{label}</div><b>{value}</b>{sub && <div className="muted" style={T14}>{sub}</div>}</div>;
}
function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const [bg, fg] = tone === 'bad' ? [BAD_BG, BAD_FG] : tone === 'warn' ? [WARN_BG, WARN_FG] : [OK_BG, OK_FG];
  return <span className="chip" style={{ background: bg, color: fg }}>{children}</span>;
}
function Card({ title, children, pad = true, right }: { title: string; children: ReactNode; pad?: boolean; right?: ReactNode }) {
  return (
    <section className="card" style={{ background: '#fff', padding: pad ? undefined : 0, overflow: pad ? undefined : 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: pad ? 0 : '16px 18px 0' }}>
        <h2 style={H}>{title}</h2>{right}
      </div>
      {pad ? children : <div style={{ overflowX: 'auto' }}>{children}</div>}
    </section>
  );
}
const Empty = ({ children }: { children: ReactNode }) => <div className="muted" style={{ ...T14, padding: pad0 }}>{children}</div>;
const pad0 = '4px 18px 16px';

/* ── balance chart: inline SVG ── */
function BalanceChart({ points, recharges }: { points: BalPoint[]; recharges: Recharge[] }) {
  const pts = points.filter((p) => p.balancePaise != null);
  if (pts.length < 2) return <Empty>Not enough balance checks yet. The chart fills in as Vobiz is checked every minute.</Empty>;
  const W = 900, Ht = 260, L = 78, R = 16, Tp = 14, B = 34;
  const t0 = pts[0].at, t1 = pts[pts.length - 1].at || t0 + 1;
  const vals = pts.map((p) => p.balancePaise as number);
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi === lo) { hi += 100; lo -= 100; }
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => Tp + (1 - (v - lo) / (hi - lo)) * (Ht - Tp - B);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.balancePaise as number).toFixed(1)}`).join(' ');
  const ticks = [lo, (lo + hi) / 2, hi];
  const marks = recharges.filter((r) => { const a = r.at; return a >= t0 && a <= t1; });
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${Ht}`} style={{ width: '100%', minWidth: 560, height: 'auto', display: 'block' }} role="img" aria-label="Vobiz balance over time">
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e6d9e9" /><text x={L - 8} y={y(v) + 5} textAnchor="end" fontSize="14" fill="#4d6268" fontFamily="Comfortaa, sans-serif">{inr(Math.round(v))}</text></g>)}
        <path d={d} fill="none" stroke="#4a2c7a" strokeWidth="2.5" />
        {pts.filter((p) => !p.ok).map((p) => <circle key={p.at} cx={x(p.at)} cy={y(p.balancePaise as number)} r="4" fill="#c82c25" />)}
        {marks.map((r) => (
          <g key={String(r.id)}>
            <line x1={x(r.at)} x2={x(r.at)} y1={Tp} y2={Ht - B} stroke="#b07a10" strokeDasharray="4 3" strokeWidth="2" />
            <text x={x(r.at)} y={Ht - B + 18} textAnchor="middle" fontSize="14" fill="#6b4e12" fontFamily="Comfortaa, sans-serif">+{inr(r.amountPaise)}</text>
          </g>
        ))}
        <text x={L} y={Ht - 4} fontSize="14" fill="#4d6268" fontFamily="Comfortaa, sans-serif">{tm(t0)}</text>
        <text x={W - R} y={Ht - 4} textAnchor="end" fontSize="14" fill="#4d6268" fontFamily="Comfortaa, sans-serif">{tm(t1)}</text>
      </svg>
      <div className="muted" style={T14}>Line = Vobiz balance. Dashed amber lines = money you put in (recharges). Red dots = a check that failed.</div>
    </div>
  );
}

/* ── legs table (used for the live feed) ── */
function LegsTable({ legs, onOpen }: { legs: Leg[]; onOpen: (callId: string) => void }) {
  return (
    <table className="t">
      <thead><tr><th>Time</th><th>Person</th><th>Role</th><th>From</th><th>To</th><th>Length</th><th>Cost</th><th>Check</th></tr></thead>
      <tbody>
        {legs.map((l) => (
          <tr key={l.legUuid} className={l.callId ? 'click' : undefined} onClick={() => l.callId && onOpen(l.callId)}>
            <td>{tm(l.endAt ?? l.startAt)}</td>
            <td>{l.role === 'unknown' ? <Chip tone="bad">Not our call</Chip> : <><strong>{l.userName || '—'}</strong><div className="muted" style={T14}>{l.userPhone ?? ''}</div></>}</td>
            <td>{l.role}</td>
            <td>{l.from ?? '—'}</td><td>{l.to ?? '—'}</td>
            <td>{mins(l.billsec)}</td><td>{inr(l.totalCostPaise)}</td>
            <td>{l.mismatch ? <Chip tone="bad">Mismatch</Chip> : !l.cdrCheckedAt ? <Chip tone="warn">Checking</Chip> : <Chip tone="ok">Matches Vobiz</Chip>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── drill-down ── */
function LegBox({ title, leg }: { title: string; leg: LegDetail | null }) {
  const w = leg?.webhook ?? null, c = leg?.cdr ?? null;
  const v = (o: Rec | null, ...k: string[]) => { if (!o) return '—'; for (const x of k) if (o[x] != null && o[x] !== '') return String(o[x]); return '—'; };
  const rows: [string, ReactNode, ReactNode][] = [
    ['Billed seconds', v(w, 'BillDuration'), v(c, 'billsec')],
    ['Total seconds', v(w, 'Duration'), v(c, 'duration')],
    ['Total cost', v(w, 'TotalCost'), v(c, 'total_cost')],
    ['Call cost', '—', v(c, 'cost')],
    ['Ended because', v(w, 'HangupCause'), v(c, 'hangup_cause')],
    ['Started', v(w, 'StartTime'), v(c, 'start_time')],
    ['Ended', v(w, 'EndTime'), v(c, 'end_time')],
    ['From', v(w, 'From'), v(c, 'caller_id_number')],
    ['To', v(w, 'To'), v(c, 'destination_number')],
  ];
  return (
    <div className="card" style={{ background: '#fff', minWidth: 0 }}>
      <h3 style={{ ...H, fontSize: 18 }}>{title}</h3>
      {!leg ? <div className="muted">No record of this leg.</div> : (
        <div style={{ display: 'grid', gap: 6, wordBreak: 'break-all' }}>
          <div>{leg.from ?? '—'} → {leg.to ?? '—'}</div>
          <div>Started {tm(leg.startAt)} · Ended {tm(leg.endAt)}</div>
          <div>Billed {mins(leg.billsec)} · Total <strong>{inr(leg.totalCostPaise)}</strong> (calls {inr(leg.costPaise)} + streaming {inr(leg.streamingCostPaise)})</div>
          <div className="muted">Vobiz id {leg.legUuid}</div>
          <div className="muted">Raw values below are exactly as Vobiz sent them.</div>
          {leg.mismatch ? <Chip tone="bad">Mismatch: {leg.mismatch}</Chip> : leg.cdrCheckedAt ? <Chip tone="ok">Webhook and Vobiz record agree</Chip> : <Chip tone="warn">Vobiz record not checked yet</Chip>}
          <table className="t" style={{ marginTop: 6 }}>
            <thead><tr><th>Field</th><th>Our webhook</th><th>Vobiz record</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r[0]}><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function DrillDown({ callId, onClose }: { callId: string; onClose: () => void }) {
  const [data, setData] = useState<{ call: CallInfo; legs: LegDetail[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setData(null); setErr(null); adminCall<{ call: CallInfo; legs: LegDetail[] }>(`/api/admin/hf/vobiz/calls/${encodeURIComponent(callId)}`).then(setData).catch((e) => setErr(fail('vobiz_call', e))); }, [callId]);
  const hostLeg = data?.legs.find((l) => l.role === 'host' || l.legUuid === data.call.hostLegUuid) ?? null;
  const callerLeg = data?.legs.find((l) => l.role === 'caller' || l.legUuid === data.call.callerLegUuid) ?? null;
  const charged = data?.call.chargedPaise;
  return (
    <Card title="Call details" right={<button type="button" className="btn ghost small" onClick={onClose}>Close</button>}>
      <div className="muted" style={{ ...T14, marginBottom: 8, wordBreak: 'break-all' }}>Call {callId}{data ? ` · ${data.call.callerName || data.call.callerPhone || 'caller'} called ${data.call.hostName || data.call.hostPhone || 'host'} · caller charged ${inr(charged)} · host earned ${inr(data.call.hostEarningPaise)}` : ''}</div>
      {err && <Banner tone="error">{err}</Banner>}
      {!data && !err && <div className="muted">Loading…</div>}
      {data && <div className="two"><LegBox title="Leg 1 — host" leg={hostLeg} /><LegBox title="Leg 2 — caller" leg={callerLeg} /></div>}
    </Card>
  );
}

export default function HostPhoneCosts() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [feed, setFeed] = useState<Leg[] | null>(null);
  const [rk, setRk] = useState<RangeKey>('today');
  const [cFrom, setCFrom] = useState(istDate(Date.now()));
  const [cTo, setCTo] = useState(istDate(Date.now()));
  const [uid, setUid] = useState('');
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: 'vobizCostPaise', dir: -1 });
  const [bal, setBal] = useState<{ points: BalPoint[]; recharges: Recharge[] } | null>(null);
  const [recharges, setRecharges] = useState<Recharge[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rf, setRf] = useState({ amount: '', at: '', utr: '', invoiceNo: '', note: '' });
  const [syncDay, setSyncDay] = useState(istDate(Date.now()));

  const range = useMemo(() => rangeOf(rk, cFrom, cTo), [rk, cFrom, cTo]);
  const q = `from=${range.from}&to=${range.to}${uid ? `&uid=${encodeURIComponent(uid)}` : ''}`;

  /* live: every 15 s */
  const live = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([
        adminCall<Summary>('/api/admin/hf/vobiz/summary'),
        adminCall<{ items: Leg[]; total: number }>('/api/admin/hf/vobiz/legs?limit=25'),
      ]);
      setSum(s); setFeed(f.items ?? []); setSumErr(null); setCheckedAt(Date.now());
    } catch (e) { setSumErr(fail('vobiz_summary', e)); }
  }, []);
  useEffect(() => { void live(); const t = setInterval(() => void live(), 15_000); return () => clearInterval(t); }, [live]);

  /* period data */
  const loadPeriod = useCallback(async () => {
    const [u, b] = await Promise.allSettled([
      adminCall<{ items: UserRow[] }>(`/api/admin/hf/vobiz/users?from=${range.from}&to=${range.to}`),
      adminCall<{ points: BalPoint[]; recharges: Recharge[] }>(`/api/admin/hf/vobiz/balance?from=${range.from}&to=${range.to}`),
    ]);
    setUsers(u.status === 'fulfilled' ? u.value.items ?? [] : []);
    if (b.status === 'fulfilled') setBal({ points: b.value.points ?? [], recharges: b.value.recharges ?? [] });
    if (u.status === 'rejected') setError(fail('vobiz_users', u.reason));
  }, [range.from, range.to]);
  const loadLists = useCallback(async () => {
    const [r, a] = await Promise.allSettled([
      adminCall<{ items: Recharge[] }>('/api/admin/hf/vobiz/recharges'),
      adminCall<{ items: Alert[] }>('/api/admin/hf/vobiz/alerts?limit=50'),
    ]);
    if (r.status === 'fulfilled') setRecharges(r.value.items ?? []); else setRecharges([]);
    if (a.status === 'fulfilled') setAlerts(a.value.items ?? []); else setAlerts([]);
  }, []);
  useEffect(() => { void loadPeriod(); }, [loadPeriod]);
  useEffect(() => { void loadLists(); const t = setInterval(() => void loadLists(), 60_000); return () => clearInterval(t); }, [loadLists]);

  const run = async (key: string, fn: () => Promise<void>, errKey: string) => {
    setBusy(key); setError(null); setNote(null);
    try { await fn(); } catch (e) { setError(fail(errKey, e)); }
    setBusy(null);
  };
  const download = (kind: 'pdf' | 'csv') => run(kind, async () => {
    const { blob, filename } = await adminBlob(`/api/admin/hf/vobiz/report.${kind}?${q}`);
    saveBlob(blob, filename ?? `vobiz-report-${istDate(range.from)}-${istDate(range.to)}.${kind}`);
  }, `vobiz_${kind}`);
  const ack = (id: string) => run(`ack${id}`, async () => { await adminCall(`/api/admin/hf/vobiz/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST', body: {} }); await loadLists(); await live(); }, 'vobiz_ack');
  const confirmRc = (id: string) => run(`rc${id}`, async () => { await adminCall(`/api/admin/hf/vobiz/recharges/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: {} }); await loadLists(); await loadPeriod(); }, 'vobiz_confirm');
  const addRecharge = () => run('add', async () => {
    const amt = Number(rf.amount);
    if (!(amt > 0)) throw new Error('Enter the amount in rupees.');
    const at = rf.at ? new Date(`${rf.at}:00+05:30`).getTime() : Date.now();
    await adminCall('/api/admin/hf/vobiz/recharges', { method: 'POST', body: { amountRupees: amt, at, utr: rf.utr.trim(), invoiceNo: rf.invoiceNo.trim(), note: rf.note.trim() } });
    setRf({ amount: '', at: '', utr: '', invoiceNo: '', note: '' }); setNote('Recharge saved.');
    await loadLists(); await loadPeriod();
  }, 'vobiz_recharge');
  const sync = () => run('sync', async () => {
    const r = await adminCall<{ ok: boolean; date: string; pages: number; fetched: number; inserted: number; filled: number; unchanged: number; failed: number; truncated: boolean }>('/api/admin/hf/vobiz/sync', { method: 'POST', body: { date: syncDay } });
    setNote(`Synced ${r.date}. Vobiz sent ${r.fetched} calls (${r.pages} pages): ${r.inserted} new, ${r.filled} checked and filled in, ${r.unchanged} already correct, ${r.failed} failed.${r.truncated ? ' There were more than we could fetch; sync again to get the rest.' : ''}`);
    await live(); await loadPeriod();
  }, 'vobiz_sync');

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    const rows = (users ?? []).filter((u) => !s || `${u.name ?? ''} ${u.phone ?? ''} ${u.uid}`.toLowerCase().includes(s));
    const val = (u: UserRow): number | string => {
      switch (sort.k) {
        case 'name': return (u.name ?? '').toLowerCase();
        case 'callerCalls': return u.asCaller?.calls ?? 0;
        case 'hostCalls': return u.asHost?.calls ?? 0;
        case 'paidPaise': return u.paidPaise; case 'diffPaise': return u.diffPaise;
        default: return u.vobizCostPaise;
      }
    };
    return [...rows].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }, [users, search, sort]);
  const th = (k: string, label: string) => (
    <th><button type="button" className="link" onClick={() => setSort((p) => ({ k, dir: p.k === k ? (p.dir === 1 ? -1 : 1) : -1 }))}>{label}{sort.k === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button></th>
  );

  const lv = sum?.live;
  const checkFailed = !!sum && lv && (!lv.ok || lv.accountActive === false);
  const staleMs = lv?.at ? Date.now() - lv.at : 0;

  return (
    <ConsultShell>
      <style>{CSS}</style>
      <div className="pc-ui" style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}
        {note && <Banner tone="info">{note}</Banner>}
        {sumErr && !sum && <Banner tone="error">{sumErr}</Banner>}

        {checkFailed && lv && (
          <div role="alert" className="card" style={{ background: BAD_BG, borderColor: '#e9b5ad', color: BAD_FG, fontWeight: 800 }}>
            {!lv.ok ? 'The last check of Vobiz failed, so the numbers below may be out of date.' : 'The Vobiz account is not active. Calls may not connect.'}
            <div style={{ ...T14, fontWeight: 400 }}>Last answer from Vobiz: {tm(lv.at)}{staleMs > 120_000 ? ` (${Math.round(staleMs / 60000)} minutes ago)` : ''}.</div>
          </div>
        )}
        {sumErr && sum && <Banner tone="error">Could not refresh just now. Showing the last numbers. {sumErr}</Banner>}

        <section>
          <div className="muted" style={{ ...T14, marginBottom: 8 }}>{checkedAt ? `Last checked ${hms(lv?.at ?? checkedAt)} (India time) · this page refreshed ${hms(checkedAt)}, then every 15 seconds` : 'Checking…'}</div>
          {!sum ? <div className="card muted">Loading the live numbers…</div> : (
            <div className="tiles">
              <Tile label="Vobiz balance" value={inr(lv?.balancePaise)} sub={`Balance as of ${tm(lv?.balanceAt)}`} tone={lv && !lv.ok ? 'bad' : undefined} />
              <Tile label="Available to spend" value={inr(lv?.availablePaise)} sub={lv?.reservedPaise ? `${inr(lv.reservedPaise)} held` : undefined} />
              <Tile label="Spent today" value={inr(sum.today.costPaise)} sub={`${sum.today.legs} legs · ${sum.today.minutes} min`} />
              <Tile label="Spent this month" value={inr(sum.month.costPaise)} sub={`${sum.month.legs} legs · ${sum.month.minutes} min`} />
              <Tile label="Unexplained today" value={inr(sum.unexplainedTodayPaise)} sub="Vobiz took it, no call of ours" tone={sum.unexplainedTodayPaise > 0 ? 'bad' : 'ok'} />
              <Tile label="Unexplained this month" value={inr(sum.unexplainedMonthPaise)} tone={sum.unexplainedMonthPaise > 0 ? 'bad' : 'ok'} />
              <Tile label="Users paid, today" value={inr(sum.chargedUsersTodayPaise)} sub={`Vobiz cost ${inr(sum.today.costPaise)}`} />
              <Tile label="Users paid, this month" value={inr(sum.chargedUsersMonthPaise)} sub={`Vobiz cost ${inr(sum.month.costPaise)}`} />
              <Tile label="Open alerts" value={sum.openAlerts} tone={sum.openAlerts > 0 ? 'warn' : 'ok'} />
              <Tile label="Waiting for Vobiz record" value={sum.pendingCdr} sub="Calls still being double-checked" tone={sum.pendingCdr > 20 ? 'warn' : undefined} />
              <Tile label="Record chain" value={sum.chainOk ? 'Intact' : 'BROKEN'} sub={sum.chainOk ? 'No entry was changed or removed' : 'Something was changed. Check alerts.'} tone={sum.chainOk ? 'ok' : 'bad'} />
            </div>
          )}
        </section>

        <Card title="Download proof" right={<span className="muted" style={T14}>Period: {range.label} (India time)</span>}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {(['today', 'yesterday', 'month', 'lastmonth', 'custom'] as RangeKey[]).map((k) => (
              <button key={k} type="button" className={`btn small${rk === k ? '' : ' ghost'}`} onClick={() => setRk(k)}>
                {{ today: 'Today', yesterday: 'Yesterday', month: 'This month', lastmonth: 'Last month', custom: 'Custom' }[k]}
              </button>
            ))}
            {rk === 'custom' && <>
              <label style={T14}>From <input type="date" style={field} value={cFrom} max={cTo} onChange={(e) => setCFrom(e.target.value)} /></label>
              <label style={T14}>To <input type="date" style={field} value={cTo} min={cFrom} onChange={(e) => setCTo(e.target.value)} /></label>
            </>}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
            <label style={T14}>Only one user <select style={field} value={uid} onChange={(e) => setUid(e.target.value)}>
              <option value="">Everyone</option>
              {(users ?? []).filter((u) => u.uid).map((u) => <option key={u.uid} value={u.uid}>{u.name || u.phone || u.uid}{u.phone && u.name ? ` · ${u.phone}` : ''}</option>)}
            </select></label>
            <button type="button" className="btn small" disabled={busy === 'pdf'} onClick={() => void download('pdf')}>{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</button>
            <button type="button" className="btn ghost small" disabled={busy === 'csv'} onClick={() => void download('csv')}>{busy === 'csv' ? 'Preparing…' : 'Download CSV'}</button>
          </div>
        </Card>

        <Card title="Live calls from Vobiz" pad={false} right={<span className="muted" style={{ ...T14, padding: '16px 18px 0' }}>Newest first · tap a row to open the call</span>}>
          {feed == null ? <Empty>Loading…</Empty> : feed.length === 0 ? <Empty>No Vobiz calls yet. They appear here within a minute of each call.</Empty> : <LegsTable legs={feed} onOpen={setOpen} />}
        </Card>

        {open && <DrillDown callId={open} onClose={() => setOpen(null)} />}

        <Card title="Balance over time">
          {bal == null ? <div className="muted">Loading…</div> : <BalanceChart points={bal.points} recharges={bal.recharges} />}
        </Card>

        <Card title="Each person: what they paid vs what Vobiz charged" pad={false}
          right={<div style={{ padding: '16px 18px 0' }}><input type="search" placeholder="Search name, number or id" aria-label="Search people" style={{ ...field, width: 280, maxWidth: '100%' }} value={search} onChange={(e) => setSearch(e.target.value)} /></div>}>
          {users == null ? <Empty>Loading…</Empty> : shown.length === 0 ? <Empty>{users.length ? 'No one matches that search.' : 'No phone usage in this period yet.'}</Empty> : (
            <table className="t">
              <thead><tr>{th('name', 'Person')}{th('callerCalls', 'Calls made')}{th('hostCalls', 'Calls taken')}{th('paidPaise', 'They paid')}{th('vobizCostPaise', 'Vobiz charged')}{th('diffPaise', 'Difference')}</tr></thead>
              <tbody>{shown.map((u) => (
                <tr key={u.uid || 'unknown'} className={u.uid ? 'click' : undefined} style={u.uid ? undefined : { background: WARN_BG }} onClick={() => u.uid && setUid(u.uid)} title={u.uid ? 'Tap to filter the download to this person' : undefined}>
                  <td>{u.uid ? <><strong>{u.name || '—'}</strong><div className="muted" style={T14}>{u.phone ?? '—'}</div></> : <><strong>Unknown traffic (not our calls)</strong><div className="muted" style={T14}>Vobiz charged these; we have no call for them.</div></>}</td>
                  <td>{u.asCaller?.calls ?? 0} · {mins(u.asCaller?.billsec ?? 0)}<div className="muted" style={T14}>{inr(u.asCaller?.costPaise ?? 0)}</div></td>
                  <td>{u.asHost?.calls ?? 0} · {mins(u.asHost?.billsec ?? 0)}<div className="muted" style={T14}>{inr(u.asHost?.costPaise ?? 0)}</div></td>
                  <td>{inr(u.paidPaise)}</td><td>{inr(u.vobizCostPaise)}</td>
                  <td>{u.diffPaise < 0 ? <Chip tone="bad">{inr(u.diffPaise)}</Chip> : <Chip tone="ok">{inr(u.diffPaise)}</Chip>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>

        <div className="two">
          <Card title="Recharges (money you put into Vobiz)" pad={false}>
            {recharges == null ? <Empty>Loading…</Empty> : recharges.length === 0 ? <Empty>No recharges recorded yet. Add one below, or it appears here when the balance jumps up.</Empty> : (
              <table className="t">
                <thead><tr><th>When</th><th>Amount</th><th>Proof</th><th /></tr></thead>
                <tbody>{recharges.map((r) => {
                  const id = String(r.id); const detected = r.kind === 'detected'; const done = !!r.confirmed;
                  return (
                    <tr key={id}>
                      <td>{tm(r.at)}</td><td>{inr(r.amountPaise)}</td>
                      <td style={{ wordBreak: 'break-all' }}>{r.utr ? `UTR ${r.utr}` : '—'}{r.invoiceNo ? ` · Invoice ${r.invoiceNo}` : ''}{r.note ? <div className="muted">{r.note}</div> : null}</td>
                      <td>{detected && !done ? <button type="button" className="btn small" disabled={busy === `rc${id}`} onClick={() => void confirmRc(id)}>Confirm</button> : <Chip tone={done || !detected ? 'ok' : 'warn'}>{detected ? 'Confirmed' : 'Added by you'}</Chip>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
            <form style={{ padding: 18, display: 'grid', gap: 8, borderTop: '1px solid #e6d9b8' }} onSubmit={(e) => { e.preventDefault(); void addRecharge(); }}>
              <strong style={{ fontFamily: "'Nunito', sans-serif", fontSize: 16 }}>Add a recharge</strong>
              <label style={T14}>Amount (₹)<input style={{ ...field, width: '100%' }} inputMode="decimal" value={rf.amount} onChange={(e) => setRf({ ...rf, amount: e.target.value })} /></label>
              <label style={T14}>Date and time (India)<input type="datetime-local" style={{ ...field, width: '100%' }} value={rf.at} onChange={(e) => setRf({ ...rf, at: e.target.value })} /></label>
              <label style={T14}>UTR<input style={{ ...field, width: '100%' }} value={rf.utr} onChange={(e) => setRf({ ...rf, utr: e.target.value })} /></label>
              <label style={T14}>Invoice no.<input style={{ ...field, width: '100%' }} value={rf.invoiceNo} onChange={(e) => setRf({ ...rf, invoiceNo: e.target.value })} /></label>
              <label style={T14}>Note<input style={{ ...field, width: '100%' }} value={rf.note} onChange={(e) => setRf({ ...rf, note: e.target.value })} /></label>
              <div><button type="submit" className="btn small" disabled={busy === 'add'}>{busy === 'add' ? 'Saving…' : 'Save recharge'}</button></div>
            </form>
          </Card>

          <Card title="Alerts" pad={false}>
            {alerts == null ? <Empty>Loading…</Empty> : alerts.length === 0 ? <Empty>No alerts. Nothing odd has happened.</Empty> : (
              <div style={{ display: 'grid' }}>
                {alerts.map((a) => {
                  const id = String(a.id); const acked = !!a.ackedAt; const crit = a.severity === 'critical';
                  return (
                    <div key={id} style={{ padding: '12px 18px', borderTop: '1px solid #e6d9b8', opacity: acked ? 0.65 : 1 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <Chip tone={crit ? 'bad' : 'warn'}>{crit ? 'Serious' : 'Warning'}</Chip>
                        <span className="muted">{tm(a.createdAt)}</span>
                        {a.amountPaise != null && <strong>{inr(a.amountPaise)}</strong>}
                      </div>
                      <div style={{ margin: '6px 0', wordBreak: 'break-word' }}>{a.message}</div>
                      {acked ? <span className="muted">Seen {tm(a.ackedAt)}</span> : <button type="button" className="btn ghost small" disabled={busy === `ack${id}`} onClick={() => void ack(id)}>Mark as seen</button>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <Card title="Sync a day from Vobiz">
          <div className="muted" style={{ ...T14, marginBottom: 8 }}>Pulls Vobiz's own call records for one India-time day and fills in anything we missed.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="date" style={field} value={syncDay} max={istDate(Date.now())} onChange={(e) => setSyncDay(e.target.value)} aria-label="Day to sync" />
            <button type="button" className="btn small" disabled={busy === 'sync' || !syncDay} onClick={() => void sync()}>{busy === 'sync' ? 'Syncing…' : 'Sync this day'}</button>
          </div>
        </Card>
      </div>
    </ConsultShell>
  );
}
