/* Shared primitives for the avaTOK auth surface (/sign-in, /sign-up).
 *
 * [WEB-AUTH-DESIGN-1 2026-08-26] Built from design/login/README.md. All styling
 * lives in src/styles/auth.css — these components only own structure, state and
 * accessibility semantics.
 *
 * ACCESSIBILITY (README §Accessibility, treated as a hard requirement):
 *   • Labels are real <label for> elements. They *look* like Silkscreen caps but
 *     must stay semantic, so no <div> labels and no aria-label substitutes.
 *   • The role picker is a real radiogroup, keyboard-operable with arrow keys.
 *   • Errors are wired with aria-describedby + aria-invalid so a screen reader
 *     announces them; the field border deliberately stays ink (no red border),
 *     which is why the text association matters more than usual here.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type FieldErrors = Record<string, string | undefined>;

/**
 * True once we've waited long enough that Clerk should have loaded but hasn't.
 *
 * WHY THIS EXISTS: every submit handler starts `if (!isLoaded) return;`. That is
 * correct — you cannot call the Clerk API before it is ready — but on its own it
 * makes the button silently do NOTHING when clerk-js fails to load. Caught in
 * testing: an ad blocker, an offline moment, or a domain mismatch leaves the
 * user clicking a dead button with no spinner and no error, forever.
 *
 * Callers disable the button while loading AND surface this flag as a real
 * message, so a failure to load is always visible rather than mute.
 */
export function useClerkStalled(isLoaded: boolean, ms = 8000): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (isLoaded) { setStalled(false); return; }
    const t = setTimeout(() => setStalled(true), ms);
    return () => clearTimeout(t);
  }, [isLoaded, ms]);
  return stalled && !isLoaded;
}

export const STALLED_MESSAGE =
  'Sign-in couldn’t start. Check your connection or any ad blocker, then reload the page.';

/* ── Wordmark ─────────────────────────────────────────────────────────── */
export function Wordmark({ href = '/' }: { href?: string }) {
  return (
    <a className="auth-wordmark" href={href} aria-label="avaTOK home">
      <span className="wm-ava">ava</span>
      <span className="wm-tok">TOK</span>
    </a>
  );
}

/* ── Text field ───────────────────────────────────────────────────────── */
export function Field({
  label, name, type = 'text', value, onChange, placeholder,
  error, autoComplete, inputMode, required = true, maxLength,
}: {
  label: string;
  name: string;
  type?: 'text' | 'email' | 'password' | 'tel';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'numeric';
  required?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const errId = `${id}-err`;
  const [reveal, setReveal] = useState(false);
  const isPassword = type === 'password';
  // A revealed password becomes type=text; `is-password` keeps the CSS honest
  // (letter-spacing drops back to normal so real characters read correctly).
  const effectiveType = isPassword && reveal ? 'text' : type;

  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>{label}</label>
      <div className="auth-boxwrap">
        <input
          id={id}
          name={name}
          className={`auth-box${isPassword && reveal ? ' is-password' : ''}`}
          type={effectiveType}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          maxLength={maxLength}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => onChange(e.target.value)}
          style={isPassword ? { paddingRight: 62 } : undefined}
        />
        {isPassword && (
          <button
            type="button"
            className="auth-show"
            onClick={() => setReveal((r) => !r)}
            aria-pressed={reveal}
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {error && <p className="auth-err" id={errId}>{error}</p>}
    </div>
  );
}

/* ── Primary / secondary button ───────────────────────────────────────── */
export function Button({
  children, type = 'button', variant = 'primary', disabled, loading, onClick,
}: {
  children: ReactNode;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'ghost' | 'ink';
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
}) {
  const cls = variant === 'primary' ? 'auth-btn' : `auth-btn auth-btn--${variant}`;
  return (
    <button type={type} className={cls} disabled={disabled || loading} onClick={onClick}>
      {/* README §Button states: loading swaps the label and goes non-interactive. */}
      {loading ? 'One sec…' : children}
    </button>
  );
}

/* ── Checkbox row ─────────────────────────────────────────────────────── */
export function CheckRow({
  checked, onChange, children, large, error, className = '',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  large?: boolean;
  error?: string;
  className?: string;
}) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <>
      <div className={`auth-row ${className}`}>
        <input
          id={id}
          type="checkbox"
          className={`auth-check${large ? ' auth-check--lg' : ''}`}
          checked={checked}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label htmlFor={id}>{children}</label>
      </div>
      {error && <p className="auth-err" id={errId}>{error}</p>}
    </>
  );
}

/* ── Role picker ──────────────────────────────────────────────────────── */
export type Role = 'friend' | 'creator';

const ROLES: { id: Role; title: string; sub: string }[] = [
  { id: 'friend', title: 'Friend', sub: 'Book talks, walks and adda.' },
  { id: 'creator', title: 'Creator', sub: 'Host sessions, get paid.' },
];

export function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move between options, as a native radio group would.
  function onKeyDown(e: React.KeyboardEvent, i: number) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? (i + 1) % ROLES.length
      : (i - 1 + ROLES.length) % ROLES.length;
    onChange(ROLES[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className="auth-field">
      <span className="auth-label" id="role-label">I&rsquo;m joining as</span>
      <div className="auth-roles" role="radiogroup" aria-labelledby="role-label">
        {ROLES.map((r, i) => {
          const selected = value === r.id;
          return (
            <button
              key={r.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className="auth-role"
              onClick={() => onChange(r.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="auth-role-top">
                <span className="auth-radio" aria-hidden="true">{selected ? '✓' : ''}</span>
                <span className="auth-role-title">{r.title}</span>
              </span>
              <span className="auth-role-sub">{r.sub}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Divider ──────────────────────────────────────────────────────────── */
export function Divider({ label }: { label: string }) {
  return <div className="auth-divider" role="separator"><span>{label}</span></div>;
}

/* ── Social buttons ───────────────────────────────────────────────────── */
/*
 * [Owner decision 2026-08-26] Apple is REMOVED (it was never enabled on the
 * Clerk instance and would have failed on click); Facebook replaces it. Neither
 * provider is wired yet — the owner's instruction was to get email + password
 * working first — so this renders nothing while SOCIAL_ENABLED is false.
 *
 * A visibly dead button on a live login page is worse than no button, which is
 * why this is a hard `null` and not a `disabled` state.
 *
 * TO TURN ON: enable google + facebook in the Clerk dashboard, flip this to
 * true, and pass an `onProvider` handler that calls
 * `signIn.authenticateWithRedirect({ strategy, redirectUrl, redirectUrlComplete })`.
 * Note the live instance currently has ONLY oauth_google enabled — verified via
 * the public Clerk environment endpoint — so Facebook needs setting up too.
 */
export const SOCIAL_ENABLED = false;

export function SocialPair({ onProvider }: { onProvider?: (p: 'google' | 'facebook') => void }) {
  if (!SOCIAL_ENABLED) return null;
  return (
    <div className="auth-social">
      <Button variant="ghost" onClick={() => onProvider?.('google')}>Google</Button>
      <Button variant="ink" onClick={() => onProvider?.('facebook')}>Facebook</Button>
    </div>
  );
}

/* ── Ornaments ────────────────────────────────────────────────────────── */
export function Rail() {
  return <span className="auth-rail" aria-hidden="true">Creator Marketplace</span>;
}
export function Stamp() {
  return <span className="auth-stamp" aria-hidden="true">Desi · Dil Se · Global</span>;
}

/* ── Validation helpers (README §Validation) ──────────────────────────── */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(v: string): string | undefined {
  if (!v.trim()) return 'Email is required.';
  if (!EMAIL_RE.test(v.trim())) return 'Enter a valid email address.';
  return undefined;
}

export function validatePassword(v: string, min = 8): string | undefined {
  if (!v) return 'Password is required.';
  // The design promises "8+ characters". Clerk's own minimum is currently 0
  // (verified on the live instance), so this floor is enforced here or nowhere.
  if (v.length < min) return `Use at least ${min} characters.`;
  return undefined;
}

export function validateRequired(v: string, field: string): string | undefined {
  return v.trim() ? undefined : `${field} is required.`;
}

/**
 * Turn a Clerk error into one line a person can act on. Clerk returns an
 * `errors[]` array; `longMessage` is the human sentence, `message` the terse
 * one. Anything unrecognised falls back to a neutral string rather than leaking
 * an internal code to the user.
 */
export function clerkError(err: unknown): string {
  const e = err as { errors?: { longMessage?: string; message?: string; code?: string }[] };
  const first = e?.errors?.[0];
  if (!first) return 'Something went wrong. Please try again.';
  if (first.code === 'form_password_pwned') {
    return 'That password has appeared in a data breach. Please choose another.';
  }
  if (first.code === 'form_identifier_not_found' || first.code === 'form_password_incorrect') {
    return 'Wrong email or password.';
  }
  return first.longMessage || first.message || 'Something went wrong. Please try again.';
}
