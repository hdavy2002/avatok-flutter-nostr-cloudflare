/* AdminNav — [ADMIN2-SHELL 2026-09-26] Admin 2 navigation + admin guard.
 *
 * Same shell as Dashboard 2 (islands/dashboard2/DashNav.tsx): this island owns
 * the page's SINGLE <ClerkProvider>. Screen islands must NOT mount their own
 * ClerkIsland; they call adminApi() from ./adminApi, which waits for this
 * island's verdict and reads the token through getActiveTokenWaited().
 *
 * Guard: signed-out → /sign-in?redirect_url=<here>. Signed-in → probe
 * GET /api/admin/whoami: 200 → the page shows; 403 → the layout's "You don't
 * have admin access" card; 401 → sign in again; anything else → a retry card.
 * The verdict lands on [data-admin2-root][data-admin2-state] (CSS in Admin2.astro).
 *
 * Layout (all three rendered, CSS picks one):
 *   ≥1024px  260px sidebar: logo + ADMIN badge, admin card, menu, View site, Logout
 *   640–1023 72px icon rail with tooltips
 *   <640px   top bar + fixed bottom tab bar (5 tabs + "More" sheet)
 */
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth, useUser } from '@clerk/clerk-react';
import { MoreHorizontal } from 'lucide-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { captureException } from '../../lib/analytics';
import { request } from '../../lib/apiClient';
import { signInUrlForHere } from '../../lib/authRedirect';
import { cn } from '../../lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { Skeleton } from '../../components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '../../components/ui/sheet';
import { ADMIN_NAV, ADMIN_PHONE_TABS, ADMIN_VIEW_SITE, ADMIN_LOGOUT, type AdminKey } from './nav';
import { ApiError, adminToken, setAdminGate, type AdminGate, type AdminWho } from './adminApi';

interface Who { name: string; email: string | null; photo: string | null }

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'A';
}

/** GET /api/admin/whoami → the gate verdict. */
async function probe(): Promise<{ gate: AdminGate | 'signin'; me: AdminWho | null }> {
  const auth = await adminToken();
  if (!auth) return { gate: 'signin', me: null };
  try {
    const me = await request<AdminWho>('/api/admin/whoami', { auth, timeoutMs: 15_000 });
    return { gate: me?.admin ? 'ok' : 'denied', me: me?.admin ? me : null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return { gate: 'denied', me: null };
    if (e instanceof ApiError && e.status === 401) return { gate: 'signin', me: null };
    captureException(e, { where: 'admin2_whoami' });
    return { gate: 'error', me: null };
  }
}

function useAdminGuard(): { ready: boolean; who: Who | null } {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { location.replace(signInUrlForHere()); return; }
    let cancelled = false;
    void (async () => {
      const r = await probe();
      if (cancelled) return;
      if (r.gate === 'signin') { location.replace(signInUrlForHere()); return; }
      setAdminGate(r.gate, r.me);
      setReady(r.gate === 'ok');
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn]);

  if (!ready) return { ready, who: null };
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const name = user?.fullName || user?.firstName || (email ?? '').split('@')[0] || 'Admin';
  return { ready, who: { name, email, photo: user?.imageUrl ?? null } };
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function UserAvatar({ who, size = 'h-10 w-10' }: { who: Who | null; size?: string }) {
  return (
    <Avatar className={size}>
      {who?.photo && <AvatarImage src={who.photo} alt="" />}
      <AvatarFallback>{who ? initials(who.name) : ''}</AvatarFallback>
    </Avatar>
  );
}

function AdminBadge({ className }: { className?: string }) {
  return (
    <span className={cn('rounded-full bg-grand-teal px-2 py-0.5 font-dashbody text-[10.5px] font-extrabold uppercase leading-[1.4] tracking-[0.12em] text-primary-foreground', className)}>
      Admin
    </span>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <a href="/admin" className="flex items-center gap-2.5 no-underline" aria-label="Saa Thum admin home">
      <img src="/diya-logo.png" alt="" width={36} height={36} className="h-9 w-9 object-contain" />
      {!compact && <span className="font-dash text-[20px] font-bold tracking-[0.02em] text-grand-teal">Saa Thum</span>}
      {!compact && <AdminBadge />}
    </a>
  );
}

function Sidebar({ active, who, ready }: { active: AdminKey; who: Who | null; ready: boolean }) {
  const reduce = useReducedMotion();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--dash-sidebar-w,260px)] flex-col overflow-y-auto border-r border-border/50 bg-card px-4 py-5 lg:flex">
      <div className="px-2"><Logo /></div>

      <div className="mt-6 rounded-xl border border-border/50 bg-background p-3 shadow-[var(--dash-shadow,none)]">
        {ready && who ? (
          <div className="flex items-center gap-3">
            <UserAvatar who={who} />
            <div className="min-w-0">
              <div className="truncate font-dash text-[15px] font-bold text-foreground">{who.name}</div>
              {who.email && <div className="truncate text-[12.5px] font-semibold text-muted-foreground">{who.email}</div>}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>
          </div>
        )}
      </div>

      <nav aria-label="Admin" className="mt-6 flex flex-1 flex-col gap-1">
        {ADMIN_NAV.map((it) => {
          const on = it.key === active;
          const Icon = it.icon;
          return (
            <a
              key={it.key}
              href={it.href}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'group relative flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-[15px] font-bold no-underline transition-colors',
                on ? 'text-accent-foreground' : 'text-foreground/80 hover:bg-muted hover:text-foreground',
              )}
            >
              {on && (
                <motion.span
                  layoutId="admin2-active"
                  className="absolute inset-0 rounded-lg bg-accent shadow-[var(--dash-shadow,none)]"
                  initial={reduce ? false : { opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              {on && <span aria-hidden className="absolute -left-4 top-2 bottom-2 w-1 rounded-r-full bg-grand-gold" />}
              <Icon className="relative h-[18px] w-[18px] shrink-0" strokeWidth={2.2} />
              <span className="relative">{it.label}</span>
            </a>
          );
        })}
      </nav>

      <div className="mt-4 flex flex-col gap-2">
        <a
          href={ADMIN_VIEW_SITE.href}
          className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-[15px] font-bold text-foreground/80 no-underline transition-colors hover:bg-muted hover:text-foreground"
        >
          <ADMIN_VIEW_SITE.icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
          {ADMIN_VIEW_SITE.label}
        </a>
        <a
          href={ADMIN_LOGOUT.href}
          className="flex min-h-[44px] items-center gap-3 rounded-lg border border-border/50 px-3 text-[15px] font-bold text-primary no-underline transition-colors hover:bg-primary/10"
        >
          <ADMIN_LOGOUT.icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
          {ADMIN_LOGOUT.label}
        </a>
      </div>
    </aside>
  );
}

function Rail({ active }: { active: AdminKey }) {
  const items = [
    ...ADMIN_NAV.map((i) => ({ key: i.key as string, label: i.label, href: i.href, icon: i.icon, tail: false, first: false })),
    { key: 'site', label: ADMIN_VIEW_SITE.label, href: ADMIN_VIEW_SITE.href, icon: ADMIN_VIEW_SITE.icon, tail: true, first: true },
    { key: 'logout', label: ADMIN_LOGOUT.label, href: ADMIN_LOGOUT.href, icon: ADMIN_LOGOUT.icon, tail: true, first: false },
  ];
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--dash-rail-w,72px)] flex-col items-center overflow-y-auto border-r border-border/50 bg-card py-4 sm:flex lg:hidden">
      <Logo compact />
      <AdminBadge className="mt-2 px-1.5 text-[9px]" />
      <TooltipProvider delayDuration={150}>
        <nav aria-label="Admin" className="mt-5 flex flex-1 flex-col items-center gap-2">
          {items.map((it) => {
            const on = it.key === active;
            const Icon = it.icon;
            return (
              <Tooltip key={it.key}>
                <TooltipTrigger asChild>
                  <a
                    href={it.href}
                    aria-label={it.label}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl no-underline transition-colors',
                      it.first && 'mt-auto',
                      it.key === 'logout' && 'text-primary hover:bg-primary/10',
                      it.key === 'site' && 'text-foreground/75 hover:bg-muted hover:text-foreground',
                      !it.tail && (on ? 'bg-accent text-accent-foreground shadow-[var(--dash-shadow,none)]' : 'text-foreground/75 hover:bg-muted hover:text-foreground'),
                    )}
                  >
                    <Icon className="h-5 w-5" strokeWidth={2.2} />
                    {on && <span aria-hidden className="absolute -left-3 top-2 bottom-2 w-1 rounded-r-full bg-grand-gold" />}
                  </a>
                </TooltipTrigger>
                <TooltipContent side="right">{it.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
      </TooltipProvider>
    </aside>
  );
}

function MoreSheet({ active, who }: { active: AdminKey; who: Who | null }) {
  const rest = ADMIN_NAV.filter((i) => !ADMIN_PHONE_TABS.includes(i.key));
  const on = rest.some((i) => i.key === active);
  const row = 'flex min-h-[52px] items-center gap-3 rounded-xl px-3 text-[16px] font-bold no-underline transition-colors';
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="More admin pages"
          className={cn(
            'relative flex h-[var(--dash-tabbar-h,64px)] min-w-[44px] flex-col items-center justify-center gap-1 bg-transparent text-[11px] font-bold',
            on ? 'text-accent' : 'text-muted-foreground',
          )}
        >
          {on && <span aria-hidden className="absolute top-0 h-[3px] w-10 rounded-b-full bg-grand-gold" />}
          <MoreHorizontal className="h-[22px] w-[22px]" strokeWidth={on ? 2.4 : 2} />
          <span className="leading-none">More</span>
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2 font-dash text-grand-teal">More <AdminBadge /></SheetTitle>
          <SheetDescription>{who?.email ?? 'Saa Thum admin'}</SheetDescription>
        </SheetHeader>
        <nav aria-label="More admin pages" className="mt-4 flex flex-col gap-1">
          {rest.map((it) => {
            const Icon = it.icon;
            const cur = it.key === active;
            return (
              <a key={it.key} href={it.href} aria-current={cur ? 'page' : undefined}
                className={cn(row, cur ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted')}>
                <Icon className="h-5 w-5" strokeWidth={2.2} />{it.label}
              </a>
            );
          })}
          <div className="my-2 h-px bg-border/60" aria-hidden />
          <a href={ADMIN_VIEW_SITE.href} className={cn(row, 'text-foreground hover:bg-muted')}>
            <ADMIN_VIEW_SITE.icon className="h-5 w-5" strokeWidth={2.2} />{ADMIN_VIEW_SITE.label}
          </a>
          <a href={ADMIN_LOGOUT.href} className={cn(row, 'text-primary hover:bg-primary/10')}>
            <ADMIN_LOGOUT.icon className="h-5 w-5" strokeWidth={2.2} />{ADMIN_LOGOUT.label}
          </a>
        </nav>
      </SheetContent>
    </Sheet>
  );
}

function PhoneBars({ active, who }: { active: AdminKey; who: Who | null }) {
  const reduce = useReducedMotion();
  const tabs = ADMIN_NAV.filter((i) => ADMIN_PHONE_TABS.includes(i.key));
  return (
    <>
      <header
        className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-border/50 px-4 pt-[env(safe-area-inset-top,0px)] sm:hidden"
        style={{ background: 'hsl(var(--card) / 0.92)', backdropFilter: 'blur(10px)', height: 'calc(var(--dash-topbar-h) + env(safe-area-inset-top, 0px))' }}
      >
        <Logo />
        <span className="flex h-11 w-11 items-center justify-center rounded-full" aria-hidden>
          <UserAvatar who={who} size="h-9 w-9" />
        </span>
      </header>
      <nav
        aria-label="Admin"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-border/50 px-1 pb-[env(safe-area-inset-bottom,0px)] sm:hidden"
        style={{ background: 'hsl(var(--card) / 0.96)', backdropFilter: 'blur(10px)' }}
      >
        {tabs.map((it) => {
          const on = it.key === active;
          const Icon = it.icon;
          return (
            <a
              key={it.key}
              href={it.href}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'relative flex h-[var(--dash-tabbar-h,64px)] min-w-[44px] flex-col items-center justify-center gap-1 text-[11px] font-bold no-underline',
                on ? 'text-accent' : 'text-muted-foreground',
              )}
            >
              {on && (
                <motion.span
                  layoutId="admin2-tab"
                  aria-hidden
                  className="absolute top-0 h-[3px] w-10 rounded-b-full bg-grand-gold"
                  initial={reduce ? false : { opacity: 0, scaleX: 0.4 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 30 }}
                />
              )}
              <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2.4 : 2} />
              <span className="max-w-full truncate px-0.5 leading-none">{it.short}</span>
            </a>
          );
        })}
        <MoreSheet active={active} who={who} />
      </nav>
    </>
  );
}

function Shell({ active, guard }: { active: AdminKey; guard: { ready: boolean; who: Who | null } }) {
  return (
    <>
      <Sidebar active={active} who={guard.who} ready={guard.ready} />
      <Rail active={active} />
      <PhoneBars active={active} who={guard.who} />
    </>
  );
}

function ClerkShell({ active }: { active: AdminKey }) {
  return <Shell active={active} guard={useAdminGuard()} />;
}

/** No Clerk key (local build without auth): nobody can be an admin. */
function NoAuthShell({ active }: { active: AdminKey }) {
  useEffect(() => { setAdminGate('denied'); }, []);
  return <Shell active={active} guard={{ ready: false, who: null }} />;
}

export default function AdminNav({ active }: { active: AdminKey }) {
  return <ClerkIsland>{CLERK_PUBLISHABLE_KEY ? <ClerkShell active={active} /> : <NoAuthShell active={active} />}</ClerkIsland>;
}
