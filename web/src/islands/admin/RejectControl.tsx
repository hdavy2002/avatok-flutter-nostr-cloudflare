// Inline "reason required" control used by both Reject listing and Reject
// poster. The server 400s on a blank reason/feedback — this makes that a UX
// rule (disabled confirm) instead of a round trip.
import { useState } from 'react';

export default function RejectControl({
  label,
  placeholder,
  busy,
  onConfirm,
  tone = 'bg-paper',
}: {
  label: string;
  placeholder: string;
  busy: boolean;
  onConfirm: (reason: string) => void;
  tone?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  if (!open) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        className={`rounded-full border-zine border-ink ${tone} px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50`}
      >
        {label}
      </button>
    );
  }

  const trimmed = text.trim();
  return (
    <div className="flex w-full flex-col gap-2 rounded-zineField border-zine border-ink bg-paper p-3">
      <label className="font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkMute">{label} — reason (required, reaches the creator)</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-y rounded-zineField border-zine border-ink bg-card p-2 font-body text-[14px] font-bold text-ink outline-none"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || trimmed.length === 0}
          onClick={() => { onConfirm(trimmed); setOpen(false); setText(''); }}
          className="rounded-full border-zine border-ink bg-coral px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-paper shadow-zine-xs disabled:opacity-50"
        >
          Confirm {label.toLowerCase()}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => { setOpen(false); setText(''); }}
          className="rounded-full border-zine border-ink bg-paper2 px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
