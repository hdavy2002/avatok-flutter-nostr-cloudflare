import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/* HeaderCtas — the auth-aware right side of the site header (replicates the
 * old site's SiteHeader CTAs). Signed-in: a wallet pill (balance → /dashboard/
 * wallet) + "Open studio" (→ /dashboard) + Sign out. Signed-out: Log in + Sign
 * up. Wrapped in ClerkIsland so it reads the live session; degrades to Log in /
 * Sign up when the session can't be read.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { request } from '../../lib/apiClient';
import type { WalletBalance } from '../checkout/types';
// [WEB-POSTHOG-1] §2.9 nav_click. Contract: Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md §2.9.
import { capture } from '../../lib/analytics';

function navClick(item: string) {
  capture('nav_click', { item });
}

const ghost =
  'rounded-full border-zine border-ink bg-card px-4 py-2 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine';
const primary =
  'rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine';

function WalletPill() {
  const {t:uiT}=useUiTranslation("web-site");

  const [bal, setBal] = useState<number | null>(null);
  useEffect(() => {
    void (async () => {
      const t = await getActiveToken();
      if (!t) return;
      try {
        const r = await request<WalletBalance>('/api/wallet/balance', { auth: t });
        setBal(Math.trunc(Number(r.balance ?? 0)));
      } catch {
        /* ignore */
      }
    })();
  }, []);
  return (
    <a href="/dashboard/wallet" className={`${ghost} flex items-center gap-2`} aria-label={uiT("web-site.2e7ab90ac60c447d","Wallet balance")} title={uiT("web-site.d1c9a01d57e90086","Wallet")} onClick={() => navClick('wallet')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="6" width="20" height="14" rx="3" />
        <path d="M2 10h20" />
        <circle cx="17" cy="15" r="1.25" fill="currentColor" stroke="none" />
      </svg>
      <span>{bal != null ? bal.toLocaleString() : '—'}</span>
    </a>
  );
}

function Authed({ onSignOut }: { onSignOut: () => void }) {
  return (
    <>
      <WalletPill />
      <a href="/dashboard" className={primary} onClick={() => navClick('open_studio')}><UiText id="web-site.730a9d80c097a1cc" source="Open studio" /></a>
      <button
        type="button"
        onClick={() => {
          navClick('sign_out');
          onSignOut();
        }}
        className={ghost}
      ><UiText id="web-site.48f0d3d397d49f13" source="Sign out" />{" "}</button>
    </>
  );
}

function Anon() {
  return (
    <>
      <a href="/sign-in" className={ghost} onClick={() => navClick('log_in')}><UiText id="web-site.c189840cf7e2d6f6" source="Log in" /></a>
      <a href="/sign-up" className={primary} onClick={() => navClick('sign_up')}><UiText id="web-site.5e2b8e96503d722e" source="Sign up" /></a>
    </>
  );
}

function Inner() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const [hasGuest, setHasGuest] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    try {
      setHasGuest(!!localStorage.getItem('avatok_guest_jwt'));
    } catch {
      /* ignore */
    }
    setChecked(true);
  }, []);

  // Avoid a flash: wait until Clerk loaded and the guest check ran.
  if (!isLoaded || !checked) return <div className="h-9 w-[120px]" />;

  const authed = isSignedIn || hasGuest;
  if (!authed) return <Anon />;
  return (
    <Authed
      onSignOut={async () => {
        try {
          localStorage.removeItem('avatok_guest_jwt');
        } catch {
          /* ignore */
        }
        try {
          await signOut();
        } catch {
          /* ignore */
        }
        location.href = '/';
      }}
    />
  );
}

export function HeaderCtas() {
  // No Clerk key configured → can't read a session; show the signed-out CTAs.
  if (!CLERK_PUBLISHABLE_KEY) return <Anon />;
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default HeaderCtas;
