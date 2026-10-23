/* HfHome — [HF-ADMIN-COMPLETE-1] The admin landing for the call app: today's headline numbers, each one opens the page that acts on it.
 * Worker (admin only): GET /api/admin/hf/desk/summary. Money is rupees. Days are IST. Nothing under 14px. */
import { useEffect, useState } from 'react';
import { adminCall } from '../peopleKit';
import { Banner, ConsultShell, fail } from '../consultants/kit';
import { DesiCard, DesiKpi, DesiKpis } from '../desi';

const inr0 = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);

interface Sum {
  members: { total: number; last24h: number; today: number; last7d: number; registered: number }; hosts: { live: number; pendingReview: number };
  bookings: { open: number; upcoming: number; pendingApproval: number }; topups: { today: { n: number; rupees: number }; month: { n: number; rupees: number } };
  ticketsOpen: number; payoutsOpen: number; refundsOpen: number; closingAccounts: number; reportsOpen: number; moneyAlertsOpen: number;
}

const go = (href: string) => () => { window.location.href = href; };

export default function HfHome() {
  const [s, setS] = useState<Sum | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { adminCall<Sum>('/api/admin/hf/desk/summary').then(setS).catch((e) => setErr(fail('hf_home_summary', e))); }, []);
  const v = (x: number | undefined) => (s ? x ?? 0 : '…');
  return (
    <ConsultShell className="hf-admin-operations">
      <div className="hfa-stack">
        {err && <Banner tone="error">{err}</Banner>}
        <DesiCard title="People" note="Who is joining and who is live.">
          <DesiKpis>
            <DesiKpi tone="plum" label="Sign-ups today" value={v(s?.members.today)} sub={s ? `${s.members.last7d} in 7 days · ${s.members.total} in all` : undefined} onClick={go('/admin/hosts/desk')} />
            <DesiKpi tone="tea" label="Influencers live" value={v(s?.hosts.live)} onClick={go('/admin/hosts')} />
            <DesiKpi tone="gold" label="Influencer reviews waiting" value={v(s?.hosts.pendingReview)} alert={!!s && s.hosts.pendingReview > 0} onClick={go('/admin/hosts')} />
          </DesiKpis>
        </DesiCard>
        <DesiCard title="Bookings and money in" note="Booked calls and wallet top-ups.">
          <DesiKpis>
            <DesiKpi tone="rani" label="Bookings coming up" value={v(s?.bookings.upcoming)} sub={s ? `${s.bookings.pendingApproval} waiting for the influencer · ${s.bookings.open} open in all` : undefined} onClick={go('/admin/hosts/desk?tab=bookings')} />
            <DesiKpi tone="tea" label="Top-ups paid today" value={s ? inr0(s.topups.today.rupees) : '…'} sub={s ? `${s.topups.today.n} top-ups` : undefined} onClick={go('/admin/hosts/desk?tab=topups')} />
            <DesiKpi tone="gold" label="Top-ups paid this month" value={s ? inr0(s.topups.month.rupees) : '…'} sub={s ? `${s.topups.month.n} top-ups` : undefined} onClick={go('/admin/hosts/desk?tab=topups')} />
          </DesiKpis>
        </DesiCard>
        <DesiCard title="Waiting for you" note="Each number is something a person is waiting on.">
          <DesiKpis>
            <DesiKpi tone="plum" label="Withdrawals waiting" value={v(s?.payoutsOpen)} alert={!!s && s.payoutsOpen > 0} onClick={go('/admin/hosts/payouts')} />
            <DesiKpi tone="rani" label="Refunds waiting" value={v(s?.refundsOpen)} sub={s ? `${s.closingAccounts} accounts closing` : undefined} alert={!!s && s.refundsOpen > 0} onClick={go('/admin/hosts/refunds')} />
            <DesiKpi tone="lav" label="Support questions open" value={v(s?.ticketsOpen)} alert={!!s && s.ticketsOpen > 0} onClick={go('/admin/hosts/desk?tab=support')} />
            <DesiKpi tone="saffron" label="Reports open" value={v(s?.reportsOpen)} alert={!!s && s.reportsOpen > 0} onClick={go('/admin/hosts/desk?tab=reports')} />
            <DesiKpi tone="gold" label="Money alerts" value={v(s?.moneyAlertsOpen)} sub="calls the money monitor could not fix" alert={!!s && s.moneyAlertsOpen > 0} onClick={go('/admin/hosts/desk?tab=money')} />
          </DesiKpis>
        </DesiCard>
      </div>
    </ConsultShell>
  );
}
