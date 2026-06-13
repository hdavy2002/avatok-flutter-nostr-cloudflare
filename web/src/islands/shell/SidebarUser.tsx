/* SidebarUser — the dashboard sidebar's profile card + sign-out, and the
 * auth guard for the whole /dashboard surface (kept in one island so there is a
 * single Clerk provider on the page).
 *
 * Guard rule (mirrors the app's AccountGate): a Clerk session OR a stored guest
 * token counts as signed-in; anyone else is bounced to /sign-in?next=<path>.
 * Sign-out clears the Clerk session and the guest token, then returns home.
 */
import { useEffect, useState } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { Avatar } from '../../components/Avatar';

const GUEST_JWT_KEY = 'avatok_guest_jwt';
const GUEST_HANDLE_KEY = 'avatok_guest_handle';

function bounceToSignIn() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/sign-in?next=${next}`);
}

function Card({
  name,
  handle,
  onSignOut,
}: {
  name: string;
  handle?: string | null;
  onSignOut: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-xs">
      <div className="flex items-center gap-3">
        <Avatar name={handle || name} size={40} />
        <div className="min-w-0">
          <div className="truncate font-display font-semibold text-[16px] text-ink">{name}</div>
          {handle && (
            <a href={`/m/${handle}`} className="font-mono font-bold text-[11px] text-blueInk no-underline">@{handle}</a>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        className="rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-coral shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine"
      >
        Sign out
      </button>
    </div>
  );
}

/** Inner component used only when a Clerk key exists (inside ClerkProvider). */
function ClerkUser() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      setReady(true);
      return;
    }
    // Not Clerk-signed-in: a stored guest token still counts.
    let guest: string | null = null;
    try {
      guest = localStorage.getItem(GUEST_JWT_KEY);
    } catch {
      /* ignore */
    }
    if (guest) setReady(true);
    else bounceToSignIn();
  }, [isLoaded, isSignedIn]);

  if (!ready) {
    return <div className="h-[84px] animate-pulse rounded-zine border-zine border-ink bg-paper2" />;
  }

  let handle: string | null = null;
  try {
    handle = (user?.username as string) || localStorage.getItem(GUEST_HANDLE_KEY);
  } catch {
    handle = (user?.username as string) || null;
  }
  const name =
    user?.fullName || user?.firstName || (user?.primaryEmailAddress?.emailAddress ?? '').split('@')[0] || 'You';

  return (
    <Card
      name={name}
      handle={handle}
      onSignOut={async () => {
        try {
          localStorage.removeItem(GUEST_JWT_KEY);
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

/** Guest-only fallback when no Clerk key is configured. */
function GuestOnlyUser() {
  const [ready, setReady] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  useEffect(() => {
    let guest: string | null = null;
    try {
      guest = localStorage.getItem(GUEST_JWT_KEY);
      setHandle(localStorage.getItem(GUEST_HANDLE_KEY));
    } catch {
      /* ignore */
    }
    if (guest) setReady(true);
    else bounceToSignIn();
  }, []);
  if (!ready) return <div className="h-[84px] animate-pulse rounded-zine border-zine border-ink bg-paper2" />;
  return (
    <Card
      name={handle || 'Guest'}
      handle={handle}
      onSignOut={() => {
        try {
          localStorage.removeItem(GUEST_JWT_KEY);
        } catch {
          /* ignore */
        }
        location.href = '/';
      }}
    />
  );
}

export function SidebarUser() {
  return (
    <ClerkIsland>{CLERK_PUBLISHABLE_KEY ? <ClerkUser /> : <GuestOnlyUser />}</ClerkIsland>
  );
}

export default SidebarUser;
