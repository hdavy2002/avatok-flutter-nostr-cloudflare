// Donate to the creator during a live stream.
//   POST /api/live/:id/donate { amount }  (auth: session JWT — guest or full)
// The Worker moves the Tokens instantly and broadcasts a banner over the room
// WS (we render that banner in LiveViewer). On 402 the donor needs funds — the
// wallet/top-up is Phase B's domain, so we just link out. PHASE-C §6.
import { useState } from 'react';
import { request, ApiError } from '../../lib/apiClient';
import { Sheet } from '../../components';

export interface DonateButtonProps {
  listingId: string;
  /** Session JWT (from the join flow). Required to donate. */
  auth: string | null;
  /** Open the guest gate to obtain a session, then retry. */
  requireAuth: () => Promise<string>;
}

interface DonateResult {
  ok: boolean;
  gross: number;
  net: number;
  fee: number;
  balance?: number;
}

const PRESETS = [10, 50, 100, 500];

export function DonateButton({ listingId, auth, requireAuth }: DonateButtonProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsFunds, setNeedsFunds] = useState(false);
  const [sent, setSent] = useState(false);

  const reset = () => {
    setBusy(false);
    setError(null);
    setNeedsFunds(false);
    setSent(false);
  };

  async function donate() {
    if (busy || amount <= 0) return;
    setBusy(true);
    setError(null);
    setNeedsFunds(false);
    try {
      const jwt = auth ?? (await requireAuth());
      await request<DonateResult>(`/api/live/${encodeURIComponent(listingId)}/donate`, {
        method: 'POST',
        auth: jwt,
        body: { amount },
      });
      setSent(true);
      setTimeout(() => {
        setOpen(false);
        reset();
      }, 1400);
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        setNeedsFunds(true);
        setError('Not enough Tokens for that amount.');
      } else if (e instanceof Error && e.message === 'cancelled') {
        // gate dismissed — no-op
      } else {
        setError(e instanceof ApiError ? e.error : 'Could not send. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="inline-flex items-center gap-2 rounded-full border-zine border-ink bg-mint px-4 py-2.5 font-display font-semibold text-[15px] text-mintInk shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
      >
        <span className="text-[17px] leading-none">✨</span> Donate
      </button>

      <Sheet open={open} onClose={() => !busy && setOpen(false)} title="Send Tokens" dismissable={!busy}>
        {sent ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="text-[56px] leading-none" style={{ animation: 'zine-pop 0.5s ease-out' }}>✨</span>
            <p className="font-display font-semibold text-[20px] text-ink">Sent {amount} Tokens!</p>
            <p className="font-body font-bold text-[14px] text-inkSoft">Thanks for supporting the creator.</p>
            <style>{'@keyframes zine-pop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.25)}100%{transform:scale(1);opacity:1}}'}</style>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  className={[
                    'rounded-zineSm border-zine px-2 py-3 font-mono font-bold text-[15px] tabular-nums shadow-zine-xs transition-transform duration-zine active:translate-y-[1px]',
                    amount === p ? 'border-ink bg-mint text-mintInk' : 'border-ink bg-card text-ink',
                  ].join(' ')}
                >
                  {p}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">Custom amount</span>
              <input
                type="number"
                min={1}
                max={100000}
                value={amount}
                onChange={(e) => setAmount(Math.max(0, Math.min(100000, Math.trunc(Number(e.target.value) || 0))))}
                className="mt-1 w-full rounded-zineField border-zine border-ink bg-paper px-3 py-2.5 font-mono font-bold text-[16px] text-ink focus:outline-none focus:shadow-zine-focus"
              />
            </label>

            {error && (
              <p className="rounded-zineSm border-zine border-ink bg-coral px-3 py-2 font-body font-bold text-[13px] text-white">
                {error}
              </p>
            )}

            {needsFunds ? (
              <a
                href="/dashboard"
                className="flex w-full items-center justify-center rounded-full border-zine border-ink bg-lime px-6 py-3.5 font-display font-semibold text-[18px] text-ink no-underline shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
              >
                Top up your wallet
              </a>
            ) : (
              <button
                type="button"
                disabled={busy || amount <= 0}
                onClick={donate}
                className="flex w-full items-center justify-center gap-2 rounded-full border-zine border-ink bg-lime px-6 py-3.5 font-display font-semibold text-[18px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:border-inkMute disabled:bg-paper2 disabled:text-inkMute disabled:shadow-none"
              >
                {busy ? 'Sending…' : `Send ${amount} Tokens`}
              </button>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}

export default DonateButton;
