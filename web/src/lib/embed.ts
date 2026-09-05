/* [LIST-EMBED-1 2026-09-05] The bridge between this site and the Flutter app's
 * in-app WebView.
 *
 * WHY THIS EXISTS. The app used to have its own create-listing surface (the
 * "List with Ava" compose chat, app/lib/features/marketplace/compose_chat.dart).
 * Owner decision 2026-09-05: there is ONE listing form, the web wizard, and the
 * app shows that same form in a WebView. Two implementations of an 8-step form
 * against a server contract that keeps growing (listingContentFieldsError,
 * contentAttrsError, commercialPolicyError) is a guarantee that one of them is
 * always wrong.
 *
 * AUTH IS THE WHOLE PROBLEM, AND IT IS WHY THIS FILE IS NOT A ONE-LINER.
 * The WebView has no Clerk session — the app holds one, natively. So the page
 * asks the host for a bearer token instead of minting its own, and
 * `lib/clerk.tsx:getActiveToken()` prefers this provider when it is installed.
 * Every island therefore keeps working unchanged.
 *
 * ⚠️ The token is NOT cached across the session, deliberately. A Clerk session
 * token is short-lived (~60s). Caching one for the life of a wizard — which a
 * creator can easily spend ten minutes in — would 401 halfway through, most
 * likely on the submit at the very end, after all the typing. Each request goes
 * back to the host, which calls the same `ApiAuth.clerkBearer` every native
 * request uses and gets a fresh one. A very short in-flight dedupe keeps a
 * burst of parallel reads down to one round trip without holding a stale value.
 *
 * The host side is app/lib/features/marketplace/listing_web_form.dart. The two
 * files are one protocol; change them together.
 */

/** Messages this page sends to the host. Keep in sync with the Dart switch. */
type OutMsg =
  | { type: 'token'; id: number }
  | { type: 'ready' }
  | { type: 'dirty'; value: boolean }
  | { type: 'submitted'; id: string | null }
  | { type: 'log'; level: 'warn' | 'error'; message: string };

interface HostChannel { postMessage(payload: string): void }

interface EmbedWindow extends Window {
  AvatokHost?: HostChannel;
  /** Host → page token delivery. Installed by `installEmbedBridge`. */
  __avatokEmbedToken?: (id: number, token: string | null) => void;
}

function w(): EmbedWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as EmbedWindow);
}

/**
 * True when this page is running inside the app's WebView.
 *
 * Both halves must hold: `?embed=1` (the app's URL) AND the `AvatokHost`
 * channel (registered by the Dart side before the first load). The query param
 * alone is a URL anyone can type, and a page that decided it was embedded on
 * that basis would sit there waiting for a token from a host that does not
 * exist — a blank form with no error. Requiring the channel means a browser
 * visit to the same URL simply falls back to the normal Clerk path.
 */
export function isEmbedded(): boolean {
  const win = w();
  if (!win || typeof win.AvatokHost?.postMessage !== 'function') return false;
  try {
    return new URLSearchParams(win.location.search).get('embed') === '1';
  } catch {
    return false;
  }
}

function send(msg: OutMsg): void {
  const win = w();
  try {
    win?.AvatokHost?.postMessage(JSON.stringify(msg));
  } catch {
    /* the host is gone (webview being torn down) — nothing useful to do */
  }
}

// ── token request/response ────────────────────────────────────────────────
let seq = 0;
const pending = new Map<number, { resolve: (t: string | null) => void; timer: number }>();
/** In-flight dedupe only — see the header on why nothing is cached for longer. */
let inFlight: Promise<string | null> | null = null;

const TOKEN_TIMEOUT_MS = 10_000;

function requestTokenFromHost(): Promise<string | null> {
  const win = w();
  if (!win) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const id = ++seq;
    const timer = win.setTimeout(() => {
      pending.delete(id);
      send({ type: 'log', level: 'warn', message: `token request ${id} timed out` });
      resolve(null);
    }, TOKEN_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    send({ type: 'token', id });
  });
}

/**
 * Installs the host bridge and returns the token provider `lib/clerk.tsx` uses.
 * Safe to call on a page that is not embedded — it no-ops and returns null.
 */
export function installEmbedBridge(): (() => Promise<string | null>) | null {
  const win = w();
  if (!win || !isEmbedded()) return null;

  win.__avatokEmbedToken = (id: number, token: string | null) => {
    const entry = pending.get(id);
    if (!entry) return; // already timed out — a late answer is not an error
    pending.delete(id);
    win.clearTimeout(entry.timer);
    entry.resolve(token && token.length ? token : null);
  };

  send({ type: 'ready' });

  return () => {
    if (inFlight) return inFlight;
    inFlight = requestTokenFromHost().finally(() => {
      // Release on the next tick so a burst of parallel callers (the wizard
      // fires several reads on mount) shares one round trip, while the call
      // AFTER that still gets a fresh token rather than this one.
      win.setTimeout(() => { inFlight = null; }, 0);
    });
    return inFlight;
  };
}

/** Tell the host whether closing now would lose work (drives the X's confirm). */
export function embedNotifyDirty(dirty: boolean): void {
  if (!isEmbedded()) return;
  send({ type: 'dirty', value: dirty });
}

/**
 * The listing went into the review queue. The host closes the WebView and takes
 * the creator to My listings, where the card reads "Review pending" — so this
 * page must NOT also navigate (the web build redirects to
 * /dashboard/listings?submitted=…, which inside a WebView would strand the user
 * on a dashboard with no app chrome and no way back).
 */
export function embedNotifySubmitted(listingId: string | null): void {
  if (!isEmbedded()) return;
  send({ type: 'submitted', id: listingId });
}
