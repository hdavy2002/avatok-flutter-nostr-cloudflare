/* [HF-DASH-V3-1] Overview: greeting hero with flowers and stickers, the Breaking ticker, headline numbers, up next, fraands online,
 * talk-time chart, top fraands, recent calls, wallet, Dosti streak and the safety strip. Every number is the person's own, from the worker. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/env';
import { callsEnabled, hfCall, type HostPresence } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import { getBookingSummary, listBookings, type BookingSummary, type HfBooking } from '../../../lib/hfBookingsApi';
import { capture } from '../../../lib/analytics';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { BEAT_MS, STATUS_NOTE, type MeHost } from '../hostActivity';
import { useDash, spendablePaise } from './data';
import { Avatar, Card, Empty, Failed, FlowerCluster, Ic, Marigold, Pill, Skel, Sticker, durationText, fmtInt, istDay, istTime, minutes } from './ui';

/* [HF-FIX-TICKER-1] Evergreen lines make NO live claim; they only follow the real headlines built from the person's own data. */
const EVERGREEN = [
  'Exclusive: chai thandi ho rahi hai, call kab karoge?',
  'Desh ka mood: doomscroll kam, dil se baat zyada',
  'Abhi abhi: number masked, tension khatam',
  'Big reveal: ek pyaari si baat se din ban jaata hai',
];
const MIN_CALL_PAISE = 2000; // ₹20, the least a wallet needs to start a call

type Headline = { kind: string; text: string; href?: string };
type TickerIn = {
  online: { displayName: string; slug: string }[] | null; apptsToday: number | null | undefined; next: HfBooking | null; bal: number | null;
  pendingReviews: number | null | undefined; hostLive: boolean; hostPresence: HostPresence | null; receivedToday: number | null | undefined;
};

function buildHeadlines(i: TickerIn): Headline[] {
  const out: Headline[] = [];
  if (i.online && i.online.length > 0) {
    const f = i.online[0], more = i.online.length - 1;
    out.push({ kind: 'online', href: `/h/${f.slug}`, text: `Breaking: ${f.displayName}${more > 0 ? ` aur ${more} aur fraands` : ''} abhi online ${more > 0 ? 'hain' : 'hai'} — call karo!` });
  }
  if (i.next) {
    const t = Date.parse(i.next.startUtc), mins = Math.round((t - Date.now()) / 60_000), who = i.next.hostName || 'aapke influencer';
    out.push({ kind: 'appointment', href: `/bookings/${encodeURIComponent(i.next.id)}`,
      text: mins > 0 && mins <= 60 ? `Abhi abhi: ${who} ke saath appointment ${mins} minute mein — tayyar ho jao!` : `Sootron ke hawale se: ${who} ke saath appointment ${istDay(t)} ko ${istTime(t)} IST pe` });
  } else if (i.apptsToday && i.apptsToday > 0) {
    out.push({ kind: 'appointment', href: '/dashboard/appointments', text: `Sootron ke hawale se: aaj aapke ${i.apptsToday} appointment${i.apptsToday === 1 ? '' : 's'} hain` });
  }
  if (i.pendingReviews && i.pendingReviews > 0) out.push({ kind: 'rating', href: '/dashboard/calls?tab=rate', text: `Exclusive: ${i.pendingReviews} call${i.pendingReviews === 1 ? '' : 's'} aapki rating ka intezaar kar${i.pendingReviews === 1 ? 'i' : 'e'} hai` });
  if (i.bal != null && i.bal < MIN_CALL_PAISE) out.push({ kind: 'wallet_low', href: '/dashboard/wallet#add', text: `Abhi abhi: wallet mein sirf ${formatPaise(i.bal)} — call shuru karne ke liye kam se kam ${formatPaise(MIN_CALL_PAISE)} chahiye, top up karo` });
  else if (i.bal != null) out.push({ kind: 'wallet', href: '/dashboard/wallet', text: `Sootron ke hawale se: aapke wallet mein ${formatPaise(i.bal)} hain — baat shuru karne ke liye kaafi` });
  if (i.hostLive && i.receivedToday != null && i.receivedToday > 0) out.push({ kind: 'host_calls', href: '/dashboard/calls', text: `Breaking: aaj aapko ${i.receivedToday} call${i.receivedToday === 1 ? '' : 's'} mili` });
  if (i.hostLive && i.hostPresence === 'offline') out.push({ kind: 'host_offline', text: 'Exclusive: aap abhi offline ho — online aao, tabhi log aapko call kar paayenge' });
  return [...out, ...EVERGREEN.map(text => ({ kind: 'evergreen', text }))];
}

export default function Overview({ account, bookingOn }: { account: DashboardAccount; bookingOn: boolean }) {
  const { insights, summary, wallet, favs, profile, reload } = useDash();
  const ins = insights.data;
  const bal = spendablePaise(wallet.data);
  const name = profile.data?.firstName || account.displayName || 'dost';
  const online = favs.data?.filter(f => f.presence === 'online') ?? null;
  const delta = ins && ins.lastMonth.seconds > 0 ? (ins.month.seconds - ins.lastMonth.seconds) / ins.lastMonth.seconds : null;
  const hostLive = account.host?.status === 'live' && !account.closing;
  const [next, setNext] = useState<HfBooking | null>(null);
  const [hostPresence, setHostPresence] = useState<HostPresence | null>(null);
  const headlines = buildHeadlines({ online, apptsToday: summary.data?.appointmentsToday, next, bal, pendingReviews: ins?.pendingReviews.length,
    hostLive, hostPresence, receivedToday: summary.data?.callsToday.received });
  const tickKey = headlines.map(h => h.text).join('|');

  return <>
    <section className="h3-hero">
      <FlowerCluster />
      <div className="text">
        <div className="hello">Namaste, {name} 🙏</div>
        <h1 style={{ marginTop: 4 }}>Aaj kisse baat karni hai?</h1>
        <p className="take">Aaj ka scene: <b>{summary.data?.appointmentsToday ?? '—'}</b> appointment{summary.data?.appointmentsToday === 1 ? '' : 's'} today, <b>{online ? online.length : '—'}</b> of your fraands {online?.length === 1 ? 'is' : 'are'} online right now, and <b>{bal == null ? '—' : formatPaise(bal)}</b> is waiting in your wallet.</p>
        <div className="acts">
          <a className="h3-btn rani" href="/marketplace" onClick={() => capture('hf_dash3_cta', { cta: 'find_someone' })}><Ic name="search" className="" />Find someone to talk to</a>
          <a className="h3-btn ghost" href="/dashboard/wallet#add"><Ic name="plus" className="" />Top up</a>
        </div>
      </div>
      <div className="art"><div style={{ position: 'relative', width: 280, height: 230 }}>
        <div style={{ position: 'absolute', right: 120, bottom: 6 }}><Sticker name="chai" w={150} rot={-8} wiggle /></div>
        <div style={{ position: 'absolute', right: 0, bottom: 70 }}><Sticker name="swag" w={170} rot={7} /></div>
      </div></div>
    </section>

    <div className="h3-ticker" role="region" aria-label="Fun headlines">
      <div className="tag"><i />Breaking</div>
      <div className="lane"><div className="run" key={tickKey}>{[0, 1].map(k => headlines.map(h => <span key={`${k}${h.text}`} aria-hidden={k === 1 ? true : undefined}>{h.href
        ? <a href={h.href} tabIndex={k === 1 ? -1 : undefined} onClick={() => capture('hf_dash3_ticker_click', { kind: h.kind, href: h.href })}>{h.text}</a> : h.text}</span>))}</div></div>
    </div>

    {account.closing && <aside className="h3-safe" style={{ background: 'var(--goldtint)' }}><div><h3>Your account is being closed.</h3><p className="small">Calling and profile editing are paused. <a href="/dashboard/close">Manage account closure</a></p></div></aside>}
    {hostLive ? <HostPanel onPresence={setHostPresence} bookingOn={bookingOn} /> : account.host && !account.closing ? <section className="h3-card"><h2><Marigold size={20} />Your influencer profile</h2><p className="muted" style={{ marginTop: 6 }}>{STATUS_NOTE[account.host.status] ?? 'Your profile is not live yet.'}</p><a className="h3-btn" style={{ marginTop: 12 }} href="/dashboard/host">Continue my profile</a></section> : null}

    <section className="h3-kpis">
      <a className="h3-card h3-kpi k1" href="/dashboard/wallet"><div className="ic"><Ic name="wallet" className="" /></div><div className="lbl">Wallet balance</div>
        <div className="big num">{bal == null ? '—' : formatPaise(bal)}</div><div className="sub">Tap to top up</div><div className="corner"><Marigold size={54} tone={1} /></div></a>
      <a className="h3-card h3-kpi" href="/dashboard/calls"><div className="ic" style={{ background: 'var(--blush)', color: 'var(--rani)' }}><Ic name="clock" className="" /></div><div className="lbl">Talk time · this month</div>
        <div className="big num">{ins ? `${fmtInt(minutes(ins.month.seconds))} min` : '—'}</div>
        <div className="sub">{delta == null ? (ins ? 'First month — welcome!' : '—') : <><span className={delta >= 0 ? 'h3-up' : 'h3-down'}>{delta >= 0 ? '+' : ''}{Math.round(delta * 100)}%</span> vs last month</>}</div></a>
      <a className="h3-card h3-kpi" href="/dashboard/calls"><div className="ic" style={{ background: 'var(--lavtint)', color: 'var(--lav)' }}><Ic name="phone" className="" /></div><div className="lbl">Calls · this month</div>
        <div className="big num">{ins ? fmtInt(ins.month.calls) : '—'}</div><div className="sub">{ins ? `${formatPaise(ins.month.paise)} of talk time` : '—'}</div></a>
      <a className="h3-card h3-kpi" href="/dashboard/fraands"><div className="ic" style={{ background: 'var(--goldtint)', color: 'var(--amber)' }}><Ic name="heart" className="" /></div><div className="lbl">My Fraands</div>
        <div className="big num">{summary.data?.fraands.saved ?? favs.data?.length ?? '—'}</div><div className="sub">{online ? `${online.length} online right now` : '—'}</div></a>
      <a className="h3-card h3-kpi" href="/dashboard/calls?tab=rate"><div className="ic" style={{ background: 'var(--teatint)', color: 'var(--peacock)' }}><Ic name="star" className="" /></div><div className="lbl">Waiting for your rating</div>
        <div className="big num">{ins ? ins.pendingReviews.length : '—'}</div><div className="sub">Two taps. Helps them a lot.</div></a>
    </section>
    {(insights.failed || wallet.failed || summary.failed) && <Failed text="Some numbers could not load." onRetry={() => reload()} />}

    <section className="h3-row c21">
      <Card title="Up next" note="Your booked time · times in IST" link={{ label: 'Calendar', href: '/dashboard/appointments' }}><UpNext enabled={bookingOn && !account.closing} uid={account.uid} onNext={setNext} /></Card>
      <Card title="My Fraands right now" note="Online first · rose dot = free to talk" link={{ label: 'All fraands', href: '/dashboard/fraands' }} tone={1}>
        {favs.failed ? <Failed onRetry={() => reload('favs')} /> : !favs.data ? <Skel h={160} /> : favs.data.length === 0 ? <Empty text="No saved influencers yet. Tap the heart on someone you like."><a className="h3-btn sm rani" href="/marketplace">Find influencers</a></Empty> :
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[...favs.data].sort((a, b) => rank(a.presence) - rank(b.presence)).slice(0, 4).map(f =>
            <div key={f.slug} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
              <a className="h3-who" href={`/h/${f.slug}`}><Avatar name={f.displayName} seed={f.slug} photo={f.photoUrl} /><span><b>{f.displayName}</b><small><Pill presence={f.presence} /></small></span></a>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{f.priceLabel && <span className="h3-price" style={{ fontSize: 15 }}>{f.priceLabel}</span>}
                <a className={`h3-btn sm ${f.presence === 'online' ? 'rani' : 'ghost'}`} href={`/h/${f.slug}`}>{f.presence === 'online' ? 'Call' : 'Notify'}</a></div>
            </div>)}</div>}
      </Card>
    </section>

    <section className="h3-row c2">
      <Card title="Talk time" note="Minutes on calls per day · last 14 days" right={<Sticker name="pco" w={54} rot={6} />}>
        {insights.failed ? <Failed onRetry={() => reload('insights')} /> : !ins ? <Skel h={210} /> : <TalkChart days={ins.talkDaily} />}
      </Card>
      <Card title="Your top fraands" note="Who you talked to most · last 30 days" tone={1}>
        {!ins ? (insights.failed ? <Failed onRetry={() => reload('insights')} /> : <Skel h={180} />) : ins.topFraands.length === 0 ? <Empty text="Your first call will show up here." /> :
          <div className="h3-bars">{ins.topFraands.map((r, i) => <div key={r.slug ?? i} className="h3-bar">
            <div><b>{r.name}</b>{i === 0 && <div style={{ marginTop: 6 }}><span className="h3-chip gold">👑 No. 1 fraand</span></div>}</div>
            <div className="track"><div className="fill" style={{ width: `${(r.seconds / Math.max(1, ins.topFraands[0].seconds)) * 100}%` }} /></div>
            <b className="num">{fmtInt(minutes(r.seconds))} min</b></div>)}</div>}
      </Card>
    </section>

    <section className="h3-row c3">
      <Card title="Recent calls" note="Handles only — nobody sees your number" link={{ label: 'All calls', href: '/dashboard/calls' }}>
        {summary.failed ? <Failed onRetry={() => reload('summary')} /> : !summary.data ? <Skel h={200} /> : !summary.data.recentMade?.length ? <Empty text="No calls yet. Your calls will show up here." /> :
          <table className="h3-table"><thead><tr><th>Influencer</th><th className="r">Time</th><th>Status</th></tr></thead><tbody>{summary.data.recentMade.map(c =>
            <tr key={c.id} onClick={() => location.assign(`/dashboard/calls#${c.id}`)}><td><div className="h3-who"><Avatar name={c.otherHandle} seed={c.otherHandle} /><span><b>{c.otherHandle}</b><small>{istDay(c.at)}</small></span></div></td>
              <td className="r">{c.status === 'completed' ? durationText(c.seconds) : '—'}</td><td><span className={`h3-chip ${c.status === 'completed' ? '' : 'miss'}`}>{c.status === 'completed' ? 'Completed' : 'Not connected'}</span></td></tr>)}</tbody></table>}
      </Card>
      <Card title="Wallet" note="Add money in a tap" link={{ label: 'Open wallet', href: '/dashboard/wallet' }} tone={1}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', padding: 14, borderRadius: 16, background: 'var(--goldtint)' }}>
          <div><div className="small muted">Balance</div><div className="num" style={{ fontSize: '2rem', color: 'var(--plum)' }}>{bal == null ? '—' : formatPaise(bal)}</div></div>
          <a className="h3-btn gold" href="/dashboard/wallet#add"><Ic name="plus" className="" />Top up</a>
        </div>
        <div className="h3-amounts" style={{ marginTop: 10 }}>{[100, 250, 500, 1000].map(a => <a key={a} href={`/dashboard/wallet?amount=${a}#add`}>₹{fmtInt(a)}</a>)}</div>
        <p className="small muted" style={{ marginTop: 8 }}>18% GST is deducted from what you pay · UPI, cards, netbanking</p>
      </Card>
      <Card title="Dosti streak" note="Days in a row you talked to someone">
        {!ins ? <Skel h={180} /> : <>
          <div className="h3-streak"><div className="num" style={{ fontSize: '3.2rem', lineHeight: 1, color: 'var(--saffron)' }}>{ins.streakDays}</div>
            <div><b style={{ fontFamily: 'var(--head)' }}>{ins.streakDays === 1 ? 'din — shuru ho gaya!' : 'din se lagataar!'}</b><div className="small muted">{ins.streakDays ? 'Ek call aaj, streak zinda.' : 'Aaj ek call, streak shuru.'}</div></div></div>
          <div className="h3-diyas" style={{ marginTop: 10 }} aria-label={`${ins.streakDays} day streak`}>{Array.from({ length: 7 }, (_, i) => <Diya key={i} lit={i < ins.streakDays} />)}</div>
          <div style={{ marginTop: 14, padding: 14, borderRadius: 16, background: 'var(--lavtint)' }}>
            <div className="small muted">You have talked to</div>
            <div><b className="num" style={{ fontSize: '1.7rem' }}>{fmtInt(ins.talkedTo)}</b> different influencer{ins.talkedTo === 1 ? '' : 's'}</div>
            <div className="small muted" style={{ marginTop: 4 }}>Naye log, nayi baatein. Try someone new this week?</div>
          </div>
          {ins.streakDays === 0 && <div style={{ marginTop: 10 }}><Sticker name="aalsi" w={110} rot={-4} /></div>}
        </>}
      </Card>
    </section>

    <section className="h3-safe">
      <div style={{ flex: 1, minWidth: '16rem' }}><h3>Log kya kahenge? Kuch nahi.</h3><p className="small" style={{ marginTop: 4 }}>Nobody sees your number, and nothing is recorded.</p>
        <ul>{['Your number is masked', 'Calls are never recorded', 'Verified influencers only', 'Press # to end, block and report', 'We never ask for OTP, PIN or bank details'].map(t => <li key={t}>{t}</li>)}</ul></div>
      <Sticker name="lkk" w={170} rot={-4} />
    </section>
    <div className="h3-foot"><Marigold size={26} /><span>Meaningful conversations. A kinder, brighter world.</span><Marigold size={26} tone={1} /></div>
  </>;
}

const rank = (p: HostPresence) => (p === 'online' ? 0 : p === 'busy' ? 1 : 2);

function Diya({ lit }: { lit: boolean }) {
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 19c2 6 22 6 24 0z" fill={lit ? '#ea6a12' : 'none'} stroke={lit ? '#9a3412' : '#c9b9c6'} strokeWidth="1.5" />
    {lit && <><path d="M16 6c3 4 3 7 0 10-3-3-3-6 0-10z" fill="#f59e0b" /><path d="M16 10c1.4 2 1.4 3.6 0 5-1.4-1.4-1.4-3 0-5z" fill="#fff3c4" /></>}</svg>;
}

/** Bars: minutes per IST day. Hover/tap a bar for the day, minutes and rupees. */
export function TalkChart({ days }: { days: { day: string; seconds: number; paise: number; calls: number }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [tip, setTip] = useState<{ i: number; x: number } | null>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const H = 210, m = { t: 12, r: 6, b: 26, l: 34 };
  const mins = days.map(d => d.seconds / 60);
  const max = Math.max(5, ...mins);
  const step = max <= 10 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : max <= 150 ? 30 : 60;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const y = (v: number) => m.t + (H - m.b - m.t) * (1 - v / top);
  const band = (w - m.l - m.r) / days.length, bw = band * 0.7;
  const every = Math.ceil(days.length / Math.max(2, Math.floor((w - 40) / 60)));
  const label = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return <div className="h3-chart" ref={box}>
    <svg width="100%" viewBox={`0 0 ${w} ${H}`} role="img" aria-label={`Talk time over the last 14 days: ${Math.round(mins.reduce((a, b) => a + b, 0))} minutes in total`}>
      <defs><linearGradient id="h3bar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#d81b72" /><stop offset="1" stopColor="#f59e0b" /></linearGradient></defs>
      {ticks.map(t => <g key={t}><line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke="#f1e3d6" /><text x={m.l - 6} y={y(t) + 5} textAnchor="end">{t}</text></g>)}
      {days.map((d, i) => { const x = m.l + i * band + (band - bw) / 2, v = mins[i]; return <g key={d.day}>
        <rect x={x} width={bw} rx={6} y={v ? y(v) : H - m.b - 3} height={v ? H - m.b - y(v) : 3} fill={v ? 'url(#h3bar)' : '#eadfd6'} opacity={tip?.i === i ? 0.8 : 1}
          onPointerEnter={() => setTip({ i, x: x + bw / 2 })} onPointerLeave={() => setTip(null)} onClick={() => setTip({ i, x: x + bw / 2 })} />
        {i % every === 0 && <text x={x + bw / 2} y={H - 6} textAnchor="middle">{label(d.day)}</text>}</g>; })}
    </svg>
    {tip && <div className="h3-tip" style={{ opacity: 1, left: Math.min(Math.max(0, (tip.x / w) * (box.current?.clientWidth ?? w) - 70), (box.current?.clientWidth ?? w) - 150), top: 0 }}>
      <div className="d">{label(days[tip.i].day)}</div><div>{fmtInt(mins[tip.i])} min · {formatPaise(days[tip.i].paise)} · {days[tip.i].calls} call{days[tip.i].calls === 1 ? '' : 's'}</div></div>}
  </div>;
}

/** Next confirmed appointment with a countdown, plus the two after it. */
function UpNext({ enabled, uid, onNext }: { enabled: boolean; uid: string; onNext?: (b: HfBooking | null) => void }) {
  const [rows, setRows] = useState<HfBooking[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(() => {
    if (!enabled) { setRows([]); return; }
    setFailed(false); setRows(null);
    const from = new Date(Date.now() - 60 * 60_000).toISOString(), to = new Date(Date.now() + 60 * 86_400_000).toISOString();
    listBookings('customer', from, to).then(p => setRows(p.bookings.filter(b => ['confirmed', 'pending_approval', 'starting', 'active'].includes(b.status)).sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))))
      .catch(() => setFailed(true));
  }, [enabled]);
  useEffect(load, [load, uid]);
  useEffect(() => { onNext?.(rows && rows.length ? rows[0] : null); }, [rows, onNext]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  if (!enabled) return <Empty text="Appointments open soon." />;
  if (failed) return <Failed onRetry={load} />;
  if (!rows) return <Skel h={110} />;
  if (!rows.length) return <Empty text="No appointments yet. Book a time with someone you like."><a className="h3-btn sm rani" href="/marketplace">Find someone</a></Empty>;
  const n = rows[0], t = Date.parse(n.startUtc), mins = Math.round((t - now) / 60_000);
  return <>
    <div className="h3-next"><Avatar name={n.hostName} seed={n.hostUid} size="" />
      <div className="who"><b style={{ fontFamily: 'var(--head)', fontSize: 18, fontWeight: 900 }}>{n.hostName || 'Your influencer'}</b><br />
        <span className="small">{istDay(t)} · {istTime(t)}{n.durationMinutes ? ` · ${n.durationMinutes} min` : ''}</span><br /><span className="small muted">{n.status === 'pending_approval' ? 'Waiting for the influencer to accept · ' : ''}{formatPaise(n.reservedPaise)} held from your wallet</span></div>
      <div style={{ textAlign: 'right' }}><div className="small muted">{mins > 0 ? 'starts in' : 'starting'}</div>
        <div className="h3-count">{mins > 0 ? (mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h` : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`) : 'Now'}</div>
        <a className="h3-btn sm" style={{ marginTop: 8 }} href={`/bookings/${encodeURIComponent(n.id)}`}>{mins <= 15 && n.status !== 'pending_approval' ? 'Join waiting room' : 'View details'}</a></div>
    </div>
    {rows.slice(1, 3).map(r => { const t2 = Date.parse(r.startUtc); return <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 4px', borderBottom: '1px dashed var(--line)' }}>
      <a className="h3-who" href={`/bookings/${encodeURIComponent(r.id)}`}><Avatar name={r.hostName} seed={r.hostUid} /><span><b>{r.hostName || 'Your influencer'}</b><small>{istDay(t2)}, {istTime(t2)}</small></span></a>
      <span className="h3-chip lav">{formatPaise(r.reservedPaise)} held</span></div>; })}
  </>;
}

/** Live influencers: the online switch, today's calls and expected earnings (same rules as before, new look). */
function HostPanel({ onPresence, bookingOn }: { onPresence?: (p: HostPresence) => void; bookingOn: boolean }) {
  const { summary } = useDash();
  // [HF-BOOKING-E2E-1] The influencer's bird's-eye numbers: days that carry a booking and requests waiting for her answer.
  const [bs, setBs] = useState<BookingSummary | null>(null);
  useEffect(() => { if (bookingOn) void getBookingSummary().then(setBs).catch(() => undefined); }, [bookingOn]);
  const [host, setHost] = useState<MeHost | null>(null);
  const [on, setOn] = useState(false);
  const [presence, setPresence] = useState<HostPresence>('offline');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const pres = useRef(presence); pres.current = presence;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { if (loaded) onPresence?.(presence); }, [loaded, presence, onPresence]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const me = await hfCall<{ host: MeHost | null }>('GET', '/api/hosts/me');
      if (!live || !me.ok || !me.data.host) return;
      setHost(me.data.host);
      const enabled = await callsEnabled(); if (!live) return; setOn(enabled);
      let p = me.data.host.presence;
      if (!p && me.data.host.slug) { try { const r = await fetch(`${API_BASE}/api/hosts/public/${encodeURIComponent(me.data.host.slug)}`, { cache: 'no-store' }); if (r.ok) p = ((await r.json()) as { status?: string }).status; } catch { /* offline */ } }
      if (live) { setPresence(p === 'online' || p === 'busy' ? p : 'offline'); setLoaded(true); }
    })();
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!on) return;
    const beat = () => { if (document.visibilityState === 'visible' && pres.current !== 'offline') void hfCall('POST', '/api/hosts/me/presence/beat').catch(() => undefined); };
    const t = setInterval(beat, BEAT_MS); return () => clearInterval(t);
  }, [on]);
  const onlineNow = presence === 'online' || presence === 'busy';
  const toggle = async () => {
    if (!on || busy) return;
    setBusy(true); setMsg('');
    const r = await hfCall<{ ok: boolean; presence: string }>('PUT', '/api/hosts/me/presence', { online: !onlineNow });
    setBusy(false);
    if (r.ok) setPresence(r.data.presence === 'online' || r.data.presence === 'busy' ? r.data.presence : 'offline');
    else setMsg(r.message || 'We could not change that. Please try again.');
  };
  return <section className="h3-row c2">
    <section className="h3-card"><h2><Marigold size={20} />Influencer status</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12 }}>
        <label className="h3-toggle"><input type="checkbox" role="switch" checked={onlineNow} disabled={busy || !on || !host} onChange={toggle} /><b>{!on ? 'Calls open soon' : onlineNow ? (presence === 'busy' ? 'On a call' : 'Online') : 'Offline'}</b></label>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>{!on ? 'Calling isn’t switched on yet.' : onlineNow ? 'Callers can call you now. Switch off when you’re done.' : 'Switch on when you’re ready. People who asked to be told get a WhatsApp.'}</p>
      {msg && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{msg}</p>}
    </section>
    <section className="h3-card"><h2><Marigold size={20} tone={1} />Today as an influencer</h2>
      <div className="h3-kpis" style={{ marginTop: 10 }}>
        <div><div className="small muted">Calls received today</div><div className="num" style={{ fontSize: '1.8rem' }}>{summary.data?.callsToday.received ?? '—'}</div></div>
        <div><div className="small muted">Saved you (hearts)</div><div className="num" style={{ fontSize: '1.8rem' }}>{summary.data?.fraands.hearts ?? '—'}</div></div>
        <div><div className="small muted">Asked to be told you’re online</div><div className="num" style={{ fontSize: '1.8rem' }}>{summary.data?.fraands.waiting ?? '—'}</div></div>
        <div><div className="small muted">Expected on hold</div><div className="num" style={{ fontSize: '1.8rem' }}>{summary.data?.expectedHostNetPaise != null ? formatPaise(summary.data.expectedHostNetPaise) : '—'}</div></div>
      </div>
      {bookingOn && <div className="h3-kpis" style={{ marginTop: 10 }}>
        <a href="/dashboard/host/calendar" style={{ color: 'inherit', textDecoration: 'none' }}><div className="small muted">Days booked</div><div className="num" style={{ fontSize: '1.8rem' }}>{bs?.bookedDays ?? '—'}</div></a>
        <a href="/dashboard/host/calendar" style={{ color: 'inherit', textDecoration: 'none' }}><div className="small muted">Appointments waiting</div><div className="num" style={{ fontSize: '1.8rem', color: bs?.waitingCount ? 'var(--rani)' : undefined }}>{bs?.waitingCount ?? '—'}</div></a>
      </div>}
      <a className="h3-link" href="/dashboard/host/earnings">Earnings →</a>
    </section>
  </section>;
}
