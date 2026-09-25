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
import { AuthenticateWithRedirectCallback } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { postLoginTarget } from '../../lib/authRedirect';

/** [DASH2-FOUNDATION 2026-09-25] ?redirect_url= / ?next=, same-origin only; else /dashboard. */
function safeNext(): string {
  return postLoginTarget();
}

export function SsoCallbackIsland() {
  const next = safeNext();
  return (
    <ClerkIsland>
      <p className="auth-footline"><UiText id="web-auth.50c6e1d175afe411" source="Finishing sign-in…" /></p>
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl={next}
        signUpFallbackRedirectUrl={next}
      />
    </ClerkIsland>
  );
}

export default SsoCallbackIsland;
