/* [HF-DASH-V3-1] Support: searchable questions by topic, "Ask us" (a real ticket: stored and emailed to the support inbox), your
 * recent questions, crisis line and links to the Help Center. Worker: GET/POST /api/hf/support/tickets. */
import { useEffect, useState } from 'react';
import { BRAND } from '../../../lib/brand';
import { capture } from '../../../lib/analytics';
import { merchEnabled } from '../merch/api';
import { getTickets, sendTicket, type Ticket } from './data';
import { Card, Ic, PageHead, Sticker, istDay, useToast } from './ui';

const FAQ: [string, string, string][] = [
  ['wallet', 'How do I add money?', 'Go to Wallet → Add money, type any whole-rupee amount from ₹10 to ₹5,000 and pay with UPI, card or netbanking. 18% GST is deducted from what you pay (you pay − GST = what your wallet gets), so your wallet gets the amount divided by 1.18. The receipt is in Wallet (tap View) and comes on WhatsApp and email.'],
  ['wallet', 'Can I get my money back?', 'We do not refund calls that were made, except when a joined call breaks in the first minute (we charge ₹1 and return the rest). Every refund goes to your wallet, never to your card or UPI. To take wallet money out, use Withdraw (Wallet → Withdraw to UPI).'],
  ['wallet', 'How do I withdraw money?', 'Go to Wallet → Withdraw to UPI. Money goes only to your own UPI ID (no bank account) after a one-time ID check. Any amount in whole rupees, no fee, up to 2 withdrawals a week. Each request shows waiting, approved, paid (with the bank reference, UTR) or not paid, and you can cancel while it is waiting. Test credits can be spent but not withdrawn. Influencer earnings are held for 7 days first.'],
  ['calls', 'How am I charged for a call?', 'By the minute you speak, at the influencer’s rate. Money is set aside 5 minutes at a time and what you do not use comes back to your wallet. If the influencer declines, cancels or does not answer, you pay nothing. To start a call or join a queue you need at least ₹20, or 5 minutes at their rate if that is more. A call can last up to 5 hours.'],
  ['calls', 'My wallet is running low during a call', 'Only you hear a voice message that the call will end soon. Top up while you are talking and the call keeps going. If a joined call breaks in the first minute we charge ₹1 and return the rest.'],
  ['calls', 'The influencer is on a call', 'Tap Join the queue or Book a time. We WhatsApp you your place (#N) and again when you are next. About a minute after their call ends, we connect you automatically. Nothing is charged while you wait and you can leave any time. If you miss our call, you are removed. At most 10 can wait, for up to 2 hours.'],
  ['calls', 'What do Online, Bookings only and Offline mean?', 'Online: call now, queue and book. Bookings only (Available by appointment): no instant calls, but you can book. Offline: no instant calls or new bookings; confirmed bookings still ring. On a call: talking to someone right now.'],
  ['calls', 'I was charged twice, or for a call that was never made', 'That is a billing error and the money goes back to your wallet. Ask us below with the call time.'],
  ['safety', 'Will the influencer see my number?', 'Never. Both numbers are masked. Influencers only see your handle.'],
  ['safety', 'Someone made me uncomfortable', 'Press # during the call to end it, block them and report it. You can also use Report a person: your report is saved with a reference number and our team reviews it. Blocking removes them from My Fraands.'],
  ['safety', 'Someone asked for my OTP or bank details', 'Hang up and report. We never ask for OTP, UPI PIN, passwords or bank details — on any channel.'],
  ['appointment', 'How do appointments work?', 'Pick a date, a time and a length (15 min, 30 min, 1 h, 2 h, 3 h, 4 h or 5 h) on an influencer’s profile. The cost of the first 15 minutes is held in your wallet and the rest is charged 5 minutes at a time while you talk. You can cancel free until 1 hour before. If the influencer does not pick up or cancels, the full hold comes back to your wallet.'],
  ['appointment', 'What is “Waiting for approval”?', 'Some influencers approve each booking. Your money stays held while you wait. If they decline, or do not accept in time (24 hours, or 1 hour before the call if earlier), you get the full amount back in your wallet. You can withdraw a pending request any time.'],
  ['account', 'How do I close my account?', 'Go to Close my account. We settle your money first: your wallet balance (after GST) is paid to your own UPI ID in whole rupees; the part below ₹1 is not paid. Set your UPI ID and do the one-time ID check first. Your account is deleted after 30 days. Influencer earnings still in the 7-day hold wait for their release date, which we show on the Close page and send on WhatsApp.'],
  ['account', 'Can I pause instead of closing?', 'Yes. Pause notifications on the Close page pauses only the Notify me WhatsApps. You can resume them any time.'],
  ['account', 'Can I change my name or handle?', 'You can change your profile name. Your @handle is permanent: if you never chose one, we made one for you.'],
  ['account', 'I was asked to accept updated terms', 'We updated the Terms, Privacy policy and Community guidelines (withdrawals go only to your own UPI ID). You are asked to accept once.'],
  ['account', 'How do I share my page?', 'Once you are live, use the Share my page card on Overview and Profile: copy the link, send it on WhatsApp, X or Facebook, put it in your Instagram bio, or show the QR code. In the app use Share my page on Me, in Settings, or the share button on your profile. Fans can share any influencer’s page with the Share button on it.'],
  ['account', 'What do I see about my fans?', 'Your hearts and how many fans tapped Notify me for you. You never see a fan’s number. Waiting fans in your queue are counted on your dashboard, and you can pause the queue.'],
];
/* [HF-HELP-MERCH-1] T-shirt answers: shown only while /api/config hfMerchEnabled is on (same switch as the Merch screens). */
const MERCH_FAQ: [string, string, string][] = [
  ['merch', 'How do I buy an influencer’s T-shirt?', 'Open the influencer’s page, pick a T-shirt, colour and size, add your address, tick the Terms and refund policy and pay. We sell the T-shirt and email you a GST invoice. The price is all-in and labelled incl. 5% GST & delivery: delivery in India is free and nothing is added at checkout. Pay from your wallet (money you added; free test credit cannot be used for merch) or with UPI, card or net banking.'],
  ['merch', 'Do I get a GST invoice?', 'Yes. We sell the T-shirt, so we email you a tax invoice at 5% GST. You can also download it from My orders.'],
  ['merch', 'Do I need a GST number to sell T-shirts?', 'No. You can start without one. There is an optional GSTIN field if you have a number and want to add it.'],
  ['merch', 'Where is my T-shirt order?', 'Open My orders. Your order goes Placed, Approved, Printing, Shipped (with the courier and a tracking link) and Delivered. We also WhatsApp and email you at each step.'],
  ['merch', 'Can I return a T-shirt?', 'No returns or exchanges, because each T-shirt is printed for you. If it is wrong or damaged, report it within 48 hours of delivery with a photo and we replace it or refund you. A refund goes back the way you paid.'],
  ['merch', 'How do I sell T-shirts?', 'Open Merch, upload your art and tick I own this art, pick a T-shirt, place the art (a quality meter blocks blurry prints), add your markup (at least ₹10) and send it for review. Our team reviews every new product and checks every paid order before it is printed.'],
  ['merch', 'How much do I earn from merch?', 'The base price is printing (incl. GST) plus shipping, shown size by size. The fan pays base plus your markup, incl. 5% GST & delivery. Shirts are capped at ₹2,500 so the 5% GST rate applies. We sell the T-shirt and issue the fan the GST invoice; you earn a design royalty of 60% of your markup (currently). You do not need a GST number to start (the GSTIN field is optional). Merch money can be withdrawn 7 days after delivery (currently); a refunded order earns nothing. You never see the fan’s phone, email, full address or payment details.'],
];
const TOPICS: [string, string][] = [['', 'All'], ['wallet', 'Wallet & payments'], ['call', 'Calls'], ['appointment', 'Appointments'], ['safety', 'Safety'], ['account', 'Account']];
const MERCH_TOPIC: [string, string] = ['merch', 'T-shirts'];
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
  const [merchOn, setMerchOn] = useState(false);
  useEffect(() => { void merchEnabled().then(setMerchOn); }, []);
  const topics = merchOn ? [...TOPICS, MERCH_TOPIC] : TOPICS;
  const load = () => { void getTickets().then(r => setTickets(r.ok ? r.data.items : [])); };
  useEffect(load, []);
  const ql = q.trim().toLowerCase();
  const fk = FAQ_KEY[topic] ?? topic;
  const list = (merchOn ? [...FAQ, ...MERCH_FAQ] : FAQ).filter(([k, qq, a]) => (!fk || k === fk) && (!ql || (qq + a).toLowerCase().includes(ql)));
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
          <div className="h3-amounts">{topics.map(([k, l]) => <button key={k} type="button" aria-pressed={topic === k} className={topic === k ? 'on' : ''} onClick={() => setTopic(k)}>{l}</button>)}</div>
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
