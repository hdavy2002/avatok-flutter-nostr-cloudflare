import { UiText } from "../../lib/i18n/react";
/* [WEB-PWLESS-1 2026-09-06] The page Google comes back to.
 *
 * `signIn.authenticateWithRedirect()` sends the browser to Google and Google
 * sends it back HERE with a handshake to finish. Clerk's
 * <AuthenticateWithRedirectCallback/> completes the sign-in and then navigates.
 *
 * WITHOUT THIS PAGE the redirect lands on a route that cannot finish the
 * handshake, and the sign-in evaporates silently — the person is bounced to a
 * normal page, still signed out, with no error anywhere. That is why the Google
 * button and this file must ship together.
 *
 * `?next=` is honoured so a Google sign-in started from a booking returns to the
 * booking rather than dumping the buyer on the dashboard mid-purchase.
 */
import { useEffect, useRef } from 'react';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { postLoginTarget, safeSameOriginPath } from '../../lib/authRedirect';
import { getPhoneStatus } from './passwordless';
import { capture } from '../../lib/analytics';

/** [DASH2-FOUNDATION 2026-09-25] ?redirect_url= / ?next=, same-origin only; else /dashboard. */
function safeNext(): string {
  return postLoginTarget();
}

/** [HF-GOOGLE-FASTPATH-1] Where Clerk wants to go next. When that is the WhatsApp gate (/sign-up?finish=1&next=X) and the
 *  account's number is already verified, the gate would only bounce straight on to X — one whole extra page load (the
 *  "STD ISD PCO · One sec…" screen). Ask the same question here (GET /api/account/phone/status, the call the gate makes)
 *  and go straight to X. Anything unclear (no session yet, status fails, needs a phone, not a gate URL) goes to the gate
 *  exactly as before, so nobody can skip phone verification. */
async function navigateOn(to: string, hasSession: () => boolean): Promise<void> {
  try {
    const u = new URL(to, location.href);
    const dest = u.origin === location.origin && u.pathname === '/sign-up' && u.searchParams.get('finish') === '1'
      ? safeSameOriginPath(u.searchParams.get('next')) : null;
    if (dest && hasSession()) {
      const st = await getPhoneStatus();
      if (st && st.needs_phone === false) {
        capture('auth_phone_gate', { outcome: 'pass', surface: 'sso_callback', has_account: st.has_account, verified: st.verified });
        location.replace(dest);
        return;
      }
    }
  } catch { /* fall through to the gate page */ }
  location.replace(to);
}

function Callback({ next }: { next: string }) {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const ran = useRef(false);
  useEffect(() => {
    if (!isLoaded || ran.current) return;
    ran.current = true;
    // clerk-js calls customNavigate from inside setActive BEFORE the new session is on the instance, and waits for it.
    // So only remember the target here, resolve at once, and decide once the session is really active.
    let started = false;
    const customNavigate = async (to: string) => {
      if (started) return;
      started = true;
      void (async () => {
        const gate = /^\/sign-up\?(?:.*&)?finish=1(?:&|$)/.test(to.replace(location.origin, ''));
        const t0 = Date.now();
        while (gate && !clerk.session && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
        await navigateOn(to, () => !!clerk.session);
      })();
    };
    void clerk.handleRedirectCallback({ signInFallbackRedirectUrl: next, signUpFallbackRedirectUrl: next }, customNavigate);
  }, [clerk, isLoaded, next]);
  return null;
}

export function SsoCallbackIsland() {
  const next = safeNext();
  return (
    <ClerkIsland>
      <p className="auth-footline"><UiText id="web-auth.50c6e1d175afe411" source="Finishing sign-in…" /></p>
      <Callback next={next} />
    </ClerkIsland>
  );
}

export default SsoCallbackIsland;
