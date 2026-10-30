/* [HF-DASH-V3-1] Wallet: balance card, Add money (Cashfree on the website, Google Play inside the app), money in and out, refunds,
 * history with filters, payment receipts, the Standard plan rate card and (for influencers) earnings.
 * Worker: GET /api/hf/wallet, POST/GET /api/hf/wallet/topup, /api/hf/wallet/refunds, /api/hf/wallet/receipts (unchanged contracts). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchWallet, hostPaise, relDate, type WalletHistoryItem } from '../../../lib/hfCallsApi';
import { formatPaise, consistentGstPaise } from '../../../lib/money';
import { isAppMode } from '../../../lib/nativeBridge';
import { BRAND } from '../../../lib/brand';
import { capture } from '../../../lib/analytics';
import { rateCardLines } from '../../../lib/hfStdPlan';
import { fetchTopupConfig, gatewaySupported, openCheckout, startTopup, topupErrorMessage, topupPreview, waitForTopup, type TopupConfig, type TopupStatus } from '../../../lib/hfTopupApi';
import { fetchRefunds, type RefundInfo } from '../../../lib/hfWalletExitApi';
import { fetchReceipts, openReceipt, receiptSplit, RECEIPT_FAIL_MSG, RECEIPT_POPUP_MSG, type ReceiptItem } from '../../../lib/hfReceiptsApi';
import TokensPanel from '../../wallet/TokensPanel';
import Withdraw from '../../wallet/Withdraw'; // [HF-WITHDRAW-1] Withdraw card (UPI setup + ID check + request + status list)
import PayoutDetails, { PAYOUT_DETAILS_ID } from '../../wallet/PayoutDetails'; // [HF-PAYOUT-CARD]
import { useDash, spendablePaise } from './data';
import { useCached } from './swr'; // [HF-DASH-CACHE-1]
import { Card, Dialog, Empty, Failed, FlowerCluster, Ic, PageHead, Petals, Skel, Sticker, fmtInt, istDay, useToast } from './ui';

type Tab = 'all' | 'purchase' | 'call_spent' | 'call_refund' | 'test';
const KIND: Record<string, { label: string; cls: string; tab: Tab }> = {
  purchase: { label: 'Top-up', cls: '', tab: 'purchase' }, call_spent: { label: 'Call', cls: 'lav', tab: 'call_spent' },
  call_refund: { label: 'Correction', cls: 'gold', tab: 'call_refund' }, test_credit: { label: 'Test credit', cls: 'gold', tab: 'test' },
  test_credit_removed: { label: 'Test credit', cls: 'dec', tab: 'test' }, call_earned: { label: 'Earned', cls: '', tab: 'all' },
  // [HF-WALLET-DEDUCTIONS-1] money that left the wallet for something other than a call, and its refunds
  merch_spent: { label: 'Merch', cls: 'dec', tab: 'call_spent' }, ai_spent: { label: 'AI picture', cls: 'dec', tab: 'call_spent' },
  merch_refund: { label: 'Refund', cls: 'gold', tab: 'call_refund' }, ai_refund: { label: 'Refund', cls: 'gold', tab: 'call_refund' },
  payout_take: { label: 'Withdrawal', cls: 'dec', tab: 'all' }, payout_return: { label: 'Refund', cls: 'gold', tab: 'call_refund' },
};
const SPENT = new Set(['call_spent', 'merch_spent', 'ai_spent']);
const paiseOf = (h: WalletHistoryItem) => h.amountPaise ?? (h.rupees != null ? Math.round(h.rupees * 100) : 0);

export default function Wallet() {
  const { wallet, reload } = useDash();
  const toast = useToast();
  const w = wallet.data;
  const bal = spendablePaise(w);
  const [tab, setTab] = useState<Tab>('all');
  const [rcptKey, setRcptKey] = useState(0);
  const app = (() => { try { return isAppMode(); } catch { return false; } })();

  useEffect(() => { const h = location.hash.replace('#', ''); if (h === 'add' || h === 'withdraw' || h === 'payout') setTimeout(() => document.getElementById(h === 'payout' ? 'withdraw' : h)?.scrollIntoView({ block: 'start' }), 350); }, []);
  const hist = useMemo(() => (w?.history ?? []).filter(h => tab === 'all' || (KIND[h.kind]?.tab ?? 'all') === tab), [w, tab]);
  const added = (w?.history ?? []).filter(h => h.kind === 'purchase').reduce((s, h) => s + (h.purchase?.walletPaise ?? Math.max(0, paiseOf(h))), 0);
  const used = (w?.history ?? []).filter(h => SPENT.has(h.kind)).reduce((s, h) => s + Math.abs(paiseOf(h)), 0);
  const hp = w?.host ? hostPaise(w.host) : null;

  return <>
    <PageHead eyebrow="Wallet" title="Paisa vasool, har baar" sub="Your balance, top-ups, refunds and payment receipts — all in rupees." art={<Sticker name="kachori" w={104} rot={6} />} />
    {wallet.failed && <Failed onRetry={() => reload('wallet')} />}
    <section className="h3-row c2">
      <div className="h3-walletcard"><FlowerCluster style={{ right: -40, top: -30, opacity: .55 }} />
        <div style={{ position: 'relative', zIndex: 2 }}>
          <div className="lbl">Wallet balance</div>
          <div className="bal">{bal == null ? '—' : formatPaise(bal)}</div>
          {w?.wallet && w.wallet.reservedPaise > 0 && <div className="small" style={{ opacity: .9 }}>{formatPaise(w.wallet.reservedPaise)} is reserved for a call or appointment.</div>}
          {w?.wallet && w.wallet.testPaise > 0 && <div className="small" style={{ opacity: .9 }}>{formatPaise(w.wallet.testPaise)} of this is test credit (spend only, can’t be refunded).</div>}
          {w?.wallet?.debtOpen && <div className="small" style={{ background: 'rgba(255,255,255,.18)', borderRadius: 10, padding: '6px 10px', marginTop: 6 }}>You owe {formatPaise(w.wallet.debtPaise)} after a refund. It is cleared from the next money you add.</div>}
          <div className="small" style={{ opacity: .85, marginTop: 4 }}>Spend it on calls and appointments. Every rupee is a rupee of talk time.</div>
          <div className="row"><a className="h3-btn gold" href="#add"><Ic name="plus" className="" />Add money</a><a className="h3-btn ghost" href="#withdraw">Withdraw to UPI</a></div>
        </div>
      </div>
      <Card title="Add money" note="Any whole amount · 18% GST is deducted from what you pay" tone={1} id="add">
        {app ? <TokensPanel /> : <AddMoney onPaid={(text) => { toast(text); reload('wallet'); setRcptKey(k => k + 1); }} />}
      </Card>
    </section>

    {/* [HF-WITHDRAW-1] Withdraw for everyone (fans too, HF-REEL-36): amount, the UPI it goes to, confirm, and the status of every request. The old
        "Withdrawal setup" (UPI ID + one-time ID check) lives inside this card and shows first while either is missing. #payout is kept as an alias. */}
    <Card title="Withdraw" note="Take your wallet money out to your own UPI. No fee." id="withdraw">
      <span id="payout" />
      <Withdraw where="wallet" skin="h3" next="/dashboard/wallet" debtOpen={!!w?.wallet?.debtOpen} onChanged={() => reload('wallet')} detailsHref={`#${PAYOUT_DETAILS_ID}`} />
    </Card>
    {/* [HF-PAYOUT-CARD] Add / change the UPI ID and see the name check + ID check. Replaces /hosts/onboarding?step=payout. */}
    <Card title="Payout details" note="Where your withdrawals are paid" tone={1} id={PAYOUT_DETAILS_ID}>
      <PayoutDetails where="wallet" skin="h3" next="/dashboard/wallet" />
    </Card>

    <section className="h3-row c21">
      <Card title="History" note="Every rupee in and out">
        <div className="h3-tabs">{([['all', 'All'], ['purchase', 'Top-ups'], ['call_spent', 'Spent'], ['call_refund', 'Refunds'], ['test', 'Test credits']] as [Tab, string][]).map(([k, l]) =>
          <button key={k} type="button" className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
        <div className="h3-scroll">{!w ? <Skel h={240} /> : hist.length === 0 ? <Empty text="Nothing here yet. Top-ups, calls and things you buy show up here." /> :
          <table className="h3-table"><thead><tr><th>Type</th><th>What</th><th className="hide-n">When</th><th className="r">Amount</th></tr></thead><tbody>
            {hist.map((h, i) => { const k = KIND[h.kind] ?? { label: 'Wallet', cls: 'dec' }; const v = paiseOf(h); return <tr key={`${h.at}-${h.callId ?? i}`} style={{ cursor: 'default' }}>
              <td><span className={`h3-chip ${k.cls}`}>{k.label}</span></td>
              <td>{h.kind === 'call_refund' ? 'Call charge corrected' : h.label}{h.purchase && <div className="small muted">Paid {formatPaise(h.purchase.paidPaise)} − GST {formatPaise(consistentGstPaise(h.purchase.paidPaise, h.purchase.gstPaise, h.purchase.walletPaise))} = added {formatPaise(h.purchase.walletPaise)}</div>}</td>
              <td className="hide-n small muted">{relDate(h.at)}</td>
              <td className={`r ${v > 0 ? 'h3-pos' : 'h3-neg'}`}>{h.amount ?? (h.tokens !== undefined ? h.tokens : `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatPaise(Math.abs(v))}`)}</td></tr>; })}
          </tbody></table>}</div>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card title="In & out" note="Across your wallet history" tone={1}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ padding: 14, borderRadius: 16, background: 'var(--teatint)' }}><div className="small muted">Added</div><div className="num" style={{ fontSize: '1.5rem', color: 'var(--peacock)' }}>{w ? formatPaise(added) : '—'}</div></div>
            <div style={{ padding: 14, borderRadius: 16, background: 'var(--blush)' }}><div className="small muted">Spent</div><div className="num" style={{ fontSize: '1.5rem', color: 'var(--rani)' }}>{w ? formatPaise(used) : '—'}</div></div>
          </div>
          <RefundBox key={`rf${rcptKey}`} />
        </Card>
        <Card title="Payment receipts" note={`Sent to WhatsApp and email after every top-up`}><Receipts reloadKey={rcptKey} /></Card>
        {w?.mode === 'rupees' && !w.plan?.influencerSetsRate && <Card title="Call rates" note="Each influencer sets their own rate; you see it before you call" tone={1}><div className="h3-break">{rateCardLines(w.plan?.tiers).map(l => <div key={l}><span>{l}</span></div>)}</div></Card>}
      </div>
    </section>

    {w?.host && hp && <Card title="Influencer earnings" note="From calls you received" link={{ label: 'Earnings & withdrawals', href: '/dashboard/host/earnings' }}>
      <div className="h3-kpis">
        <div><div className="small muted">Pending (7-day hold)</div><div className="num" style={{ fontSize: '1.6rem' }}>{formatPaise(hp.pending)}</div></div>
        <div><div className="small muted">Available to withdraw</div><div className="num" style={{ fontSize: '1.6rem' }}>{formatPaise(hp.available)}</div></div>
        <div><div className="small muted">Total earned</div><div className="num" style={{ fontSize: '1.6rem' }}>{formatPaise(hp.total)}</div></div>
      </div>
    </Card>}

  </>;
}

function paidText(r: TopupStatus): string {
  if (r.walletPaise == null) return `₹${fmtInt(r.amountRupees)} added to your wallet.`;
  return `Paisa aa gaya! ${formatPaise(r.walletPaise)} added to your wallet (you paid ${formatPaise(r.paidPaise ?? r.amountRupees * 100)} − your GST ${formatPaise(r.gstPaise ?? 0)}).`;
}

function AddMoney({ onPaid }: { onPaid: (text: string) => void }) {
  const [cfg, setCfg] = useState<TopupConfig | null>(null);
  const [amt, setAmt] = useState(() => { const a = Number(new URLSearchParams(location.search).get('amount')); return Number.isInteger(a) && a > 0 ? String(a) : '500'; });
  const [phase, setPhase] = useState<'idle' | 'starting' | 'paying' | 'confirming'>('idle');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [party, setParty] = useState(0);
  const paid = useRef(onPaid); paid.current = onPaid;
  useEffect(() => {
    let live = true;
    void fetchTopupConfig().then(c => { if (live) setCfg(c); });
    const back = new URLSearchParams(location.search).get('topup');
    if (back && /^hftop_[a-f0-9]{24}$/.test(back)) {
      setPhase('confirming'); setMsg({ kind: 'info', text: 'Confirming your payment…' });
      void waitForTopup(back).then(r => {
        if (!live) return;
        setPhase('idle');
        if (r?.credited) { const t = paidText(r); setMsg({ kind: 'ok', text: t }); setParty(p => p + 1); paid.current(t); capture('hf_dash3_topup_credited', { amount: r.amountRupees }); }
        else setMsg({ kind: 'info', text: 'We have not received the payment yet. If money was taken it will show up here shortly.' });
        history.replaceState(null, '', location.pathname);
      });
    }
    return () => { live = false; };
  }, []);
  if (!cfg) return <Skel h={220} />;
  if (!cfg.enabled || !gatewaySupported(cfg.gateway)) return <p className="small muted">Adding money on the website opens soon. You can add money in the {BRAND.name} app.</p>;
  const a = Math.floor(Number(amt) || 0);
  const ok = Number.isInteger(a) && a >= cfg.minRupees && a <= cfg.maxRupees;
  const prev = topupPreview(ok ? a : 0, cfg.gstBps);
  const busy = phase !== 'idle';
  const ask = () => { if (!ok || busy) return; if (cfg.confirmAboveRupees > 0 && a >= cfg.confirmAboveRupees) { setConfirm(a); return; } void pay(a); };
  async function pay(amount: number) {
    setConfirm(null); setMsg(null); setPhase('starting');
    capture('hf_dash3_topup_start', { amount });
    let order;
    try { order = await startTopup(amount); } catch (e) { setPhase('idle'); setMsg({ kind: 'err', text: topupErrorMessage(e) }); return; }
    setPhase('paying');
    try { await openCheckout(order.gateway, order.client_payload, order.testMode); }
    catch (e) { setPhase('idle'); setMsg((e as Error)?.message === 'dismissed' ? { kind: 'info', text: 'Payment cancelled. Nothing was charged.' } : { kind: 'err', text: 'The payment window could not open. Please try again.' }); return; }
    setPhase('confirming'); setMsg({ kind: 'info', text: 'Confirming your payment…' });
    const r = await waitForTopup(order.topupId);
    setPhase('idle');
    if (r?.credited) { const t = paidText(r); setMsg({ kind: 'ok', text: t }); setParty(p => p + 1); paid.current(t); capture('hf_dash3_topup_credited', { amount }); }
    else if (r?.status === 'failed') setMsg({ kind: 'err', text: 'The payment did not go through. Nothing was charged.' });
    else setMsg({ kind: 'info', text: 'We have not received the payment yet. If money was taken it will show up here shortly.' });
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' }}>
    <Petals run={party} />
    {cfg.testMode && <p className="small" style={{ color: 'var(--amber)' }} role="note">Test mode — no real money moves.</p>}
    <label className="f">How much? (₹{fmtInt(cfg.minRupees)} – ₹{fmtInt(cfg.maxRupees)})<input inputMode="numeric" value={amt} disabled={busy} onChange={e => setAmt(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} aria-label="Amount in rupees" /></label>
    <div className="h3-amounts">{(cfg.packs.length ? cfg.packs : [100, 250, 500, 1000]).map(v => <button key={v} type="button" className={v === a ? 'on' : ''} disabled={busy} onClick={() => setAmt(String(v))}>₹{fmtInt(v)}</button>)}</div>
    <div className="h3-break" aria-live="polite">
      <div><span>You pay</span><b>{formatPaise(prev.paidPaise)}</b></div>
      <div className="muted"><span>Your GST ({(cfg.gstBps / 100).toFixed(0)}%)</span><span>− {formatPaise(prev.gstPaise)}</span></div>
      <div className="tot"><span>Wallet gets</span><span>{formatPaise(prev.walletPaise)}</span></div>
    </div>
    <button type="button" className="h3-btn rani" style={{ width: '100%' }} disabled={!ok || busy} onClick={ask}><Ic name="wallet" className="" />
      {phase === 'starting' ? 'Starting…' : phase === 'paying' ? 'Opening payment…' : phase === 'confirming' ? 'Confirming…' : ok ? `Pay ₹${fmtInt(a)} securely` : `Enter ₹${fmtInt(cfg.minRupees)} – ₹${fmtInt(cfg.maxRupees)}`}</button>
    <div className="small muted" style={{ textAlign: 'center' }}>🔒 Secure checkout · UPI, cards, netbanking · receipt on WhatsApp & email</div>
    {msg && <p role="status" className="small" style={{ color: msg.kind === 'err' ? 'var(--bad)' : msg.kind === 'ok' ? 'var(--peacock)' : 'var(--muted)', fontWeight: 700 }}>{msg.text}</p>}
    <Dialog open={confirm != null} onClose={() => setConfirm(null)} label="Confirm amount">
      <div style={{ textAlign: 'center' }}><Sticker name="kyabaat" w={110} rot={-4} /><h2 style={{ marginTop: 10 }}>Add ₹{fmtInt(confirm ?? 0)}?</h2>
        <p className="muted small">{BRAND.name} calls are for friendly conversation — only add what you’re comfortable spending. <a href="/wellbeing">Use it in a healthy way</a>.</p>
        <div className="acts"><button type="button" className="h3-btn rani" onClick={() => confirm != null && void pay(confirm)}>Yes, add ₹{fmtInt(confirm ?? 0)}</button><button type="button" className="h3-btn ghost" onClick={() => setConfirm(null)}>No, go back</button></div></div>
    </Dialog>
  </div>;
}

function RefundBox() {
  const { data: info } = useCached<RefundInfo | null>('wallet:refunds', () => fetchRefunds().catch(() => null), 30_000); // [HF-DASH-CACHE-1] last answer at once, refreshed quietly
  if (!info) return null;
  const open = info.requests.find(r => r.status === 'requested' || r.status === 'processing');
  return <div style={{ marginTop: 12, padding: 14, borderRadius: 16, background: 'var(--cream)', border: '1px dashed var(--line)' }}>
    <p className="small muted">Refunds go to your wallet, never to your card or UPI. To take money out, use <a href="#withdraw">Withdraw</a> on this page (or in the app: Me, then Withdraw). It goes to your own UPI after a one-time ID check, or it is paid out when you close your account.</p>
    {open && <p className="small" style={{ marginTop: 8 }}>A refund of {formatPaise(Math.round(open.amount * 100))} is in progress.</p>}
  </div>;
}

function Receipts({ reloadKey }: { reloadKey: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  // [HF-DASH-CACHE-1] cached receipts paint at once; a new top-up (reloadKey) forces a re-read.
  const { data: rr } = useCached('wallet:receipts', fetchReceipts, 30_000, reloadKey);
  const items: ReceiptItem[] | null = rr ? (rr.ok ? rr.data.receipts : []) : null;
  const failed = !!rr && !rr.ok;
  if (items === null) return <Skel h={100} />;
  if (failed) return <Failed text="We could not load your receipts." />;
  if (!items.length) return <p className="small muted">Your first top-up receipt will show up here.</p>;
  return <div>{items.slice(0, 8).map(r => { const sp = receiptSplit(r); return <div key={r.id} className="h3-rcpt">
    <div><b>{r.number}</b><div className="small muted">{r.kind === 'tax_invoice' ? 'Tax invoice' : 'Payment receipt'} · {istDay(r.issuedAt)}{sp ? ` · paid ${formatPaise(sp.paid)} − GST ${formatPaise(sp.gst)}` : ` · ${formatPaise(Math.round(r.amountRupees * 100))}`}</div></div>
    <button type="button" className="h3-btn sm ghost" disabled={busy === r.id} onClick={async () => { setBusy(r.id); const res = await openReceipt(r.id); setBusy(null); if (res === 'popup_blocked') toast(RECEIPT_POPUP_MSG); else if (res === 'failed') toast(RECEIPT_FAIL_MSG); }}><Ic name="down" className="" />{busy === r.id ? 'Opening…' : 'View'}</button>
  </div>; })}</div>;
}
