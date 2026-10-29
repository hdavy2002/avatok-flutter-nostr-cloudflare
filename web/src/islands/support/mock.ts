// [HF-SUPPORT-DESK] In-memory stand-in for the support API (HF-SUPPORT-CONTRACT.md) so every screen can be previewed and
// clicked through before the worker routes exist. Switched on ONLY by the build-time env PUBLIC_SUPPORT_MOCK=1
// (see api.ts). It is never active in a normal build: with the variable unset this module is not even loaded.
//
// Keep the response shapes in step with the contract. The state lives in memory, so a page reload resets it.
import { defaultSignature } from './signature';
import { CATEGORIES } from './types';
import { BRAND } from '../../lib/brand';

type Q = Record<string, string | undefined>;
export interface MockResult { status: number; data: unknown }

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const now = () => Date.now();
const ok = (data: Record<string, unknown> = {}): MockResult => ({ status: 200, data: { ok: true, ...data } });
const fail = (status: number, error: string): MockResult => ({ status, data: { ok: false, error } });

export type MockWho = 'staff' | 'customer' | 'guest';
let who: MockWho = 'staff';
export const setMockWho = (w: MockWho) => { who = w; };
export const getMockWho = () => who;

/* ── people ─────────────────────────────────────────────────────────────── */
interface Person { key: string; uid: string | null; name: string; handle?: string; role: 'fan' | 'influencer' | 'unverified'; email: string; wa?: string; joined: number; wallet?: number; pending?: number; calls?: number; strikes?: number }
const PEOPLE: Record<string, Person> = {
  ravi: { key: 'ravi', uid: 'u_ravi', name: 'Ravi K', handle: '@ravik29', role: 'fan', email: 'ravi.k@example.com', wa: '+91 98xxx xx421', joined: now() - 45 * DAY, wallet: 212, pending: 450, calls: 7, strikes: 0 },
  ananya: { key: 'ananya', uid: 'u_ananya', name: 'Ananya S', handle: '@ananya_s', role: 'fan', email: 'ananya.s@example.com', wa: '+91 99xxx xx118', joined: now() - 20 * DAY, wallet: 60, pending: 0, calls: 2, strikes: 0 },
  priya: { key: 'priya', uid: 'u_priya', name: 'Priya M', handle: '@priya.makes', role: 'influencer', email: 'priya.m@example.com', wa: '+91 90xxx xx077', joined: now() - 80 * DAY, wallet: 0, pending: 3200, calls: 41, strikes: 0 },
  arjun: { key: 'arjun', uid: 'u_arjun', name: 'Arjun T', handle: '@arjunt', role: 'fan', email: 'arjun.t@example.com', wa: '+91 97xxx xx302', joined: now() - 9 * DAY, wallet: 15, pending: 0, calls: 1, strikes: 0 },
  meera: { key: 'meera', uid: 'u_meera', name: 'Meera J', handle: '@meera', role: 'influencer', email: 'meera.j@example.com', wa: '+91 95xxx xx640', joined: now() - 60 * DAY, wallet: 0, pending: 780, calls: 63, strikes: 0 },
  unknown: { key: 'unknown', uid: null, name: 'unknown sender', role: 'unverified', email: 'someone@mailinator.example', joined: now() - 3 * HOUR },
  kabir: { key: 'kabir', uid: 'u_kabir', name: 'Kabir N', handle: '@kabirn', role: 'fan', email: 'kabir.n@example.com', wa: '+91 88xxx xx905', joined: now() - 12 * DAY, wallet: 0, pending: 0, calls: 0, strikes: 0 },
  sana: { key: 'sana', uid: 'u_sana', name: 'Sana R', handle: '@sanar', role: 'fan', email: 'sana.r@example.com', wa: '+91 91xxx xx556', joined: now() - 30 * DAY, wallet: 90, pending: 0, calls: 4, strikes: 1 },
};
const ME = { uid: 'u_davy', name: 'Davy', role: 'admin' as const, email: 'hdavy2002@gmail.com' };
let staff = [
  { id: 's1', uid: 'u_davy', email: 'hdavy2002@gmail.com', name: 'Davy', role: 'admin' },
  { id: 's2', uid: 'u_satish', email: 'satish@example.com', name: 'Satish', role: 'agent' },
  { id: 's3', uid: 'u_neha', email: 'neha@example.com', name: 'Neha', role: 'viewer' },
];

/* ── tickets ────────────────────────────────────────────────────────────── */
interface Msg { id: string; kind: 'customer' | 'support' | 'note' | 'system'; authorName: string; authorEmail?: string; text: string; createdAt: number; attachments: { id: string; name: string; size: number; contentType: string }[]; sentAt?: number }
interface Tk {
  number: string; person: string; subject: string; category: string; priority: 'urgent' | 'high' | 'normal' | 'low'; status: string;
  assignee: { uid: string; name: string } | null; channel: string; createdAt: number; updatedAt: number; unread: boolean; dueAt: number | null;
  messages: Msg[]; events: { id: string; text: string; createdAt: number }[]; snoozeUntil: number | null; solvedAt?: number | null;
}
let seq = 1;
const nid = (p: string) => `${p}${seq++}`;
const att = (name: string, size: number, type: string) => ({ id: nid('att_'), name, size, contentType: type });
const msg = (kind: Msg['kind'], who2: string, text: string, ago: number, attachments: Msg['attachments'] = [], extra: Partial<Msg> = {}): Msg =>
  ({ id: nid('m_'), kind, authorName: who2, text, createdAt: now() - ago, attachments, ...extra });

function mk(number: string, person: string, subject: string, category: string, priority: Tk['priority'], status: string, ago: number, dueIn: number | null, messages: Msg[], extra: Partial<Tk> = {}): Tk {
  return {
    number, person, subject, category, priority, status, assignee: null, channel: 'Email', createdAt: now() - ago - 6 * HOUR, updatedAt: now() - ago,
    unread: false, dueAt: dueIn == null ? null : now() + dueIn, messages, events: [], snoozeUntil: null, ...extra,
  };
}
const SUP = 'Davy (Support)';
const tickets: Tk[] = [
  mk('HF-10241', 'ananya', 'Influencer asked for my UPI on call', 'report', 'urgent', 'new', 4 * MIN, 72 * MIN, [
    msg('customer', 'Ananya S', 'He kept asking me to pay him directly to his UPI id instead of through the app. I said no and he got rude. I do not want this to happen to anyone else.', 4 * MIN),
  ], { unread: true, channel: 'App' }),
  mk('HF-10240', 'ravi', 'Withdraw not received', 'withdraw', 'high', 'open', 18 * MIN, 20 * HOUR, [
    msg('customer', 'Ravi K', 'I withdrew ₹450 to my UPI on Monday. It shows Paid in the app but I have not received it.', 2 * DAY, [att('withdraw-screen.png', 182_000, 'image/png')], { authorEmail: 'ravi.k@example.com' }),
    msg('support', SUP, 'Hi Ravi, thanks for the screenshot. The bank shows your ₹450 as sent on 27 Oct with UTR 4312 8890 1123. Banks can take up to 48 hours. If it has not reached you by Thursday evening, reply here and we will raise it with the bank.', 2 * DAY - 5 * HOUR, [], { sentAt: now() - 2 * DAY }),
    msg('customer', 'Ravi K', 'It is Thursday now and still nothing in my account. Please check again.', 18 * MIN, [att('bank-statement.pdf', 240_000, 'application/pdf')], { authorEmail: 'ravi.k@example.com' }),
    msg('note', 'Satish', 'Checked the payout log. UTR is real. Asked HDFC for a trace, they say 24 h.', 5 * MIN),
  ], { unread: true, events: [{ id: 'e1', text: "Status changed to Open by the customer's reply", createdAt: now() - 18 * MIN }] }),
  mk('HF-10239', 'priya', 'Earnings still on hold', 'withdraw', 'high', 'open', 1 * HOUR, -2 * HOUR, [
    msg('customer', 'Priya M', 'It says 7-day hold but it has been 9 days and my earnings are still not available to withdraw.', 1 * HOUR),
  ]),
  mk('HF-10238', 'arjun', 'Call cut after 40 seconds', 'calls', 'normal', 'open', 2 * HOUR, 22 * HOUR, [
    msg('customer', 'Arjun T', 'Charged ₹1, is that right? The call dropped after 40 seconds and I did not get to talk.', 2 * HOUR),
  ]),
  mk('HF-10237', 'meera', 'Can I change my display name?', 'influencer', 'normal', 'open', 3 * HOUR, 23 * HOUR, [
    msg('customer', 'Meera J', 'I chose the wrong spelling at sign-up. Can you change it for me?', 3 * HOUR),
  ]),
  mk('HF-10236', 'unknown', 'Top-up failed twice', 'wallet', 'normal', 'new', 3 * HOUR, 23 * HOUR, [
    msg('customer', 'unknown sender', 'Money left my bank but wallet shows ₹0. I tried twice. Please help.', 3 * HOUR, [], { authorEmail: 'someone@mailinator.example' }),
  ], { unread: true }),
  mk('HF-10235', 'kabir', 'App stuck on splash screen', 'app', 'low', 'open', 5 * HOUR, 30 * HOUR, [
    msg('customer', 'Kabir N', 'Redmi Note 12, Android 14, build 2260. The app opens and then freezes on the splash screen.', 5 * HOUR),
  ], { channel: 'App' }),
  mk('HF-10233', 'sana', 'Booking time changed', 'bookings', 'normal', 'open', 1 * DAY, -30 * MIN, [
    msg('customer', 'Sana R', 'She moved my slot from 7 pm to 9 pm without asking. I cannot make 9 pm.', 1 * DAY),
  ]),
  mk('HF-10234', 'ravi', 'Withdraw not received', 'withdraw', 'high', 'waiting', 2 * HOUR, null, [
    msg('customer', 'Ravi K', 'I withdrew ₹450 to my UPI on Monday. It shows Paid in the app but I have not received it.', 2 * DAY, [att('withdraw-screen.png', 182_000, 'image/png')]),
    msg('support', SUP, 'Hi Ravi, thanks for the screenshot. The bank shows your ₹450 as sent on 27 Oct with UTR 4312 8890 1123. Banks can take up to 48 hours. If it has not reached you by Thursday evening, reply here and we will raise it with the bank.', 2 * HOUR, [], { sentAt: now() - 2 * HOUR }),
  ], { assignee: { uid: 'u_davy', name: 'Davy' } }),
  mk('HF-10198', 'ravi', 'Booking time changed by influencer', 'bookings', 'normal', 'open', 1 * DAY, 10 * HOUR, [
    msg('customer', 'Ravi K', 'My booking with @meera moved from 7 pm to 9 pm and I was not told. Can you check?', 1 * DAY),
  ], { assignee: { uid: 'u_satish', name: 'Satish' } }),
  mk('HF-10102', 'ravi', 'Top-up not showing in wallet', 'wallet', 'normal', 'solved', 17 * DAY, null, [
    msg('customer', 'Ravi K', 'I topped up ₹120 but the wallet did not change.', 18 * DAY),
    msg('support', SUP, 'Sorted, the ₹120 is now in your wallet. Sorry for the trouble.', 17 * DAY),
  ], { solvedAt: now() - 17 * DAY, assignee: { uid: 'u_davy', name: 'Davy' } }),
  mk('HF-10090', 'sana', 'How do I delete my account?', 'other', 'low', 'closed', 30 * DAY, null, [
    msg('customer', 'Sana R', 'How do I delete my account?', 31 * DAY),
    msg('support', SUP, 'Open Profile, then Settings, then Delete account. It takes a minute.', 30 * DAY),
  ], { assignee: { uid: 'u_satish', name: 'Satish' } }),
  mk('HF-10077', 'unknown', 'WIN a FREE phone now!!!', 'other', 'low', 'spam', 3 * DAY, null, [msg('customer', 'unknown sender', 'Click here to claim.', 3 * DAY)]),
];
let nextNo = 10242;
const find = (n: string) => tickets.find((t) => t.number === n);

/* ── lookup helpers ─────────────────────────────────────────────────────── */
const OPEN_ST = ['new', 'open'];
function folderOf(t: Tk): string[] {
  const f: string[] = [];
  if (OPEN_ST.includes(t.status) && !t.assignee) f.push('unassigned');
  if (t.assignee?.uid === ME.uid && !['solved', 'closed', 'spam', 'trash'].includes(t.status)) f.push('mine');
  if (OPEN_ST.includes(t.status)) f.push('open');
  if (['waiting', 'on_hold', 'solved', 'closed', 'spam', 'trash'].includes(t.status)) f.push(t.status);
  return f;
}
const label = (s: string) => ({ new: 'Open', open: 'Open', on_hold: 'Open', waiting: 'We replied', solved: 'Solved', closed: 'Closed' } as Record<string, string>)[s] ?? s;
const prev = (t: Tk) => (t.messages.filter((m) => m.kind !== 'note').slice(-1)[0]?.text ?? '').slice(0, 110);
function slaState(t: Tk): 'ok' | 'amber' | 'red' {
  if (t.dueAt == null) return 'ok';
  const d = t.dueAt - now();
  return d < 0 ? 'red' : d < 2 * HOUR ? 'amber' : 'ok';
}
function addEvent(t: Tk, text: string) { t.events.push({ id: nid('e_'), text, createdAt: now() }); t.updatedAt = now(); }

/* ── canned replies, signature, settings, queues ───────────────────────── */
let canned = [
  { id: 'c1', title: 'Withdraw: bank can take 48 h', body: 'Hi {customer_name}, thanks for writing. Withdrawals to UPI can take up to 48 hours to reach your bank. If it has not arrived after that, reply here and we will raise it with the bank.' },
  { id: 'c2', title: 'Call dropped: refund', body: 'Hi {customer_name}, sorry about the call dropping. We have checked it and added the amount back to your wallet.' },
  { id: 'c3', title: 'Need a screenshot', body: 'Hi {customer_name}, could you send a screenshot of the problem and the time it happened? That helps us find it quickly.' },
  { id: 'c4', title: 'Report received (safety)', body: 'Hi {customer_name}, thank you for telling us. We take this seriously and our safety team is looking at it today. You do not need to do anything else for now.' },
];
let teamSig = defaultSignature(null);
let mySig = '';
let useFor: 'team' | 'personal' = 'team';
let settings: Record<string, unknown> = {
  alert_whatsapp: '+917817058560', whatsapp_min_interval_ms: 1000,
  business_hours: { days: [1, 2, 3, 4, 5, 6], from: '10:00', to: '19:00', tz: 'Asia/Kolkata' },
  holidays: [{ date: '2026-11-08', label: 'Diwali' }, { date: '2026-11-09', label: 'Diwali (day 2)' }],
  automations: [{ id: 'a1', category: 'report', assigneeUid: 'u_davy', priority: 'urgent' }, { id: 'a2', category: 'withdraw', assigneeUid: null, priority: 'high' }],
};
let failed = [
  { id: 'f1', queue: 'email-bulk', what: 'Ticket acknowledgement HF-10228 → priya@…', reason: 'Mailbox does not exist (bounced)', at: now() - 2 * HOUR },
  { id: 'f2', queue: 'whatsapp-normal', what: '"Support replied" nudge HF-10219', reason: 'Number is not on WhatsApp', at: now() - 3 * HOUR },
];
let suppressions = [
  { email: 'priya@oldmail.example', reason: 'Hard bounce', at: now() - 2 * DAY },
  { email: 'noone@invalid.example', reason: 'Hard bounce', at: now() - 5 * DAY },
  { email: 'complaint@spam.example', reason: 'Marked as spam', at: now() - 9 * DAY },
];
let blocked = [{ email: 'win-free@spam.example', at: now() - 3 * DAY, by: 'Davy' }, { domain: 'mailinator.example', at: now() - 8 * DAY, by: 'Satish' }];

function queues() {
  const j = (n: number) => Math.max(0, n + Math.round((Math.random() - 0.5) * n * 0.1));
  return [
    { name: 'support-inbound', what: 'Incoming emails becoming tickets', waiting: j(12), perMin: 1840, failed24h: 0, oldestSec: 2 },
    { name: 'email-priority', what: 'Login codes and staff replies', waiting: 0, perMin: j(96), failed24h: 0, oldestSec: null },
    { name: 'email-bulk', what: 'Acknowledgements, reminders, receipts', waiting: j(2310), perMin: 1200, failed24h: failed.filter((f) => f.queue === 'email-bulk').length, oldestSec: 110 },
    { name: 'whatsapp-priority', what: 'WhatsApp login codes', waiting: 0, perMin: j(14), failed24h: 0, oldestSec: null },
    { name: 'whatsapp-normal', what: 'Support nudges and admin alerts', waiting: j(86), perMin: 60, failed24h: failed.filter((f) => f.queue === 'whatsapp-normal').length, oldestSec: 86 },
    { name: 'support-jobs', what: 'Reminders, auto-close, search, clean-up', waiting: j(4), perMin: 30, failed24h: 0, oldestSec: 8 },
  ];
}

/* ── row / detail builders ──────────────────────────────────────────────── */
function rowOf(t: Tk) {
  const p = PEOPLE[t.person];
  return {
    number: t.number, customer: { name: p.name, role: p.role, uid: p.uid, email: p.email }, subject: t.subject, preview: prev(t), category: t.category,
    priority: t.priority, assignee: t.assignee, sla: { dueAt: t.dueAt, state: slaState(t) }, updatedAt: t.updatedAt, unread: t.unread, status: t.status, channel: t.channel,
  };
}
function detailOf(t: Tk) {
  const p = PEOPLE[t.person];
  const others = tickets.filter((x) => x.person === t.person && x.number !== t.number).map((x) => ({ number: x.number, subject: x.subject, status: label(x.status) }));
  const viewers = t.number === 'HF-10240' ? [{ uid: 'u_satish', name: 'Satish' }] : [];
  const msgs = t.messages.map((m) => {
    let delivery: string | undefined;
    if (m.kind === 'support') delivery = m.sentAt && now() - m.sentAt > 4000 ? 'delivered' : 'sent';
    return { ...m, delivery };
  });
  return {
    ticket: { number: t.number, subject: t.subject, category: t.category, status: t.status, priority: t.priority, channel: t.channel, assignee: t.assignee, sla: { dueAt: t.dueAt, state: slaState(t) }, createdAt: t.createdAt, updatedAt: t.updatedAt, snoozeUntil: t.snoozeUntil },
    messages: msgs, events: t.events,
    customer: {
      uid: p.uid, name: p.name, handle: p.handle ?? null, role: p.role, verified: p.role !== 'unverified', whatsappMasked: p.wa ?? null, email: p.email, joinedAt: p.joined,
      walletRupees: p.wallet ?? null, pendingWithdrawRupees: p.pending ?? null, calls30d: p.calls ?? null, strikes: p.strikes ?? null,
      recentMoney: p.uid ? [{ label: 'Withdraw to UPI · 27 Oct', amountRupees: -450 }, { label: 'Call with @meera · 9 min', amountRupees: -90 }, { label: 'Top-up · 20 Oct', amountRupees: 510 }] : [],
      otherTickets: others,
    },
    viewers,
  };
}

/* ── the router ─────────────────────────────────────────────────────────── */
export function mockHandle(method: string, path: string, q: Q, body: Record<string, unknown>): MockResult {
  const customerMe = PEOPLE.ravi;
  if (who === 'guest') return fail(401, 'no_session');
  const admin = path.startsWith('/api/admin/hf/support');
  if (admin && who !== 'staff') return fail(403, 'forbidden');
  const m = (re: RegExp) => path.match(re);

  /* customer ------------------------------------------------------------- */
  if (!admin) {
    let r: RegExpMatchArray | null;
    if (method === 'GET' && path === '/api/hf/support/tickets') {
      const st = q.status ?? 'all';
      const rows = tickets.filter((t) => t.person === customerMe.key && !['spam', 'trash'].includes(t.status))
        .filter((t) => st === 'all' || (st === 'open' && ['new', 'open', 'waiting', 'on_hold'].includes(t.status)) || t.status === st)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => ({ number: t.number, subject: t.subject, category: t.category, status: t.status, statusLabel: label(t.status), preview: prev(t), updatedAt: t.updatedAt, unread: t.unread && t.number === 'HF-10234' }));
      return ok({ tickets: rows });
    }
    if (method === 'POST' && path === '/api/hf/support/tickets') {
      const subject = String(body.subject ?? '').trim(), message = String(body.message ?? '').trim();
      if (!subject || !message) return fail(400, 'subject_and_message_required');
      if (!CATEGORIES.some((c) => c.slug === body.category)) return fail(400, 'bad_category');
      const cat = String(body.category);
      const number = `HF-${nextNo++}`;
      const t = mk(number, customerMe.key, subject, cat, cat === 'report' ? 'urgent' : cat === 'wallet' || cat === 'withdraw' ? 'high' : 'normal', 'new', 0, 24 * HOUR, [
        msg('customer', customerMe.name, message, 0, ((body.attachmentIds as string[]) ?? []).map((id) => ({ id, name: 'attachment', size: 1000, contentType: 'image/png' }))),
        msg('system', BRAND.name, `Your ticket ${number} is open. Someone from ${BRAND.name} will respond back soon.`, 0),
      ], { channel: 'Web', unread: true });
      tickets.unshift(t);
      return ok({ ticket: { number, subject, category: cat, status: 'new', statusLabel: 'Open' } });
    }
    if (method === 'GET' && (r = m(/^\/api\/hf\/support\/tickets\/(HF-\d+)$/))) {
      const t = find(r[1]);
      if (!t || t.person !== customerMe.key) return fail(404, 'not_found');
      t.unread = false;
      const canReopen = t.status === 'solved' && (t.solvedAt ?? 0) > now() - 7 * DAY;
      return ok({
        ticket: { number: t.number, subject: t.subject, category: t.category, status: t.status, statusLabel: label(t.status), createdAt: t.createdAt, updatedAt: t.updatedAt, canReopen },
        messages: t.messages.filter((x) => x.kind !== 'note').map((x) => ({
          id: x.id, author: x.kind === 'note' ? 'system' : x.kind, authorName: x.kind === 'customer' ? 'You' : x.authorName, text: x.text, createdAt: x.createdAt, attachments: x.attachments,
        })),
      });
    }
    if (method === 'POST' && (r = m(/^\/api\/hf\/support\/tickets\/(HF-\d+)\/(reply|solve|reopen)$/))) {
      const t = find(r[1]);
      if (!t || t.person !== customerMe.key) return fail(404, 'not_found');
      if (r[2] === 'reply') {
        const text = String(body.message ?? '').trim();
        if (!text) return fail(400, 'message_required');
        if (t.status === 'closed') return fail(409, 'ticket_closed');
        t.messages.push(msg('customer', customerMe.name, text, 0, ((body.attachmentIds as string[]) ?? []).map((id) => ({ id, name: 'attachment', size: 1000, contentType: 'image/png' }))));
        if (t.status === 'waiting' || t.status === 'solved') { t.status = 'open'; addEvent(t, "Status changed to Open by the customer's reply"); }
        t.updatedAt = now();
      } else if (r[2] === 'solve') { t.status = 'solved'; t.solvedAt = now(); addEvent(t, 'Marked solved by the customer'); }
      else { if (t.status !== 'solved') return fail(409, 'not_solved'); t.status = 'open'; addEvent(t, 'Reopened by the customer'); }
      return ok();
    }
    if (method === 'POST' && path === '/api/hf/support/attachments') {
      const name = String(body.__name ?? 'file'), size = Number(body.__size ?? 0);
      if (/\.(exe|apk|bat|js|scr|zip)$/i.test(name)) return fail(415, 'file_type_not_allowed');
      return ok({ id: nid('att_'), name, size, url: body.__dataUrl as string | undefined });
    }
    return fail(404, 'not_found');
  }

  /* admin ---------------------------------------------------------------- */
  const base = '/api/admin/hf/support';
  const sub = path.slice(base.length);
  let r: RegExpMatchArray | null;
  if (method === 'GET' && sub === '/tickets') {
    const folder = q.folder ?? 'unassigned';
    let list = tickets.filter((t) => folderOf(t).includes(folder));
    const counts: Record<string, number> = {};
    for (const f of ['unassigned', 'mine', 'open', 'waiting', 'on_hold', 'solved', 'closed', 'spam', 'trash']) counts[f] = tickets.filter((t) => folderOf(t).includes(f)).length;
    counts.solved += 128 - counts.solved; counts.closed += 2400 - counts.closed;
    if (q.q) { const s = q.q.toLowerCase(); list = list.filter((t) => [t.number, t.subject, prev(t), PEOPLE[t.person].name, PEOPLE[t.person].email, PEOPLE[t.person].handle ?? ''].join(' ').toLowerCase().includes(s)); }
    if (q.category) list = list.filter((t) => t.category === q.category);
    if (q.priority) list = list.filter((t) => t.priority === q.priority);
    if (q.channel) list = list.filter((t) => t.channel.toLowerCase() === q.channel!.toLowerCase());
    if (q.assignee) list = list.filter((t) => (q.assignee === 'none' ? !t.assignee : t.assignee?.uid === (q.assignee === 'me' ? ME.uid : q.assignee)));
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return ok({ tickets: list.map(rowOf), counts, nextCursor: null, me: { uid: ME.uid, name: ME.name, role: ME.role } });
  }
  if (method === 'GET' && /^\/tickets\/HF-\d+$/.test(sub)) {
    const t = find(sub.split('/')[2]);
    if (!t) return fail(404, 'not_found');
    t.unread = false;
    return ok(detailOf(t));
  }
  if ((r = sub.match(/^\/tickets\/(HF-\d+)\/(reply|note|merge|split|spam|viewing)$/)) && method === 'POST') {
    const t = find(r[1]);
    if (!t) return fail(404, 'not_found');
    const act = r[2];
    if (act === 'viewing') return ok();
    if (act === 'reply') {
      const text = String(body.text ?? '').trim();
      if (!text) return fail(400, 'text_required');
      t.messages.push(msg('support', SUP, text, 0, ((body.attachmentIds as string[]) ?? []).map((id) => ({ id, name: 'attachment', size: 1000, contentType: 'image/png' })), { sentAt: now() }));
      if (body.setStatus) { t.status = String(body.setStatus); addEvent(t, `Status changed to ${label(t.status)} by ${ME.name}`); } else if (t.status === 'new') { t.status = 'open'; }
      if (!t.assignee) t.assignee = { uid: ME.uid, name: ME.name };
      t.updatedAt = now(); t.dueAt = null;
      return ok({ delivery: 'queued' });
    }
    if (act === 'note') { t.messages.push(msg('note', ME.name, String(body.text ?? ''), 0)); t.updatedAt = now(); return ok(); }
    if (act === 'merge') {
      const into = find(String(body.into));
      if (!into || into.number === t.number) return fail(400, 'bad_target');
      into.messages.push(...t.messages); into.messages.sort((a, b) => a.createdAt - b.createdAt);
      addEvent(into, `${t.number} was merged into this ticket`);
      tickets.splice(tickets.indexOf(t), 1);
      return ok({ into: into.number });
    }
    if (act === 'split') {
      const i = t.messages.findIndex((x) => x.id === body.messageId);
      if (i < 0) return fail(404, 'message_not_found');
      const [mm] = t.messages.splice(i, 1);
      const n = `HF-${nextNo++}`;
      tickets.unshift(mk(n, t.person, `Split from ${t.number}: ${t.subject}`, t.category, t.priority, 'open', 0, 24 * HOUR, [mm]));
      addEvent(t, `A message was split into ${n}`);
      return ok({ number: n });
    }
    if (act === 'spam') { t.status = 'spam'; addEvent(t, `Marked as spam by ${ME.name}`); return ok(); }
  }
  if (method === 'PATCH' && (r = sub.match(/^\/tickets\/(HF-\d+)$/))) {
    const t = find(r[1]);
    if (!t) return fail(404, 'not_found');
    if (body.status) { t.status = String(body.status); addEvent(t, `Status changed to ${label(t.status)} by ${ME.name}`); if (t.status === 'solved') t.solvedAt = now(); }
    if (body.priority) { t.priority = body.priority as Tk['priority']; addEvent(t, `Priority set to ${t.priority} by ${ME.name}`); }
    if (body.category) { t.category = String(body.category); addEvent(t, `Category set to ${t.category} by ${ME.name}`); }
    if ('assigneeUid' in body) {
      const s = staff.find((x) => x.uid === body.assigneeUid);
      t.assignee = s ? { uid: s.uid!, name: s.name ?? s.email } : null;
      addEvent(t, t.assignee ? `Assigned to ${t.assignee.name} by ${ME.name}` : `Unassigned by ${ME.name}`);
    }
    if ('snoozeUntil' in body) { t.snoozeUntil = body.snoozeUntil ? Number(body.snoozeUntil) : null; if (t.snoozeUntil) { t.status = 'on_hold'; addEvent(t, `Snoozed by ${ME.name}`); } }
    t.updatedAt = now();
    return ok();
  }
  if (method === 'POST' && sub === '/block') {
    blocked.unshift({ email: body.email as string | undefined, domain: body.domain as string | undefined, at: now(), by: ME.name } as never);
    return ok();
  }
  if (method === 'GET' && sub === '/block') return ok({ items: blocked });
  if (method === 'DELETE' && sub === '/block') {
    blocked = blocked.filter((b) => !(b.email && b.email === q.email) && !(b.domain && b.domain === q.domain));
    return ok();
  }
  if (method === 'POST' && sub === '/bulk') {
    const nums = (body.numbers as string[]) ?? [];
    for (const n of nums) {
      const t = find(n); if (!t) continue;
      switch (body.action) {
        case 'solve': t.status = 'solved'; t.solvedAt = now(); break;
        case 'close': t.status = 'closed'; break;
        case 'spam': t.status = 'spam'; break;
        case 'trash': t.status = 'trash'; break;
        case 'priority': t.priority = body.value as Tk['priority']; break;
        case 'category': t.category = String(body.value); break;
        case 'assign': { const s = staff.find((x) => x.uid === body.value); t.assignee = s ? { uid: s.uid!, name: s.name ?? s.email } : null; break; }
        default: break;
      }
      t.updatedAt = now();
    }
    return ok({ changed: nums.length });
  }
  if (sub.startsWith('/canned')) {
    const id = sub.split('/')[2];
    if (method === 'GET') return ok({ items: canned });
    if (method === 'POST') { const c = { id: nid('c'), title: String(body.title ?? ''), body: String(body.body ?? '') }; canned.push(c); return ok({ item: c }); }
    if (method === 'PUT') { canned = canned.map((c) => (c.id === id ? { ...c, title: String(body.title ?? c.title), body: String(body.body ?? c.body) } : c)); return ok(); }
    if (method === 'DELETE') { canned = canned.filter((c) => c.id !== id); return ok(); }
  }
  if (sub === '/signature') {
    if (method === 'GET') return ok(q.scope === 'me' ? { html: mySig, useFor } : { html: teamSig, useFor });
    if (method === 'PUT') { if (q.scope === 'me') mySig = String(body.html ?? ''); else teamSig = String(body.html ?? ''); useFor = body.useFor === 'personal' ? 'personal' : 'team'; return ok(); }
  }
  if (method === 'POST' && sub === '/signature/test') return ok({ sentTo: ME.email });
  if (sub === '/settings') {
    if (method === 'GET') return ok({ settings });
    if (method === 'PUT') { settings = { ...settings, ...body }; return ok({ settings }); }
  }
  if (sub.startsWith('/staff')) {
    const id = sub.split('/')[2];
    if (method === 'GET') return ok({ items: staff });
    if (method === 'POST') { staff.push({ id: nid('s'), uid: null as never, email: String(body.email), name: String(body.email).split('@')[0], role: String(body.role ?? 'agent') }); return ok(); }
    if (method === 'DELETE') { staff = staff.filter((s) => s.id !== id && s.uid !== id); return ok(); }
  }
  if (method === 'GET' && sub === '/queues') return ok({ queues: queues() });
  if (method === 'GET' && sub === '/queues/failed') return ok({ items: failed });
  if (method === 'POST' && (r = sub.match(/^\/queues\/failed\/([^/]+)\/(retry|discard)$/))) { failed = failed.filter((f) => f.id !== r![1]); return ok(); }
  if (sub === '/queues/suppressions') {
    if (method === 'GET') return ok({ items: suppressions });
    if (method === 'DELETE') { suppressions = suppressions.filter((s) => s.email !== q.email); return ok(); }
  }
  if (method === 'GET' && sub === '/reports') {
    const days = q.range === '30d' ? 30 : q.range === '90d' ? 90 : 7;
    const per = Array.from({ length: Math.min(days, 30) }, (_, i) => {
      const d = new Date(now() - (Math.min(days, 30) - 1 - i) * DAY);
      const c = 8 + ((i * 7 + 3) % 11); const s = 6 + ((i * 5 + 1) % 10);
      return { day: d.toISOString().slice(0, 10), created: c, solved: s };
    });
    const cats: Record<string, number> = {};
    tickets.forEach((t) => { cats[t.category] = (cats[t.category] ?? 0) + 1; });
    const catRows = Object.entries(cats).map(([category, count]) => ({ category, count: count * (days === 7 ? 6 : days === 30 ? 22 : 60) })).sort((a, b) => b.count - a.count);
    const created = per.reduce((a, b) => a + b.created, 0) * (days > 30 ? 3 : 1);
    return ok({ range: q.range ?? '7d', totals: { created, solved: Math.round(created * 0.88), open: tickets.filter((t) => OPEN_ST.includes(t.status)).length, firstReplyMinutes: 212, slaMetPct: 93 }, perDay: per, byCategory: catRows });
  }
  return fail(404, 'not_found');
}

export const MOCK_ME = { name: ME.name, email: ME.email };
export const MOCK_CUSTOMER = { name: PEOPLE.ravi.name, email: PEOPLE.ravi.email };
