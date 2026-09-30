/* AI assistant › Conversations — [SAATHUM-PREETI-1 2026-09-30]
 * WhatsApp-Web-style inbox. Left: searchable, filterable list (cursor infinite scroll, polled every
 * 20 s while the tab is visible). Right: the chat, with status, an internal note and the person's
 * bookings. On phones the list is the page and a chat opens full-screen with a Back button. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Loader2, MessageCircle, MessagesSquare, Search } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { toast } from '../../components/ui/sonner';
import { errMessage, istDateTime } from './adminApi';
import { ErrorBox, ListSkeleton } from './peopleKit';
import { aiApi, type AdminAiConversationDetail, type AdminAiConversationRow, type AdminAiMessage, type ConvStatus } from './aiApi';
import { Chip, HINT, LABEL, TEXTAREA } from './AiKit';

const BADGES: { key: string; label: string; variant: 'destructive' | 'accent' | 'secondary' | 'outline' }[] = [
  { key: 'hot_lead', label: 'Hot lead', variant: 'accent' },
  { key: 'needs_human', label: 'Needs human', variant: 'destructive' },
  { key: 'booking_check', label: 'Booking check', variant: 'secondary' },
  { key: 'angry', label: 'Angry', variant: 'destructive' },
];
const badgeMeta = (k: string) => BADGES.find((b) => b.key === k) ?? { key: k, label: k.replace(/_/g, ' '), variant: 'outline' as const };
const STATUSES: { key: ConvStatus; label: string }[] = [
  { key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'needs_human', label: 'Needs human' },
];
const SELECT = 'h-10 rounded-md border border-input bg-background px-3 font-dashbody text-[14px] font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function rowTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same
    ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}
const who = (c: Pick<AdminAiConversationRow, 'name' | 'e164' | 'visitor_label'>) => c.name || c.e164 || c.visitor_label;

function useIsDesktop(): boolean {
  const [d, setD] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 768px)');
    const on = () => setD(m.matches);
    on(); m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return d;
}

/* ── chat pieces ────────────────────────────────────────────────────────── */
function Bubble({ m }: { m: AdminAiMessage }) {
  if (m.role === 'tool' || m.role === 'system') {
    return (
      <p className="mx-auto w-fit max-w-[90%] rounded-full bg-muted px-3 py-1 text-center text-[12px] font-bold text-muted-foreground">
        {m.role === 'tool' ? `${m.tool_name ?? 'tool'}: ${m.tool_summary ?? m.text}` : m.text}
      </p>
    );
  }
  const note = m.role === 'admin_note';
  const mine = m.role === 'visitor';
  return (
    <div className={cn('flex', mine ? 'justify-end' : note ? 'justify-center' : 'justify-start')}>
      <div className={cn(
        'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[14.5px] font-semibold leading-relaxed',
        mine ? 'bg-accent text-accent-foreground' : note ? 'border border-grand-gold/70 bg-grand-gold/25 text-foreground' : 'border border-border bg-card text-foreground',
      )}>
        {note && <span className="mb-0.5 block text-[11px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">Admin note</span>}
        {m.text}
        {m.blocked && <span className="mt-1 block text-[11.5px] font-bold text-destructive">Blocked by the safety filter</span>}
        {m.cards.map((c, i) => (
          <a key={i} href={c.type === 'event' ? c.read_more_url : c.url} target="_blank" rel="noreferrer"
            className="mt-2 flex items-center gap-2 rounded-lg border border-border/70 bg-background p-2 text-[13px] text-foreground no-underline hover:bg-muted">
            {c.image && <img src={c.image} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" loading="lazy" />}
            <span className="min-w-0">
              <b className="block truncate">{c.title}</b>
              <span className="text-muted-foreground">
                {c.type === 'event' ? `${c.price_rupees != null ? `₹${c.price_rupees}` : 'Free'}${c.live_now ? ' · live now' : ''}` : 'Article'}
              </span>
            </span>
          </a>
        ))}
        <span className="mt-1 block text-right text-[11px] font-semibold opacity-70">{rowTime(m.created_at)}</span>
      </div>
    </div>
  );
}

function ChatPane({ id, onBack, onChanged, phone }: { id: string; onBack: () => void; onChanged: (c: AdminAiConversationRow) => void; phone: boolean }) {
  const [d, setD] = useState<AdminAiConversationDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteDirty, setNoteDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const idRef = useRef(id);
  idRef.current = id;
  const dirtyRef = useRef(false);
  dirtyRef.current = noteDirty;

  const load = useCallback(async (initial: boolean) => {
    try {
      const r = await aiApi.conversation(id);
      if (idRef.current !== id) return;
      setD(r); setErr(null);
      if (initial || !dirtyRef.current) setNote(r.conversation.admin_note ?? '');
    } catch (e) {
      if (initial) { captureException(e, { where: 'admin_ai_conversation_load' }); setErr('Could not open this conversation.'); }
    }
  }, [id]);

  useEffect(() => { setD(null); setErr(null); setNoteDirty(false); lastCount.current = 0; void load(true); }, [id, load]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void load(false); }, 20_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    const n = d?.messages.length ?? 0;
    if (n !== lastCount.current) { lastCount.current = n; end.current?.scrollIntoView({ block: 'end' }); }
  }, [d]);

  async function patch(p: { status?: ConvStatus; admin_note?: string }) {
    setBusy(true);
    try {
      await aiApi.patchConversation(id, p);
      capture('admin_ai_conversation_updated', { status: p.status ?? null, note: p.admin_note != null });
      if (p.admin_note != null) { setNoteDirty(false); toast.success('Note saved'); }
      await load(true);
      const r = await aiApi.conversation(id);
      onChanged(r.conversation);
    } catch (e) { captureException(e, { where: 'admin_ai_conversation_patch' }); toast.error(errMessage(e, 'Could not save.')); }
    finally { setBusy(false); }
  }

  if (err) return <div className="p-4"><ErrorBox message={err} onRetry={() => void load(true)} /></div>;
  if (!d) return <div className="p-4"><ListSkeleton rows={4} /></div>;
  const c = d.conversation;
  const wa = c.e164 ? c.e164.replace(/\D/g, '') : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 bg-card px-3 py-2.5">
        {phone && <Button size="icon" variant="ghost" onClick={onBack} aria-label="Back to conversations"><ArrowLeft /></Button>}
        <div className="min-w-0 flex-1">
          <p className="truncate font-dashbody text-[16px] font-extrabold text-foreground">{who(c)}</p>
          <p className="truncate text-[12.5px] font-semibold text-muted-foreground">{c.e164 && c.name ? `${c.e164} · ` : ''}{c.uid ? 'Signed in' : 'Visitor'}{c.last_page ? ` · ${c.last_page}` : ''}</p>
          {c.email && <p className="truncate text-[12.5px] font-semibold text-muted-foreground">{c.email}</p>}
        </div>
        {wa && (
          <Button asChild size="sm" variant="outline">
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><MessageCircle /> WhatsApp</a>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-card px-3 py-2">
        <label htmlFor="conv-status" className="sr-only">Status</label>
        <select id="conv-status" value={c.status} disabled={busy} onChange={(e) => void patch({ status: e.target.value as ConvStatus })} className={SELECT}>
          {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {c.badges.map((b) => <Badge key={b} variant={badgeMeta(b).variant}>{badgeMeta(b).label}</Badge>)}
        <span className={cn(HINT, 'ml-auto')}>{c.message_count} messages</span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite">
        {d.messages.length === 0 ? <p className={cn(HINT, 'py-8 text-center')}>No messages yet.</p> : d.messages.map((m) => <Bubble key={m.id} m={m} />)}
        <div ref={end} />
      </div>

      <div className="grid max-h-[45%] gap-3 overflow-y-auto border-t border-border/60 bg-card p-3">
        <div className="grid gap-1.5">
          <label htmlFor="conv-note" className={LABEL}>Internal note <span className={HINT}>(only admins see it)</span></label>
          <textarea id="conv-note" rows={2} maxLength={1000} value={note} onChange={(e) => { setNote(e.target.value); setNoteDirty(true); }} className={TEXTAREA} />
          <div><Button size="sm" variant="outline" disabled={busy || !noteDirty} onClick={() => void patch({ admin_note: note })}>{busy ? <Loader2 className="animate-spin" /> : null} Save note</Button></div>
        </div>
        <div>
          <p className={LABEL}>Bookings</p>
          {d.bookings.length === 0 ? <p className={HINT}>No bookings linked to this person.</p> : (
            <ul className="mt-1 grid gap-1.5">
              {d.bookings.map((b) => (
                <li key={b.checkout_id}>
                  <a href="/admin/bookings" className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-[13.5px] font-semibold text-foreground no-underline hover:bg-muted">
                    <span className="min-w-0 flex-1 truncate font-extrabold">{b.listing_title}</span>
                    <Badge variant="outline">{b.status}</Badge>
                    <span className="text-muted-foreground">{istDateTime(b.created_at)}</span>
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── main ───────────────────────────────────────────────────────────────── */
export default function AiConversations() {
  const desktop = useIsDesktop();
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [badge, setBadge] = useState('');
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<AdminAiConversationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setApplied(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const query = useMemo(() => ({ q: applied || undefined, badge: badge || undefined, status: status || undefined }), [applied, badge, status]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setPhase('loading');
    try {
      const r = await aiApi.conversations(query);
      if (my !== seq.current) return;
      setItems(r.items ?? []); setCursor(r.next_cursor ?? null); setPhase('ready');
    } catch (e) {
      if (my !== seq.current) return;
      captureException(e, { where: 'admin_ai_conversations_load' }); setPhase('error');
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  // Poll the first page every 20 s while visible; merge so loaded older pages stay put.
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden) return;
      const my = seq.current;
      try {
        const r = await aiApi.conversations(query);
        if (my !== seq.current) return;
        setItems((cur) => {
          const fresh = new Map((r.items ?? []).map((x) => [x.id, x]));
          const rest = cur.filter((x) => !fresh.has(x.id));
          return [...fresh.values(), ...rest].sort((a, b) => b.last_message_at - a.last_message_at);
        });
      } catch (e) { captureException(e, { where: 'admin_ai_conversations_poll' }); }
    }, 20_000);
    return () => clearInterval(t);
  }, [query]);

  const loadMore = useCallback(async () => {
    if (!cursor || more) return;
    setMore(true);
    const my = seq.current;
    try {
      const r = await aiApi.conversations({ ...query, cursor });
      if (my !== seq.current) return;
      setItems((cur) => { const ids = new Set(cur.map((x) => x.id)); return [...cur, ...(r.items ?? []).filter((x) => !ids.has(x.id))]; });
      setCursor(r.next_cursor ?? null);
    } catch (e) { captureException(e, { where: 'admin_ai_conversations_more' }); toast.error(errMessage(e, 'Could not load more.')); }
    finally { setMore(false); }
  }, [cursor, more, query]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es[0]?.isIntersecting) void loadMore(); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore, items.length]);

  const onChanged = (c: AdminAiConversationRow) => setItems((cur) => cur.map((x) => (x.id === c.id ? { ...x, ...c } : x)));
  const filtered = !!(applied || badge || status);

  const list = (
    <div className="flex h-full min-h-0 flex-col border-border bg-card md:border-r">
      <div className="grid gap-2 border-b border-border/60 p-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={q} maxLength={80} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email, UTR or text" aria-label="Search conversations" className="pl-9" />
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Filters">
          {BADGES.map((b) => <Chip key={b.key} active={badge === b.key} onClick={() => setBadge(badge === b.key ? '' : b.key)}>{b.label}</Chip>)}
          {STATUSES.map((s) => <Chip key={s.key} active={status === s.key} onClick={() => setStatus(status === s.key ? '' : s.key)}>{s.label}</Chip>)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {phase === 'loading' && items.length === 0 ? <div className="p-3"><ListSkeleton rows={6} /></div>
          : phase === 'error' ? <div className="p-3"><ErrorBox message="Could not load conversations." onRetry={() => void load()} /></div>
          : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <MessagesSquare className="h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="font-dash text-[17px] font-bold text-foreground">{filtered ? 'Nothing matches' : 'No conversations yet'}</p>
              <p className={HINT}>{filtered ? 'Try a different search or clear the filters.' : 'They appear here as visitors chat with her.'}</p>
            </div>
          ) : (
            <ul>
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button" onClick={() => setSel(c.id)} aria-current={c.id === sel ? 'true' : undefined}
                    className={cn('flex w-full flex-col gap-1 border-b border-border/50 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', c.id === sel ? 'bg-accent/10' : 'hover:bg-muted')}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-dashbody text-[15px] font-extrabold text-foreground">{who(c)}</span>
                      <span className="shrink-0 text-[12px] font-semibold text-muted-foreground">{rowTime(c.last_message_at)}</span>
                    </span>
                    {c.name && c.e164 && <span className="truncate text-[12.5px] font-semibold text-muted-foreground">{c.e164}</span>}
                    {c.email && <span className="truncate text-[12.5px] font-semibold text-muted-foreground">{c.email}</span>}
                    <span className="truncate text-[13.5px] font-semibold text-muted-foreground">{c.last_text || '…'}</span>
                    <span className="flex flex-wrap items-center gap-1">
                      {c.badges.map((b) => <Badge key={b} variant={badgeMeta(b).variant} className="px-2 py-0 text-[11px]">{badgeMeta(b).label}</Badge>)}
                      <Badge variant={c.status === 'open' ? 'outline' : c.status === 'resolved' ? 'muted' : 'destructive'} className="px-2 py-0 text-[11px]">
                        {STATUSES.find((s) => s.key === c.status)?.label ?? c.status}
                      </Badge>
                    </span>
                  </button>
                </li>
              ))}
              {cursor && <li><div ref={sentinel} className="flex justify-center p-3">{more ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading more" /> : <Button size="sm" variant="ghost" onClick={() => void loadMore()}>Load more</Button>}</div></li>}
            </ul>
          )}
      </div>
    </div>
  );

  if (!desktop) {
    return (
      <>
        <div className="h-[calc(100dvh-15rem)] min-h-[420px] overflow-hidden rounded-xl border border-border">{list}</div>
        {sel && (
          <div className="fixed inset-0 z-[60] bg-background pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]">
            <ChatPane id={sel} phone onBack={() => setSel(null)} onChanged={onChanged} />
          </div>
        )}
      </>
    );
  }
  return (
    <div className="grid h-[calc(100vh-13rem)] min-h-[560px] grid-cols-[minmax(300px,360px)_1fr] overflow-hidden rounded-xl border border-border">
      {list}
      {sel ? <ChatPane id={sel} phone={false} onBack={() => setSel(null)} onChanged={onChanged} /> : (
        <div className="flex flex-col items-center justify-center gap-2 bg-background text-center">
          <MessagesSquare className="h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="font-dash text-[18px] font-bold text-foreground">Pick a conversation</p>
          <p className={HINT}>Choose one on the left to read it.</p>
        </div>
      )}
    </div>
  );
}
