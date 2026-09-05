// [ADMIN-EDIT-1 2026-09-05] The reviewer can fix a listing instead of bouncing it.
//
// Until now the admin queue could approve, reject with a reason, and run poster
// actions — nothing else. A listing that was 95% right had to go back to its
// creator over a typo or a missing start time, and the creator often could not
// fix it either (a live event's schedule was frozen the moment it left draft).
// The owner's ask, 2026-09-05: "as an admin, I should have full editing
// capabilities, in case I need to adjust something."
//
// Two deliberate choices here:
//
//  * ONLY DIRTY FIELDS ARE SENT. The form starts from the listing and submits
//    the difference, so an admin who opens the editor to change a price cannot
//    silently rewrite a description they merely scrolled past. The server diffs
//    again and records what actually changed.
//  * NO CLIENT-SIDE RULES. Validity is the server's answer (the blockers list),
//    not a second opinion computed here. A browser copy of the rules drifting
//    from the server's is the bug this whole change is undoing.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ListingDetail } from './adminListingsShared';

/** Mirrors ADMIN_EDITABLE in worker/src/routes/admin_listings.ts. The server is
 *  the authority — it rejects anything outside its own set with
 *  `field_not_editable`, so a drift here is a visible 400, never a silent write. */
type FieldKind = 'text' | 'textarea' | 'number' | 'datetime';
const FIELDS: { key: string; label: string; kind: FieldKind; help?: string }[] = [
  { key: 'title', label: 'Title', kind: 'text' },
  { key: 'blurb', label: 'One-liner', kind: 'text' },
  { key: 'description', label: 'Description', kind: 'textarea' },
  { key: 'category', label: 'Category id', kind: 'text', help: 'Must be an active id from listing_categories.' },
  { key: 'price', label: 'Price (tokens = ₹)', kind: 'number' },
  { key: 'starts_at', label: 'Starts', kind: 'datetime', help: 'Live events need a future start.' },
  { key: 'duration_min', label: 'Length (minutes)', kind: 'number', help: '5–480.' },
  { key: 'capacity', label: 'Capacity', kind: 'number', help: 'Consult listings: 1, 10 or 20.' },
  { key: 'max_per_booking', label: 'Max per booking', kind: 'number' },
  { key: 'timezone', label: 'Timezone', kind: 'text' },
  { key: 'location', label: 'Location', kind: 'text' },
  { key: 'video_url', label: 'Video URL', kind: 'text' },
];

const inputCls = 'w-full rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body text-[14px] font-bold text-ink';

/** epoch ms -> the value an <input type="datetime-local"> wants, in LOCAL time.
 *  toISOString() would silently shift the admin's input by their UTC offset —
 *  on a listing whose whole problem is a wrong start time, that is the last
 *  place to introduce an hours-long error. */
function toLocalInput(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n - new Date(n).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
function fromLocalInput(v: string): number | '' {
  if (!v) return '';
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : '';
}

export default function EditPanel({ listing, busy, focusField, onSave }: {
  listing: ListingDetail;
  busy: boolean;
  /** Set when the admin clicked "Fix <field>" on a blocker. */
  focusField: string | null;
  onSave: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const initial = useMemo(() => {
    const o: Record<string, string> = {};
    for (const f of FIELDS) {
      const raw = (listing as any)[f.key];
      o[f.key] = f.kind === 'datetime'
        ? toLocalInput(raw)
        : raw === null || raw === undefined ? '' : String(raw);
    }
    return o;
  }, [listing]);

  const [form, setForm] = useState<Record<string, string>>(initial);
  const [open, setOpen] = useState(false);
  const refs = useRef<Record<string, HTMLElement | null>>({});

  // Re-seed whenever the listing changes underneath (a save, a poster action, a
  // different listing selected). Without this the form would keep showing the
  // pre-save values and the next save would send them back as "changes".
  useEffect(() => { setForm(initial); }, [initial]);

  useEffect(() => {
    if (!focusField) return;
    setOpen(true);
    // Next frame: the panel may have only just been expanded.
    const t = window.setTimeout(() => {
      const el = refs.current[focusField];
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); (el as HTMLInputElement).focus?.(); }
    }, 60);
    return () => window.clearTimeout(t);
  }, [focusField]);

  const dirty = FIELDS.filter((f) => form[f.key] !== initial[f.key]);

  async function save() {
    const fields: Record<string, unknown> = {};
    for (const f of dirty) {
      const v = form[f.key];
      if (f.kind === 'number') fields[f.key] = v === '' ? null : Number(v);
      else if (f.kind === 'datetime') fields[f.key] = v === '' ? null : fromLocalInput(v);
      else fields[f.key] = v;
    }
    await onSave(fields);
  }

  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[18px] font-semibold text-ink">Edit listing</h3>
        <button type="button" onClick={() => setOpen((o) => !o)}
          className="rounded-full border-zine border-ink bg-paper px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs">
          {open ? 'Close' : 'Open editor'}
        </button>
      </div>

      {open && (
        <>
          <p className="mt-2 font-body text-[13px] font-bold text-inkSoft">
            Your changes are logged against your admin id in this listing's history, and the
            listing keeps its current approval.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft">
                  {f.label}
                  {form[f.key] !== initial[f.key] && <span className="ml-2 text-coral">changed</span>}
                </span>
                {f.kind === 'textarea' ? (
                  <textarea ref={(el) => { refs.current[f.key] = el; }} rows={4} className={inputCls}
                    value={form[f.key]} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
                ) : (
                  <input ref={(el) => { refs.current[f.key] = el; }}
                    type={f.kind === 'number' ? 'number' : f.kind === 'datetime' ? 'datetime-local' : 'text'}
                    className={inputCls}
                    value={form[f.key]} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
                )}
                {f.help && <span className="mt-1 block font-body text-[12px] font-bold text-inkMute">{f.help}</span>}
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy || !dirty.length} onClick={() => void save()}
              className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
              {dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}` : 'No changes'}
            </button>
            {dirty.length > 0 && (
              <button type="button" disabled={busy} onClick={() => setForm(initial)}
                className="rounded-full border-zine border-ink bg-paper px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
                Discard
              </button>
            )}
            {dirty.length > 0 && (
              <span className="font-body text-[13px] font-bold text-inkSoft">
                Sending only: {dirty.map((f) => f.label).join(', ')}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
