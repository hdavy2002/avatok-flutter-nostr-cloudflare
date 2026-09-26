/* Users — [ADMIN2-USERS 2026-09-26] Every Saa Thum account.
 * GET /api/admin/v2/users?q&filter&sort&joined_from&joined_to&cursor(&format=csv)
 * Clicking a row opens a panel DIRECTLY BELOW it (animated height, one at a time, URL ?user=<uid>)
 * with the full profile, money, bookings, payments and the account actions:
 *   Block / Unblock          POST /api/admin/v2/users/:uid/{block,unblock}
 *   Reset login              POST /api/admin/v2/users/:uid/signout-all  (there are NO passwords:
 *                            sign-in is an email code or Google, so "reset" = end every session)
 *   Delete user              DELETE /api/admin/v2/users/:uid {confirm: email}
 * Actions are never shown for admins or for yourself (the worker refuses them too). */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Ban, CalendarClock, ChevronDown, ExternalLink, Home, IndianRupee, Info, Languages, Loader2, LogOut, Mail, Phone,
  ShieldCheck, ShieldOff, Trash2, UserRound, Wallet,
} from 'lucide-react';
import { captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { istDate, istDateTime, errMessage, errCode } from './adminApi';
import {
  CopyValue, DateField, Empty, ErrorBox, ExportButton, FilterBar, ListSkeleton, LoadMore, SearchBox, StatusPill, TD, TH, Tile,
  adminCall, dayMs, formatPaise, phoneText, usePaged, useUrlFilters,
} from './peopleKit';

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

function UserAvatar({ u, size = 'h-10 w-10' }: { u: { name: string | null; email: string | null; photo_url?: string | null }; size?: string }) {
  return (
    <Avatar className={size}>
      {u.photo_url ? <AvatarImage src={u.photo_url} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback>{initials(u)}</AvatarFallback>
    </Avatar>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <Badge variant="accent" className="whitespace-nowrap text-[11px]"><ShieldCheck className="h-3 w-3" />Verified</Badge>
    : <Badge variant="muted" className="whitespace-nowrap text-[11px]">Not verified</Badge>;
}

function StatusBadge({ u }: { u: Pick<UserItem, 'status' | 'deleting' | 'is_admin'> }) {
  if (u.deleting) return <Badge variant="muted" className="whitespace-nowrap">Deleting</Badge>;
  if (u.status === 'blocked') return <Badge variant="destructive" className="whitespace-nowrap"><Ban className="h-3 w-3" />Blocked</Badge>;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline" className="whitespace-nowrap">Active</Badge>
      {u.is_admin && <Badge variant="secondary" className="whitespace-nowrap">Admin</Badge>}
    </span>
  );
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
      <dt className="flex shrink-0 items-center gap-1.5 text-[13px] font-bold text-muted-foreground">{icon}{label}</dt>
      <dd className="min-w-0 text-right text-[14px] font-semibold text-foreground sm:text-left">{children}</dd>
    </div>
  );
}

const None = () => <span className="text-muted-foreground">—</span>;

function useIsDesktop(): boolean {
  const [d, setD] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 768px)');
    const on = () => setD(m.matches);
    on(); m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return d;
}

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
  const desktop = useIsDesktop();

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

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
        <FilterBar
          title="Filter users"
          count={count}
          onClear={clear}
          resultLabel={list.phase === 'ready' ? `Show ${list.items.length}${list.cursor ? '+' : ''}` : 'Show'}
          search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search users" placeholder="Name, email or phone" />}
        >
          <div role="group" aria-label="Filters" className="flex flex-wrap gap-2">
            {FILTERS.map((x) => (
              <button
                key={x.key}
                type="button"
                aria-pressed={on.has(x.key)}
                onClick={() => flip(x.key)}
                className={cn(
                  'inline-flex h-9 items-center rounded-full border px-3 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on.has(x.key) ? 'border-accent bg-accent text-accent-foreground' : 'border-border/70 bg-card text-foreground hover:bg-muted',
                )}
              >
                {x.label}
              </button>
            ))}
          </div>
          <DateField id="u-from" label="Joined from" value={f.joined_from} onChange={(v) => set({ joined_from: v })} />
          <DateField id="u-to" label="Joined to" value={f.joined_to} onChange={(v) => set({ joined_to: v })} />
          <label className="grid gap-1 text-[12px] font-bold text-muted-foreground">
            Sort
            <Select value={f.sort || 'joined'} onValueChange={(v) => set({ sort: v === 'joined' ? '' : v })}>
              <SelectTrigger className="h-11 w-[170px] font-semibold text-foreground" aria-label="Sort users"><SelectValue /></SelectTrigger>
              <SelectContent>{SORTS.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
        </FilterBar>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] font-semibold text-muted-foreground" aria-live="polite">
            {list.phase === 'loading' ? 'Loading…' : totals
              ? `${totals.users} user${totals.users === 1 ? '' : 's'} · ${formatPaise(totals.spent_paise)} spent · ${totals.verified} phone-verified · ${totals.blocked} blocked`
              : ''}
          </p>
          <ExportButton kind="users" path="/api/admin/v2/users" query={query} />
        </div>

        {open && !openInList && list.phase === 'ready' && (
          <div className="rounded-xl border border-grand-gold/60 bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border/50 px-4 py-2">
              <span className="text-[12.5px] font-bold text-muted-foreground">Opened from a link</span>
              <Button variant="ghost" size="sm" onClick={() => toggle(open)}>Close</Button>
            </div>
            <UserPanel uid={open} onChange={patch} />
          </div>
        )}

        {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load users.'} onRetry={list.reload} /> :
          list.items.length === 0 ? (
            <Empty title={q || count ? 'No user matches' : 'No users yet'} body={q ? 'Check the spelling, or try the full email or the full mobile number.' : 'People appear here once they create an account.'} />
          ) : desktop ? (
            <div className="overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm">
              <table className="w-full min-w-[980px] border-collapse">
                <thead className="bg-muted/60">
                  <tr>
                    <th className={TH}>User</th><th className={TH}>Phone</th><th className={TH}>Joined</th><th className={TH}>Last active</th>
                    <th className={`${TH} text-right`}>Bookings</th><th className={`${TH} text-right`}>Spent</th><th className={TH}>Status</th><th className="w-10" aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((u) => {
                    const isOpen = u.uid === open;
                    return [
                      <tr
                        key={u.uid}
                        className={cn('cursor-pointer border-t border-border/40 hover:bg-muted/30', isOpen && 'bg-muted/40')}
                        onClick={() => toggle(u.uid)}
                      >
                        <td className={`${TD} max-w-[300px]`}>
                          <div className="flex items-center gap-3">
                            <UserAvatar u={u} />
                            <div className="min-w-0">
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                aria-controls={`user-panel-${u.uid}`}
                                onClick={(e) => { e.stopPropagation(); toggle(u.uid); }}
                                className="text-left font-extrabold text-foreground underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {u.name ?? 'No name'}{u.is_self ? ' (you)' : ''}
                              </button>
                              {u.email && <div className="truncate text-[12.5px] font-semibold text-muted-foreground" title={u.email}>{u.email}</div>}
                            </div>
                          </div>
                        </td>
                        <td className={TD}>
                          <div className={cn('text-[13px] tabular-nums', u.phone_hash_only && 'italic text-muted-foreground')}>{phoneText(u) ?? <None />}</div>
                          <div className="mt-1"><VerifiedBadge verified={u.phone_verified} /></div>
                        </td>
                        <td className={`${TD} whitespace-nowrap text-[13px] text-muted-foreground`}>{istDate(u.joined_at)}</td>
                        <td className={`${TD} whitespace-nowrap text-[13px] text-muted-foreground`}>{u.last_active_at ? istDateTime(u.last_active_at) : '—'}</td>
                        <td className={`${TD} text-right tabular-nums`}>{u.bookings}</td>
                        <td className={`${TD} text-right font-extrabold tabular-nums`}>{formatPaise(u.spent_paise)}</td>
                        <td className={TD}><StatusBadge u={u} /></td>
                        <td className={`${TD} pr-3`}><ChevronDown aria-hidden className={cn('h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} /></td>
                      </tr>,
                      <tr key={`${u.uid}-panel`} className={cn(!mounted(u.uid) && 'hidden')}>
                        <td colSpan={8} className="p-0">
                          <Expander open={isOpen} id={`user-panel-${u.uid}`}>
                            {mounted(u.uid) && <div className="border-t border-border/40 bg-background/60"><UserPanel uid={u.uid} onChange={patch} /></div>}
                          </Expander>
                        </td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="space-y-3">
              {list.items.map((u) => {
                const isOpen = u.uid === open;
                return (
                  <li key={u.uid} className={cn('overflow-hidden rounded-xl border bg-card shadow-sm', isOpen ? 'border-grand-gold/70' : 'border-border/60')}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`user-panel-m-${u.uid}`}
                      onClick={() => toggle(u.uid)}
                      className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <UserAvatar u={u} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-extrabold text-foreground">{u.name ?? 'No name'}{u.is_self ? ' (you)' : ''}</span>
                          <StatusBadge u={u} />
                        </div>
                        {u.email && <div className="truncate text-[12.5px] font-semibold text-muted-foreground">{u.email}</div>}
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
                          <span className={cn('tabular-nums', u.phone_hash_only && 'italic')}>{phoneText(u) ?? 'No phone'}</span>
                          <VerifiedBadge verified={u.phone_verified} />
                        </div>
                        <div className="mt-1 text-[12.5px] font-bold text-foreground">
                          {u.bookings} booking{u.bookings === 1 ? '' : 's'} · {formatPaise(u.spent_paise)} · joined {istDate(u.joined_at)}
                        </div>
                      </div>
                      <ChevronDown aria-hidden className={cn('h-5 w-5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} />
                    </button>
                    {mounted(u.uid) && (
                      <Expander open={isOpen} id={`user-panel-m-${u.uid}`}>
                        <div className="border-t border-border/40 bg-background/60"><UserPanel uid={u.uid} onChange={patch} /></div>
                      </Expander>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        {list.phase === 'ready' && list.items.length > 0 && <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />}
      </div>
    </TooltipProvider>
  );
}

/* ── the panel under a row ─────────────────────────────────────────────── */

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
      <div className="flex items-center gap-2 p-6 text-[13px] font-semibold text-muted-foreground" aria-busy="true">
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

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <UserAvatar u={{ name: p.name, email: p.email, photo_url: p.photo_url }} size="h-14 w-14" />
        <div className="min-w-0 flex-1">
          <div className="font-dash text-[19px] font-bold leading-tight text-foreground">{p.name ?? 'No name'}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge u={{ status: a.status, deleting: a.deleting, is_admin: a.is_admin }} />
            <span className="text-[12px] font-semibold text-muted-foreground">ID</span>
            <CopyValue value={uid} label="user ID" className="text-[12px]" />
          </div>
        </div>
      </div>

      {a.status === 'blocked' && a.blocked && (
        <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] font-semibold text-foreground">
          Blocked {a.blocked.at ? istDateTime(a.blocked.at) : ''}{a.blocked.reason ? `: ${a.blocked.reason}` : ''}. They can't sign in, and the app and website refuse their requests.
        </p>
      )}
      {a.deleting && (
        <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-[13px] font-semibold text-foreground">
          This account is being deleted. It disappears from the list once the deletion finishes.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <section aria-label="Profile" className="rounded-xl border border-border/60 bg-card p-4">
          <h3 className="mb-1 font-dash text-[15px] font-bold text-foreground">Profile</h3>
          <dl className="divide-y divide-border/40">
            <Field label="Full name" icon={<UserRound className="h-3.5 w-3.5" />}>{p.name ?? <None />}</Field>
            <Field label="Email" icon={<Mail className="h-3.5 w-3.5" />}>
              {p.email ? <span className="break-all">{p.email}{a.clerk.email_verified ? <Badge variant="outline" className="ml-1.5 text-[10.5px]">verified</Badge> : null}</span> : <None />}
            </Field>
            <Field label="Phone" icon={<Phone className="h-3.5 w-3.5" />}>
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5 sm:justify-start">
                <span className={cn('tabular-nums', p.phone.hash_only && 'italic text-muted-foreground')}>{phoneText({ phone_masked: p.phone.masked, phone_hash_only: p.phone.hash_only }) ?? 'None'}</span>
                <VerifiedBadge verified={p.phone.verified} />
              </span>
            </Field>
            <Field label="UPI IDs" icon={<Wallet className="h-3.5 w-3.5" />}>
              {p.vpas.length ? p.vpas.map((v) => <div key={v.id} className="break-all">{v.vpa}{v.is_default ? <span className="ml-1 text-[12px] text-muted-foreground">(default)</span> : null}</div>) : <None />}
            </Field>
            <Field label="Prasad address" icon={<Home className="h-3.5 w-3.5" />}>{addr || <None />}</Field>
            <Field label="Gotra">{p.gotra ?? <None />}</Field>
            <Field label="Language" icon={<Languages className="h-3.5 w-3.5" />}>{p.language ? (LANG[p.language] ?? p.language) : <None />}</Field>
            <Field label="Joined" icon={<CalendarClock className="h-3.5 w-3.5" />}>{p.joined_at ? istDateTime(p.joined_at) : a.clerk.created_at ? istDateTime(a.clerk.created_at) : '—'}</Field>
            <Field label="Last sign-in">{a.clerk.last_sign_in_at ? istDateTime(a.clerk.last_sign_in_at) : <None />}</Field>
            <Field label="Last active">{a.clerk.last_active_at ? istDateTime(a.clerk.last_active_at) : <None />}</Field>
          </dl>
          {!a.clerk.found && <p className="mt-2 text-[12px] font-semibold text-muted-foreground">Sign-in details couldn't be loaded right now.</p>}
        </section>

        <div className="space-y-5">
          <section aria-label="Money" className="grid grid-cols-2 gap-3">
            <Tile label="Total spent" tone="accent" value={formatPaise(m.spent_paise)} hint="GST included, after refunds" />
            <Tile label="Payments" value={m.payments} hint={`${m.bookings} seat${m.bookings === 1 ? '' : 's'} held`} />
            <Tile label="Refunds" tone={m.refunds ? 'amber' : undefined} value={m.refunds} hint={m.refunds ? `${formatPaise(m.refunded_paise)} sent back` : 'None'} />
            <Tile label="Pending" tone={m.pending ? 'gold' : undefined} value={m.pending} hint={m.pending ? `${formatPaise(m.pending_paise)} waiting` : 'None'} />
          </section>

          <section aria-label="Actions" className="rounded-xl border border-border/60 bg-card p-4">
            <h3 className="mb-2 font-dash text-[15px] font-bold text-foreground">Account actions</h3>
            {canAct ? (
              <Actions uid={uid} email={p.email} name={p.name} blocked={a.status === 'blocked'} onDone={(patch) => { onChange(uid, patch); void load(); }} />
            ) : (
              <p className="flex items-start gap-1.5 text-[13px] font-semibold text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {a.is_self ? 'This is your own account. Actions are hidden.' : a.is_admin ? 'This is an admin account. Admins can\'t be blocked, signed out or deleted here.' : 'No actions while the account is being deleted.'}
              </p>
            )}
          </section>
        </div>
      </div>

      <section aria-label="Bookings" className="rounded-xl border border-border/60 bg-card p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-dash text-[15px] font-bold text-foreground">Bookings</h3>
          <a href={`/admin/bookings?q=${encodeURIComponent(p.email ?? uid)}`} className="inline-flex items-center gap-1 text-[12.5px] font-bold text-accent no-underline hover:underline">All in Bookings <ExternalLink className="h-3 w-3" /></a>
        </div>
        {d.bookings.length === 0 ? <p className="text-[13px] font-semibold text-muted-foreground">No bookings yet.</p> : (
          <div className="grid gap-4 md:grid-cols-2">
            <BookingList title="Upcoming" items={upcoming} />
            <BookingList title="Past" items={past.slice(0, 10)} more={past.length > 10 ? past.length - 10 : 0} />
          </div>
        )}
      </section>

      <section aria-label="Recent payments" className="rounded-xl border border-border/60 bg-card p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-dash text-[15px] font-bold text-foreground">Recent payments</h3>
          <a href={`/admin/payments?q=${encodeURIComponent(p.email ?? uid)}`} className="inline-flex items-center gap-1 text-[12.5px] font-bold text-accent no-underline hover:underline">All in Payments <ExternalLink className="h-3 w-3" /></a>
        </div>
        {d.payments.length === 0 ? <p className="text-[13px] font-semibold text-muted-foreground">No payments yet.</p> : (
          <ul className="divide-y divide-border/40">
            {d.payments.slice(0, 8).map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <a href={`/admin/payments?q=${encodeURIComponent(x.id)}`} className="min-w-0 flex-1 truncate text-[14px] font-bold text-foreground no-underline hover:text-accent hover:underline">{x.event_title ?? x.listing_id}</a>
                <span className="text-[12.5px] font-semibold text-muted-foreground">{istDateTime(x.paid_at ?? x.created_at)}</span>
                {x.utr && <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">UTR {x.utr}</span>}
                <span className="font-extrabold tabular-nums"><IndianRupee className="sr-only" />{formatPaise(x.amount_paise)}</span>
                <StatusPill status={x.status} />
              </li>
            ))}
          </ul>
        )}
        {d.refunds.length > 0 && (
          <a href="/admin/refunds" className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-accent no-underline hover:underline">
            {d.refunds.length} refund request{d.refunds.length === 1 ? '' : 's'} in Refunds <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </section>
    </div>
  );
}

function BookingList({ title, items, more = 0 }: { title: string; items: Booking[]; more?: number }) {
  return (
    <div>
      <h4 className="mb-1 text-[12px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">{title}</h4>
      {items.length === 0 ? <p className="text-[13px] font-semibold text-muted-foreground">None.</p> : (
        <ul className="divide-y divide-border/40">
          {items.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
              <a href={`/admin/events/${encodeURIComponent(b.listing_id)}`} className="min-w-0 flex-1 truncate text-[14px] font-bold text-foreground no-underline hover:text-accent hover:underline">{b.event_title ?? b.listing_id}</a>
              <span className="text-[12.5px] font-semibold text-muted-foreground">{b.event_starts_at ? istDateTime(b.event_starts_at) : '—'}</span>
              <StatusPill status={b.status} />
              <a href={`/admin/bookings?event=${encodeURIComponent(b.listing_id)}`} className="text-[12px] font-bold text-accent no-underline hover:underline">Seats</a>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="mt-1 text-[12px] font-semibold text-muted-foreground">and {more} more in Bookings</p>}
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
          <Button variant="outline" onClick={() => setDialog('unblock')}><ShieldOff /> Unblock</Button>
        ) : (
          <Button variant="outline" onClick={() => setDialog('block')}><Ban /> Block</Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" onClick={() => setDialog('signout')}><LogOut /> Reset login (sign out all devices)</Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[280px] text-left leading-snug">
            Saa Thum has no passwords: people sign in with an email code or Google. This ends every session, so they must sign in again.
          </TooltipContent>
        </Tooltip>
        <Button variant="destructive" onClick={() => setDialog('delete')}><Trash2 /> Delete user</Button>
      </div>

      <AlertDialog open={dialog === 'block'} onOpenChange={(o) => !busy && setDialog(o ? 'block' : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Block {who}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out everywhere, can't sign in again, and the app and website refuse their requests. Their bookings and payments stay. You can unblock them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor={`block-reason-${uid}`} className="grid gap-1 text-[13px] font-bold text-muted-foreground">
            Reason (optional, only admins see it)
            <textarea
              id={`block-reason-${uid}`}
              value={reason}
              maxLength={300}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-[14px] font-semibold text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void run('block'); }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {busy ? <Loader2 className="animate-spin" /> : <Ban />} Block
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'unblock'} onOpenChange={(o) => !busy && setDialog(o ? 'unblock' : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unblock {who}?</AlertDialogTitle>
            <AlertDialogDescription>They will be able to sign in and use Saa Thum again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void run('unblock'); }}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldOff />} Unblock
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'signout'} onOpenChange={(o) => !busy && setDialog(o ? 'signout' : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign {who} out of every device?</AlertDialogTitle>
            <AlertDialogDescription>
              Saa Thum has no passwords, so there is nothing to reset. This ends all their sign-ins on phones and browsers; they sign in again with an email code or Google. It can take up to a minute to take effect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void run('signout'); }}>
              {busy ? <Loader2 className="animate-spin" /> : <LogOut />} Sign out everywhere
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'delete'} onOpenChange={(o) => { if (busy) return; setDialog(o ? 'delete' : null); if (!o) setConfirm(''); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {who} permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This is permanent and can't be undone. Their account, profile, sign-in and personal data are erased straight away. Money records kept for the law stay without their name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor={`delete-confirm-${uid}`} className="grid gap-1 text-[13px] font-bold text-muted-foreground">
            Type {email ? 'their email' : 'their user ID'} to confirm: <span className="break-all font-extrabold text-foreground">{expected}</span>
            <Input
              id={`delete-confirm-${uid}`}
              value={confirm}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={expected}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !confirmOk}
              onClick={(e) => { e.preventDefault(); if (confirmOk) void run('delete'); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
