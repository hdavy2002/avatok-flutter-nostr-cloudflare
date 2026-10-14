/* [HF-DASH-FRAANDS-1] Heart button: save a host to "My Fraands". Client-only (the host pages are server-rendered / prerendered).
 * Hidden while hfFavouritesEnabled is off. Signed out: a click sends the person to sign in and back. Otherwise toggles
 * optimistically and rolls back if the server says no. */
import { useEffect, useRef, useState } from 'react';
import { looksSignedOut, signInUrl } from '../../lib/hfCallsApi';
import { favouritesEnabled, isFavourite, saveFavourite, unsaveFavourite } from '../../lib/hfFavouritesApi';
import { capture, captureException } from '../../lib/analytics';
import '../../styles/hf-save-host.css';

export interface SaveHostButtonProps {
  slug: string;
  name: string;
  /** Where the button sits, for telemetry. */
  surface: 'profile' | 'explore' | 'dashboard';
  /** 'icon' = round heart (cards); 'pill' = heart + words (profile page). */
  variant?: 'icon' | 'pill';
  /** Known state (the dashboard list already knows these are saved). */
  initialSaved?: boolean;
  /** Called after a successful change. */
  onChange?: (saved: boolean) => void;
}

function Heart({ filled }: { filled: boolean }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 20s-8-4.6-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.4-8 10-8 10Z" />
  </svg>;
}

export default function SaveHostButton({ slug, name, surface, variant = 'icon', initialSaved, onChange }: SaveHostButtonProps) {
  const [on, setOn] = useState<boolean | null>(null); // flag
  const [saved, setSaved] = useState(initialSaved ?? false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      const enabled = await favouritesEnabled();
      if (!alive.current) return;
      setOn(enabled);
      if (!enabled || initialSaved !== undefined || looksSignedOut()) return;
      const r = await isFavourite(slug);
      if (alive.current && r.ok) setSaved(r.data.saved);
    })();
    return () => { alive.current = false; };
  }, [slug, initialSaved]);

  if (!on) return null;

  async function toggle(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation(); // the card and the profile page have links around them
    if (busy) return;
    if (looksSignedOut()) { location.href = signInUrl(); return; }
    const next = !saved;
    setBusy(true); setNote(''); setSaved(next);
    try {
      const r = next ? await saveFavourite(slug) : await unsaveFavourite(slug);
      if (!alive.current) return;
      if (!r.ok) {
        if (r.status === 401) { location.href = signInUrl(); return; }
        setSaved(!next);
        setNote(r.message || 'We could not save that. Please try again.');
        captureException(new Error(`favourite_${r.code || r.status}`), { area: 'hf_favourites', step: next ? 'save' : 'unsave', status: r.status, host_slug: slug });
        return;
      }
      capture('hf_favourite_toggle', { host_slug: slug, on: next, surface });
      onChange?.(next);
    } catch (err) {
      if (alive.current) { setSaved(!next); setNote('We could not save that. Please try again.'); }
      captureException(err, { area: 'hf_favourites', step: next ? 'save' : 'unsave', host_slug: slug });
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const label = saved ? `Remove ${name} from My Fraands` : `Save ${name}`;
  return <span className={`hf-save hf-save-${variant}`}>
    <button type="button" className="hf-save-btn" aria-pressed={saved} aria-label={label} title={label} disabled={busy} onClick={toggle}>
      <Heart filled={saved} />
      {variant === 'pill' && <span>{saved ? 'Saved' : 'Save'}</span>}
    </button>
    {note && <span className="hf-save-note" role="alert">{note}</span>}
  </span>;
}
