// [HF-SUPPORT-DESK] One ticket for staff (design: AdminTicket): actions, the thread with yellow internal notes, Reply / Internal
// note tabs, saved replies, the signature line, delivery ticks, the "someone else is viewing" banner (heartbeat every 20 s),
// a 10-second undo before a reply is really sent, and the customer panel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND, brandUrl } from '../../lib/brand';
import { AttachButton, FileChips, PickedChips, useAttachments } from './attachments';
import { adminApi, errMessage, isAbort } from './api';
import { fileSize, fullDate, initials, monthYear, plural, rupees, slaText, textToHtml, timeOnly, toMs } from './format';
import { readList } from './AdminInbox';
import { Link, navigate, setQuery, useLoc } from './router';
import { sanitizeHtml } from './sanitize';
import { SubHeader, useHotkeys, useStaff } from './staff';
import { CATEGORIES, PRIORITIES, categoryLabel, categoryShort, type AdminDetail, type AdminMessage, type CannedReply, type Status, type TicketEvent } from './types';
import { Corner } from './desi';
import { Chip, ErrorBox, Gold, Menu, MenuItem, Modal, PRIORITY_LABEL, Spinner, categoryTone, priorityChipTone, statusTone, useCountdown, useInterval, usePageVisible, useToast } from './ui';
import { ShortcutList } from './AdminInbox';

const STATUS_LABEL: Record<string, string> = { new: 'New', open: 'Open', waiting: 'Waiting on customer', on_hold: 'On hold', solved: 'Solved', closed: 'Closed', spam: 'Spam', trash: 'Trash' };
const UNDO_MS = 10_000;

type Item = { kind: 'msg'; at: number; m: AdminMessage } | { kind: 'event'; at: number; e: TicketEvent };

function Delivery({ state }: { state?: string | null }) {
  switch (state) {
    case 'queued': return <span className="hfs-tick is-wait">Sending…</span>;
    case 'sent': return <span className="hfs-tick">Sent ✓</span>;
    case 'delivered': case 'opened': return <span className="hfs-tick is-ok">Delivered ✓✓</span>;
    case 'failed': case 'bounced': return <span className="hfs-tick is-bad">Not delivered ✗</span>;
    default: return null;
  }
}

function Message({ m, canWrite, onSplit }: { m: AdminMessage; canWrite: boolean; onSplit: (id: string) => void }) {
  if (m.kind === 'note') {
    return (
      <div className="hfs-note-card">
        <div className="hfs-note-card__head">Internal note · {m.authorName} · {timeOnly(m.createdAt)}</div>
        <p>{m.text}</p>
      </div>
    );
  }
  if (m.kind === 'system') return <div className="hfs-sysline">{m.text}</div>;
  const html = m.kind === 'support' && m.html ? sanitizeHtml(m.html) : '';
  return (
    <article className={`hfs-card hfs-amsg${m.kind === 'support' ? ' is-support' : ''}`}>
      <div className="hfs-amsg__head">
        <strong className={m.kind === 'support' ? 'is-support' : ''}>{m.kind === 'support' ? `${m.authorName}` : `${m.authorName}${m.authorEmail ? ` <${m.authorEmail}>` : ''}`}</strong>
        <span className="hfs-amsg__meta">
          {fullDate(m.createdAt)}{m.kind === 'support' && m.delivery ? <> · <Delivery state={m.delivery} /></> : null}
          {m.kind === 'customer' && canWrite && (
            <Menu align="right" className="hfs-iconbtn hfs-iconbtn--dots" label={<span aria-hidden="true">⋯</span>} title="Message actions">
              {(close) => <MenuItem onClick={() => { close(); onSplit(m.id); }}>Split into a new ticket</MenuItem>}
            </Menu>
          )}
        </span>
      </div>
      {html ? <div className="hfs-msg__html" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="hfs-msg__text">{m.text}</p>}
      <FileChips files={m.attachments} />
    </article>
  );
}

export default function AdminTicket({ number }: { number: string }) {
  const me = useStaff();
  const toast = useToast();
  const loc = useLoc();
  const visible = usePageVisible();

  const [d, setD] = useState<AdminDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [modal, setModal] = useState<null | 'merge' | 'block' | 'help'>(null);
  const [canned, setCanned] = useState<CannedReply[]>([]);
  const [sigLabel, setSigLabel] = useState('Team signature');
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<null | { endsAt: number; setStatus?: Status }>(null);
  const att = useAttachments();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const known = useRef<Set<string>>(new Set());
  const ctl = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef({ text: '', tab: 'reply' as 'reply' | 'note', ids: [] as string[] });
  draft.current = { text, tab, ids: att.ids };

  const load = useCallback(async (quiet = false) => {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    try {
      const r = await adminApi.ticket(number, c.signal);
      if (c.signal.aborted) return;
      if (quiet && known.current.size) {
        const arrived = r.messages.some((m) => !known.current.has(m.id) && m.kind !== 'note');
        if (arrived) setFresh(true);
      }
      known.current = new Set(r.messages.map((m) => m.id));
      setD(r); setErr(null);
    } catch (e) {
      if (isAbort(e) || c.signal.aborted) return;
      if (!quiet) setErr(errMessage(e, 'Could not open this ticket.'));
    }
  }, [number]);

  useEffect(() => {
    setD(null); setText(''); setFresh(false); setTab('reply'); att.clear(); known.current = new Set();
    void load();
    void adminApi.viewing(number).catch(() => undefined);
    return () => ctl.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  // Collision heartbeat: tell the server we are looking (30 s TTL) and pick up new messages / other viewers.
  useInterval(() => { if (!pending) void adminApi.viewing(number).then(() => load(true)).catch(() => undefined); }, visible ? 20_000 : null);

  useEffect(() => { adminApi.canned().then(setCanned).catch(() => undefined); }, []);
  useEffect(() => {
    adminApi.signature('me').then((s) => { if (s.useFor === 'personal') setSigLabel('My personal signature'); }).catch(() => undefined);
  }, []);

  // ?focus=reply|note from the inbox shortcuts
  const focus = loc.params.get('focus');
  useEffect(() => {
    if (!d || !focus) return;
    setTab(focus === 'note' ? 'note' : 'reply');
    setTimeout(() => boxRef.current?.focus(), 30);
    setQuery({ focus: null });
  }, [d, focus]);

  /* the 10-second undo, then the real send */
  const flush = useCallback(async (setStatus?: Status) => {
    const cur = draft.current;
    try {
      await adminApi.reply(number, { html: textToHtml(cur.text.trim()), text: cur.text.trim(), attachmentIds: cur.ids, setStatus });
      setText(''); att.clear(); setPending(null);
      toast('Reply sent');
      await load(true);
    } catch (e) {
      setPending(null);
      toast(`${errMessage(e, 'Could not send the reply.')} Your text is still in the box.`, 'error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number, load]);
  const startSend = (setStatus?: Status) => {
    if (!text.trim() || att.uploading || pending) return;
    if (!me.canWrite) { toast('You have read-only access, so you cannot reply.', 'error'); return; }
    setPending({ endsAt: Date.now() + UNDO_MS, setStatus });
    timer.current = setTimeout(() => { timer.current = null; void flush(setStatus); }, UNDO_MS);
  };
  const undo = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setPending(null); toast('Not sent. Your reply is back in the box.', 'info'); setTimeout(() => boxRef.current?.focus(), 20); };
  // Leaving the page with a reply waiting: send it now rather than lose it (the person did press Send).
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current); timer.current = null;
      const cur = draft.current;
      void adminApi.reply(number, { html: textToHtml(cur.text.trim()), text: cur.text.trim(), attachmentIds: cur.ids }).catch(() => undefined);
    }
  }, [number]);
  useEffect(() => {
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);

  const saveNote = async () => {
    if (!text.trim() || busy) return;
    if (!me.canWrite) { toast('You have read-only access.', 'error'); return; }
    setBusy(true);
    try { await adminApi.note(number, text.trim()); setText(''); toast('Note saved'); await load(true); }
    catch (e) { toast(errMessage(e), 'error'); }
    finally { setBusy(false); }
  };

  /* actions */
  const patch = async (b: Parameters<typeof adminApi.patch>[1], done: string) => {
    if (!me.canWrite) { toast('You have read-only access.', 'error'); return; }
    try { await adminApi.patch(number, b); toast(done); await load(true); }
    catch (e) { toast(errMessage(e), 'error'); }
  };
  const spam = async () => {
    if (!me.canWrite) { toast('You have read-only access.', 'error'); return; }
    try { await adminApi.spam(number); toast(`${number} flagged as spam`); navigate(`/desk?f=${readList()?.folder ?? 'unassigned'}`); }
    catch (e) { toast(errMessage(e), 'error'); }
  };
  const split = async (messageId: string) => {
    try { const r = await adminApi.split(number, messageId); toast(r.number ? `Split into ${r.number}` : 'Split into a new ticket'); await load(true); }
    catch (e) { toast(errMessage(e), 'error'); }
  };

  /* shortcuts: j/k step through the list the inbox showed */
  const step = (dir: 1 | -1) => {
    const l = readList();
    if (!l) return;
    const i = l.numbers.indexOf(number);
    const n = l.numbers[i + dir];
    if (n) navigate(`/desk/t/${n}`);
  };
  useHotkeys({
    j: () => step(1), k: () => step(-1),
    r: (e) => { e.preventDefault(); setTab('reply'); boxRef.current?.focus(); },
    n: (e) => { e.preventDefault(); setTab('note'); boxRef.current?.focus(); },
    e: () => { if (d && d.ticket.status !== 'solved') void patch({ status: 'solved' }, 'Marked solved'); },
    '!': () => void spam(),
    '?': () => setModal('help'),
    u: () => navigate(`/desk?f=${readList()?.folder ?? 'unassigned'}`),
  });

  /* thread: newest first; the composer sits after what is still unanswered, like the design */
  const { top, rest } = useMemo(() => {
    if (!d) return { top: [] as Item[], rest: [] as Item[] };
    const items: Item[] = [
      ...d.messages.map((m): Item => ({ kind: 'msg', at: toMs(m.createdAt) ?? 0, m })),
      ...d.events.map((e): Item => ({ kind: 'event', at: toMs(e.createdAt) ?? 0, e })),
    ].sort((a, b) => b.at - a.at);
    const i = items.findIndex((x) => x.kind === 'msg' && x.m.kind === 'support');
    return i < 0 ? { top: items, rest: [] as Item[] } : { top: items.slice(0, i), rest: items.slice(i) };
  }, [d]);

  const left = useCountdown(pending?.endsAt ?? 0);

  if (err) return (<div className="hfs hfs-admin"><SubHeader back="Inbox" backTo="/desk" /><div className="hfs-pad"><ErrorBox message={err} onRetry={() => void load()} /></div></div>);
  if (!d) return (<div className="hfs hfs-admin"><SubHeader back="Inbox" backTo="/desk" /><div className="hfs-center"><Spinner /></div></div>);

  const t = d.ticket;
  const c = d.customer;
  const folder = readList()?.folder ?? 'unassigned';
  const others = d.viewers.filter((v) => !v.me && v.uid !== me.uid);
  const st = statusTone(t.status);
  const pr = priorityChipTone(t.priority);
  const ct = categoryTone(t.category);
  const sla = slaText(t.sla);
  const slaChip = sla.text && ['new', 'open', 'on_hold'].includes(t.status)
    ? (sla.state === 'red' ? sla.text.replace('Overdue', 'Reply overdue by') : `First reply due in ${sla.text.replace(' left', '')}`) : '';
  const firstName = c.name.split(/\s+/)[0] ?? c.name;
  const readOnly = !me.canWrite;

  const insertCanned = (r: CannedReply) => {
    const body = r.body.replace(/\{customer_name\}/g, firstName).replace(/\{ticket_number\}/g, t.number).replace(/\{agent_name\}/g, me.name);
    setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${body}` : body));
    setTab('reply');
    setTimeout(() => boxRef.current?.focus(), 20);
  };

  const forward = () => {
    const body = d.messages.filter((m) => m.kind !== 'note').slice().reverse().map((m) => `${m.authorName} · ${fullDate(m.createdAt)}\n${m.text}`).join('\n\n---\n\n');
    window.location.href = `mailto:?subject=${encodeURIComponent(`Fwd: [${t.number}] ${t.subject}`)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
  };
  const snoozeAt = (ms: number) => void patch({ snoozeUntil: ms }, 'Snoozed');
  const tomorrow10 = () => { const x = new Date(); x.setDate(x.getDate() + 1); x.setHours(10, 0, 0, 0); return x.getTime(); };
  const monday10 = () => { const x = new Date(); x.setDate(x.getDate() + ((8 - x.getDay()) % 7 || 7)); x.setHours(10, 0, 0, 0); return x.getTime(); };

  const renderItem = (it: Item) => it.kind === 'event'
    ? <div key={it.e.id} className="hfs-sysline">{it.e.text} · {timeOnly(it.e.createdAt)}</div>
    : <Message key={it.m.id} m={it.m} canWrite={me.canWrite} onSplit={(id) => void split(id)} />;

  return (
    <div className="hfs hfs-admin hfs-ticketpage">
      <SubHeader back={STATUS_LABEL[folder] ?? (folder === 'unassigned' ? 'Unassigned' : folder === 'mine' ? 'My tickets' : folder === 'open' ? 'All open' : 'Inbox')} backTo={`/desk?f=${folder}`}>
        <span className="hfs-crumb">{t.number}</span>
        {others.length > 0 && <span className="hfs-viewing" role="status">{others.map((v) => v.name).join(' and ')} {others.length > 1 ? 'are' : 'is'} viewing this ticket</span>}
      </SubHeader>

      <div className="hfs-ticket hfs-in">
        <main className="hfs-ticket__main">
          {fresh && <div className="hfs-banner" role="status">A new message arrived on this ticket. <button type="button" className="hfs-linkbtn" onClick={() => setFresh(false)}>Dismiss</button></div>}
          {readOnly && <div className="hfs-banner hfs-banner--info">You have view-only access. You can read tickets but not change them.</div>}

          <section className="hfs-card hfs-thead has-corner">
            <Corner kind="genda" size={60} />
            <p className="hfs-thead__no">{t.number} · {categoryLabel(t.category)}</p>
            <h1>{t.subject}</h1>
            <div className="hfs-chips">
              <Chip tint={st.tint} ink={st.ink}>{STATUS_LABEL[t.status] ?? t.status}</Chip>
              <Chip tint={pr.tint} ink={pr.ink}>{PRIORITY_LABEL[t.priority]}</Chip>
              <Chip tint={ct.tint} ink={ct.ink}>{categoryShort(t.category)}</Chip>
              <Chip tint="#F8EEE6" ink="#6F5B6F">via {t.channel}</Chip>
              {slaChip && <Chip tint={sla.state === 'red' ? '#FFE6EF' : '#F8EEE6'} ink={sla.state === 'red' ? '#C0262D' : '#6F5B6F'}>{slaChip}</Chip>}
              {t.snoozeUntil && <Chip tint="#E3F6F6" ink="#0E7C86">Snoozed until {fullDate(t.snoozeUntil)}</Chip>}
            </div>
            <div className="hfs-actionsbar" role="toolbar" aria-label="Ticket actions">
              <Menu className="hfs-btn hfs-btn--pill" label={`Assign: ${t.assignee ? (t.assignee.uid === me.uid ? 'me' : t.assignee.name) : 'nobody'}`} disabled={readOnly}>
                {(close) => (<>
                  <MenuItem active={t.assignee?.uid === me.uid} onClick={() => { close(); void patch({ assigneeUid: me.uid }, 'Assigned to you'); }}>Assign to me</MenuItem>
                  {me.team.filter((x) => x.uid && x.uid !== me.uid).map((x) => <MenuItem key={x.id} active={t.assignee?.uid === x.uid} onClick={() => { close(); void patch({ assigneeUid: x.uid ?? null }, `Assigned to ${x.name || x.email}`); }}>{x.name || x.email}</MenuItem>)}
                  <MenuItem onClick={() => { close(); void patch({ assigneeUid: null }, 'Unassigned'); }}>Unassign</MenuItem>
                </>)}
              </Menu>
              <Menu className="hfs-btn hfs-btn--pill" label="Priority" disabled={readOnly}>
                {(close) => PRIORITIES.map((p) => <MenuItem key={p} active={t.priority === p} onClick={() => { close(); void patch({ priority: p }, `Priority: ${PRIORITY_LABEL[p]}`); }}>{PRIORITY_LABEL[p]}</MenuItem>)}
              </Menu>
              <Menu className="hfs-btn hfs-btn--pill" label="Category" disabled={readOnly}>
                {(close) => CATEGORIES.map((x) => <MenuItem key={x.slug} active={t.category === x.slug} onClick={() => { close(); void patch({ category: x.slug }, `Category: ${x.label}`); }}>{x.label}</MenuItem>)}
              </Menu>
              {t.status === 'solved' || t.status === 'closed'
                ? <button type="button" className="hfs-btn hfs-btn--pill" disabled={readOnly} onClick={() => void patch({ status: 'open' }, 'Reopened')}>Reopen</button>
                : <button type="button" className="hfs-btn hfs-btn--green hfs-btn--pill" disabled={readOnly} onClick={() => void patch({ status: 'solved' }, 'Marked solved')}>Solve</button>}
              <button type="button" className={`hfs-btn hfs-btn--pill${t.status === 'on_hold' ? ' is-on' : ''}`} disabled={readOnly} onClick={() => void patch({ status: t.status === 'on_hold' ? 'open' : 'on_hold' }, t.status === 'on_hold' ? 'Taken off hold' : 'Put on hold')}>On hold</button>
              <Menu className="hfs-btn hfs-btn--pill" label="Snooze" disabled={readOnly}>
                {(close) => (<>
                  <MenuItem onClick={() => { close(); snoozeAt(Date.now() + 3_600_000); }}>For 1 hour</MenuItem>
                  <MenuItem onClick={() => { close(); snoozeAt(Date.now() + 3 * 3_600_000); }}>For 3 hours</MenuItem>
                  <MenuItem onClick={() => { close(); snoozeAt(tomorrow10()); }}>Tomorrow, 10 am</MenuItem>
                  <MenuItem onClick={() => { close(); snoozeAt(monday10()); }}>Next Monday, 10 am</MenuItem>
                  {t.snoozeUntil && <MenuItem onClick={() => { close(); void patch({ snoozeUntil: null, status: 'open' }, 'Snooze cleared'); }}>Clear snooze</MenuItem>}
                </>)}
              </Menu>
              <button type="button" className="hfs-btn hfs-btn--pill" disabled={readOnly} onClick={() => setModal('merge')}>Merge</button>
              <Menu className="hfs-btn hfs-btn--pill" label="More ▾">
                {(close) => (<>
                  <MenuItem onClick={() => { close(); forward(); }}>Forward by email</MenuItem>
                  <MenuItem onClick={() => { close(); window.print(); }}>Print</MenuItem>
                  <MenuItem disabled={readOnly} onClick={() => { close(); setModal('block'); }}>Block sender…</MenuItem>
                  <MenuItem onClick={() => { close(); void navigator.clipboard?.writeText(`${location.origin}${location.pathname}`).then(() => toast('Link copied')); }}>Copy link</MenuItem>
                  <MenuItem disabled={readOnly} onClick={() => { close(); void patch({ status: 'closed' }, 'Closed'); }}>Close ticket</MenuItem>
                  <MenuItem danger disabled={readOnly} onClick={() => { close(); void patch({ status: 'trash' }, 'Moved to trash'); }}>Move to trash</MenuItem>
                  <MenuItem onClick={() => { close(); setModal('help'); }}>Keyboard shortcuts</MenuItem>
                </>)}
              </Menu>
              {t.status === 'spam'
                ? <button type="button" className="hfs-btn hfs-btn--pill" disabled={readOnly} onClick={() => void patch({ status: 'open' }, 'Marked as not spam')}>Not spam</button>
                : <button type="button" className="hfs-btn hfs-btn--red hfs-btn--pill" disabled={readOnly} onClick={() => void spam()}>Flag as spam</button>}
            </div>
          </section>

          {top.map(renderItem)}

          <section className={`hfs-composer${tab === 'note' ? ' is-note' : ''}`} aria-label="Reply or note">
            <div className="hfs-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'reply'} className={tab === 'reply' ? 'is-on' : ''} onClick={() => setTab('reply')}>Reply to customer</button>
              <button type="button" role="tab" aria-selected={tab === 'note'} className={tab === 'note' ? 'is-on is-note' : ''} onClick={() => setTab('note')}>Internal note</button>
            </div>
            <div className="hfs-composer__body">
              {others.length > 0 && tab === 'reply' && <p className="hfs-warnline">{others.map((v) => v.name).join(' and ')} {others.length > 1 ? 'are' : 'is'} also looking at this ticket. Check with them before replying.</p>}
              <div className="hfs-composer__tools">
                {tab === 'reply' && (
                  <Menu className="hfs-btn hfs-btn--soft hfs-btn--sm" label="Saved replies ▾">
                    {(close) => (<>
                      {canned.length === 0 && <div className="hfs-menu__note">No saved replies yet.</div>}
                      {canned.map((r) => <MenuItem key={r.id} onClick={() => { close(); insertCanned(r); }}>{r.title}</MenuItem>)}
                      <MenuItem onClick={() => { close(); navigate('/desk/settings/canned'); }}>Manage saved replies…</MenuItem>
                    </>)}
                  </Menu>
                )}
                {tab === 'reply' && <AttachButton onPick={(f) => void att.add(f)} disabled={att.uploading || !!pending} className="hfs-btn hfs-btn--soft hfs-btn--sm" label="Attach" />}
              </div>
              <label htmlFor="hfs-rep" className="hfs-sr">{tab === 'reply' ? 'Message to the customer' : 'Internal note'}</label>
              <textarea
                id="hfs-rep" ref={boxRef} className="hfs-composer__text" rows={6} value={text} readOnly={!!pending || readOnly}
                placeholder={tab === 'reply' ? `Write to ${firstName}…` : 'Only your team can see this note'}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (tab === 'reply') startSend(); else void saveNote(); } if (e.key === 'Escape') (e.target as HTMLElement).blur(); }}
              />
              {tab === 'reply' && <PickedChips items={att.items} onRemove={att.remove} uploading={att.uploading} error={att.error} />}
              {tab === 'reply' && (
                <div className="hfs-sigline">Signature: {sigLabel} ({me.name} · {BRAND.name} Support) · <Link to="/desk/settings/signature">change</Link></div>
              )}
              {pending ? (
                <div className="hfs-undo" role="status">
                  <span>Sending in {left} s…</span>
                  <button type="button" className="hfs-btn hfs-btn--white hfs-btn--sm" onClick={undo}>Undo</button>
                </div>
              ) : (
                <div className="hfs-actions">
                  {tab === 'reply' ? (<>
                    <button type="button" className="hfs-btn hfs-btn--primary" disabled={!text.trim() || att.uploading || readOnly} onClick={() => startSend()}>Send reply</button>
                    <button type="button" className="hfs-btn hfs-btn--ghost" disabled={!text.trim() || att.uploading || readOnly} onClick={() => startSend('waiting')}>Send and set Waiting on customer</button>
                    <span className="hfs-fineprint">10-second undo after sending · Ctrl+Enter sends</span>
                  </>) : (
                    <button type="button" className="hfs-btn hfs-btn--note" disabled={!text.trim() || busy || readOnly} onClick={() => void saveNote()}>Save note</button>
                  )}
                </div>
              )}
            </div>
          </section>

          {rest.map(renderItem)}
          {rest.length === 0 && top.length === 0 && <p className="hfs-fineprint">No messages yet.</p>}
        </main>

        <aside className="hfs-ticket__aside" aria-label="Customer">
          <section className="hfs-card hfs-cpanel">
            <Gold size={34} className="hfs-flower--tr" />
            <div className="hfs-cpanel__who">
              <span className="hfs-avatar hfs-avatar--lilac hfs-cpanel__av" aria-hidden="true">{initials(c.name)}</span>
              <div>
                <div className="hfs-cpanel__name">{c.name} <span style={{ color: c.role === 'influencer' ? '#0E7C86' : c.role === 'fan' ? '#6D4FD0' : '#C0262D' }}>· {c.role === 'fan' ? 'Fan' : c.role === 'influencer' ? 'Influencer' : 'Not verified'}</span></div>
                <div className="hfs-cpanel__sub">{c.handle ? `${c.handle} · ` : ''}{c.joinedAt ? `joined ${monthYear(c.joinedAt)}` : c.uid ? '' : 'email only, no account yet'}</div>
              </div>
            </div>
            {c.uid ? (
              <dl className="hfs-stats">
                <div className="is-amber"><dt>Wallet</dt><dd>{rupees(c.walletRupees)}</dd></div>
                <div className="is-teal"><dt>Withdraw pending</dt><dd>{rupees(c.pendingWithdrawRupees)}</dd></div>
                <div className="is-violet"><dt>Calls (30 days)</dt><dd>{c.calls30d ?? '–'}</dd></div>
                <div className="is-rose"><dt>Strikes</dt><dd>{c.strikes ?? '–'}</dd></div>
              </dl>
            ) : <p className="hfs-fineprint">This sender has not verified yet. Once they verify at the support site, their earlier tickets attach to their account.</p>}
            <div className="hfs-cpanel__contact">
              {c.whatsappMasked && <div>WhatsApp {c.whatsappMasked} ✓</div>}
              {c.email && <div>{c.email}{c.uid ? ' ✓' : ''}</div>}
            </div>
            {c.uid && <a className="hfs-cpanel__link" href={brandUrl(`/admin/customers/${encodeURIComponent(c.uid)}`)} target="_blank" rel="noopener noreferrer">Open in admin →</a>}
          </section>

          {c.recentMoney.length > 0 && (
            <section className="hfs-card hfs-sidecard hfs-t-gold has-corner">
              <Corner kind="jasmine" size={50} />
              <h2>Recent money</h2>
              <ul className="hfs-money">
                {c.recentMoney.map((m, i) => (<li key={i}><span>{m.label}</span><strong className={m.amountRupees > 0 ? 'is-in' : ''}>{m.amountRupees > 0 ? '+' : '−'}₹{Math.abs(m.amountRupees).toLocaleString('en-IN')}</strong></li>))}
              </ul>
            </section>
          )}

          <section className="hfs-card hfs-sidecard hfs-t-lav has-corner">
            <Corner kind="hibiscus" size={60} />
            <h2>Other tickets</h2>
            {c.otherTickets.length === 0 ? <p className="hfs-fineprint">No other tickets from this person.</p> : c.otherTickets.map((o) => (
              <Link key={o.number} to={`/desk/t/${o.number}`} className="hfs-other">{o.number} · {o.subject} · {o.status}</Link>
            ))}
          </section>
        </aside>
      </div>

      {modal === 'merge' && <MergeModal from={t.number} options={c.otherTickets.map((o) => o.number)} onClose={() => setModal(null)} onDone={(into) => { setModal(null); toast(`Merged into ${into}`); navigate(`/desk/t/${into}`); }} />}
      {modal === 'block' && <BlockModal email={c.email ?? ''} onClose={() => setModal(null)} onDone={() => { setModal(null); toast('Sender blocked'); }} />}
      {modal === 'help' && <Modal title="Keyboard shortcuts" onClose={() => setModal(null)}><ShortcutList /></Modal>}
      <div className="hfs-printonly">
        <h1>{t.number} · {t.subject}</h1>
        <p>{c.name} · {c.email} · {categoryLabel(t.category)} · {STATUS_LABEL[t.status]}</p>
        <p>{plural(d.messages.length, 'message')} · {d.messages.reduce((n, m) => n + m.attachments.reduce((s, a) => s + a.size, 0), 0) ? `attachments ${fileSize(d.messages.reduce((n, m) => n + m.attachments.reduce((s, a) => s + a.size, 0), 0))}` : 'no attachments'}</p>
      </div>
    </div>
  );
}

function MergeModal({ from, options, onClose, onDone }: { from: string; options: string[]; onClose: () => void; onDone: (into: string) => void }) {
  const toast = useToast();
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const n = into.trim().toUpperCase().replace(/^#/, '');
    if (!/^HF-\d+$/.test(n)) { toast('Enter a ticket number like HF-10234.', 'error'); return; }
    if (n === from) { toast('Pick a different ticket.', 'error'); return; }
    setBusy(true);
    try { await adminApi.merge(from, n); onDone(n); } catch (e) { toast(errMessage(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Merge ${from} into another ticket`} onClose={onClose}>
      <p>Messages from {from} move into the ticket you pick, and {from} is closed.</p>
      <label htmlFor="hfs-mg" className="hfs-label">Merge into</label>
      <input id="hfs-mg" className="hfs-input" placeholder="HF-10234" value={into} onChange={(e) => setInto(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />
      {options.length > 0 && <div className="hfs-pills hfs-pills--sm">{options.map((o) => <button key={o} type="button" className="hfs-pill" onClick={() => setInto(o)}>{o}</button>)}</div>}
      <div className="hfs-modal__actions">
        <button type="button" className="hfs-btn hfs-btn--primary" disabled={busy} onClick={() => void go()}>{busy ? 'Merging…' : 'Merge'}</button>
        <button type="button" className="hfs-btn hfs-btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function BlockModal({ email, onClose, onDone }: { email: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const domain = email.split('@')[1] ?? '';
  const [what, setWhat] = useState<'email' | 'domain'>('email');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await adminApi.block(what === 'email' ? { email } : { domain }); onDone(); } catch (e) { toast(errMessage(e), 'error'); } finally { setBusy(false); }
  };
  if (!email) return <Modal title="Block sender" onClose={onClose}><p>This ticket has no email address to block.</p></Modal>;
  return (
    <Modal title="Block sender" onClose={onClose}>
      <p>Blocked senders can no longer open tickets by email. They get no reply and no alert.</p>
      <label className="hfs-radio"><input type="radio" name="blk" checked={what === 'email'} onChange={() => setWhat('email')} /> Block <strong>{email}</strong></label>
      <label className="hfs-radio"><input type="radio" name="blk" checked={what === 'domain'} onChange={() => setWhat('domain')} /> Block everyone at <strong>{domain}</strong></label>
      <div className="hfs-modal__actions">
        <button type="button" className="hfs-btn hfs-btn--red" disabled={busy} onClick={() => void go()}>{busy ? 'Blocking…' : 'Block'}</button>
        <button type="button" className="hfs-btn hfs-btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
