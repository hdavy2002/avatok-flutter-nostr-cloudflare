// [HF-SUPPORT-DESK] The customer's view (design: WebCustomerInbox): a Gmail-style list, a ticket pane, a reply box with
// attachments, "This solved my issue", reopen, and a New ticket form with the app's 8 categories.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BRAND, brandUrl } from '../../lib/brand';
import { AttachButton, FileChips, PickedChips, useAttachments } from './attachments';
import { customerApi, errMessage, isAbort } from './api';
import { useAuthState } from './auth';
import { ago, fullDate } from './format';
import { Link, navigate, useLoc } from './router';
import { sanitizeHtml } from './sanitize';
import { CATEGORIES, categoryLabel, type CategorySlug, type CustomerMessage, type CustomerTicketDetail, type CustomerTicketRow } from './types';
import { Avatar, Chip, Empty, ErrorBox, Icon, Menu, MenuItem, Rose, Spinner, statusTone, useInterval, usePageVisible, useToast, Marigold, Lilac } from './ui';

type Filter = 'all' | 'open' | 'solved' | 'closed';
const isOpenish = (s: string) => ['new', 'open', 'waiting', 'on_hold'].includes(s);

function Wordmark() {
  return <span className="hfs-wordmark">{BRAND.name} <em>Support</em></span>;
}

function deviceMeta() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  return { platform: 'web', appVersion: 'support-web', device: `${browser} on ${os}`, os, lastScreen: location.pathname };
}

/* ── list ──────────────────────────────────────────────────────────────── */
function TicketList({ rows, selected, filter, q }: { rows: CustomerTicketRow[]; selected?: string; filter: Filter; q: string }) {
  if (!rows.length) {
    return (
      <Empty title={q ? 'No tickets match your search' : filter === 'all' ? 'No tickets yet' : 'Nothing here'}>
        {q ? 'Try a ticket number or a different word.' : 'When you write to support, your tickets and our replies appear here and in the app.'}
      </Empty>
    );
  }
  return (
    <ul className="hfs-clist__rows">
      {rows.map((t) => {
        const tone = statusTone(t.status);
        return (
          <li key={t.number}>
            <Link to={`/t/${t.number}${filter !== 'all' ? `?s=${filter}` : ''}`} className={`hfs-crow${selected === t.number ? ' is-on' : ''}${t.unread ? ' is-unread' : ''}`}>
              <span className="hfs-crow__top"><span>{t.number}</span><span>{ago(t.updatedAt)}</span></span>
              <span className="hfs-crow__subject">{t.unread && <i className="hfs-dot" aria-label="Unread" />}{t.subject}</span>
              <span className="hfs-crow__preview">{t.preview}</span>
              <Chip tint={tone.tint} ink={tone.ink}>{t.statusLabel}</Chip>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/* ── one message ───────────────────────────────────────────────────────── */
function Bubble({ m }: { m: CustomerMessage }) {
  if (m.author === 'system') {
    return <div className="hfs-sysline">{m.text}</div>;
  }
  const html = m.author === 'support' && m.html ? sanitizeHtml(m.html) : '';
  return (
    <article className="hfs-msg">
      <div className="hfs-msg__head">
        <strong className={m.author === 'support' ? 'is-support' : ''}>{m.author === 'customer' ? 'You' : m.authorName || `${BRAND.name} Support`}</strong>
        <span>{fullDate(m.createdAt)}</span>
      </div>
      {html ? <div className="hfs-msg__html" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="hfs-msg__text">{m.text}</p>}
      <FileChips files={m.attachments} />
    </article>
  );
}

/* ── a ticket ──────────────────────────────────────────────────────────── */
function TicketPane({ number, onChanged }: { number: string; onChanged: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<CustomerTicketDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const att = useAttachments();
  const visible = usePageVisible();
  const ctl = useRef<AbortController | null>(null);

  const load = useCallback(async (quiet = false) => {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    if (!quiet) { setErr(null); }
    try { const r = await customerApi.get(number, c.signal); if (!c.signal.aborted) setD(r); }
    catch (e) { if (!isAbort(e) && !quiet) setErr(errMessage(e, 'Could not open this ticket.')); }
  }, [number]);
  useEffect(() => { setD(null); setText(''); att.clear(); void load(); return () => ctl.current?.abort(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);
  useInterval(() => void load(true), visible ? 30_000 : null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (sending || att.uploading || !text.trim()) return;
    setSending(true);
    try {
      await customerApi.reply(number, text.trim(), att.ids);
      setText(''); att.clear();
      await load(true); onChanged();
      toast('Reply sent');
    } catch (x) { toast(errMessage(x, 'Could not send your reply.'), 'error'); }
    finally { setSending(false); }
  };
  const act = async (kind: 'solve' | 'reopen') => {
    try {
      if (kind === 'solve') await customerApi.solve(number); else await customerApi.reopen(number);
      await load(true); onChanged();
      toast(kind === 'solve' ? 'Marked as solved. Glad that is sorted.' : 'Ticket reopened.');
    } catch (x) { toast(errMessage(x, 'Could not update the ticket.'), 'error'); }
  };

  if (err) return <ErrorBox message={err} onRetry={() => void load()} />;
  if (!d) return <div className="hfs-center"><Spinner /></div>;
  const t = d.ticket;
  const tone = statusTone(t.status);
  const canReply = t.status !== 'closed' && t.status !== 'spam' && t.status !== 'trash';
  const solvedOk = t.status === 'solved';
  return (
    <>
      <div className="hfs-pane__head">
        <div>
          <div className="hfs-pane__kicker">{t.number} · {categoryLabel(t.category)}</div>
          <h1 className="hfs-pane__title">{t.subject}</h1>
        </div>
        <Chip tint={tone.tint} ink={tone.ink} className="hfs-chip--lg">{t.statusLabel}</Chip>
      </div>
      <div className="hfs-thread">{d.messages.map((m) => <Bubble key={m.id} m={m} />)}</div>

      {canReply ? (
        <form className="hfs-reply" onSubmit={send}>
          <label htmlFor="hfs-reply" className="hfs-label">{solvedOk ? 'Not fixed? Reply to reopen this ticket' : 'Reply'}</label>
          <textarea id="hfs-reply" className="hfs-input hfs-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your message" />
          <PickedChips items={att.items} onRemove={att.remove} uploading={att.uploading} error={att.error} />
          <div className="hfs-actions">
            <button type="submit" className="hfs-btn hfs-btn--primary" disabled={sending || att.uploading || !text.trim()}>{sending ? 'Sending…' : 'Send reply'}</button>
            <AttachButton onPick={(f) => void att.add(f)} disabled={att.uploading} />
            {isOpenish(t.status) && <button type="button" className="hfs-btn hfs-btn--green hfs-actions__end" onClick={() => void act('solve')}>This solved my issue</button>}
            {solvedOk && t.canReopen && <button type="button" className="hfs-btn hfs-btn--ghost hfs-actions__end" onClick={() => void act('reopen')}>Reopen ticket</button>}
          </div>
        </form>
      ) : (
        <div className="hfs-closedbox">
          <p>This ticket is closed. If you still need help, start a new ticket and we will link it to this one.</p>
          <Link to="/new" className="hfs-btn hfs-btn--primary">New ticket</Link>
        </div>
      )}
    </>
  );
}

/* ── new ticket ────────────────────────────────────────────────────────── */
function NewTicket({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [cat, setCat] = useState<CategorySlug | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const att = useAttachments();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || att.uploading) return;
    if (!cat) { setErr('Pick what it is about.'); return; }
    if (subject.trim().length < 3) { setErr('Add a short subject.'); return; }
    if (message.trim().length < 5) { setErr('Tell us what happened.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await customerApi.create({ category: cat, subject: subject.trim(), message: message.trim(), attachmentIds: att.ids, meta: deviceMeta() });
      onCreated();
      toast(`Your ticket ${r.number} is open. Someone from ${BRAND.name} will respond back soon.`);
      navigate(r.number ? `/t/${r.number}` : '/');
    } catch (x) { setErr(errMessage(x, 'Could not send your ticket. Please try again.')); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="hfs-pane__head">
        <div>
          <div className="hfs-pane__kicker">New ticket</div>
          <h1 className="hfs-pane__title">Open a ticket</h1>
        </div>
      </div>
      <p className="hfs-lead">We reply by email and right here. Mon–Sat, 10 am–7 pm IST.</p>
      <p className="hfs-label">What is it about?</p>
      <div className="hfs-pills" role="radiogroup" aria-label="Topic">
        {CATEGORIES.map((c) => (
          <button key={c.slug} type="button" role="radio" aria-checked={cat === c.slug} className={`hfs-pill${cat === c.slug ? ' is-on' : ''}`} onClick={() => setCat(c.slug)}>{c.label}</button>
        ))}
      </div>
      <label htmlFor="hfs-subj" className="hfs-label">Subject</label>
      <input id="hfs-subj" className="hfs-input" value={subject} maxLength={140} onChange={(e) => setSubject(e.target.value)} />
      <label htmlFor="hfs-msg" className="hfs-label hfs-label--gap">Tell us what happened</label>
      <textarea id="hfs-msg" className="hfs-input hfs-textarea" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="hfs-actions">
        <AttachButton onPick={(f) => void att.add(f)} disabled={att.uploading} label="Add a screenshot" icon="image" />
      </div>
      <PickedChips items={att.items} onRemove={att.remove} uploading={att.uploading} error={att.error} />
      <p className="hfs-fineprint">Your browser and device are added for us automatically.</p>
      {err && <p className="hfs-formerr" role="alert">{err}</p>}
      <div className="hfs-actions">
        <button type="submit" className="hfs-btn hfs-btn--primary hfs-btn--xl" disabled={busy || att.uploading}>{busy ? 'Sending…' : 'SEND TO SUPPORT'}</button>
        <Link to="/" className="hfs-btn hfs-btn--ghost">Cancel</Link>
      </div>
    </form>
  );
}

/* ── the screen ────────────────────────────────────────────────────────── */
export default function CustomerApp() {
  const auth = useAuthState();
  const loc = useLoc();
  const [rows, setRows] = useState<CustomerTicketRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const visible = usePageVisible();

  const filter = (['all', 'open', 'solved', 'closed'].includes(loc.params.get('s') ?? '') ? loc.params.get('s') : 'all') as Filter;
  const m = loc.path.match(/^\/t\/(HF-\d+)$/i);
  const openNumber = m ? m[1].toUpperCase() : undefined;
  const composing = loc.path === '/new';

  const load = useCallback(async () => {
    try { setRows(await customerApi.list('all')); setErr(null); }
    catch (e) { setErr(errMessage(e, 'Could not load your tickets.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useInterval(() => void load(), visible ? 45_000 : null);

  const counts = useMemo(() => {
    const r = rows ?? [];
    return { all: r.length, open: r.filter((t) => isOpenish(t.status)).length, solved: r.filter((t) => t.status === 'solved').length, closed: r.filter((t) => t.status === 'closed').length };
  }, [rows]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter((t) => (filter === 'all' || (filter === 'open' ? isOpenish(t.status) : t.status === filter))
      && (!needle || `${t.number} ${t.subject} ${t.preview}`.toLowerCase().includes(needle)));
  }, [rows, filter, q]);

  const detailOpen = composing || !!openNumber;
  const navItems: { key: Filter; label: string }[] = [{ key: 'all', label: 'All tickets' }, { key: 'open', label: 'Open' }, { key: 'solved', label: 'Solved' }, { key: 'closed', label: 'Closed' }];

  return (
    <div className="hfs hfs-customer hfs-cust">
      <header className="hfs-bar">
        <Link to="/" className="hfs-bar__brand"><Wordmark /></Link>
        <label htmlFor="hfs-q" className="hfs-sr">Search my tickets</label>
        <div className="hfs-search">
          <Icon name="search" size={18} />
          <input id="hfs-q" type="search" placeholder="Search my tickets" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="hfs-bar__user">
          <Menu align="right" className="hfs-userbtn" label={<><span className="hfs-userbtn__name">{auth.name || 'Me'}</span><Avatar name={auth.name || auth.email} /></>}>
            {(close) => (
              <>
                <div className="hfs-menu__note">{auth.email}</div>
                <MenuItem onClick={() => { close(); window.location.href = brandUrl('/'); }}>Back to {BRAND.domain}</MenuItem>
                <MenuItem onClick={() => { close(); void auth.signOut(); }}>Sign out</MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className={`hfs-cgrid${detailOpen ? ' has-detail' : ''}`}>
        <nav className="hfs-cnav" aria-label="Ticket folders">
          <Link to="/new" className="hfs-btn hfs-btn--primary hfs-btn--xl hfs-cnav__new"><Icon name="plus" size={20} />New ticket</Link>
          {navItems.map((n) => (
            <Link key={n.key} to={n.key === 'all' ? '/' : `/?s=${n.key}`} className={`hfs-cnav__item${filter === n.key ? ' is-on' : ''}`}>
              {n.label} <span>{rows ? counts[n.key] : ''}</span>
            </Link>
          ))}
        </nav>

        <section className="hfs-card hfs-clist" aria-label="Tickets">
          {err ? <ErrorBox message={err} onRetry={() => void load()} /> : rows === null ? <div className="hfs-center"><Spinner /></div> : <TicketList rows={shown} selected={openNumber} filter={filter} q={q} />}
        </section>

        <section className="hfs-card hfs-cpane" aria-label="Ticket">
          <Rose size={40} className="hfs-flower--tr" />
          {detailOpen && <Link to={filter === 'all' ? '/' : `/?s=${filter}`} className="hfs-back"><Icon name="back" size={18} />All tickets</Link>}
          {composing ? <NewTicket onCreated={() => void load()} />
            : openNumber ? <TicketPane key={openNumber} number={openNumber} onChanged={() => void load()} />
            : (
              <Empty title={rows && rows.length ? 'Pick a ticket to read it' : 'We are here to help'} action={<Link to="/new" className="hfs-btn hfs-btn--primary">Open a ticket</Link>}>
                {rows && rows.length ? 'Your conversation and our replies show here.' : 'Open a ticket and we will reply by email and right here.'}
              </Empty>
            )}
        </section>
      </div>
      <footer className="hfs-foot"><Marigold size={22} /><Lilac size={22} /><span>{BRAND.name} Support · Mon–Sat, 10 am–7 pm IST</span></footer>
    </div>
  );
}
