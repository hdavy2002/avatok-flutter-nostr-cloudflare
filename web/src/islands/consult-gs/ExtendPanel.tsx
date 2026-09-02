/*
 * ExtendPanel — the "+ extend time" flow (SPEC-2026-09-01 §4.4).
 *
 * RULE (non-negotiable per the spec): the price is shown in rupees, via
 * `inr()`, BEFORE either side confirms anything. Nothing here ever calls
 * confirm(accept: true) as a side effect of opening the panel — only an
 * explicit click does that.
 *
 * Dual consent, as implemented server-side
 * (`commercialConsultExtensionQuote`/`commercialConsultExtensionConfirm`):
 * quoting is idempotent and deterministic per (booking, current end time,
 * configured minutes), so whichever party opens this panel next sees the
 * SAME pending extension and its current consent flags — that is how the
 * other party learns a request exists, since there is no separate
 * notification channel on this GetStream-only lane. Once my own consent is
 * registered, this panel polls `confirm(accept: true)` (safe / idempotent
 * for a party who already consented) until the row reaches a terminal state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '../../components';
import { inr } from '../../lib/money';
import { capture } from '../../lib/analytics';
import { quoteExtension, confirmExtension, type ExtensionQuote } from './extend';

export interface ExtendPanelProps {
  bookingId: string;
  jwt: string;
  /** 'creator' | 'buyer' — which consent flag is "mine". */
  role: 'creator' | 'buyer';
  onClose: () => void;
  /** Fired once the extension is applied, with the new authoritative end time. */
  onExtended: (newEndsAtMs: number) => void;
}

type Step = 'loading' | 'quoted' | 'waiting' | 'error' | 'unavailable';

const POLL_MS = 3000;
const MAX_POLLS = 100; // ~5 minutes — long enough for a slow counterpart, not forever.

export function ExtendPanel({ bookingId, jwt, role, onClose, onExtended }: ExtendPanelProps) {
  const [step, setStep] = useState<Step>('loading');
  const [quote, setQuote] = useState<ExtensionQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const quoteRef = useRef<ExtensionQuote | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCountRef = useRef(0);
  const closedRef = useRef(false);

  const myConsent = (q: ExtensionQuote) => (role === 'creator' ? q.creator_consented : q.buyer_consented);
  const theirConsent = (q: ExtensionQuote) => (role === 'creator' ? q.buyer_consented : q.creator_consented);

  const stopPolling = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  };

  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      stopPolling();
    };
  }, []);

  // `poll` reads the extension id from a ref, never from the `quote` state
  // closure — a `setTimeout(poll, …)` scheduled inside the SAME render that
  // just called `setQuote` would otherwise capture the pre-update value.
  const poll = useCallback(async () => {
    const current = quoteRef.current;
    if (closedRef.current || !current) return;
    pollCountRef.current += 1;
    const r = await confirmExtension(bookingId, jwt, current.extension_id, true);
    if (closedRef.current) return;
    if ('error' in r) {
      setStep('error');
      setError(r.error || 'Lost track of the extension request.');
      return;
    }
    if ('extension_id' in r) {
      quoteRef.current = r;
      setQuote(r);
      if (r.state === 'applied') {
        try {
          capture('consult_extension_confirm', { outcome: 'ok' });
        } catch {
          /* best-effort */
        }
        onExtended(r.extension_ends_at);
        onClose();
        return;
      }
      if (r.state === 'declined' || r.state === 'failed') {
        setStep('error');
        setError(r.state === 'declined' ? 'The other side declined the extension.' : 'The extension could not be completed.');
        try {
          capture('consult_extension_confirm', { outcome: 'refused', reason: r.state });
        } catch {
          /* best-effort */
        }
        return;
      }
      if (pollCountRef.current < MAX_POLLS) {
        pollRef.current = setTimeout(poll, POLL_MS);
      } else {
        setStep('error');
        setError('Still waiting on the other side. You can try again in a moment.');
      }
      return;
    }
    // Terminal 202 outcome (schedule conflict / verification failed / refunded).
    setStep('error');
    setError(r.reason || 'The extension could not be applied — any hold was refunded.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, jwt, onClose, onExtended]);

  const fetchQuote = useCallback(async () => {
    setStep('loading');
    setError(null);
    const r = await quoteExtension(bookingId, jwt);
    if (closedRef.current) return;
    if ('error' in r) {
      setStep(r.status === 404 ? 'unavailable' : 'error');
      setError(r.status === 404 ? 'Extending this session isn’t available right now.' : (r.error || 'Could not price the extension.'));
      try {
        capture('consult_extension_quote', { outcome: 'error' });
      } catch {
        /* best-effort */
      }
      return;
    }
    try {
      capture('consult_extension_quote', { outcome: 'ok' });
    } catch {
      /* best-effort */
    }
    quoteRef.current = r;
    setQuote(r);
    if (r.state === 'applied') {
      onExtended(r.extension_ends_at);
      onClose();
      return;
    }
    setStep(myConsent(r) ? 'waiting' : 'quoted');
    if (myConsent(r) && r.state !== 'declined' && r.state !== 'failed') {
      pollCountRef.current = 0;
      pollRef.current = setTimeout(poll, POLL_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, jwt, poll]);

  useEffect(() => {
    void fetchQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = async () => {
    if (!quote) return;
    setStep('waiting');
    stopPolling();
    const r = await confirmExtension(bookingId, jwt, quote.extension_id, true);
    if (closedRef.current) return;
    if ('error' in r) {
      setStep('error');
      setError(r.error || 'Could not confirm the extension.');
      try {
        capture('consult_extension_confirm', { outcome: 'error' });
      } catch {
        /* best-effort */
      }
      return;
    }
    if ('extension_id' in r) {
      quoteRef.current = r;
      setQuote(r);
      if (r.state === 'applied') {
        try {
          capture('consult_extension_confirm', { outcome: 'ok' });
        } catch {
          /* best-effort */
        }
        onExtended(r.extension_ends_at);
        onClose();
        return;
      }
      pollCountRef.current = 0;
      pollRef.current = setTimeout(poll, POLL_MS);
      return;
    }
    setStep('error');
    setError(r.reason || 'The extension could not be applied.');
    try {
      capture('consult_extension_confirm', { outcome: 'refused', reason: r.reason });
    } catch {
      /* best-effort */
    }
  };

  const decline = async () => {
    stopPolling();
    if (quote) {
      try {
        await confirmExtension(bookingId, jwt, quote.extension_id, false);
        capture('consult_extension_confirm', { outcome: 'refused', reason: 'declined' });
      } catch {
        /* best-effort */
      }
    }
    onClose();
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-ink/60 p-4">
      <div className="w-full max-w-sm rounded-zine border-zine border-ink bg-card p-5 shadow-zine">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display font-semibold text-[19px] text-ink">Extend this session</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={decline}
            className="font-display text-[18px] text-inkMute"
          >
            ✕
          </button>
        </div>

        {step === 'loading' && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Spinner size={24} />
            <p className="font-body font-bold text-[14px] text-inkSoft">Pricing the extension…</p>
          </div>
        )}

        {(step === 'quoted' || step === 'waiting') && quote && (
          <div className="flex flex-col gap-4">
            <p className="font-body font-bold text-[15px] text-inkSoft">
              +{quote.extension_minutes} minutes for{' '}
              <span className="text-ink">{inr(quote.amount)}</span>
              {quote.rate_per_minute > 0 && (
                <span className="text-inkMute"> ({inr(quote.rate_per_minute)}/min)</span>
              )}
            </p>
            <p className="font-body font-bold text-[13px] text-inkMute">
              Held from your wallet only once both sides agree. Nothing is charged before that.
            </p>

            {step === 'waiting' ? (
              <div className="flex items-center gap-2 rounded-zine-field border-zine border-ink bg-paper2 px-3 py-2.5">
                <Spinner size={18} />
                <span className="font-body font-bold text-[13px] text-inkSoft">
                  {theirConsent(quote)
                    ? 'Finishing up…'
                    : `Waiting for the other side to accept…`}
                </span>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button variant="lime" fullWidth label={`Accept — ${inr(quote.amount)}`} onClick={() => void accept()} />
                <Button variant="ghost" label="Not now" onClick={() => void decline()} />
              </div>
            )}
          </div>
        )}

        {(step === 'error' || step === 'unavailable') && (
          <div className="flex flex-col gap-4">
            <p className="font-body font-bold text-[14px] text-ink">{error}</p>
            <div className="flex gap-2">
              {step === 'error' && (
                <Button variant="blue" label="Try again" onClick={() => void fetchQuote()} />
              )}
              <Button variant="ghost" label="Close" onClick={onClose} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ExtendPanel;
