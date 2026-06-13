/* §5.3 Users & accounts — search by email/uid/npub/handle, profile panel, and
 * balance adjust (reuses the EXISTING audited /api/admin/adjust money endpoint). */
import { useState } from 'react';
import { AdminGate } from './AdminGate';
import { searchUser, getAccount, adjust, coins, fmtTime, type UserSummary } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';

function Inner() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<UserSummary | null>(null);
  const [bal, setBal] = useState<{ balance: number | null; held: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adjAmt, setAdjAmt] = useState(''); const [adjReason, setAdjReason] = useState(''); const [adjMsg, setAdjMsg] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setLoading(true); setErr(null); setRes(null); setBal(null); setAdjMsg(null);
    try {
      const r = await searchUser(q.trim()); setRes(r);
      if (r.found && r.user) { try { const acc = await getAccount(r.user.uid); setBal({ balance: acc.balance ?? null, held: acc.held ?? null }); } catch { /* live balance optional */ } }
    } catch (e) { setErr(e instanceof Error ? e.message : 'search failed'); }
    finally { setLoading(false); }
  };

  const doAdjust = async () => {
    if (!res?.user) return;
    const amount = Math.trunc(Number(adjAmt));
    if (!amount || !adjReason.trim()) { setAdjMsg('amount (non-zero) and reason required'); return; }
    setAdjMsg('working…');
    try { const r = await adjust({ account: res.user.uid, amount, reason: adjReason.trim() }); setAdjMsg(r?.ok === false ? 'failed' : 'adjusted ✓'); }
    catch (e) { setAdjMsg(e instanceof Error ? e.message : 'failed'); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <div className="flex-1"><Field label="Search" placeholder="email · uid · @handle · npub" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} /></div>
        <div className="self-end"><Button variant="blue" loading={loading} onClick={run}>Search</Button></div>
      </div>
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      {loading && <Spinner size={22} />}
      {res && !res.found && <p className="font-mono text-[13px] text-inkMute">No user found for “{q}”.</p>}

      {res?.found && res.user && (
        <Card shadow="lg">
          <div className="flex flex-col gap-3 p-1">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="font-display font-semibold text-[20px] text-ink">{res.user.display_name || res.user.handle || res.user.uid}</span>
                <span className="font-mono text-[11px] text-inkMute">{res.user.uid}{res.user.handle ? ` · @${res.user.handle}` : ''}</span>
              </div>
              <Pill kind={res.kyc === 'verified' ? 'ok' : 'hint'}>KYC: {res.kyc}</Pill>
            </div>
            <div className="flex flex-wrap gap-2">
              <Pill>Balance: {coins(bal?.balance ?? null)}</Pill>
              <Pill>Held: {coins(bal?.held ?? null)}</Pill>
              <Pill kind={(res.strikes ?? 0) > 0 ? 'no' : 'hint'}>Strikes: {res.strikes}</Pill>
              <Pill>Verified proofs: {res.verified_proofs}</Pill>
              <Pill>Joined: {fmtTime(res.user.created_at)}</Pill>
            </div>
            <div className="flex flex-wrap gap-2">
              <Pill>Listings: {res.counts?.listings}</Pill>
              <Pill>Voice agents: {res.counts?.voice_agents}</Pill>
              <Pill>Vision agents: {res.counts?.vision_agents}</Pill>
            </div>

            <div className="mt-2 border-t-zine border-inkMute pt-3">
              <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-blueInk">Adjust balance (audited)</span>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="Amount (coins, ±)" value={adjAmt} onChange={(e) => setAdjAmt(e.target.value)} />
                <div className="min-w-[200px] flex-1"><Field label="Reason" value={adjReason} onChange={(e) => setAdjReason(e.target.value)} /></div>
                <Button variant="coral" onClick={doAdjust}>Apply</Button>
              </div>
              {adjMsg && <p className="mt-1 font-mono text-[12px] text-inkSoft">{adjMsg}</p>}
            </div>

            <details className="mt-2">
              <summary className="cursor-pointer font-mono text-[12px] text-blueInk">Recent ledger ({res.recent_ledger?.length ?? 0})</summary>
              <div className="mt-2 flex flex-col gap-1">
                {(res.recent_ledger ?? []).map((l: any) => (
                  <div key={l.id} className="flex items-center justify-between font-mono text-[11px] text-inkSoft">
                    <span>{l.type}</span><span>{coins(l.amount)}</span><span className="text-inkMute">{fmtTime(l.created_at)}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function UserSearch() { return <AdminGate><Inner /></AdminGate>; }
