// [ADMIN-PURGE-1 2026-09-05] Permanently delete a listing.
//
// The owner's queue is full of dead test rows and cancelling only changes a
// status, so they never leave the list. This is the button that removes one for
// good, along with the ~30 tables that reference it.
//
// Three things about this UI are deliberate, and none of them are ceremony:
//
//  * COLLAPSED BY DEFAULT, and the last panel on the page. Nothing irreversible
//    should sit next to Approve.
//  * TYPE THE TITLE. The queue shows near-identical rows — "Cooking with Davy"
//    appears twice, one approved and one cancelled — and the server refuses
//    unless the typed title matches exactly. The confirmation is not "are you
//    sure", it is "which one".
//  * THE REFUSAL IS THE FEATURE. When the listing has bookings, orders or
//    receipts the server answers 409 and names them; that is rendered here as
//    the main message rather than as an error, because "you cannot delete this,
//    here is what is attached to it" is the useful answer.
import { useState } from 'react';

export default function DeletePanel({ title, status, busy, onDelete }: {
  title: string;
  status?: string | null;
  busy: boolean;
  /** Resolves with the server's message; throws with it on refusal. */
  onDelete: (confirm: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const matches = typed.trim() === (title ?? '').trim() && !!title;

  async function go() {
    setProblem(null);
    try { await onDelete(typed.trim()); }
    catch (e) { setProblem(e instanceof Error ? e.message : 'Could not delete this listing.'); }
  }

  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[18px] font-semibold text-ink">Delete permanently</h3>
        <button type="button" onClick={() => { setOpen((o) => !o); setProblem(null); setTyped(''); }}
          className="rounded-full border-zine border-ink bg-paper px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs">
          {open ? 'Cancel' : 'Delete…'}
        </button>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="font-body text-[13px] font-bold text-inkSoft">
            This removes the listing and everything referencing it — photos, poster files, slots,
            reviews, promotions and its history. It cannot be undone.
            {status !== 'cancelled' && status !== 'draft' && (
              <> This listing is <span className="text-ink">{status}</span>. Consider cancelling it instead.</>
            )}
          </p>
          <p className="font-body text-[13px] font-bold text-inkSoft">
            If anyone has booked or paid for it, the delete will be refused and nothing will change.
          </p>
          <label className="block">
            <span className="mb-1 block font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft">
              Type the title to confirm: {title || '(this listing has no title)'}
            </span>
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder={title}
              className="w-full rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body text-[14px] font-bold text-ink" />
          </label>
          {problem && (
            <p className="rounded-zineField border-zine border-ink bg-paper2 px-3 py-2 font-body text-[13px] font-bold text-coral">
              {problem}
            </p>
          )}
          <button type="button" disabled={busy || !matches} onClick={() => void go()}
            className="self-start rounded-full border-zine border-ink bg-coral px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-paper shadow-zine-xs disabled:opacity-50">
            Delete this listing for good
          </button>
        </div>
      )}
    </div>
  );
}
