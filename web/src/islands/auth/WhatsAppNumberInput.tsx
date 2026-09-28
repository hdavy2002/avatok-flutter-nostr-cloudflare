/* [WA-WEB-1 2026-09-28] Reusable WhatsApp number field: a searchable country
 * picker (flag + dial code) plus the national number, used everywhere a
 * WhatsApp number is entered — /sign-in, /sign-up, checkout's "You" step and
 * the dashboard profile's change-number dialog.
 *
 * Deliberately styleless beyond the classes it's handed: each surface passes
 * its OWN existing classes (auth-* on the auth pages, sthc-* in checkout) via
 * `classes`, so this never introduces a new visual language — owner rule is
 * reuse the existing components/classes on every page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { COUNTRIES, findCountry } from '../../lib/countries';

export interface WhatsAppNumberInputClasses {
  /** Wraps label + boxes (e.g. "auth-field" / "sthc-fld"). */
  field?: string;
  label?: string;
  /** The number input's box class (e.g. "auth-box" / "sthc-in"). */
  box?: string;
  /** The country-picker button's box class — defaults to `box`. */
  countryBox?: string;
  err?: string;
}

const DEFAULT_CLASSES: Required<Omit<WhatsAppNumberInputClasses, 'countryBox'>> = {
  field: 'auth-field',
  label: 'auth-label',
  box: 'auth-box',
  err: 'auth-err',
};

export interface WhatsAppNumberInputProps {
  /** National digits only (no dial code). */
  value: string;
  /** ISO 3166-1 alpha-2, e.g. "IN". */
  countryCode: string;
  onChange: (national: string, countryCode: string) => void;
  disabled?: boolean;
  error?: string;
  label?: string;
  id?: string;
  autoFocus?: boolean;
  classes?: WhatsAppNumberInputClasses;
}

export function WhatsAppNumberInput({
  value, countryCode, onChange, disabled, error, label = 'WhatsApp number', id, autoFocus, classes,
}: WhatsAppNumberInputProps) {
  const c = { ...DEFAULT_CLASSES, ...classes };
  const countryBoxCls = classes?.countryBox ?? c.box;
  const genId = useRef(`wa-num-${Math.random().toString(36).slice(2)}`).current;
  const inputId = id ?? genId;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const popRef = useRef<HTMLDivElement | null>(null);
  const country = findCountry(countryCode);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (x) => x.name.toLowerCase().includes(q) || x.dial.includes(q.replace(/^\+/, '')) || x.code.toLowerCase() === q,
    );
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className={c.field}>
      {label && <label className={c.label} htmlFor={inputId}>{label}</label>}
      <div style={{ display: 'flex', gap: 8, position: 'relative' }} ref={popRef}>
        <button
          type="button"
          className={countryBoxCls}
          style={{ flex: '0 0 96px', textAlign: 'left', cursor: disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Country code, currently ${country.name} +${country.dial}`}
        >
          <span aria-hidden="true">{country.flag}</span>
          <span>+{country.dial}</span>
        </button>
        {open && (
          <div
            role="listbox"
            aria-label="Choose a country"
            style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 30, width: 280, maxHeight: 280, overflowY: 'auto',
              background: 'var(--card-bg, #fff)', color: 'inherit', border: '1px solid rgba(0,0,0,0.15)',
              borderRadius: 10, marginTop: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            }}
          >
            <input
              autoFocus
              className={c.box}
              placeholder="Search country or code"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ margin: 8, width: 'calc(100% - 16px)' }}
            />
            {filtered.map((x) => (
              <button
                type="button"
                key={x.code}
                role="option"
                aria-selected={x.code === country.code}
                style={{
                  display: 'flex', width: '100%', gap: 8, padding: '8px 12px', background: x.code === country.code ? 'rgba(0,0,0,0.05)' : 'none',
                  border: 'none', textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
                }}
                onClick={() => { onChange(value, x.code); setOpen(false); setQuery(''); }}
              >
                <span aria-hidden="true">{x.flag}</span>
                <span style={{ flex: 1 }}>{x.name}</span>
                <span style={{ opacity: 0.65 }}>+{x.dial}</span>
              </button>
            ))}
            {!filtered.length && <div style={{ padding: 12, opacity: 0.6 }}>No matches</div>}
          </div>
        )}
        <input
          id={inputId}
          className={c.box}
          style={{ flex: 1 }}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          autoFocus={autoFocus}
          placeholder="98765 43210"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 14), country.code)}
        />
      </div>
      {error && <p className={c.err} role="alert">{error}</p>}
    </div>
  );
}

export default WhatsAppNumberInput;
