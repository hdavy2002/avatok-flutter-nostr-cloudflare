/* [HF-CLOSE-UPI-1] Withdrawal setup on the website, for EVERYONE (fans too, rulebook HF-REEL-36): add / change the UPI ID, and see / start the one-time
 * ID check. Used on Wallet ("Withdrawal setup") and on the Close my account page, so a fan can close there without the app.
 * Worker: PUT /api/hf/payouts/upi (format check only, no name check), GET /api/hf/payouts/summary. The saved UPI is shown masked (never in full).
 * The ID check is /verify/id (Aadhaar OTP, DigiLocker as the fallback). Telemetry: hf_payout_upi_saved / hf_payout_upi_failed / hf_payout_idcheck_clicked.
 * [HF-PAYOUT-CARD] Also the body of the "Payout details" card (PayoutDetails.tsx). Shows the name check the API returns (upi.nameMatched) and
 * fires PAYOUT_CHANGED on save so every other copy on the page (the Withdraw card) re-reads; it listens to the same event itself. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException, currentDistinctUid } from '../../lib/analytics';
import { ApiError, cleanUpi, fetchPayoutSummary, maskUpi, saveUpi, upiSaveMessage, UPI_RE, type PayoutSummary } from '../../lib/hfPayoutApi';

/** [HF-PAYOUT-CARD] Window event fired after a UPI ID is saved anywhere on the page. */
export const PAYOUT_CHANGED = 'hf-payout-changed';

interface Props {
  /** Where the ID check sends the person back to (a path under /dashboard). */
  next: string;
  /** Which button/field classes to use: the dashboard (h3) or the older account pages (hfc). */
  skin: 'h3' | 'hfc';
  /** Called after the UPI ID is saved, so the page can re-read its own state. */
  onSaved?: () => void;
  /** Where this form sits, for telemetry. */
  where: 'wallet' | 'close' | 'earnings';
}

export const idCheckHref = (next: string) => `/verify/id?next=${encodeURIComponent(next)}`;

export default function UpiSetup({ next, skin, onSaved, where }: Props) {
  const [sum, setSum] = useState<PayoutSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [vpa, setVpa] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const uid = () => ({ uid: currentDistinctUid(), where });

  const load = useCallback(async () => {
    setFailed(false);
    try { const s = await fetchPayoutSummary(); setSum(s); setEditing(!s.upi); }
    catch (e) {
      setFailed(true);
      capture('hf_payout_setup_load_failed', { ...uid(), status: e instanceof ApiError ? e.status : 0 });
      if (!(e instanceof ApiError)) captureException(e, { area: 'hf_payout_setup', step: 'load', ...uid() });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const on = () => { void load(); };
    window.addEventListener(PAYOUT_CHANGED, on);
    return () => window.removeEventListener(PAYOUT_CHANGED, on);
  }, [load]);

  const btn = skin === 'h3' ? 'h3-btn' : 'hfc-btn';
  const primary = skin === 'h3' ? 'h3-btn rani' : 'hfc-btn hfc-primary';
  const ghost = skin === 'h3' ? 'h3-btn sm ghost' : 'hfc-btn';
  const valid = UPI_RE.test(cleanUpi(vpa));

  async function save() {
    if (!valid || busy) return;
    setBusy(true); setMsg(null);
    try {
      await saveUpi(cleanUpi(vpa));
      capture('hf_payout_upi_saved', uid());
      setVpa(''); setMsg({ kind: 'ok', text: 'Your UPI ID is saved.' });
      await load(); onSaved?.();
      try { window.dispatchEvent(new Event(PAYOUT_CHANGED)); } catch { /* ignore */ }
    } catch (e) {
      const code = e instanceof ApiError && e.body && typeof e.body === 'object' ? String((e.body as { error?: unknown }).error ?? '') : '';
      capture('hf_payout_upi_failed', { ...uid(), error: code || (e instanceof ApiError ? `http_${e.status}` : 'network'), status: e instanceof ApiError ? e.status : 0 });
      if (!(e instanceof ApiError)) captureException(e, { area: 'hf_payout_setup', step: 'save', ...uid() });
      setMsg({ kind: 'err', text: upiSaveMessage(e) });
    }
    setBusy(false);
  }

  if (failed) return <div><p className="small" role="alert" style={{ color: 'var(--bad, #b3261e)' }}>We could not load your withdrawal details.</p><button type="button" className={ghost} onClick={() => void load()}>Try again</button></div>;
  if (!sum) return <p className="small muted" role="status">Loading…</p>;
  const kyc = sum.kycStatus === 'verified';
  return <div style={{ display: 'grid', gap: 12 }}>
    <div>
      <b>1. Your UPI ID</b>
      {sum.upi && !editing
        ? <p className="small" style={{ marginTop: 4 }}>Saved: <b>{maskUpi(sum.upi.vpa)}</b> · money is paid only to this UPI ID. <button type="button" className={ghost} style={{ marginLeft: 6 }} onClick={() => { setEditing(true); setMsg(null); }}>Change</button></p>
        : <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: 'grid', gap: 8, marginTop: 6 }}>
            <label className={skin === 'h3' ? 'f' : undefined}>Your own UPI ID, like name@bank
              <input value={vpa} onChange={e => setVpa(e.target.value.slice(0, 80))} autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="email" placeholder="name@bank" aria-label="UPI ID" aria-invalid={vpa !== '' && !valid} disabled={busy} />
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="submit" className={primary} disabled={!valid || busy}>{busy ? 'Saving…' : 'Save UPI ID'}</button>
              {sum.upi && <button type="button" className={btn} disabled={busy} onClick={() => { setEditing(false); setVpa(''); setMsg(null); }}>Cancel</button>}
            </div>
            <p className="small muted">Use a UPI ID in your own name. We do not show it to anyone else, and only the first two letters are shown back to you.</p>
          </form>}
    </div>
    {sum.upi && !editing && <NameCheck matched={sum.upi.nameMatched} />}
    <div>
      <b>2. One-time ID check</b>
      {kyc
        ? <p className="small" style={{ marginTop: 4 }}>Done. We do not ask again.</p>
        : <p className="small" style={{ marginTop: 4 }}>We check your ID once, before your first withdrawal (Aadhaar with an OTP, or DigiLocker). <a className={ghost} style={{ marginLeft: 6 }} href={idCheckHref(next)} onClick={() => capture('hf_payout_idcheck_clicked', uid())}>Do the ID check</a></p>}
    </div>
    {msg && <p role="status" className="small" style={{ color: msg.kind === 'err' ? 'var(--bad, #b3261e)' : 'var(--peacock, #1b6b5f)', fontWeight: 700 }}>{msg.text}</p>}
  </div>;
}

/** [HF-PAYOUT-CARD] The name check on the saved UPI ID, as the API returns it (true / false / not checked yet). */
function NameCheck({ matched }: { matched: boolean | null }) {
  if (matched === true) return <p className="small" style={{ margin: 0, color: 'var(--peacock, #1b6b5f)', fontWeight: 700 }}>Name check: the name on this UPI ID matches your ID.</p>;
  if (matched === false) return <p className="small" role="alert" style={{ margin: 0, color: 'var(--bad, #b3261e)', fontWeight: 700 }}>Name check: the name on this UPI ID does not match your ID. Change it to a UPI ID in your own name.</p>;
  return <p className="small muted" style={{ margin: 0 }}>Name check: not checked yet. We pay only to a UPI ID in your own name, and a person checks it before every payment.</p>;
}
