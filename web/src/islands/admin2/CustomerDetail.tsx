/* CustomerDetail — [ADMIN2-PEOPLE 2026-09-26] One customer: profile, bookings, payments and
 * refunds, each on its own tab (tab kept in ?tab=). GET /api/admin/v2/customers/:uid.
 * The phone is masked; "on file (not readable)" means only a hash of it is stored. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Home, IndianRupee, Mail, Phone, UserRound, Wallet } from 'lucide-react';
import { captureException } from '../../lib/analytics';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Badge } from '../../components/ui/badge';
import { istDate, istDateTime, errMessage, errCode } from './adminApi';
import {
  CopyValue, Empty, ErrorBox, ExportButton, ListSkeleton, StatusPill, TD, TH, Tile, adminCall, formatPaise, type Customer,
} from './peopleKit';

interface Booking { id: string; listing_id: string; event_title: string | null; event_starts_at: number | null; status: string; amount_paise: number; utr: string | null; booked_at: number }
interface Payment { id: string; order_id: string | null; listing_id: string; event_title: string | null; amount_paise: number; status: string; paid_at: number | null; created_at: number; utr: string | null; refund?: { amount_paise: number | null } }
interface Refund {
  refund_id: string; payment_id: string; event_title: string | null; amount_paise: number; payer_utr: string | null; requested_at: number;
  reason: string | null; status: string; refund_amount_paise: number; refund_utr: string | null; refund_vpa: string | null; refunded_at: number | null;
}
interface Detail {
  profile: {
    uid: string; name: string | null; email: string | null; photo_url?: string; joined_at: number | null;
    phone: { masked: string | null; verified: boolean; hash_only: boolean };
    vpas: { id: string; vpa: string; is_default: boolean }[];
    address: { name: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; pin: string | null; country: string | null } | null;
    gotra: string | null; language: string | null; family: unknown[];
  };
  bookings: Booking[]; payments: Payment[]; refunds: Refund[];
  payment_totals: { collected_paise: number; pending_paise: number; refunded_paise: number; count: number };
  truncated: { bookings: boolean; payments: boolean };
}

const TABS = ['profile', 'bookings', 'payments', 'refunds'] as const;
type Tab = (typeof TABS)[number];

function Row({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 sm:grid sm:grid-cols-[160px_1fr] sm:justify-start">
      <dt className="flex shrink-0 items-center gap-1.5 text-[13px] font-bold text-muted-foreground">{icon}{label}</dt>
      <dd className="min-w-0 text-right text-[14px] font-semibold text-foreground sm:text-left">{children}</dd>
    </div>
  );
}

function familyText(f: unknown[]): string {
  return f.map((m) => (typeof m === 'string' ? m : m && typeof m === 'object' && 'name' in m ? `${(m as { name: string }).name}${(m as { relation?: string }).relation ? ` (${(m as { relation?: string }).relation})` : ''}` : '')).filter(Boolean).join(', ');
}

export default function CustomerDetail({ uid }: { uid: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'profile';
    const t = new URLSearchParams(location.search).get('tab');
    return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'profile';
  });

  const load = useCallback(async () => {
    setError(null); setMissing(false);
    try {
      setD(await adminCall<Detail>(`/api/admin/v2/customers/${encodeURIComponent(uid)}`));
    } catch (e) {
      if (errCode(e) === 'not_found') { setMissing(true); return; }
      captureException(e, { where: 'admin2_customer', uid });
      setError(errMessage(e, 'Could not load this customer.'));
    }
  }, [uid]);
  useEffect(() => { void load(); }, [load]);

  const pick = (t: string) => {
    setTab(t as Tab);
    const u = new URL(location.href);
    if (t === 'profile') u.searchParams.delete('tab'); else u.searchParams.set('tab', t);
    history.replaceState(history.state, '', u.toString());
  };

  if (missing) return <Empty title="Customer not found" body="This account may have been deleted." />;
  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!d) return <ListSkeleton rows={4} />;
  const p = d.profile;
  const c: Customer = { uid: p.uid, name: p.name, email: p.email, phone_masked: p.phone.masked, phone_hash_only: p.phone.hash_only };
  const addr = p.address ? [p.address.name, p.address.line1, p.address.line2, [p.address.city, p.address.state, p.address.pin].filter(Boolean).join(' '), p.address.country].filter(Boolean) : [];

  return (
    <div className="space-y-5">
      <a href="/admin/customers" className="inline-flex items-center gap-1 text-[13px] font-bold text-muted-foreground no-underline hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All customers
      </a>

      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:p-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {p.photo_url
            ? <img src={p.photo_url} alt="" className="h-14 w-14 shrink-0 rounded-full border border-border object-cover" />
            : <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><UserRound className="h-7 w-7" /></span>}
          <div className="min-w-0">
            <h2 className="truncate font-dash text-[22px] font-bold text-grand-teal">{c.name ?? 'No name'}</h2>
            <div className="truncate text-[13.5px] font-semibold text-muted-foreground">{c.email ?? 'No email on file'}</div>
            <div className="text-[12.5px] font-semibold text-muted-foreground">Joined {istDate(p.joined_at)}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:w-[420px]">
          <Tile tone="accent" label="Paid" value={formatPaise(d.payment_totals.collected_paise ?? 0)} />
          <Tile label="Bookings" value={d.bookings.length + (d.truncated.bookings ? '+' : '')} />
          <Tile tone="muted" label="Refunded" value={formatPaise(d.payment_totals.refunded_paise ?? 0)} />
        </div>
      </section>

      <Tabs value={tab} onValueChange={pick}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 sm:w-auto">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="bookings">Bookings <Badge variant="muted" className="ml-1.5">{d.bookings.length}</Badge></TabsTrigger>
          <TabsTrigger value="payments">Payments <Badge variant="muted" className="ml-1.5">{d.payments.length}</Badge></TabsTrigger>
          <TabsTrigger value="refunds">Refunds <Badge variant="muted" className="ml-1.5">{d.refunds.length}</Badge></TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
              <h3 className="mb-1 font-dash text-[15px] font-bold text-grand-teal">Contact</h3>
              <dl className="divide-y divide-border/30">
                <Row label="Name" icon={<UserRound className="h-4 w-4" />}>{c.name ?? '—'}</Row>
                <Row label="Email" icon={<Mail className="h-4 w-4" />}>{c.email ? <CopyValue value={c.email} label="email" /> : '—'}</Row>
                <Row label="Phone" icon={<Phone className="h-4 w-4" />}>
                  {p.phone.masked ?? (p.phone.hash_only ? <span className="italic text-muted-foreground">On file, stored only as a hash</span> : '—')}
                  {p.phone.verified && <Badge variant="accent" className="ml-2">Verified</Badge>}
                </Row>
                <Row label="Customer ID"><CopyValue value={p.uid} label="customer ID" className="text-[12.5px]" /></Row>
              </dl>
            </section>
            <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
              <h3 className="mb-1 font-dash text-[15px] font-bold text-grand-teal">Puja details</h3>
              <dl className="divide-y divide-border/30">
                <Row label="Gotra">{p.gotra ?? '—'}</Row>
                <Row label="Family">{familyText(p.family) || '—'}</Row>
                <Row label="Language">{p.language ?? '—'}</Row>
              </dl>
            </section>
            <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
              <h3 className="mb-1 flex items-center gap-1.5 font-dash text-[15px] font-bold text-grand-teal"><Wallet className="h-4 w-4" />UPI ids (for refunds)</h3>
              {p.vpas.length ? (
                <ul className="divide-y divide-border/30">
                  {p.vpas.map((v) => (
                    <li key={v.id} className="flex items-center justify-between gap-2 py-2.5">
                      <CopyValue value={v.vpa} label="UPI id" />
                      {v.is_default && <Badge variant="outline">Default</Badge>}
                    </li>
                  ))}
                </ul>
              ) : <p className="py-2 text-[14px] font-semibold text-muted-foreground">No UPI id saved.</p>}
            </section>
            <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
              <h3 className="mb-1 flex items-center gap-1.5 font-dash text-[15px] font-bold text-grand-teal"><Home className="h-4 w-4" />Address (prasad delivery)</h3>
              {addr.length ? <address className="whitespace-pre-line py-2 text-[14px] font-semibold not-italic text-foreground">{addr.join('\n')}</address>
                : <p className="py-2 text-[14px] font-semibold text-muted-foreground">No address saved.</p>}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="bookings">
          <div className="mb-3 flex justify-end"><ExportButton kind="customer_bookings" path="/api/admin/v2/bookings" query={{ uid }} /></div>
          {d.bookings.length === 0 ? <Empty title="No bookings" /> : (
            <div className="overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm">
              <table className="w-full min-w-[560px] border-collapse">
                <thead className="bg-muted/60"><tr><th className={TH}>Event</th><th className={TH}>Status</th><th className={`${TH} text-right`}>Amount</th><th className={TH}>Booked</th></tr></thead>
                <tbody className="divide-y divide-border/40">
                  {d.bookings.map((b) => (
                    <tr key={b.id}>
                      <td className={TD}>
                        <a href={`/admin/bookings?event=${encodeURIComponent(b.listing_id)}`} className="font-bold text-foreground underline-offset-2 hover:underline">{b.event_title ?? b.listing_id}</a>
                        <div className="text-[12.5px] font-semibold text-muted-foreground">{b.event_starts_at ? istDateTime(b.event_starts_at) : 'No date'}</div>
                      </td>
                      <td className={TD}><StatusPill status={b.status} /></td>
                      <td className={`${TD} text-right font-extrabold tabular-nums`}>{b.status === 'free' ? 'Free' : formatPaise(b.amount_paise)}</td>
                      <td className={`${TD} whitespace-nowrap text-[13px] text-muted-foreground`}>{istDateTime(b.booked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="payments">
          <div className="mb-3 flex justify-end"><ExportButton kind="customer_payments" path="/api/admin/v2/payments" query={{ uid }} /></div>
          {d.payments.length === 0 ? <Empty title="No payments" /> : (
            <div className="overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm">
              <table className="w-full min-w-[620px] border-collapse">
                <thead className="bg-muted/60"><tr><th className={TH}>Paid</th><th className={TH}>Event</th><th className={TH}>Status</th><th className={`${TH} text-right`}>Amount</th><th className={TH}>UTR</th></tr></thead>
                <tbody className="divide-y divide-border/40">
                  {d.payments.map((x) => (
                    <tr key={x.id}>
                      <td className={`${TD} whitespace-nowrap text-[13px]`}>{x.paid_at ? istDateTime(x.paid_at) : <span className="text-muted-foreground">Started {istDateTime(x.created_at)}</span>}</td>
                      <td className={TD}>{x.event_title ?? x.listing_id}</td>
                      <td className={TD}><StatusPill status={x.status} /></td>
                      <td className={`${TD} text-right font-extrabold tabular-nums`}>{formatPaise(x.amount_paise)}</td>
                      <td className={`${TD} text-[13px]`}>{x.utr ? <CopyValue value={x.utr} label="UTR" /> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="refunds">
          {d.refunds.length === 0 ? <Empty title="No refund requests" /> : (
            <ul className="space-y-3">
              {d.refunds.map((r) => (
                <li key={r.refund_id} className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-dash text-[16px] font-bold"><IndianRupee className="-mt-0.5 mr-0.5 inline h-4 w-4" />{formatPaise(r.amount_paise).replace('₹', '')} · {r.event_title ?? 'Unknown event'}</div>
                      <div className="text-[12.5px] font-semibold text-muted-foreground">Requested {istDateTime(r.requested_at)}</div>
                    </div>
                    <StatusPill status={r.status} />
                  </div>
                  {r.reason && <p className="mt-2 rounded-lg bg-muted/60 p-2.5 text-[13.5px] font-semibold text-foreground">{r.reason === 'admin_initiated' ? 'Refunded by an admin without a customer request.' : r.reason}</p>}
                  {r.status === 'refunded' && (
                    <p className="mt-2 text-[13px] font-semibold text-muted-foreground">
                      {formatPaise(r.refund_amount_paise)} sent to {r.refund_vpa ?? '—'} on {istDateTime(r.refunded_at)}{r.refund_utr ? ` · UTR ${r.refund_utr}` : ''}
                    </p>
                  )}
                  {r.status === 'requested' && <a href="/admin/refunds" className="mt-2 inline-block text-[13px] font-bold text-accent underline-offset-2 hover:underline">Handle in Refunds</a>}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
