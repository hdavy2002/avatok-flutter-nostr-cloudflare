/* HostReconciliation — [HF-WALLET-LIMITS-1] Admin money reconciliation (HF-PAY-17). Worker: GET /api/admin/hf/reconciliation?from=&to=[&format=csv] (IST dates).
 * Per day: top-ups paid by gateway vs wallet credits, call charges / host earnings / platform share (paid vs test), payouts (UTR), refunds, and a mismatch list.
 * Read only. Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { adminCall } from '../peopleKit';
import { adminBlob, saveBlob } from '../adminApi';
import { Banner, ConsultShell, Spinner, fail, rupees } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
const field = { ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1', minHeight: 44 } as const;

interface Gw { count: number; rupees: number }
interface Day {
  date: string;
  topups: { count: number; rupees: number; byGateway: Record<string, Gw> };
  walletCredits: Gw; calls: { paid: number; test: number }; hostEarnings: { paid: number; test: number }; platformShare: { paid: number; test: number };
  payouts: Gw; refunds: Gw | null;
}
interface Mismatch { kind: string; topupId: string; uid: string; topupRupees: number | null; creditRupees: number | null; detail: string; at: number }
/* [HF-TOK-EXIT-1] Token-era section: present only while tokens are on. Money in paise, tokens in micro-tokens (1 token = 1,000,000). */
interface TokDay {
  date: string;
  purchases: { count: number; paidPaise: number; tokensMicro: number };
  spent: { calls: number; tokensMicro: number; consumedPaise: number; callCostPaise: number; hostPaise: number; platformPaise: number };
  hostLedger: { earningsPaise: number; testEarningsPaise: number };
  refunds: { revocations: number; revokedMicro: number; revokedValuePaise: number; playRefunds: number; playRefundPaise: number; debtsCreated: number; debtsCreatedPaise: number; debtsWrittenOffPaise: number };
  testLots: { grantedLots: number; grantedMicro: number; spentMicro: number; spentValuePaise: number };
}
interface TokMismatch { kind: string; ref: string; uid: string | null; expected: number | null; actual: number | null; detail: string }
interface TokReport {
  days: TokDay[]; totals: Omit<TokDay, 'date'>;
  openDebts: { count: number; valuePaise: number; tokensMicro: number };
  outstanding: { purchaseTokensMicro: number; testTokensMicro: number; hostBalancePaise: number };
  mismatches: TokMismatch[];
}
interface Report {
  tokens?: TokReport;
  from: string; to: string; days: Day[]; totals: Omit<Day, 'date'>; mismatches: Mismatch[];
  payouts: { id: string; host_uid: string; amount_rupees: number; utr: string | null; paid_at: number }[];
  refundsAvailable: boolean; liabilities: { callerWalletsApprox: number; hostEarningsApprox: number; note: string } | null;
}

const istToday = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
const istDaysAgo = (n: number) => new Date(Date.now() + 19_800_000 - n * 86_400_000).toISOString().slice(0, 10);
const KIND: Record<string, string> = {
  paid_without_credit: 'Paid, but no wallet credit', credit_without_paid_topup: 'Wallet credit without a paid top-up', amount_difference: 'Amounts differ',
};
const gw = (d: Omit<Day, 'date'>) => Object.entries(d.topups.byGateway).map(([g, v]) => `${g} ${v.count} (${rupees(v.rupees)})`).join(', ') || '—';
const TOK_KIND: Record<string, string> = {
  lot_balance: 'Token lot balance is wrong', call_split: 'Call value does not add up', host_earning_ledger: 'Host earning differs from the call',
  host_payout_ledger: 'Host payout differs from the ledger', host_balance_negative: 'Host balance is below zero',
  purchase_without_lot: 'Purchase without a token lot', lot_without_purchase: 'Token lot without a purchase',
};
const pr = (paise: number) => rupees(paise / 100);
const tk = (micro: number) => (micro / 1_000_000).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pair = (a: number, b: number) => `${rupees(a)} / ${rupees(b)}`;

function Row({ label, d, strong }: { label: string; d: Omit<Day, 'date'>; strong?: boolean }) {
  const st = strong ? { fontWeight: 700 } : undefined;
  return (
    <tr style={st}>
      <td>{label}</td>
      <td>{d.topups.count} · {rupees(d.topups.rupees)}<div className="muted" style={T14}>{gw(d)}</div></td>
      <td>{d.walletCredits.count} · {rupees(d.walletCredits.rupees)}</td>
      <td>{pair(d.calls.paid, d.calls.test)}</td>
      <td>{pair(d.hostEarnings.paid, d.hostEarnings.test)}</td>
      <td>{pair(d.platformShare.paid, d.platformShare.test)}</td>
      <td>{d.payouts.count} · {rupees(d.payouts.rupees)}</td>
      <td>{d.refunds ? `${d.refunds.count} · ${rupees(d.refunds.rupees)}` : 'n/a'}</td>
    </tr>
  );
}

function TokenSection({ t }: { t: TokReport }) {
  const x = t.totals;
  return (
    <section className="card" style={{ background: '#fff', ...T14, display: 'grid', gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Tokens {t.mismatches.length === 0 ? '· everything matches' : `· ${t.mismatches.length} to look at`}</h2>
      {t.mismatches.map((m) => (
        <div key={m.kind + m.ref} style={{ borderTop: '1px solid #eadcee', paddingTop: 8, wordBreak: 'break-all' }}>
          <strong>{TOK_KIND[m.kind] ?? m.kind}</strong>
          <div>{m.detail}</div>
          <div className="muted">{m.ref}{m.uid ? ` · ${m.uid}` : ''}</div>
        </div>
      ))}
      <div style={{ display: 'grid', gap: 2 }}>
        <div>Google Play purchases: <strong>{x.purchases.count}</strong> · paid {pr(x.purchases.paidPaise)} · {tk(x.purchases.tokensMicro)} tokens granted</div>
        <div>Tokens spent on {x.spent.calls} calls: <strong>{tk(x.spent.tokensMicro)}</strong> · value consumed {pr(x.spent.consumedPaise)} = call cost {pr(x.spent.callCostPaise)} + host {pr(x.spent.hostPaise)} + platform {pr(x.spent.platformPaise)}</div>
        <div>Host earnings credited: {pr(x.hostLedger.earningsPaise)} (test {pr(x.hostLedger.testEarningsPaise)})</div>
        <div>Refunds through Google Play: {x.refunds.playRefunds} · {pr(x.refunds.playRefundPaise)} · tokens removed {tk(x.refunds.revokedMicro)} ({pr(x.refunds.revokedValuePaise)})</div>
        <div>Debts: created {x.refunds.debtsCreated} ({pr(x.refunds.debtsCreatedPaise)}) · written off {pr(x.refunds.debtsWrittenOffPaise)} · open now {t.openDebts.count} ({pr(t.openDebts.valuePaise)})</div>
        <div>Test tokens (not real money): {x.testLots.grantedLots} lots · {tk(x.testLots.grantedMicro)} granted · {tk(x.testLots.spentMicro)} spent</div>
        <div>Still held: purchased tokens {tk(t.outstanding.purchaseTokensMicro)} · test tokens {tk(t.outstanding.testTokensMicro)} · host balance {pr(t.outstanding.hostBalancePaise)}</div>
      </div>
      <div style={{ overflow: 'auto' }}>
        <table className="t" style={T14}>
          <thead><tr><th>Day</th><th>Purchases</th><th>Tokens spent</th><th>Value consumed</th><th>Host</th><th>Platform</th><th>Refunds</th></tr></thead>
          <tbody>
            {t.days.map((d) => (
              <tr key={d.date}>
                <td>{d.date}</td><td>{d.purchases.count} · {pr(d.purchases.paidPaise)}</td><td>{tk(d.spent.tokensMicro)}</td><td>{pr(d.spent.consumedPaise)}</td>
                <td>{pr(d.spent.hostPaise)}</td><td>{pr(d.spent.platformPaise)}</td><td>{d.refunds.playRefunds} · {pr(d.refunds.playRefundPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function HostReconciliation() {
  const [from, setFrom] = useState(istDaysAgo(6));
  const [to, setTo] = useState(istToday());
  const [rep, setRep] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const load = useCallback(async () => {
    setError(null); setBusy(true);
    try { setRep(await adminCall<Report>(`/api/admin/hf/reconciliation?${q}`)); } catch (e) { setError(fail('hf_reconciliation', e)); setRep(null); }
    setBusy(false);
  }, [q]);
  useEffect(() => { void load(); /* first load only */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const csv = async () => {
    setError(null);
    try { const { blob, filename } = await adminBlob(`/api/admin/hf/reconciliation?${q}&format=csv`); saveBlob(blob, filename ?? `hf-reconciliation-${from}-to-${to}.csv`); }
    catch (e) { setError(fail('hf_reconciliation_csv', e)); }
  };

  return (
    <ConsultShell>
      <form onSubmit={(e) => { e.preventDefault(); void load(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <label style={T14}>From <input type="date" style={field} value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={T14}>To <input type="date" style={field} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="submit" className="btn small" style={{ ...T14, minHeight: 44 }} disabled={busy || !from || !to}>{busy ? 'Loading…' : 'Show'}</button>
        <button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44 }} disabled={!rep} onClick={() => void csv()}>Download CSV</button>
      </form>
      <p className="muted" style={{ ...T14, marginTop: 0 }}>Dates are India time. Money columns show real (paid) / test credits. Up to 93 days at a time.</p>
      {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
      {busy && !rep && <Spinner label="Working it out…" />}
      {rep && (
        <div style={{ display: 'grid', gap: 14 }}>
          <section className="card" style={{ background: '#fff' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{rep.mismatches.length === 0 ? 'Everything matches' : `${rep.mismatches.length} to look at`}</h2>
            {rep.mismatches.length === 0 && <div className="muted" style={T14}>Every paid top-up in this period has exactly one wallet credit for the same amount, and the other way round. Top-ups paid in the last 30 minutes are skipped while their credit is still being recorded.</div>}
            <div style={{ display: 'grid', gap: 8 }}>
              {rep.mismatches.map((m) => (
                <div key={m.kind + m.topupId} style={{ ...T14, borderTop: '1px solid #eadcee', paddingTop: 8, wordBreak: 'break-all' }}>
                  <strong>{KIND[m.kind] ?? m.kind}</strong> · {m.topupRupees != null ? `top-up ${rupees(m.topupRupees)}` : 'no top-up'} · {m.creditRupees != null ? `credit ${rupees(m.creditRupees)}` : 'no credit'}
                  <div>{m.detail}</div>
                  <div className="muted">{m.topupId} · {m.uid}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="card" style={{ padding: 0, overflow: 'auto', background: '#fff' }}>
            <table className="t" style={T14}>
              <thead><tr><th>Day</th><th>Top-ups paid</th><th>Wallet credits</th><th>Call charges (paid / test)</th><th>Host earnings (paid / test)</th><th>Platform share (paid / test)</th><th>Payouts paid</th><th>Refunds</th></tr></thead>
              <tbody>
                {rep.days.map((d) => <Row key={d.date} label={d.date} d={d} />)}
                <Row label="Total" d={rep.totals} strong />
              </tbody>
            </table>
          </section>

          {rep.liabilities && (
            <section className="card" style={{ background: '#fff', ...T14 }}>
              <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Still owed (approximate)</h2>
              <div>Caller wallets: <strong>{rupees(rep.liabilities.callerWalletsApprox)}</strong> · Host earnings not yet withdrawn: <strong>{rupees(rep.liabilities.hostEarningsApprox)}</strong></div>
              <div className="muted">{rep.liabilities.note}{rep.refundsAvailable ? '' : ' Refunds are not included (no refunds record yet).'}</div>
            </section>
          )}

          {rep.tokens && <TokenSection t={rep.tokens} />}

          <section className="card" style={{ background: '#fff', ...T14 }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Payouts paid</h2>
            {rep.payouts.length === 0 ? <div className="muted">None in this period.</div> : rep.payouts.map((p) => (
              <div key={p.id} style={{ wordBreak: 'break-all' }}>{new Date(p.paid_at + 19_800_000).toISOString().slice(0, 10)} · {rupees(p.amount_rupees)} · UTR {p.utr || '—'} · {p.host_uid}</div>
            ))}
          </section>
        </div>
      )}
    </ConsultShell>
  );
}
