/* [HF-TOPUP-1] "Add money" card on /wallet. Off (default): a calm note and nothing clickable. On: packs + custom amount, then the
 * gateway's own checkout (src/lib/hfTopupApi.ts), then a status poll and onPaid() so the balance refreshes. */
import { useEffect, useState } from 'react';
import { inr } from '../../lib/hfCallsApi';
import { BRAND } from '../../lib/brand';
import {
  fetchTopupConfig, gatewaySupported, openCheckout, startTopup, topupErrorMessage, waitForTopup, type TopupConfig,
} from '../../lib/hfTopupApi';

type Phase = 'idle' | 'starting' | 'paying' | 'confirming';

export default function TopupPanel({ onPaid }: { onPaid: () => void }) {
  const [cfg, setCfg] = useState<TopupConfig | null>(null);
  const [custom, setCustom] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [pending, setPending] = useState<number | null>(null); // [HF-WALLET-LIMITS-1] amount waiting for the "Are you sure?" step

  useEffect(() => {
    let live = true;
    fetchTopupConfig().then(c => { if (live) setCfg(c); });
    // Returning from a redirect-style gateway (?topup=<id>): confirm it.
    const back = new URLSearchParams(location.search).get('topup');
    if (back && /^hftop_[a-f0-9]{24}$/.test(back)) {
      setPhase('confirming'); setMsg({ kind: 'info', text: 'Confirming your payment…' });
      waitForTopup(back).then(r => {
        if (!live) return;
        setPhase('idle');
        if (r?.credited) { setMsg({ kind: 'ok', text: `${inr(r.amountRupees)} added to your wallet.` }); onPaid(); }
        else setMsg({ kind: 'info', text: 'We have not received the payment yet. If money was taken it will show up here shortly.' });
        history.replaceState(null, '', location.pathname);
      });
    }
    return () => { live = false; };
  }, []);

  if (!cfg) return <section className="hfc-card" aria-busy="true"><h2>Add money</h2><p className="hfc-sub" style={{ margin: 0 }}>Loading…</p></section>;

  if (!cfg.enabled || !gatewaySupported(cfg.gateway)) {
    return (
      <section className="hfc-card" aria-labelledby="hft-h">
        <h2 id="hft-h">Add money</h2>
        <p className="hfc-note" style={{ margin: 0 }}>Adding money opens soon — test credits can be added by the team.</p>
      </section>
    );
  }

  const busy = phase !== 'idle';
  const customAmount = Number(custom);
  const customOk = Number.isInteger(customAmount) && customAmount >= cfg.minRupees && customAmount <= cfg.maxRupees;

  /** [HF-WALLET-LIMITS-1] Large top-ups (hfTopupConfirmAboveRupees) get an "Are you sure?" step first (HF-PAY-7). */
  function ask(amount: number) {
    if (!cfg || busy) return;
    if (cfg.confirmAboveRupees > 0 && amount >= cfg.confirmAboveRupees) { setMsg(null); setPending(amount); return; }
    void pay(amount);
  }

  async function pay(amount: number) {
    if (!cfg || busy) return;
    setPending(null);
    setMsg(null); setPhase('starting');
    let order;
    try { order = await startTopup(amount); } catch (e) { setPhase('idle'); setMsg({ kind: 'err', text: topupErrorMessage(e) }); return; }
    setPhase('paying');
    try { await openCheckout(order.gateway, order.client_payload, order.testMode); }
    catch (e) {
      if ((e as Error)?.message === 'dismissed') { setPhase('idle'); setMsg({ kind: 'info', text: 'Payment cancelled. Nothing was charged.' }); return; }
      setPhase('idle'); setMsg({ kind: 'err', text: 'The payment window could not open. Please check your internet and try again.' }); return;
    }
    setPhase('confirming'); setMsg({ kind: 'info', text: 'Confirming your payment…' });
    const r = await waitForTopup(order.topupId);
    setPhase('idle');
    if (r?.credited) { setMsg({ kind: 'ok', text: `${inr(order.amountRupees)} added to your wallet.` }); setCustom(''); onPaid(); }
    else if (r?.status === 'failed') setMsg({ kind: 'err', text: 'The payment did not go through. Nothing was charged.' });
    else setMsg({ kind: 'info', text: 'We have not received the payment yet. If money was taken it will show up here shortly.' });
  }

  return (
    <section className="hfc-card" aria-labelledby="hft-h">
      <h2 id="hft-h">Add money</h2>
      {cfg.testMode && <p className="hfc-note" style={{ margin: 0 }} role="note">Test mode — no real money. Payments here use the gateway’s test environment.</p>}
      <div className="hfc-stats" role="group" aria-label="Choose an amount">
        {cfg.packs.map(a => (
          <button key={a} type="button" className="hfc-btn" disabled={busy} onClick={() => ask(a)}>{inr(a)}</button>
        ))}
      </div>
      <form onSubmit={e => { e.preventDefault(); if (customOk) ask(customAmount); }} style={{ display: 'grid', gap: 8 }}>
        <label htmlFor="hft-custom">Or enter an amount ({inr(cfg.minRupees)} to {inr(cfg.maxRupees)})</label>
        <input id="hft-custom" inputMode="numeric" pattern="[0-9]*" value={custom} disabled={busy}
          onChange={e => setCustom(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} style={{ minHeight: 48, padding: '0 14px', borderRadius: 12, border: '1px solid #cdbbd0', font: 'inherit' }} />
        <button type="submit" className="hfc-btn hfc-primary" disabled={busy || !customOk}>
          {phase === 'starting' ? 'Starting…' : phase === 'confirming' ? 'Confirming…' : customOk ? `Add ${inr(customAmount)}` : 'Add money'}
        </button>
      </form>
      {pending !== null && (
        <div role="alertdialog" aria-labelledby="hft-confirm-h" className="hfc-note" style={{ display: 'grid', gap: 10 }}>
          <strong id="hft-confirm-h">Are you sure you want to add {inr(pending)}?</strong>
          <span>You’re adding {inr(pending)}. {BRAND.name} calls are for friendly conversation — only add what you’re comfortable spending. <a href="/wellbeing">Use it in a healthy way</a>.</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="hfc-btn hfc-primary" style={{ minHeight: 48 }} onClick={() => pay(pending)}>Yes, add {inr(pending)}</button>
            <button type="button" className="hfc-btn" style={{ minHeight: 48 }} onClick={() => setPending(null)}>No, go back</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={msg.kind === 'err' ? 'hfc-err' : msg.kind === 'ok' ? 'hfc-note' : 'hfc-sub'} style={{ margin: 0 }}>{msg.text}</p>}
    </section>
  );
}
