/* Clerk provider + the shared GuestGate — the auth foundation every other
 * phase (B/C/D/E) depends on. See MASTER-PROMPT §4b.
 *
 * CONTRACT NOTE (drift from MASTER-PROMPT §4b — confirmed by reading the
 * Worker, documented for A–E):
 *   §4b sketches the gate as email → start → verify → identity/guest → JWT.
 *   The real Worker is HANDLE-FIRST and inverts the order:
 *     1. POST /api/identity/guest { handle, device_id? }  (NO auth)
 *          -> { uid, handle, guest_token, level:0 }   ← the session JWT is minted HERE
 *     2. POST /api/id/email/start { email }   (requires the guest_token)
 *          -> sends a 6-digit OTP
 *     3. POST /api/id/email/verify { email, code }   (requires the guest_token)
 *          -> attaches/verifies the email on the guest identity
 *   So a valid authenticated session exists after step 1; email verification
 *   (steps 2–3) captures the email for notifications, per §4b's rationale.
 *   `requireGuestAuth()` resolves the guest_token (a valid `requireUser` JWT).
 */
import {
  ClerkProvider,
  useAuth,
  SignInButton as ClerkSignInButton,
} from '@clerk/clerk-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CLERK_PUBLISHABLE_KEY } from './config';
import { request, ApiError } from './apiClient';
import type { GuestCreated } from './types';
import { Modal } from '../components/Modal';
import { Field } from '../components/Field';
import { Button } from '../components/Button';

const GUEST_JWT_KEY = 'avatok_guest_jwt';
const DEVICE_ID_KEY = 'avatok_device_id';

// ── module-level bridges so non-React callers (requireGuestAuth) can read a
// live Clerk session and open the gate modal mounted by <ClerkIsland>. ──────
let _clerkGetToken: (() => Promise<string | null>) | null = null;
let _clerkSignedIn = false;
let _openGate: ((resolve: (jwt: string) => void, reject: (e: unknown) => void) => void) | null = null;

function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage?.setItem(key, val);
  } catch {
    /* private mode / SSR — ignore */
  }
}

/** Stable per-browser device id (used to seed guest accounts). */
export function deviceId(): string {
  let id = lsGet(DEVICE_ID_KEY);
  if (!id) {
    id = (globalThis.crypto?.randomUUID?.() ?? `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    lsSet(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Best-effort read of the current session JWT WITHOUT opening any UI:
 * live Clerk session first, then a stored guest_token. Returns null for an
 * anonymous visitor. Use this for optional-auth reads.
 */
export async function getActiveToken(): Promise<string | null> {
  if (_clerkSignedIn && _clerkGetToken) {
    try {
      const t = await _clerkGetToken();
      if (t) return t;
    } catch {
      /* fall through to guest */
    }
  }
  return lsGet(GUEST_JWT_KEY);
}

/**
 * Like getActiveToken, but tolerant of the cross-island race on dashboard pages:
 * the body panels mount alongside <SidebarUser/> (the page's single ClerkProvider),
 * whose ClerkBridge populates the module-level token getter a beat later. We poll
 * briefly so a Clerk-only session (no guest token yet) resolves instead of reading
 * null on first paint. Returns null only if nothing resolves within `timeoutMs`.
 */
export async function getActiveTokenWaited(timeoutMs = 5000): Promise<string | null> {
  const start = Date.now();
  for (;;) {
    const t = await getActiveToken();
    if (t) return t;
    if (Date.now() - start >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * THE gate. Resolves to a session JWT, opening the email/OTP modal only when no
 * session exists. Call at the point of a gated action (book / talk / join /
 * enter), then retry the action with the returned token.
 */
export async function requireGuestAuth(): Promise<string> {
  const existing = await getActiveToken();
  if (existing) return existing;
  if (!_openGate) {
    throw new Error('GuestGate host not mounted — wrap the island in <ClerkIsland>.');
  }
  return new Promise<string>((resolve, reject) => _openGate!(resolve, reject));
}

// ── handle generation for guest creation ──────────────────────────────────
const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
function candidateHandle(email: string, attempt: number): string {
  const local = (email.split('@')[0] || 'guest').toLowerCase().replace(/[^a-z0-9_]/g, '');
  const base = (local || 'guest').slice(0, 18) || 'guest';
  const suffix = Math.random().toString(36).slice(2, attempt === 0 ? 6 : 8);
  let h = `${base}_${suffix}`.slice(0, 30);
  if (h.length < 3) h = `guest_${suffix}`;
  return HANDLE_RE.test(h) ? h : `guest_${suffix}`;
}

/** Create a guest account, retrying on handle collisions. Returns the token. */
async function createGuest(email: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const handle = candidateHandle(email, attempt);
    try {
      const res = await request<GuestCreated>('/api/identity/guest', {
        method: 'POST',
        body: { handle, device_id: deviceId() },
      });
      lsSet(GUEST_JWT_KEY, res.guest_token);
      return res.guest_token;
    } catch (e) {
      lastErr = e;
      if (e instanceof ApiError && e.status === 409) continue; // handle taken → retry
      throw e;
    }
  }
  throw lastErr ?? new Error('could not create a guest account');
}

// ───────────────────────────── React surface ─────────────────────────────

/** Wrap any auth-aware island. Provides Clerk context + mounts the GuestGate host. */
export function ClerkIsland({ children }: { children: ReactNode }) {
  if (!CLERK_PUBLISHABLE_KEY) {
    // No key yet (e.g. first preview) — still mount the gate host so guest auth
    // works; Clerk sign-in just won't be available.
    return (
      <>
        <GuestGateHost />
        {children}
      </>
    );
  }
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <ClerkBridge />
      <GuestGateHost />
      {children}
    </ClerkProvider>
  );
}

/** Keeps the module-level Clerk bridges in sync with the live session. */
function ClerkBridge() {
  const { isSignedIn, getToken } = useAuth();
  useEffect(() => {
    _clerkSignedIn = !!isSignedIn;
    _clerkGetToken = () => getToken();
    return () => {
      _clerkGetToken = null;
      _clerkSignedIn = false;
    };
  }, [isSignedIn, getToken]);
  return null;
}

/** Re-export of Clerk's sign-in trigger (full-account path). */
export const SignInButton = ClerkSignInButton;

/**
 * Hook for islands: the current session JWT (Clerk or guest), or null when
 * anonymous. `refresh()` re-reads; `require()` opens the gate if needed.
 */
export function useAuthToken(): {
  token: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  require: () => Promise<string>;
} {
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = async () => {
    setToken(await getActiveToken());
    setLoaded(true);
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    token,
    loaded,
    refresh,
    require: async () => {
      const t = await requireGuestAuth();
      setToken(t);
      return t;
    },
  };
}

export interface GuestGateProps {
  open: boolean;
  /** Resolves with the session JWT on success. */
  onAuthed: (jwt: string) => void;
  /** Called on dismiss/cancel. */
  onCancel?: () => void;
}

type Step = 'email' | 'code';

/**
 * The reusable email→OTP gate modal. Standalone-usable, and also driven by
 * {@link requireGuestAuth} via the host. Runs the real Worker flow:
 * identity/guest (handle) → id/email/start → id/email/verify.
 */
export function GuestGate({ open, onAuthed, onCancel }: GuestGateProps) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  const reset = () => {
    setStep('email');
    setEmail('');
    setCode('');
    setBusy(false);
    setError(null);
    tokenRef.current = null;
  };

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  async function submitEmail() {
    if (!emailValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Reuse an existing guest token if we already have one this session.
      const existing = lsGet(GUEST_JWT_KEY);
      const jwt = existing ?? (await createGuest(email.trim().toLowerCase()));
      tokenRef.current = jwt;
      await request('/api/id/email/start', { method: 'POST', auth: jwt, body: { email: email.trim().toLowerCase() } });
      setStep('code');
    } catch (e) {
      setError(messageFor(e, 'Could not send the code. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    const jwt = tokenRef.current;
    if (!jwt || code.trim().length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request('/api/id/email/verify', {
        method: 'POST',
        auth: jwt,
        body: { email: email.trim().toLowerCase(), code: code.trim() },
      });
      const done = jwt;
      reset();
      onAuthed(done);
    } catch (e) {
      setError(messageFor(e, 'That code did not work.'));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    const jwt = tokenRef.current;
    if (!jwt || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request('/api/id/email/start', { method: 'POST', auth: jwt, body: { email: email.trim().toLowerCase() } });
    } catch (e) {
      setError(messageFor(e, 'Could not resend. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onCancel?.();
      }}
      title={step === 'email' ? 'Just your email' : 'Enter the code'}
      dismissable={!busy}
    >
      {step === 'email' ? (
        <div className="space-y-4">
          <p className="font-body font-bold text-[15px] text-inkSoft">
            We use it to send your booking and reminders. No password, no app needed.
          </p>
          <Field
            label="Email"
            lead="@"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            placeholder="you@email.com"
            value={email}
            error={error}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
          />
          <Button fullWidth loading={busy} disabled={!emailValid} label="Send code" onClick={submitEmail} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="font-body font-bold text-[15px] text-inkSoft">
            We sent a 6-digit code to <span className="text-ink">{email}</span>.
          </p>
          <Field
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="123456"
            maxLength={6}
            value={code}
            error={error}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && submitCode()}
          />
          <Button fullWidth loading={busy} disabled={code.trim().length < 4} label="Verify" onClick={submitCode} />
          <button
            type="button"
            className="w-full font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2 disabled:text-inkMute"
            disabled={busy}
            onClick={resend}
          >
            Resend code
          </button>
        </div>
      )}
    </Modal>
  );
}

/** Mounted once by ClerkIsland; bridges requireGuestAuth() to the modal. */
function GuestGateHost() {
  const [open, setOpen] = useState(false);
  const cbRef = useRef<{ resolve: (jwt: string) => void; reject: (e: unknown) => void } | null>(null);

  useEffect(() => {
    _openGate = (resolve, reject) => {
      cbRef.current = { resolve, reject };
      setOpen(true);
    };
    return () => {
      _openGate = null;
    };
  }, []);

  return (
    <GuestGate
      open={open}
      onAuthed={(jwt) => {
        setOpen(false);
        cbRef.current?.resolve(jwt);
        cbRef.current = null;
      }}
      onCancel={() => {
        setOpen(false);
        cbRef.current?.reject(new Error('cancelled'));
        cbRef.current = null;
      }}
    />
  );
}

function messageFor(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.error || fallback;
  return fallback;
}
