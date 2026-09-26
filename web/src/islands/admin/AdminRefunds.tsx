// [DASH2-ADMIN-REFUNDS 2026-09-26] Admin refunds queue (/admin/refunds).
//
// Owner rule: refunds are sent BY HAND from the bank app. This screen lists the
// customers' refund requests (requested first, oldest first). The admin pays the
// customer from the bank app, then "Mark refunded" records the refund UTR, the
// amount and the UPI id it went to (POST /api/admin/refunds/:payment_id). The
// customer sees it in Dashboard 2 → Billing. "Reject" turns a request down
// (POST /api/admin/refunds/:refund_id/reject) with an optional note.
//
// Same flat-card layout and zine styling as AdminReviews.tsx, and the same auth
// dance (token per request, one forced fresh mint on a 401) — see the comment in
// AdminListings.tsx for why it is not optional.
//
// The list is fetched from "/api/admin/refunds/" WITH the trailing slash: the
// worker's router forwards "/api/admin/refunds/…" to the Dashboard 2 dispatcher.
import { useCallback, useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';
import { Spinner } from '../../components/Spinner';

type RefundStatus = 'requested' | 'refunded' | 'rejected';
type RefundRow = {
  refund_id: string;
  payment_id: string;
  order_id: string | null;
  customer: { uid: string; email: string | null; name: string | null };
  listing_id: string | null;
  event_title: string | null;
  event_starts_at: number | null;
  amount_paise: number;
  payer_utr: string | null;
  requested_at: number;
  reason: string | null;
  status: RefundStatus;
  refund_amount_paise: number;
  refund_utr: string | null;
  refund_vpa: string | null;
  refunded_at: number | null;
};
type ListResponse = { items: RefundRow[]; counts: Record<string, number>; next_cursor?: string };

const TABS: Array<{ key: RefundStatus | 'all'; label: string }> = [
  { key: 'requested', label: 'Requested' },
  { key: 'refunded', label: 'Refunded' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

// Mirrors the worker: adminRecordRefund's UTR rule and me_dashboard_logic.ts VPA_RE.
const UTR_RE = /^[A-Za-z0-9]{6,35}$/;
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

const IST: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' };
function when(ms: number | null | undefined): string {
  if (!ms) return '—';
  try { return `${new Date(ms).toLocaleString('en-IN', IST)} IST`; } catch { return '—'; }
}
function rupees(paise: number | null | undefined): string {
  if (typeof paise !== 'number' || !Number.isFinite(paise)) return '—';
  const r = paise / 100;
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
/** "1,254.50" / "1254.5" → 125450 paise; null when not a positive amount with ≤2 decimals. */
function rupeesToPaise(raw: string): number | null {
  const s = raw.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}
function paiseToInput(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}
/** The worker's { error, message } — the message is what a human should read. */
function messageOf(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b = e.body as { message?: unknown } | undefined;
    return b && typeof b.message === 'string' && b.message ? b.message : e.error;
  }
  return fallback;
}

const btn = 'rounded-full border-zine border-ink px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] shadow-zine-xs disabled:opacity-50';
const input = 'w-full rounded-zine border-zine border-ink bg-paper2 p-3 font-body text-[14px] text-ink';

function Copyable({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { setDone(false); }
      }}
      className="inline-flex items-center gap-2 rounded-full border-zine border-ink bg-paper2 px-3 py-0.5 font-mono text-[13px] font-bold text-ink"
    >
      {value}
      <span className="font-body text-[12px] text-inkSoft">{done ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export default function AdminRefunds() {
  const [tab, setTab] = useState<RefundStatus | 'all'>('requested');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Which row has which form open.
  const [open, setOpen] = useState<{ id: string; kind: 'refund' | 'reject' } | null>(null);
  const [utr, setUtr] = useState('');
  const [amount, setAmount] = useState('');
  const [vpa, setVpa] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const withAuth = useCallback(async <T,>(run: (token: string) => Promise<T>): Promise<T> => {
    const first = await getActiveToken();
    if (!first) throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
    try {
      return await run(first);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      const fresh = await getActiveToken(5000, { skipCache: true });
      if (!fresh || fresh === first) {
        capture('admin_auth_retry', { outcome: fresh ? 'same_token' : 'no_token', surface: 'refunds' });
        throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
      }
      const out = await run(fresh);
      capture('admin_auth_retry', { outcome: 'recovered', surface: 'refunds' });
      return out;
    }
  }, []);

  const fetchPage = useCallback((after: string | null) => withAuth((t) => request<ListResponse>('/api/admin/refunds/', {
    auth: t, query: { status: tab, q: query || undefined, cursor: after ?? undefined },
  })), [tab, query, withAuth]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchPage(null);
      setRows(r.items ?? []);
      setCounts(r.counts ?? {});
      setCursor(r.next_cursor ?? null);
    } catch (e) {
      setError(messageOf(e, 'Could not load refunds.'));
      setRows([]); setCursor(null);
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => { void load(); }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setMoreLoading(true); setError(null);
    try {
      const r = await fetchPage(cursor);
      setRows((prev) => [...prev, ...(r.items ?? [])]);
      setCounts(r.counts ?? {});
      setCursor(r.next_cursor ?? null);
    } catch (e) {
      setError(messageOf(e, 'Could not load more refunds.'));
    } finally {
      setMoreLoading(false);
    }
  }

  function openForm(r: RefundRow, kind: 'refund' | 'reject') {
    if (open && open.id === r.refund_id && open.kind === kind) { setOpen(null); return; }
    setOpen({ id: r.refund_id, kind });
    setFormError(null); setNotice(null);
    setUtr(''); setNote('');
    setAmount(paiseToInput(r.amount_paise));
    setVpa(r.refund_vpa ?? '');
  }

  async function markRefunded(r: RefundRow) {
    const u = utr.trim();
    const v = vpa.trim();
    const paise = rupeesToPaise(amount);
    if (!UTR_RE.test(u)) { setFormError('Enter the refund UTR from the bank app: 6–35 letters or digits, no spaces.'); return; }
    if (paise == null) { setFormError('Enter the refunded amount in rupees, e.g. 627 or 627.50.'); return; }
    if (paise > r.amount_paise) { setFormError(`The refund can't be more than the ${rupees(r.amount_paise)} paid.`); return; }
    if (!VPA_RE.test(v)) { setFormError('Enter the UPI id the refund was sent to, like name@bank.'); return; }
    setBusy(r.refund_id); setFormError(null);
    try {
      await withAuth((t) => request(`/api/admin/refunds/${encodeURIComponent(r.payment_id)}`, {
        method: 'POST', auth: t, body: { refund_utr: u, amount_paise: paise, refund_vpa: v },
      }));
      setOpen(null);
      setNotice(`Recorded ${rupees(paise)} refunded to ${r.customer.name ?? r.customer.email ?? 'the customer'}. They will see it in Billing.`);
      await load();
    } catch (e) {
      setFormError(messageOf(e, 'Could not record that refund.'));
    } finally {
      setBusy(null);
    }
  }

  async function reject(r: RefundRow) {
    setBusy(r.refund_id); setFormError(null);
    try {
      await withAuth((t) => request(`/api/admin/refunds/${encodeURIComponent(r.refund_id)}/reject`, {
        method: 'POST', auth: t, body: { note: note.trim() || undefined },
      }));
      setOpen(null);
      setNotice(`Rejected the refund request from ${r.customer.name ?? r.customer.email ?? 'the customer'}.`);
      await load();
    } catch (e) {
      setFormError(messageOf(e, 'Could not reject that request.'));
    } finally {
      setBusy(null);
    }
  }

  const requested = counts.requested ?? 0;
  const total = (counts.requested ?? 0) + (counts.refunded ?? 0) + (counts.rejected ?? 0);

  return (
    <div className="grid gap-5">
      <div className="rounded-zine border-zine border-ink bg-paper2 p-4 font-body text-[14px] font-bold text-inkSoft shadow-zine-sm">
        Refunds are sent by hand from the bank app. Send the money first, then record the refund UTR here. The customer sees it in Billing.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const n = t.key === 'all' ? total : counts[t.key];
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => { setTab(t.key); setOpen(null); setNotice(null); }}
              aria-pressed={tab === t.key}
              className={`inline-flex items-center gap-2 rounded-full border-zine border-ink px-4 py-2 font-body text-[13px] font-bold shadow-zine-xs ${
                tab === t.key ? 'bg-lime text-ink' : 'bg-card text-inkSoft'
              }`}
            >
              {t.label}
              {t.key === 'requested' ? (
                <span className={`rounded-full border-zine border-ink px-2 font-mono text-[12px] ${requested > 0 ? 'bg-coral text-ink' : 'bg-paper2 text-inkSoft'}`}>{requested}</span>
              ) : n != null ? <span className="font-mono text-[12px]">({n})</span> : null}
            </button>
          );
        })}
        <form
          className="ml-auto flex w-full gap-2 sm:w-auto"
          onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); setOpen(null); }}
          role="search"
        >
          <input
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); if (!e.target.value) setQuery(''); }}
            placeholder="Name, email, event, UTR, payment id"
            aria-label="Search refunds"
            className="min-w-0 flex-1 rounded-full border-zine border-ink bg-card px-4 py-2 font-body text-[13px] text-ink sm:w-72"
          />
          <button type="submit" className={`${btn} bg-card text-ink`}>Search</button>
        </form>
      </div>

      {notice && (
        <div role="status" className="rounded-zine border-zine border-ink bg-lime p-4 font-body text-[14px] font-bold text-ink shadow-zine-sm">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-zine border-zine border-ink bg-coral p-4 font-body text-[14px] font-bold text-ink shadow-zine-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-zine border-zine border-ink bg-card p-6 font-body text-[15px] font-bold text-inkSoft shadow-zine-sm">
          {query ? 'Nothing matches that search.' : tab === 'requested' ? 'No refund requests waiting.' : 'Nothing here.'}
        </div>
      ) : (
        <div className="grid gap-4">
          {rows.map((r) => {
            const isOpen = open?.id === r.refund_id;
            return (
              <article key={r.refund_id} className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-display text-[20px] font-semibold text-ink">{rupees(r.amount_paise)} · {r.event_title ?? 'Unknown event'}</div>
                    <div className="mt-1 break-words font-body text-[14px] font-bold text-inkSoft">
                      {r.customer.name ?? 'No name'}{r.customer.email ? ` · ${r.customer.email}` : ''}
                    </div>
                    <div className="mt-1 font-body text-[13px] text-inkSoft">
                      Event {when(r.event_starts_at)} · requested {when(r.requested_at)}
                    </div>
                  </div>
                  <span className={`rounded-full border-zine border-ink px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink ${
                    r.status === 'requested' ? 'bg-coral' : r.status === 'refunded' ? 'bg-lime' : 'bg-paper2'
                  }`}>
                    {r.status}
                  </span>
                </div>

                <dl className="mt-3 grid gap-2 font-body text-[14px] text-ink sm:grid-cols-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <dt className="font-bold text-inkSoft">Payer UTR</dt>
                    <dd>{r.payer_utr ? <Copyable value={r.payer_utr} /> : '—'}</dd>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <dt className="font-bold text-inkSoft">Payment</dt>
                    <dd className="break-all font-mono text-[13px]">{r.payment_id}</dd>
                  </div>
                  {r.refund_vpa && r.status !== 'refunded' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <dt className="font-bold text-inkSoft">Customer's UPI id</dt>
                      <dd><Copyable value={r.refund_vpa} /></dd>
                    </div>
                  )}
                </dl>

                <p className="mt-3 whitespace-pre-wrap rounded-zine border-zine border-ink bg-paper2 p-3 font-body text-[14px] leading-relaxed text-ink">
                  {r.reason && r.reason !== 'admin_initiated' ? r.reason : r.reason === 'admin_initiated' ? 'Refunded by an admin without a customer request.' : 'No reason given.'}
                </p>

                {r.status === 'refunded' && (
                  <p className="mt-2 font-body text-[13px] font-bold text-inkSoft">
                    Refunded {rupees(r.refund_amount_paise)} to {r.refund_vpa ?? '—'} on {when(r.refunded_at)} · refund UTR {r.refund_utr ?? '—'}
                  </p>
                )}

                {r.status === 'requested' && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button type="button" disabled={busy === r.refund_id} onClick={() => openForm(r, 'refund')} className={`${btn} bg-lime text-ink`}>
                      Mark refunded
                    </button>
                    <button type="button" disabled={busy === r.refund_id} onClick={() => openForm(r, 'reject')} className={`${btn} bg-card text-ink`}>
                      Reject
                    </button>
                  </div>
                )}

                {isOpen && open?.kind === 'refund' && (
                  <form className="mt-3 grid gap-3" onSubmit={(e) => { e.preventDefault(); void markRefunded(r); }}>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="grid gap-1 font-body text-[13px] font-bold text-inkSoft">
                        Refund UTR
                        <input className={input} value={utr} onChange={(e) => setUtr(e.target.value)} required maxLength={35} autoComplete="off" placeholder="From the bank app" />
                      </label>
                      <label className="grid gap-1 font-body text-[13px] font-bold text-inkSoft">
                        Amount (₹)
                        <input className={input} value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" />
                      </label>
                      <label className="grid gap-1 font-body text-[13px] font-bold text-inkSoft">
                        Refund UPI id
                        <input className={input} value={vpa} onChange={(e) => setVpa(e.target.value)} required autoComplete="off" placeholder="name@bank" />
                      </label>
                    </div>
                    {formError && <p role="alert" className="rounded-zine border-zine border-ink bg-coral p-3 font-body text-[13px] font-bold text-ink">{formError}</p>}
                    <div className="flex gap-2">
                      <button type="submit" disabled={busy === r.refund_id} className={`${btn} bg-lime text-ink`}>
                        {busy === r.refund_id ? 'Saving…' : 'Record refund'}
                      </button>
                      <button type="button" onClick={() => setOpen(null)} className={`${btn} bg-card text-inkSoft`}>Cancel</button>
                    </div>
                  </form>
                )}

                {isOpen && open?.kind === 'reject' && (
                  <form className="mt-3 grid gap-2" onSubmit={(e) => { e.preventDefault(); void reject(r); }}>
                    <label className="font-body text-[13px] font-bold text-inkSoft" htmlFor={`note-${r.refund_id}`}>
                      Note (optional, kept in the admin audit log)
                    </label>
                    <textarea id={`note-${r.refund_id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={input} />
                    {formError && <p role="alert" className="rounded-zine border-zine border-ink bg-coral p-3 font-body text-[13px] font-bold text-ink">{formError}</p>}
                    <div className="flex gap-2">
                      <button type="submit" disabled={busy === r.refund_id} className={`${btn} bg-coral text-ink`}>
                        {busy === r.refund_id ? 'Rejecting…' : 'Confirm reject'}
                      </button>
                      <button type="button" onClick={() => setOpen(null)} className={`${btn} bg-card text-inkSoft`}>Cancel</button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
          {cursor && (
            <button type="button" disabled={moreLoading} onClick={() => void loadMore()} className={`${btn} justify-self-center bg-card text-ink`}>
              {moreLoading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
