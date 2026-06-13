/* Overview — the /dashboard cockpit. Aggregates the creator's whole world into
 * one live view: identity status, wallet + earnings, listing performance (bars +
 * table over /api/listings/mine), upcoming bookings, top inbox messages, and an
 * affiliate snapshot. Everything is real data from the worker (listing engagement
 * is server-tracked via PostHog); it auto-refreshes every 45s so it reads live.
 */
import { useCallback, useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

const usd = (c?: number | null) => `$${((c ?? 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const dt = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const ago = (ms?: number) => {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
};

type Row = { id: string; title?: string; kind?: string; status?: string; price?: number | null; rating?: number | null; joined_count?: number };
type Booking = { id: string; title?: string | null; kind?: string; starts_at?: number; price?: number; status?: string };
type Note = { id: string; type?: string; title?: string; body?: string; read?: boolean; created_at?: number };

function Stat({ label, value, sub, tone, href }: { label: string; value: string; sub?: string; tone: string; href?: string }) {
  const inner = (
    <div className={`flex h-full flex-col gap-1 rounded-zine border-zine border-ink ${tone} p-4 shadow-zine-sm transition-transform duration-zine ${href ? 'hover:-translate-y-[2px]' : ''}`}>
      <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">{label}</span>
      <span className="font-display font-semibold text-[26px] leading-none text-ink">{value}</span>
      {sub && <span className="font-body font-bold text-[12px] text-inkSoft">{sub}</span>}
    </div>
  );
  return href ? <a href={href} className="no-underline">{inner}</a> : inner;
}

function Bars({ data, fmt }: { data: { label: string; value: number; tone: string }[]; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex flex-col gap-2.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate font-body font-bold text-[12px] text-inkSoft">{d.label}</span>
          <div className="h-4 flex-1 overflow-hidden rounded-full border-zine border-ink bg-paper">
            <div className={`h-full ${d.tone}`} style={{ width: `${Math.max(3, Math.round((d.value / max) * 100))}%` }} />
          </div>
          <span className="w-16 shrink-0 text-right font-display font-semibold text-[13px] text-ink">{fmt ? fmt(d.value) : d.value}</span>
        </div>
      ))}
    </div>
  );
}

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [last, setLast] = useState<number>(0);
  const [ident, setIdent] = useState<any>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [earn, setEarn] = useState<any>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [aff, setAff] = useState<any>(null);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);

  const load = useCallback(async (t: string) => {
    const pull = async <T,>(p: string, q?: Record<string, any>) => { try { return await request<T>(p, { auth: t, query: q }); } catch { return null as any; } };
    const [id, bal, er, mine, bk, nt, un, af] = await Promise.all([
      pull<any>('/api/identity/level'),
      pull<any>('/api/wallet/balance'),
      pull<any>('/api/wallet/earnings'),
      pull<{ listings: Row[] }>('/api/listings/mine'),
      pull<{ bookings?: Booking[] }>('/api/booking/list', { role: 'creator', when: 'upcoming' }),
      pull<{ items?: Note[] }>('/api/notifications', { limit: 6 }),
      pull<{ unread?: number }>('/api/notifications/unread'),
      pull<any>('/api/affiliate/me'),
    ]);
    if (id) setIdent(id);
    if (bal) setBalance(Number(bal.balance ?? 0));
    if (er) setEarn(er);
    if (mine) setRows(mine.listings ?? []);
    if (bk) setBookings((bk.bookings ?? (Array.isArray(bk) ? bk : [])) as Booking[]);
    if (nt) setNotes(nt.items ?? []);
    if (un) setUnread(Number(un.unread ?? 0));
    if (af) setAff(af);
    setLast(Date.now()); setLoading(false);
  }, []);

  useEffect(() => {
    if (!checked || !token) { if (checked) setLoading(false); return; }
    void load(token);
    const iv = setInterval(() => { if (!document.hidden) void load(token); }, 45000);
    return () => clearInterval(iv);
  }, [checked, token, load]);

  if (!checked || (token && loading)) return <div className="flex items-center gap-3 p-10"><Spinner size={24} /> <span className="font-body font-bold text-inkSoft">Building your cockpit…</span></div>;

  const published = rows.filter((r) => (r.status ?? 'draft') === 'published' || r.status === 'live');
  const drafts = rows.filter((r) => (r.status ?? 'draft') === 'draft');
  const totalJoins = rows.reduce((s, r) => s + (r.joined_count ?? 0), 0);
  const grossEst = rows.reduce((s, r) => s + (r.joined_count ?? 0) * (r.price ?? 0), 0);
  const ratings = rows.map((r) => r.rating).filter((x): x is number => typeof x === 'number' && x > 0);
  const avgRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
  const level = Number(ident?.level ?? 0);
  const verified = level >= 2 || ident?.kyc === 'verified' || ident?.kyc === 'approved';
  const topListings = [...rows].sort((a, b) => (b.joined_count ?? 0) - (a.joined_count ?? 0)).slice(0, 6);
  const TONES = ['bg-lime', 'bg-blue', 'bg-coral', 'bg-lilac', 'bg-mint', 'bg-card'];

  return (
    <div className="flex flex-col gap-6">
      {/* Identity / status banner */}
      <div className="flex flex-wrap items-center gap-3 rounded-zine border-zine border-ink bg-paper2 p-4 shadow-zine-sm">
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-zine border-zine border-ink ${verified ? 'bg-mint' : 'bg-card'} font-display text-[16px] font-semibold text-ink shadow-zine-xs`}>L{level}</span>
          <div>
            <div className="flex items-center gap-2 font-display font-semibold text-[17px] text-ink">
              {ident?.handle ? `@${ident.handle}` : 'Your studio'}
              {verified
                ? <span className="inline-flex items-center gap-1 rounded-full border-zine border-ink bg-mint px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-ink shadow-zine-xs">● Verified</span>
                : <a href="/dashboard/identity" className="inline-flex items-center gap-1 rounded-full border-zine border-ink bg-lime px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-ink no-underline shadow-zine-xs">Verify →</a>}
            </div>
            <div className="font-body font-bold text-[12px] text-inkSoft">{verified ? 'Identity verified — payouts unlocked.' : 'Verify your identity to unlock creator payouts.'}</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border-zine border-ink bg-card px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-inkSoft shadow-zine-xs"><span className="h-2 w-2 animate-pulse rounded-full bg-coral"></span>Live · {last ? ago(last) : '—'}</span>
          <a href="/dashboard/listings/new" className="rounded-full border-zine border-ink bg-lime px-4 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">+ New listing</a>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Wallet" value={usd(balance)} sub="AvaCoins balance" tone="bg-lime" href="/dashboard/wallet" />
        <Stat label="Available" value={usd(earn?.released_total)} sub="to withdraw" tone="bg-mint" href="/dashboard/payout" />
        <Stat label="Clearing" value={usd(earn?.held)} sub="7-day hold" tone="bg-card" />
        <Stat label="Listings" value={String(rows.length)} sub={`${published.length} live · ${drafts.length} draft`} tone="bg-blue" href="/dashboard/listings" />
        <Stat label="Bookings" value={String(totalJoins)} sub="all-time joins" tone="bg-lilac" href="/dashboard/bookings" />
        <Stat label="Inbox" value={String(unread)} sub="unread" tone="bg-coral" href="/dashboard/inbox" />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
            <div className="mb-4 flex items-center gap-2">
              <h2 className="font-display font-semibold text-[18px] text-ink">Listing performance</h2>
              <span className="ml-auto font-mono text-[11px] text-inkSoft">{usd(grossEst)} est. gross · {avgRating ? `★ ${avgRating.toFixed(1)}` : 'no ratings yet'}</span>
            </div>
            {topListings.length === 0 ? (
              <div className="rounded-zineField bg-paper2 p-6 font-body font-bold text-[14px] text-inkSoft">No listings yet. <a href="/dashboard/listings/new" className="text-blueInk underline">Create your first →</a></div>
            ) : (
              <Bars data={topListings.map((l, i) => ({ label: l.title || 'Untitled', value: l.joined_count ?? 0, tone: TONES[i % TONES.length] }))} />
            )}
          </div>

          {rows.length > 0 && (
            <div className="overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine-sm">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 border-b-zine border-ink bg-paper2 px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-inkSoft">
                <span>Listing</span><span className="text-right">Joins</span><span className="text-right">Rating</span><span className="text-right">Gross</span>
              </div>
              {rows.slice(0, 8).map((l) => (
                <a key={l.id} href={`/dashboard/l/${encodeURIComponent(l.id)}`} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-t-zine border-ink px-4 py-2.5 no-underline first:border-t-0 hover:bg-paper2">
                  <span className="min-w-0 truncate font-body font-extrabold text-[14px] text-ink">{l.title || 'Untitled'} <span className="ml-1 font-mono text-[10px] uppercase text-inkMute">{l.status ?? 'draft'}</span></span>
                  <span className="text-right font-display font-semibold text-[14px] text-ink">{l.joined_count ?? 0}</span>
                  <span className="text-right font-mono text-[12px] text-inkSoft">{l.rating ? `★${Number(l.rating).toFixed(1)}` : '—'}</span>
                  <span className="text-right font-display font-semibold text-[13px] text-blueInk">{usd((l.joined_count ?? 0) * (l.price ?? 0))}</span>
                </a>
              ))}
            </div>
          )}

          <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
            <h2 className="mb-4 font-display font-semibold text-[18px] text-ink">Earnings</h2>
            <Bars fmt={usd} data={[
              { label: 'Available', value: Number(earn?.released_total ?? 0), tone: 'bg-mint' },
              { label: 'Clearing', value: Number(earn?.held ?? 0), tone: 'bg-blue' },
              { label: 'Upcoming 7d', value: Number(earn?.upcoming ?? 0), tone: 'bg-lilac' },
              { label: 'Affiliate', value: Number(aff?.totals?.lifetime_coins ?? 0), tone: 'bg-coral' },
            ]} />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-zine border-zine border-ink bg-card p-4 shadow-zine-sm">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-display font-semibold text-[16px] text-ink">Inbox</h2>
              <a href="/dashboard/inbox" className="ml-auto font-mono text-[11px] font-bold uppercase text-blueInk no-underline">All →</a>
            </div>
            {notes.length === 0 ? <p className="font-body font-bold text-[13px] text-inkSoft">No messages yet.</p> : (
              <div className="flex flex-col gap-2">
                {notes.slice(0, 5).map((n) => (
                  <div key={n.id} className="flex items-start gap-2">
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full border border-ink ${n.read ? 'bg-paper' : 'bg-coral'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-body font-extrabold text-[13px] text-ink">{n.title ?? n.type ?? 'Notification'}</div>
                      {n.body && <div className="truncate font-body font-bold text-[12px] text-inkSoft">{n.body}</div>}
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-inkMute">{ago(n.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-zine border-zine border-ink bg-card p-4 shadow-zine-sm">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-display font-semibold text-[16px] text-ink">Upcoming</h2>
              <a href="/dashboard/calendar" className="ml-auto font-mono text-[11px] font-bold uppercase text-blueInk no-underline">Calendar →</a>
            </div>
            {bookings.length === 0 ? <p className="font-body font-bold text-[13px] text-inkSoft">Nothing booked yet.</p> : (
              <div className="flex flex-col gap-2.5">
                {bookings.slice(0, 5).map((b) => (
                  <div key={b.id} className="flex items-center gap-2">
                    <span className="rounded-full border-zine border-ink bg-lime px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-ink">{b.kind ?? 'event'}</span>
                    <span className="min-w-0 flex-1 truncate font-body font-extrabold text-[13px] text-ink">{b.title || 'Session'}</span>
                    <span className="shrink-0 font-mono text-[10px] text-inkMute">{dt(b.starts_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-zine border-zine border-ink bg-paper2 p-4 shadow-zine-sm">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="font-display font-semibold text-[16px] text-ink">Affiliate</h2>
              <a href="/dashboard/affiliate" className="ml-auto font-mono text-[11px] font-bold uppercase text-blueInk no-underline">Open →</a>
            </div>
            {aff?.registered ? (
              <div className="flex items-baseline gap-3">
                <span className="font-display font-semibold text-[24px] text-ink">{usd(aff?.totals?.lifetime_coins)}</span>
                <span className="font-body font-bold text-[12px] text-inkSoft">{aff?.totals?.referred_users ?? 0} referred</span>
              </div>
            ) : (
              <p className="font-body font-bold text-[13px] text-inkSoft">Earn 10% for life — <a href="/dashboard/affiliate" className="text-blueInk underline">become an affiliate →</a></p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Overview() { return <ClerkIsland><Inner /></ClerkIsland>; }
export default Overview;
