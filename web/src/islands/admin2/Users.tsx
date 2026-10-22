/* Users — [ADMIN2-USERS 2026-09-26] Every Saa Thum account.
 * GET /api/admin/v2/users?q&filter&sort&joined_from&joined_to&cursor(&format=csv)
 * Cards view (default): a person card opens the full panel in a side sheet. Table view: a row opens the panel
 * DIRECTLY BELOW it (animated height, one at a time). Either way URL ?user=<uid> is kept, and the panel shows
 * the full profile, money, bookings, payments and the account actions:
 *   Block / Unblock          POST /api/admin/v2/users/:uid/{block,unblock}
 *   Reset login              POST /api/admin/v2/users/:uid/signout-all  (there are NO passwords:
 *                            sign-in is an email code or Google, so "reset" = end every session)
 *   Delete user              DELETE /api/admin/v2/users/:uid {confirm: email}
 * Actions are never shown for admins or for yourself (the worker refuses them too). */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Ban, CalendarClock, ChevronDown, ExternalLink, Home, IndianRupee, Info, Languages, LayoutGrid, Loader2, LogOut, Mail, Phone,
  ShieldCheck, ShieldOff, Table2, Trash2, UserRound, Users as UsersIcon, Wallet,
} from 'lucide-react';
import { captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Input } from '../../components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { istDate, istDateTime, errMessage, errCode } from './adminApi';
import { DesiCard, DesiChip, DesiKpi, DesiKpis, DesiPersonCard, avatarColour } from './desi';
import {
  CopyValue, DateField, Empty, ErrorBox, ExportButton, FilterBar, ListSkeleton, LoadMore, SearchBox, StatusPill, Tile,
  adminCall, dayMs, formatPaise, phoneText, usePaged, useUrlFilters,
} from './peopleKit';
import { BRAND } from '../../lib/brand';

/* ── types ──────────────────────────────────────────────────────────────── */

interface UserItem {
  uid: string; name: string | null; email: string | null; photo_url: string | null;
  phone_masked: string | null; phone_hash_only: boolean; phone_verified: boolean;
  joined_at: number | null; last_active_at: number | null; bookings: number; spent_paise: number;
  status: 'active' | 'blocked'; deleting: boolean; is_admin: boolean; is_self: boolean;
}
interface Booking { id: string; listing_id: string; event_title: string | null; event_starts_at: number | null; status: string; amount_paise: number; booked_at: number }
interface Payment { id: string; listing_id: string; event_title: string | null; amount_paise: number; status: string; paid_at: number | null; created_at: number; utr: string | null }
interface Detail {
  profile: {
    uid: string; name: string | null; email: string | null; photo_url?: string; joined_at: number | null;
    phone: { masked: string | null; verified: boolean; hash_only: boolean };
    vpas: { id: string; vpa: string; is_default: boolean }[];
    address: { name: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; pin: string | null; country: string | null } | null;
    gotra: string | null; language: string | null;
  };
  bookings: Booking[]; payments: Payment[];
  refunds: { refund_id: string; status: string }[];
  money: { spent_paise: number; payments: number; refunds: number; refunded_paise: number; pending: number; pending_paise: number; bookings: number };
  account: {
    status: 'active' | 'blocked';
    blocked: { at: number | null; by: string | null; reason: string | null } | null;
    clerk: { found: boolean; email_verified?: boolean; created_at?: number | null; last_sign_in_at?: number | null; last_active_at?: number | null };
    deleting: boolean; is_admin: boolean; is_self: boolean;
  };
}

const KEYS = ['q', 'filter', 'sort', 'joined_from', 'joined_to'] as const;
const FILTERS = [
  { key: 'verified', label: 'Verified' },
  { key: 'not_verified', label: 'Not verified' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'has_spent', label: 'Has spent' },
] as const;
const SORTS = [
  { key: 'joined', label: 'Newest first' },
  { key: 'spent', label: 'Most spent' },
  { key: 'name', label: 'Name A–Z' },
] as const;
const LANG: Record<string, string> = { en: 'English', hi: 'Hindi', mr: 'Marathi', gu: 'Gujarati', ta: 'Tamil', te: 'Telugu', bn: 'Bengali', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi' };

/* ── small pieces ───────────────────────────────────────────────────────── */

const initials = (u: { name: string | null; email: string | null }) =>
  ((u.name ?? u.email ?? '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?');

/** Marigold-ringed avatar: photo when there is one, else coloured initials. */
function UserAvatar({ u, seed, size = 44 }: { u: { name: string | null; email: string | null; photo_url?: string | null }; seed: string; size?: number }) {
  return (
    <Avatar className="border-[3px] border-white shadow-[0_0_0_2px_var(--a-marigold,#f59e0b)]" style={{ width: size, height: size }}>
      {u.photo_url ? <AvatarImage src={u.photo_url} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className="font-black text-white" style={{ background: avatarColour(seed), fontSize: size * 0.38 }}>{initials(u)}</AvatarFallback>
    </Avatar>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <DesiChip tone="tea" className="whitespace-nowrap"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />Verified</DesiChip>
    : <DesiChip tone="grey" className="whitespace-nowrap">Not verified</DesiChip>;
}

function StatusBadge({ u }: { u: Pick<UserItem, 'status' | 'deleting' | 'is_admin'> }) {
  if (u.deleting) return <DesiChip tone="grey" className="whitespace-nowrap">Deleting</DesiChip>;
  if (u.status === 'blocked') return <DesiChip tone="rani" className="whitespace-nowrap"><Ban className="h-3.5 w-3.5" aria-hidden />Blocked</DesiChip>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <DesiChip tone="tea" className="whitespace-nowrap">Active</DesiChip>
      {u.is_admin && <DesiChip tone="lav" className="whitespace-nowrap">Admin</DesiChip>}
    </span>
  );
}

/** Band colour of a person card + the matching row edge in the table. */
type Band = 'tea' | 'lav' | 'rani' | 'grey';
const bandOf = (u: Pick<UserItem, 'status' | 'deleting' | 'is_admin' | 'phone_verified'>): Band =>
  u.deleting ? 'grey' : u.status === 'blocked' ? 'rani' : u.is_admin ? 'lav' : u.phone_verified ? 'tea' : 'grey';
const BAND_INK: Record<Band, string> = { tea: '#0e7c86', lav: '#6d4fd0', rani: '#d81b72', grey: '#c9b9c9' };

function ago(ms: number | null): string {
  if (!ms) return '—';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** Height-animated disclosure: grid rows 0fr → 1fr (reduced motion: instant). */
function Expander({ open, children, id }: { open: boolean; children: ReactNode; id: string }) {
  return (
    <div
      id={id}
      className={cn('grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function Field({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 sm:grid sm:grid-cols-[150px_1fr] sm:justify-start">
      <dt className="flex shrink-0 items-center gap-1.5 text-[14px] font-bold text-[var(--a-muted,#6f5b6f)]">{icon}{label}</dt>
      <dd className="min-w-0 text-right text-[14px] font-semibold text-[var(--a-ink,#2b1530)] sm:text-left">{children}</dd>
    </div>
  );
}

const None = () => <span className="text-[var(--a-muted,#6f5b6f)]">—</span>;

function readUserParam(): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('user');
  return v ? v.slice(0, 200) : null;
}
function writeUserParam(uid: string | null) {
  const u = new URL(location.href);
  if (uid) u.searchParams.set('user', uid); else u.searchParams.delete('user');
  history.replaceState(history.state, '', u.toString());
}

/* ── main ───────────────────────────────────────────────────────────────── */

type View = 'cards' | 'table';
const DOT = ['#d81b72', '#6d4fd0', '#0e7c86', '#f59e0b'];

export default function Users() {
  const { f, applied, set, clear, key } = useUrlFilters(KEYS);
  const query = useMemo(() => ({
    q: applied.q.trim() || undefined,
    filter: applied.filter || undefined,
    sort: applied.sort && applied.sort !== 'joined' ? applied.sort : undefined,
    joined_from: dayMs(applied.joined_from),
    joined_to: dayMs(applied.joined_to, true),
  }), [applied]);
  const list = usePaged<UserItem>('/api/admin/v2/users', query, key);
  const totals = (list.first?.totals ?? null) as { users: number; spent_paise: number; blocked: number; verified: number } | null;
  const [view, setView] = useState<View>('cards');

  const [open, setOpen] = useState<string | null>(readUserParam);
  const [closing, setClosing] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggle = useCallback((uid: string) => {
    setOpen((cur) => {
      const next = cur === uid ? null : uid;
      if (cur) {
        setClosing(cur);
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setClosing(null), 320);
      }
      writeUserParam(next);
      return next;
    });
  }, []);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  // An action changed a user: patch the row in place (no refetch of the whole list).
  const patch = useCallback((uid: string, p: Partial<UserItem>) => {
    list.setItems((items) => items.map((u) => (u.uid === uid ? { ...u, ...p } : u)));
  }, [list.setItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const on = new Set(f.filter ? f.filter.split(',') : []);
  const flip = (k: string) => { const n = new Set(on); if (n.has(k)) n.delete(k); else n.add(k); set({ filter: [...n].join(',') }); };
  const count = on.size + (f.joined_from ? 1 : 0) + (f.joined_to ? 1 : 0) + (f.sort && f.sort !== 'joined' ? 1 : 0);
  const q = applied.q.trim();
  const openInList = !!open && list.items.some((u) => u.uid === open);

  const mounted = (uid: string) => uid === open || uid === closing;
  const sheetUid = open ?? closing;

  // "Naye log, is hafte": the newest sign-ups among the people already loaded.
  const fresh = useMemo(() => {
    const dated = list.items.filter((u) => u.joined_at).sort((a, b) => (b.joined_at ?? 0) - (a.joined_at ?? 0));
    const week = dated.filter((u) => (Date.now() - (u.joined_at ?? 0)) < 7 * 86_400_000);
    return { rows: (week.length ? week : dated).slice(0, 6), thisWeek: week.length > 0 };
  }, [list.items]);
  const showFresh = list.phase === 'ready' && fresh.rows.length > 0;

  const listBody = list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load users.'} onRetry={list.reload} /> :
    list.items.length === 0 ? (
      <Empty title={q || count ? 'No user matches' : 'No users yet'} body={q ? 'Check the spelling, or try the full email or the full mobile number.' : 'People appear here once they create an account.'} />
    ) : view === 'cards' ? (
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-[clamp(10px,1vw,16px)] p-0">
        {list.items.map((u) => {
          const band = bandOf(u);
          return (
            <li key={u.uid} className="min-w-0">
              <DesiPersonCard
                band={band}
                selected={u.uid === open}
                onClick={() => toggle(u.uid)}
                avatar={<UserAvatar u={u} seed={u.uid} size={56} />}
                title={<>{u.name ?? 'No name'}{u.is_self ? ' (you)' : ''}</>}
                sub={u.email ? <span className="block truncate" title={u.email}>{u.email}</span> : <span className={cn(u.phone_hash_only && 'italic')}>{phoneText(u) ?? 'No phone'}</span>}
                chips={
                  <>
                    {u.deleting ? <DesiChip tone="grey">Deleting</DesiChip>
                      : u.status === 'blocked' ? <DesiChip tone="rani"><Ban className="h-3.5 w-3.5" aria-hidden />Blocked</DesiChip>
                      : <VerifiedBadge verified={u.phone_verified} />}
                    <DesiChip tone={u.spent_paise > 0 ? 'gold' : 'grey'}>{u.spent_paise > 0 ? formatPaise(u.spent_paise) : 'No spend'} · {u.bookings} booking{u.bookings === 1 ? '' : 's'}</DesiChip>
                    {u.is_admin && <DesiChip tone="lav">Admin</DesiChip>}
                    {u.is_self && <DesiChip tone="plum">You</DesiChip>}
                  </>
                }
                meta={<><span>Joined {istDate(u.joined_at)}</span><span>Active {u.last_active_at ? istDate(u.last_active_at) : '—'}</span></>}
              />
            </li>
          );
        })}
      </ul>
    ) : (
      <DesiCard tone="cream" corner="marigold">
        <div className="hfa-scroll">
          <table className="hfa-table min-w-[980px]">
            <thead>
              <tr>
                <th>User</th><th>Phone</th><th>Joined</th><th>Last active</th>
                <th className="text-right">Bookings</th><th className="text-right">Spent</th><th>Status</th><th className="w-10" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {list.items.map((u) => {
                const isOpen = u.uid === open;
                return [
                  <tr
                    key={u.uid}
                    className={cn('cursor-pointer', isOpen && 'bg-[var(--a-blush,#ffe6ef)]')}
                    style={{ boxShadow: `inset 5px 0 0 ${BAND_INK[bandOf(u)]}` }}
                    onClick={() => toggle(u.uid)}
                  >
                    <td className="max-w-[300px] pl-4">
                      <div className="flex items-center gap-3">
                        <UserAvatar u={u} seed={u.uid} size={44} />
                        <div className="min-w-0">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={`user-panel-${u.uid}`}
                            onClick={(e) => { e.stopPropagation(); toggle(u.uid); }}
                            className="min-h-11 text-left font-extrabold text-[var(--a-ink,#2b1530)] underline-offset-2 hover:text-[var(--a-rani,#d81b72)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]"
                          >
                            {u.name ?? 'No name'}{u.is_self ? ' (you)' : ''}
                          </button>
                          {u.email && <div className="truncate text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]" title={u.email}>{u.email}</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className={cn('tabular-nums', u.phone_hash_only && 'italic text-[var(--a-muted,#6f5b6f)]')}>{phoneText(u) ?? <None />}</div>
                      <div className="mt-1"><VerifiedBadge verified={u.phone_verified} /></div>
                    </td>
                    <td className="whitespace-nowrap text-[var(--a-muted,#6f5b6f)]">{istDate(u.joined_at)}</td>
                    <td className="whitespace-nowrap text-[var(--a-muted,#6f5b6f)]">{u.last_active_at ? istDateTime(u.last_active_at) : '—'}</td>
                    <td className="text-right tabular-nums">{u.bookings}</td>
                    <td className="text-right font-['Nunito'] font-black tabular-nums text-[var(--a-amber,#b45309)]">{formatPaise(u.spent_paise)}</td>
                    <td><StatusBadge u={u} /></td>
                    <td className="pr-3"><ChevronDown aria-hidden className={cn('h-4 w-4 text-[var(--a-muted,#6f5b6f)] transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} /></td>
                  </tr>,
                  <tr key={`${u.uid}-panel`} className={cn(!mounted(u.uid) && 'hidden')}>
                    <td colSpan={8} className="!p-0">
                      <Expander open={isOpen} id={`user-panel-${u.uid}`}>
                        {mounted(u.uid) && <div className="border-t border-dashed border-[var(--a-line,#f1e3d6)] bg-[var(--a-cream,#fffaf3)]"><UserPanel uid={u.uid} onChange={patch} /></div>}
                      </Expander>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      </DesiCard>
    );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="hf-admin-operations hfa-stack">
        {totals && (
          <DesiKpis>
            <DesiKpi tone="plum" icon={<UsersIcon strokeWidth={2.2} />} label="Total people" value={totals.users} sub="Accounts in this view" />
            <DesiKpi tone="gold" icon={<IndianRupee strokeWidth={2.2} />} label="Spent" value={formatPaise(totals.spent_paise)} sub="Across these people" />
            <DesiKpi tone="tea" icon={<ShieldCheck strokeWidth={2.2} />} label="Verified" value={totals.verified} sub="Phone-verified" />
            <DesiKpi tone="rani" icon={<Ban strokeWidth={2.2} />} label="Blocked" value={totals.blocked} sub={totals.blocked ? 'Cannot sign in' : 'Nobody blocked'} />
          </DesiKpis>
        )}

        <FilterBar
          title="Filter users"
          count={count}
          onClear={clear}
          resultLabel={list.phase === 'ready' ? `Show ${list.items.length}${list.cursor ? '+' : ''}` : 'Show'}
          search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search users" placeholder="Name, email or phone" />}
        >
          <div role="group" aria-label="Filters" className="hfa-pills">
            {FILTERS.map((x) => (
              <button key={x.key} type="button" aria-pressed={on.has(x.key)} onClick={() => flip(x.key)} className="hfa-pill">
                {x.label}
              </button>
            ))}
          </div>
          <DateField id="u-from" label="Joined from" value={f.joined_from} onChange={(v) => set({ joined_from: v })} />
          <DateField id="u-to" label="Joined to" value={f.joined_to} onChange={(v) => set({ joined_to: v })} />
          <label className="grid gap-1 text-[14px] font-bold text-[var(--a-muted,#6f5b6f)]">
            Sort
            <Select value={f.sort || 'joined'} onValueChange={(v) => set({ sort: v === 'joined' ? '' : v })}>
              <SelectTrigger className="h-11 w-[170px] rounded-full border-[1.5px] border-[var(--a-line,#f1e3d6)] bg-white font-semibold text-[var(--a-ink,#2b1530)]" aria-label="Sort users"><SelectValue /></SelectTrigger>
              <SelectContent>{SORTS.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
        </FilterBar>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={cn('hfa-note !mt-0', totals && 'sr-only')} aria-live="polite">
            {list.phase === 'loading' ? 'Loading…' : totals
              ? `${totals.users} user${totals.users === 1 ? '' : 's'} · ${formatPaise(totals.spent_paise)} spent · ${totals.verified} phone-verified · ${totals.blocked} blocked`
              : ''}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div role="group" aria-label="View" className="hfa-pills">
              <button type="button" className="hfa-pill inline-flex items-center gap-2" aria-pressed={view === 'cards'} onClick={() => setView('cards')}><LayoutGrid className="h-4 w-4" aria-hidden />Cards</button>
              <button type="button" className="hfa-pill inline-flex items-center gap-2" aria-pressed={view === 'table'} onClick={() => setView('table')}><Table2 className="h-4 w-4" aria-hidden />Table</button>
            </div>
            <ExportButton kind="users" path="/api/admin/v2/users" query={query} />
          </div>
        </div>

        {view === 'table' && open && !openInList && list.phase === 'ready' && (
          <DesiCard tone="gold" corner="marigold" title="Opened from a link" action={<button type="button" className="hfa-btn ghost" onClick={() => toggle(open)}>Close</button>}>
            <UserPanel uid={open} onChange={patch} />
          </DesiCard>
        )}

        {showFresh ? (
          <div className="hfa-row-side">
            <div className="hfa-stack">{listBody}</div>
            <aside className="max-[1100px]:hidden" aria-label="New sign-ups">
              <DesiCard title="Naye log, is hafte" note={fresh.thisWeek ? 'Joined in the last 7 days' : 'Latest sign-ups loaded'} tone="lav" corner="jasmine" pattern="dots">
                <ol className="relative m-0 list-none space-y-1 p-0 pl-6 before:absolute before:bottom-3 before:left-[9px] before:top-3 before:border-l-[3px] before:border-dashed before:border-[#c7b6f5] before:content-['']">
                  {fresh.rows.map((u, i) => (
                    <li key={u.uid} className="relative">
                      <span aria-hidden className="absolute -left-[22px] top-[18px] h-4 w-4 rounded-full border-[3px] border-white" style={{ background: DOT[i % DOT.length], boxShadow: '0 0 0 2px #fff1d6' }} />
                      <button type="button" onClick={() => toggle(u.uid)} className="flex min-h-11 w-full flex-col items-start rounded-2xl px-3 py-2 text-left hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]">
                        <b className="font-['Nunito'] text-[var(--a-ink,#2b1530)] [overflow-wrap:anywhere]">{u.name ?? u.email ?? 'No name'}</b>
                        <span className="hfa-note !mt-0">Joined {ago(u.joined_at)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </DesiCard>
            </aside>
          </div>
        ) : listBody}

        {list.phase === 'ready' && list.items.length > 0 && <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />}

        <Sheet open={view === 'cards' && !!open} onOpenChange={(o) => { if (!o && open) toggle(open); }}>
          <SheetContent className="hf-admin-operations !max-w-[min(100vw,56rem)] !bg-[var(--a-cream,#fffaf3)] !p-0 sm:!max-w-[min(100vw,56rem)]">
            <SheetTitle className="sr-only">User details</SheetTitle>
            <SheetDescription className="sr-only">Profile, money, bookings, payments and account actions for this person.</SheetDescription>
            {sheetUid && view === 'cards' && (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-dashed border-[var(--a-line,#f1e3d6)] bg-[linear-gradient(100deg,#fff1d6,#ffe6ef)] px-4 py-3 pr-16">
                  <span className="hfa-eyebrow">Person details</span>
                  <button type="button" className="hfa-btn ghost" onClick={() => open && toggle(open)}>Close</button>
                </div>
                <UserPanel key={sheetUid} uid={sheetUid} onChange={patch} />
              </>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}

/* ── the panel for one person ──────────────────────────────────────────── */

function UserPanel({ uid, onChange }: { uid: string; onChange: (uid: string, p: Partial<UserItem>) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    setError(null); setMissing(false);
    try {
      setD(await adminCall<Detail>(`/api/admin/v2/users/${encodeURIComponent(uid)}`));
    } catch (e) {
      if (errCode(e) === 'not_found') { setMissing(true); return; }
      captureException(e, { where: 'admin2_user_panel', uid });
      setError(errMessage(e, 'Could not load this user.'));
    }
  }, [uid]);
  useEffect(() => { void load(); }, [load]);

  if (missing) return <div className="p-4"><Empty title="User not found" body="This account may have been deleted." /></div>;
  if (error) return <div className="p-4"><ErrorBox message={error} onRetry={load} /></div>;
  if (!d) {
    return (
      <div className="flex items-center gap-2 p-6 text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]" aria-busy="true">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Loading profile…
      </div>
    );
  }

  const p = d.profile, a = d.account, m = d.money;
  const now = Date.now();
  const upcoming = d.bookings.filter((b) => b.event_starts_at != null && b.event_starts_at > now).sort((x, y) => (x.event_starts_at ?? 0) - (y.event_starts_at ?? 0));
  const past = d.bookings.filter((b) => !(b.event_starts_at != null && b.event_starts_at > now));
  const addr = p.address ? [p.address.name, p.address.line1, p.address.line2, p.address.city, p.address.state, p.address.pin, p.address.country].filter(Boolean).join(', ') : '';
  const canAct = !a.is_admin && !a.is_self && !a.deleting;
  const headTone = a.status === 'blocked' ? 'rani' : 'plum';

  return (
    <div className="hfa-stack p-4 sm:p-5">
      <DesiCard tone={headTone} corner="marigold">
        <div className="flex flex-wrap items-center gap-4 pr-10">
          <UserAvatar u={{ name: p.name, email: p.email, photo_url: p.photo_url }} seed={uid} size={72} />
          <div className="min-w-0 flex-1">
            <div className="font-['Nunito'] text-[length:var(--fs-h2,20px)] font-black leading-tight [overflow-wrap:anywhere]">{p.name ?? 'No name'}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge u={{ status: a.status, deleting: a.deleting, is_admin: a.is_admin }} />
              <span className="text-[14px] font-semibold opacity-85">ID</span>
              <CopyValue value={uid} label="user ID" className="text-[14px]" />
            </div>
          </div>
        </div>
      </DesiCard>

      {a.status === 'blocked' && a.blocked && (
        <p role="status" className="rounded-[22px] border-2 border-dashed border-[#f2a9c8] bg-[var(--a-blush,#ffe6ef)] px-4 py-3 text-[14px] font-bold text-[var(--a-ink,#2b1530)]">
          Blocked {a.blocked.at ? istDateTime(a.blocked.at) : ''}{a.blocked.reason ? `: ${a.blocked.reason}` : ''}. They can't sign in, and the app and website refuse their requests.
        </p>
      )}
      {a.deleting && (
        <p role="status" className="rounded-[22px] border-2 border-dashed border-[var(--a-line,#f1e3d6)] bg-[#f3eef2] px-4 py-3 text-[14px] font-bold text-[var(--a-ink,#2b1530)]">
          This account is being deleted. It disappears from the list once the deletion finishes.
        </p>
      )}

      <div className="hfa-row">
        <DesiCard title="Profile" tone="cream" corner="jasmine" className="[&_dl]:divide-y [&_dl]:divide-dashed [&_dl]:divide-[var(--a-line,#f1e3d6)]">
          <dl>
            <Field label="Full name" icon={<UserRound className="h-4 w-4" />}>{p.name ?? <None />}</Field>
            <Field label="Email" icon={<Mail className="h-4 w-4" />}>
              {p.email ? <span className="break-all">{p.email}{a.clerk.email_verified ? <DesiChip tone="tea" className="ml-1.5">verified</DesiChip> : null}</span> : <None />}
            </Field>
            <Field label="Phone" icon={<Phone className="h-4 w-4" />}>
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5 sm:justify-start">
                <span className={cn('tabular-nums', p.phone.hash_only && 'italic text-[var(--a-muted,#6f5b6f)]')}>{phoneText({ phone_masked: p.phone.masked, phone_hash_only: p.phone.hash_only }) ?? 'None'}</span>
                <VerifiedBadge verified={p.phone.verified} />
              </span>
            </Field>
            <Field label="UPI IDs" icon={<Wallet className="h-4 w-4" />}>
              {p.vpas.length ? p.vpas.map((v) => <div key={v.id} className="break-all">{v.vpa}{v.is_default ? <span className="ml-1 text-[14px] text-[var(--a-muted,#6f5b6f)]">(default)</span> : null}</div>) : <None />}
            </Field>
            <Field label="Prasad address" icon={<Home className="h-4 w-4" />}>{addr || <None />}</Field>
            <Field label="Gotra">{p.gotra ?? <None />}</Field>
            <Field label="Language" icon={<Languages className="h-4 w-4" />}>{p.language ? (LANG[p.language] ?? p.language) : <None />}</Field>
            <Field label="Joined" icon={<CalendarClock className="h-4 w-4" />}>{p.joined_at ? istDateTime(p.joined_at) : a.clerk.created_at ? istDateTime(a.clerk.created_at) : '—'}</Field>
            <Field label="Last sign-in">{a.clerk.last_sign_in_at ? istDateTime(a.clerk.last_sign_in_at) : <None />}</Field>
            <Field label="Last active">{a.clerk.last_active_at ? istDateTime(a.clerk.last_active_at) : <None />}</Field>
          </dl>
          {!a.clerk.found && <p className="hfa-note">Sign-in details couldn't be loaded right now.</p>}
        </DesiCard>

        <div className="hfa-stack">
          <section aria-label="Money" className="grid grid-cols-2 gap-3">
            <Tile label="Total spent" tone="accent" value={formatPaise(m.spent_paise)} hint="GST included, after refunds" />
            <Tile label="Payments" value={m.payments} hint={`${m.bookings} seat${m.bookings === 1 ? '' : 's'} held`} />
            <Tile label="Refunds" tone={m.refunds ? 'amber' : undefined} value={m.refunds} hint={m.refunds ? `${formatPaise(m.refunded_paise)} sent back` : 'None'} />
            <Tile label="Pending" tone={m.pending ? 'gold' : undefined} value={m.pending} hint={m.pending ? `${formatPaise(m.pending_paise)} waiting` : 'None'} />
          </section>

          <a href={`/admin/wallets?wallet=${encodeURIComponent(uid)}`} className="hfa-btn tea self-start no-underline">
            <Wallet className="h-4 w-4" /> Open wallet (balance, top-ups, add money) <ExternalLink className="h-3.5 w-3.5" />
          </a>

          <DesiCard title="Account actions" tone="gold" pattern="stripes" note="Careful: these change what this person can do.">
            {canAct ? (
              <Actions uid={uid} email={p.email} name={p.name} blocked={a.status === 'blocked'} onDone={(patch) => { onChange(uid, patch); void load(); }} />
            ) : (
              <p className="flex items-start gap-1.5 text-[14px] font-semibold text-[var(--a-ink,#2b1530)]">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {a.is_self ? 'This is your own account. Actions are hidden.' : a.is_admin ? 'This is an admin account. Admins can\'t be blocked, signed out or deleted here.' : 'No actions while the account is being deleted.'}
              </p>
            )}
          </DesiCard>
        </div>
      </div>

      <DesiCard
        title="Bookings" tone="tea" corner="marigold"
        action={<a href={`/admin/bookings?q=${encodeURIComponent(p.email ?? uid)}`} className="inline-flex min-h-11 items-center gap-1 text-[14px] font-bold text-[var(--a-peacock,#0e7c86)] no-underline hover:underline">All in Bookings <ExternalLink className="h-3.5 w-3.5" /></a>}
      >
        {d.bookings.length === 0 ? <p className="text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]">No bookings yet.</p> : (
          <div className="grid gap-4 md:grid-cols-2">
            <BookingList title="Upcoming" items={upcoming} />
            <BookingList title="Past" items={past.slice(0, 10)} more={past.length > 10 ? past.length - 10 : 0} />
          </div>
        )}
      </DesiCard>

      <DesiCard
        title="Recent payments" tone="gold" corner="hibiscus"
        action={<a href={`/admin/payments?q=${encodeURIComponent(p.email ?? uid)}`} className="inline-flex min-h-11 items-center gap-1 text-[14px] font-bold text-[var(--a-amber,#b45309)] no-underline hover:underline">All in Payments <ExternalLink className="h-3.5 w-3.5" /></a>}
      >
        {d.payments.length === 0 ? <p className="text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]">No payments yet.</p> : (
          <ul className="m-0 list-none divide-y divide-dashed divide-[#e9c98d] p-0">
            {d.payments.slice(0, 8).map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <a href={`/admin/payments?q=${encodeURIComponent(x.id)}`} className="inline-flex min-h-11 min-w-0 flex-1 items-center truncate text-[14px] font-bold text-[var(--a-ink,#2b1530)] no-underline hover:text-[var(--a-rani,#d81b72)] hover:underline">{x.event_title ?? x.listing_id}</a>
                <span className="text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]">{istDateTime(x.paid_at ?? x.created_at)}</span>
                {x.utr && <span className="text-[14px] font-semibold tabular-nums text-[var(--a-muted,#6f5b6f)]">UTR {x.utr}</span>}
                <span className="font-['Nunito'] font-black tabular-nums text-[var(--a-peacock,#0e7c86)]"><IndianRupee className="sr-only" />{formatPaise(x.amount_paise)}</span>
                <StatusPill status={x.status} />
              </li>
            ))}
          </ul>
        )}
        {d.refunds.length > 0 && (
          <a href="/admin/refunds" className="mt-2 inline-flex min-h-11 items-center gap-1 text-[14px] font-bold text-[var(--a-rani,#d81b72)] no-underline hover:underline">
            {d.refunds.length} refund request{d.refunds.length === 1 ? '' : 's'} in Refunds <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </DesiCard>
    </div>
  );
}

function BookingList({ title, items, more = 0 }: { title: string; items: Booking[]; more?: number }) {
  return (
    <div>
      <h4 className="hfa-eyebrow mb-1 !text-[var(--a-peacock,#0e7c86)]">{title}</h4>
      {items.length === 0 ? <p className="text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]">None.</p> : (
        <ul className="m-0 list-none divide-y divide-dashed divide-[#9fd3d8] p-0">
          {items.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
              <a href={`/admin/events/${encodeURIComponent(b.listing_id)}`} className="inline-flex min-h-11 min-w-0 flex-1 items-center truncate text-[14px] font-bold text-[var(--a-ink,#2b1530)] no-underline hover:text-[var(--a-rani,#d81b72)] hover:underline">{b.event_title ?? b.listing_id}</a>
              <span className="text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]">{b.event_starts_at ? istDateTime(b.event_starts_at) : '—'}</span>
              <StatusPill status={b.status} />
              <a href={`/admin/bookings?event=${encodeURIComponent(b.listing_id)}`} className="inline-flex min-h-11 items-center text-[14px] font-bold text-[var(--a-peacock,#0e7c86)] no-underline hover:underline">Seats</a>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="hfa-note">and {more} more in Bookings</p>}
    </div>
  );
}

/* ── actions ────────────────────────────────────────────────────────────── */

type Dialog = null | 'block' | 'unblock' | 'signout' | 'delete';

function Actions({ uid, email, name, blocked, onDone }: {
  uid: string; email: string | null; name: string | null; blocked: boolean; onDone: (patch: Partial<UserItem>) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const who = name ?? email ?? 'this user';
  const expected = email ?? uid;
  const confirmOk = confirm.trim().toLowerCase() === expected.toLowerCase();

  const run = async (kind: Exclude<Dialog, null>) => {
    setBusy(true);
    const path = `/api/admin/v2/users/${encodeURIComponent(uid)}`;
    try {
      if (kind === 'block') {
        await adminCall(`${path}/block`, { method: 'POST', body: { reason: reason.trim() || null } });
        toast.success(`${who} is blocked. They can't sign in any more.`);
        onDone({ status: 'blocked' });
      } else if (kind === 'unblock') {
        await adminCall(`${path}/unblock`, { method: 'POST', body: {} });
        toast.success(`${who} is unblocked and can sign in again.`);
        onDone({ status: 'active' });
      } else if (kind === 'signout') {
        const r = await adminCall<{ revoked: number }>(`${path}/signout-all`, { method: 'POST', body: {} });
        toast.success(r.revoked ? `Signed ${who} out of ${r.revoked} device${r.revoked === 1 ? '' : 's'}.` : `${who} had no active sign-ins.`);
        onDone({});
      } else {
        await adminCall(path, { method: 'DELETE', body: { confirm: confirm.trim() } });
        toast.success(`Deleting ${who}. This takes a few minutes.`);
        onDone({ deleting: true });
      }
      setDialog(null); setReason(''); setConfirm('');
    } catch (e) {
      captureException(e, { where: 'admin2_user_action', action: kind, uid });
      if (errCode(e) === 'clerk_failed' && kind === 'block') { onDone({ status: 'blocked' }); setDialog(null); }
      toast.error(errMessage(e, 'That didn\'t work. Please try again.'));
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {blocked ? (
          <button type="button" className="hfa-btn tea" onClick={() => setDialog('unblock')}><ShieldOff className="h-4 w-4" /> Unblock</button>
        ) : (
          <button type="button" className="hfa-btn danger" onClick={() => setDialog('block')}><Ban className="h-4 w-4" /> Block</button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="hfa-btn ghost !whitespace-normal" onClick={() => setDialog('signout')}><LogOut className="h-4 w-4" /> Reset login (sign out all devices)</button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[280px] text-left leading-snug">
            {BRAND.name} has no passwords: people sign in with an email code or Google. This ends every session, so they must sign in again.
          </TooltipContent>
        </Tooltip>
        <button type="button" className="hfa-btn rani" onClick={() => setDialog('delete')}><Trash2 className="h-4 w-4" /> Delete user</button>
      </div>

      <AlertDialog open={dialog === 'block'} onOpenChange={(o) => !busy && setDialog(o ? 'block' : null)}>
        <AlertDialogContent className="hf-admin-operations rounded-[28px] border-0 border-t-[8px] border-t-[#d81b72] bg-[#fffaf3]">
          <AlertDialogHeader>
            <AlertDialogTitle>Block {who}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out everywhere, can't sign in again, and the app and website refuse their requests. Their bookings and payments stay. You can unblock them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor={`block-reason-${uid}`} className="grid gap-1 text-[14px] font-bold text-muted-foreground">
            Reason (optional, only admins see it)
            <textarea
              id={`block-reason-${uid}`}
              value={reason}
              maxLength={300}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-2xl border-[1.5px] border-[var(--a-line,#f1e3d6)] bg-white px-4 py-3 text-[14px] font-semibold text-[var(--a-ink,#2b1530)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]"
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="min-h-11 rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void run('block'); }} className="min-h-11 rounded-full bg-[#d81b72] text-white hover:bg-[#b3135c]">
              {busy ? <Loader2 className="animate-spin" /> : <Ban />} Block
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'unblock'} onOpenChange={(o) => !busy && setDialog(o ? 'unblock' : null)}>
        <AlertDialogContent className="hf-admin-operations rounded-[28px] border-0 border-t-[8px] border-t-[#0e7c86] bg-[#fffaf3]">
          <AlertDialogHeader>
            <AlertDialogTitle>Unblock {who}?</AlertDialogTitle>
            <AlertDialogDescription>They will be able to sign in and use {BRAND.name} again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="min-h-11 rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void run('unblock'); }} className="min-h-11 rounded-full">
              {busy ? <Loader2 className="animate-spin" /> : <ShieldOff />} Unblock
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'signout'} onOpenChange={(o) => !busy && setDialog(o ? 'signout' : null)}>
        <AlertDialogContent className="hf-admin-operations rounded-[28px] border-0 border-t-[8px] border-t-[#f59e0b] bg-[#fffaf3]">
          <AlertDialogHeader>
            <AlertDialogTitle>Sign {who} out of every device?</AlertDialogTitle>
            <AlertDialogDescription>
              {BRAND.name} has no passwords, so there is nothing to reset. This ends all their sign-ins on phones and browsers; they sign in again with an email code or Google. It can take up to a minute to take effect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="min-h-11 rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void run('signout'); }} className="min-h-11 rounded-full">
              {busy ? <Loader2 className="animate-spin" /> : <LogOut />} Sign out everywhere
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'delete'} onOpenChange={(o) => { if (busy) return; setDialog(o ? 'delete' : null); if (!o) setConfirm(''); }}>
        <AlertDialogContent className="hf-admin-operations rounded-[28px] border-0 border-t-[8px] border-t-[#d81b72] bg-[#fffaf3]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {who} permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This is permanent and can't be undone. Their account, profile, sign-in and personal data are erased straight away. Money records kept for the law stay without their name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor={`delete-confirm-${uid}`} className="grid gap-1 text-[14px] font-bold text-muted-foreground">
            Type {email ? 'their email' : 'their user ID'} to confirm: <span className="break-all font-extrabold text-foreground">{expected}</span>
            <Input
              className="h-11 rounded-full border-[1.5px] border-[var(--a-line,#f1e3d6)] bg-white px-4"
              id={`delete-confirm-${uid}`}
              value={confirm}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={expected}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="min-h-11 rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !confirmOk}
              onClick={(e) => { e.preventDefault(); if (confirmOk) void run('delete'); }}
              className="min-h-11 rounded-full bg-[#d81b72] text-white hover:bg-[#b3135c]"
            >
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
