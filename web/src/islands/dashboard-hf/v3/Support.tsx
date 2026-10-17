/* [HF-DASH-V3-1] Support: searchable questions by topic, "Ask us" (a real ticket: stored and emailed to the support inbox), your
 * recent questions, crisis line and links to the Help Center. Worker: GET/POST /api/hf/support/tickets. */
import { useEffect, useState } from 'react';
import { BRAND } from '../../../lib/brand';
import { capture } from '../../../lib/analytics';
import { getTickets, sendTicket, type Ticket } from './data';
import { Card, Ic, PageHead, Sticker, istDay, useToast } from './ui';

const FAQ: [string, string, string][] = [
  ['wallet', 'How do I add money?', 'Go to Wallet → Add money, type any whole amount and pay with UPI, card or netbanking. The price includes 18% GST, and the receipt comes on WhatsApp and email.'],
  ['wallet', 'Can I get my money back?', 'Unused top-up money can go back to the original payment within 180 days of paying, after our team approves it. Money spent on connected calls is not refundable.'],
  ['calls', 'How am I charged for a call?', 'By the minute of connected time, at the influencer’s rate. Ringing, declined, missed or failed calls cost ₹0. You need 2 minutes of balance to start.'],
  ['calls', 'I was charged for a call that never connected', 'That is a billing error and the money goes back to your wallet. Ask us below with the call time.'],
  ['safety', 'Will the influencer see my number?', 'Never. Both numbers are masked and calls are not recorded. Influencers only see your handle.'],
  ['safety', 'Someone made me uncomfortable', 'Press # during the call to end it, block them and report it. You can also block from a call’s details in Calls. Our team reviews every report.'],
  ['safety', 'Someone asked for my OTP or bank details', 'Hang up and report. We never ask for OTP, UPI PIN, passwords or bank details — on any channel.'],
  ['appointment', 'How do appointments work?', 'Pick a free slot on an influencer’s profile. The amount is held from your wallet until the call. Open the appointment a few minutes early; the cancellation rules are on each appointment.'],
  ['account', 'How do I close my account?', 'Go to Close my account. If you have money in your wallet we refund it first, then delete your account.'],
];
const TOPICS: [string, string][] = [['', 'All'], ['wallet', 'Wallet & payments'], ['call', 'Calls'], ['appointment', 'Appointments'], ['safety', 'Safety'], ['account', 'Account']];
const FAQ_KEY: Record<string, string> = { call: 'calls' };

export default function Support() {
  const toast = useToast();
  const [topic, setTopic] = useState('');
  const [q, setQ] = useState('');
  const [tTopic, setTTopic] = useState('wallet');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const load = () => { void getTickets().then(r => setTickets(r.ok ? r.data.items : [])); };
  useEffect(load, []);
  const ql = q.trim().toLowerCase();
  const fk = FAQ_KEY[topic] ?? topic;
  const list = FAQ.filter(([k, qq, a]) => (!fk || k === fk) && (!ql || (qq + a).toLowerCase().includes(ql)));
  const send = async () => {
    if (msg.trim().length < 10) { setErr('Thoda detail likh do 🙏 (at least 10 characters)'); return; }
    setBusy(true); setErr('');
    const r = await sendTicket(tTopic, msg.trim());
    setBusy(false);
    if (r.ok) { setMsg(''); toast(`Got it! Ticket ${r.data.id} — we’ll reply by email or WhatsApp.`); capture('hf_dash3_ticket_sent', { topic: tTopic }); load(); }
    else setErr(r.status === 429 ? 'You’ve sent a lot today. Please try again tomorrow or email us.' : r.message || 'We could not send that. Please try again.');
  };
  return <>
    <PageHead eyebrow="Support" title="Peace bro, hum hain na" sub="Answers to common questions, or write to us and we’ll sort it out." art={<Sticker name="peace" w={84} rot={6} />} />
    <section className="h3-row c21">
      <Card title="Common questions" note="Pick a topic or search">
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="h3-amounts">{TOPICS.map(([k, l]) => <button key={k} type="button" aria-pressed={topic === k} className={topic === k ? 'on' : ''} onClick={() => setTopic(k)}>{l}</button>)}</div>
          <input type="search" placeholder="Type your question…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search questions" />
          <div className="h3-faq">{list.length ? list.map(([, qq, a]) => <details key={qq}><summary>{qq}</summary><p>{a}</p></details>) : <p className="muted">Nothing matched. Ask us 👉</p>}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><a className="h3-btn sm ghost" href="/help">Help Center</a><a className="h3-btn sm ghost" href="/talk-safely">Talk safely</a><a className="h3-btn sm ghost" href="/report">Report a person</a></div>
        </div>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card title="Ask us" note="We usually reply the same day" tone={1}>
          <div style={{ display: 'grid', gap: 12 }}>
            <label className="f">Topic<select value={tTopic} onChange={e => setTTopic(e.target.value)}>{TOPICS.slice(1).map(([k, l]) => <option key={k} value={k}>{l}</option>)}<option value="other">Something else</option></select></label>
            <label className="f">Message<textarea rows={4} maxLength={2000} placeholder="Tell us what happened. Add the call time if it’s about a call." value={msg} onChange={e => { setMsg(e.target.value); setErr(''); }} /></label>
            {err && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
            <button type="button" className="h3-btn rani" disabled={busy} onClick={send}><Ic name="chat" className="" />{busy ? 'Sending…' : 'Send'}</button>
            <p className="small muted">Or email <a href={`mailto:${BRAND.emails.support}`}>{BRAND.emails.support}</a></p>
            {tickets && tickets.length > 0 && <div><b className="small">Your recent questions</b>{tickets.slice(0, 5).map(t => <div key={t.id} className="h3-rcpt"><span>{t.id} · {TOPICS.find(x => x[0] === t.topic)?.[1] ?? 'Other'}</span><span className={`h3-chip ${t.status === 'open' ? 'gold' : ''}`}>{t.status === 'open' ? `Open · ${istDay(t.createdAt)}` : 'Answered'}</span></div>)}</div>}
          </div>
        </Card>
        <section className="h3-safe"><div style={{ flex: 1, minWidth: '15rem' }}><h3>Feeling low?</h3>
          <p className="small" style={{ marginTop: 4 }}>{BRAND.name} is a friendly chat, not counselling. Tele-MANAS is free, confidential and open 24×7: call <b>14416</b>.</p></div>
          <Sticker name="mohmaya" w={80} rot={-6} /></section>
      </div>
    </section>
  </>;
}
