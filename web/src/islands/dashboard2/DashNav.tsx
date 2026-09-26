/* DashNav — [DASH2-FOUNDATION 2026-09-25] Dashboard 2 navigation + auth guard.
 *
 * This island owns the page's SINGLE <ClerkProvider> (via ClerkIsland) — like
 * SidebarUser did for v1. Screen islands on the same page must NOT mount their
 * own ClerkIsland (two providers throw and the island renders nothing); they
 * read tokens with `getActiveTokenWaited()` from lib/clerk, which this
 * island's ClerkBridge feeds.
 *
 * Guard: signed-out → /sign-in?redirect_url=<here>. Signed-in but owing a
 * verified phone (Worker phoneOtpStatus) → the phone gate /sign-up?finish=1.
 * A stored guest token counts as signed in (same rule as v1).
 *
 * Layout (all three rendered, CSS picks one):
 *   ≥1024px  260px sidebar: diya logo, user card, menu with animated marker, Logout
 *   640–1023 72px icon rail with tooltips
 *   <640px   top bar + fixed bottom tab bar (5 tabs; Logout lives in Profile)
 */
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { capture, captureException } from '../../lib/analytics';
import { getPhoneStatus, finishUrl } from '../auth/passwordless';
import { signInUrlForHere } from '../../lib/authRedirect';
import { cn } from '../../lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { Skeleton } from '../../components/ui/skeleton';
import { DASH_NAV, DASH_LOGOUT, type DashKey } from './nav';

const GUEST_JWT_KEY = 'avatok_guest_jwt';
const GUEST_HANDLE_KEY = 'avatok_guest_handle';
const LANDED_KEY = 'dash2_landed_sid';

interface Who { name: string; email: string | null; photo: string | null }

function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'S';
}

/** dash2_login_landed — once per Clerk session (i.e. the first dashboard load after a login). */
function markLanded(sessionKey: string, active: DashKey) {
  if (lsGet(LANDED_KEY) === sessionKey) return;
  try { localStorage.setItem(LANDED_KEY, sessionKey); } catch { /* storage blocked */ }
  capture('dash2_login_landed', { screen: active, path: location.pathname });
}

/** Phone gate: an account that still owes a verified phone finishes sign-up first. */
async function phoneGate(): Promise<boolean> {
  try {
    const st = await getPhoneStatus();
    if (st.needs_phone) {
      location.replace(finishUrl(location.pathname + location.search));
      return false;
    }
  } catch (err) {
    // Same rule as SignUpIsland: a failed status read lets the person in
    // (bootstrap still refuses an unverified phone server-side). Recorded.
    captureException(err, { where: 'dash2_phone_gate' });
  }
  return true;
}

function useGuard(active: DashKey): { ready: boolean; who: Who | null } {
  const { isLoaded, isSignedIn, sessionId } = useAuth();
  const { user } = useUser();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn && !lsGet(GUEST_JWT_KEY)) {
      location.replace(signInUrlForHere());
      return;
    }
    let cancelled = false;
    void (async () => {
      if (isSignedIn && !(await phoneGate())) return;
      if (cancelled) return;
      setReady(true);
      markLanded(sessionId ?? `guest:${lsGet(GUEST_JWT_KEY)?.slice(-12) ?? ''}`, active);
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, sessionId, active]);

  if (!ready) return { ready, who: null };
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const name = user?.fullName || user?.firstName || (email ?? '').split('@')[0] || lsGet(GUEST_HANDLE_KEY) || 'Devotee';
  return { ready, who: { name, email, photo: user?.imageUrl ?? null } };
}

function useGuestGuard(): { ready: boolean; who: Who | null } {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (lsGet(GUEST_JWT_KEY)) setReady(true);
    else location.replace(signInUrlForHere());
  }, []);
  return { ready, who: ready ? { name: lsGet(GUEST_HANDLE_KEY) || 'Guest', email: null, photo: null } : null };
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

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <a href="/" className="flex items-center gap-2.5 no-underline" aria-label="Saa Thum home">
      <img src="/diya-logo.png" alt="" width={36} height={36} className="h-9 w-9 object-contain" />
      {!compact && <span className="font-dash text-[20px] font-bold tracking-[0.02em] text-grand-teal">Saa Thum</span>}
    </a>
  );
}

function Sidebar({ active, who, ready }: { active: DashKey; who: Who | null; ready: boolean }) {
  const reduce = useReducedMotion();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--dash-sidebar-w,260px)] flex-col border-r border-border/50 bg-card px-4 py-5 lg:flex">
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

      <nav aria-label="Dashboard" className="mt-6 flex flex-1 flex-col gap-1">
        {DASH_NAV.map((it) => {
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
                  layoutId="dash2-active"
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

      <a
        href={DASH_LOGOUT.href}
        className="mt-4 flex min-h-[44px] items-center gap-3 rounded-lg border border-border/50 px-3 text-[15px] font-bold text-primary no-underline transition-colors hover:bg-primary/10"
      >
        <DASH_LOGOUT.icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
        {DASH_LOGOUT.label}
      </a>
    </aside>
  );
}

function Rail({ active }: { active: DashKey }) {
  const items = [...DASH_NAV.map((i) => ({ ...i, logout: false })), { key: 'logout', label: DASH_LOGOUT.label, short: '', href: DASH_LOGOUT.href, icon: DASH_LOGOUT.icon, logout: true }];
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--dash-rail-w,72px)] flex-col items-center border-r border-border/50 bg-card py-4 sm:flex lg:hidden">
      <Logo compact />
      <TooltipProvider delayDuration={150}>
        <nav aria-label="Dashboard" className="mt-6 flex flex-1 flex-col items-center gap-2">
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
                      'relative flex h-12 w-12 items-center justify-center rounded-xl no-underline transition-colors',
                      it.logout && 'mt-auto text-primary hover:bg-primary/10',
                      !it.logout && (on ? 'bg-accent text-accent-foreground shadow-[var(--dash-shadow,none)]' : 'text-foreground/75 hover:bg-muted hover:text-foreground'),
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

function PhoneBars({ active, who }: { active: DashKey; who: Who | null }) {
  const reduce = useReducedMotion();
  return (
    <>
      <header
        className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-border/50 px-4 pt-[env(safe-area-inset-top,0px)] sm:hidden"
        style={{ background: 'hsl(var(--card) / 0.92)', backdropFilter: 'blur(10px)', height: 'calc(var(--dash-topbar-h) + env(safe-area-inset-top, 0px))' }}
      >
        <Logo />
        <a href="/dashboard/profile" aria-label="Profile" className="flex h-11 w-11 items-center justify-center rounded-full no-underline">
          <UserAvatar who={who} size="h-9 w-9" />
        </a>
      </header>
      <nav
        aria-label="Dashboard"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border/50 px-1 pb-[env(safe-area-inset-bottom,0px)] sm:hidden"
        style={{ background: 'hsl(var(--card) / 0.96)', backdropFilter: 'blur(10px)' }}
      >
        {DASH_NAV.map((it) => {
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
                  layoutId="dash2-tab"
                  aria-hidden
                  className="absolute top-0 h-[3px] w-10 rounded-b-full bg-grand-gold"
                  initial={reduce ? false : { opacity: 0, scaleX: 0.4 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 30 }}
                />
              )}
              <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2.4 : 2} />
              <span className="leading-none">{it.short}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}

function Shell({ active, guard }: { active: DashKey; guard: { ready: boolean; who: Who | null } }) {
  return (
    <>
      <Sidebar active={active} who={guard.who} ready={guard.ready} />
      <Rail active={active} />
      <PhoneBars active={active} who={guard.who} />
    </>
  );
}

function ClerkShell({ active }: { active: DashKey }) {
  return <Shell active={active} guard={useGuard(active)} />;
}
function GuestShell({ active }: { active: DashKey }) {
  return <Shell active={active} guard={useGuestGuard()} />;
}

export default function DashNav({ active }: { active: DashKey }) {
  return <ClerkIsland>{CLERK_PUBLISHABLE_KEY ? <ClerkShell active={active} /> : <GuestShell active={active} />}</ClerkIsland>;
}
