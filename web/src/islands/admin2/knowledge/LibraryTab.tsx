/* Tradition library › Library — [AUMFE-KNOWLEDGE-ADMIN-UI-1 2026-10-01]
 * The reviewed text the AI quotes from. List + filters, an edit drawer, bulk .jsonl import (always lands as drafts)
 * and "Approve selected". API: /api/admin/v2/knowledge/tradition*. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, FileUp, Loader2, Plus } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../../components/ui/sheet';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import { Empty, ErrorBox, ListSkeleton } from '../peopleKit';
import { CARD, HINT, LABEL, TEXTAREA } from '../AiKit';
import {
  GRAHAS, REVIEW_NOTICE, WEEKDAYS, cap, grahaLabel, knowledgeApi, wordCount, type EntryStatus, type TraditionEntry, type TraditionFields,
} from './knowledgeApi';

const FIELD = 'h-12 w-full rounded-md border border-input bg-background px-3 font-dashbody text-[16px] font-semibold text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
const KNOWN_TOPICS = ['chakra', 'colour', 'deity', 'dosha', 'festival', 'navagraha', 'puja', 'symbol', 'weekday'];
const BATCH = 50;

const STATUS: Record<EntryStatus, { label: string; variant: 'accent' | 'secondary' | 'muted' }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  approved: { label: 'Approved', variant: 'accent' },
  archived: { label: 'Archived', variant: 'muted' },
};
export function StatusChip({ s }: { s: string }) {
  const m = STATUS[s as EntryStatus] ?? { label: cap(s), variant: 'muted' as const };
  return <Badge variant={m.variant} className="whitespace-nowrap text-[13px]">{m.label}</Badge>;
}

const blank = (): TraditionFields => ({ topic: '', title: '', text: '', source: '', lang: 'en', graha: null, weekday: null, deity: null });

/** Parses a .jsonl file in the browser: one JSON object per line. Bad lines are counted, not fatal. */
export function parseJsonl(raw: string): { rows: Record<string, unknown>[]; bad: number } {
  const rows: Record<string, unknown>[] = []; let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim(); if (!t) continue;
    try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o as Record<string, unknown>); else bad++; } catch { bad++; }
  }
  return { rows, bad };
}

export default function LibraryTab() {
  const [status, setStatus] = useState('');
  const [topic, setTopic] = useState('');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [items, setItems] = useState<TraditionEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [topics, setTopics] = useState<string[]>(KNOWN_TOPICS);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ id: string | null; entry: TraditionEntry | null } | null>(null);
  const [job, setJob] = useState<{ label: string; done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    setErr('');
    try {
      const r = await knowledgeApi.list({ status: status || undefined, topic: topic || undefined, q: dq || undefined });
      setItems(r);
      setTopics((cur) => Array.from(new Set([...cur, ...r.map((e) => e.topic).filter(Boolean)])).sort());
      setPicked((cur) => new Set([...cur].filter((id) => r.some((e) => e.id === id))));
    } catch (e) {
      captureException(e, { where: 'admin_tradition_list' });
      setErr(errMessage(e, 'Could not load the library.'));
    }
  }, [status, topic, dq]);
  useEffect(() => { void load(); }, [load]);

  const selectable = useMemo(() => (items ?? []).filter((e) => e.status === 'draft'), [items]);
  const togglePick = (id: string) => setPicked((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function importFile(file: File) {
    let parsed: ReturnType<typeof parseJsonl>;
    try { parsed = parseJsonl(await file.text()); } catch (e) { captureException(e, { where: 'admin_tradition_import_read' }); toast.error('Could not read that file.'); return; }
    if (!parsed.rows.length) { toast.error('No entries found. Use one JSON object per line (.jsonl).'); return; }
    let imported = 0; let skipped = 0; let failedBatches = 0;
    setJob({ label: 'Importing', done: 0, total: parsed.rows.length });
    for (let i = 0; i < parsed.rows.length; i += BATCH) {
      const batch = parsed.rows.slice(i, i + BATCH);
      try { const r = await knowledgeApi.importBatch(batch); imported += r.imported; skipped += r.skipped.length; }
      catch (e) { failedBatches++; skipped += batch.length; captureException(e, { where: 'admin_tradition_import' }); }
      setJob({ label: 'Importing', done: Math.min(i + BATCH, parsed.rows.length), total: parsed.rows.length });
    }
    setJob(null);
    capture('admin_tradition_imported', { imported, skipped, bad_lines: parsed.bad, failed_batches: failedBatches });
    const extra = [skipped ? `${skipped} skipped` : '', parsed.bad ? `${parsed.bad} unreadable line${parsed.bad > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
    (failedBatches ? toast.error : toast.success)(`${imported} entries imported as drafts`, { description: extra || 'Review and approve them below.' });
    void load();
  }

  async function approveSelected() {
    const ids = [...picked]; if (!ids.length) return;
    let ok = 0; let fail = 0; let notIndexed = 0;
    setJob({ label: 'Approving', done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i++) {
      try { const r = await knowledgeApi.approve(ids[i]); ok++; if (!r.indexed) notIndexed++; capture('admin_tradition_approved', { id: ids[i], bulk: true, indexed: r.indexed }); }
      catch (e) { fail++; captureException(e, { where: 'admin_tradition_approve' }); }
      setJob({ label: 'Approving', done: i + 1, total: ids.length });
    }
    setJob(null); setPicked(new Set());
    (fail ? toast.error : toast.success)(`${ok} approved${fail ? `, ${fail} failed` : ''}`, notIndexed ? { description: `${notIndexed} not indexed yet. Use Re-index in Search test.` } : undefined);
    void load();
  }

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3 font-dashbody text-[15px] font-bold text-foreground" role="note">{REVIEW_NOTICE}</p>

      <div className={cn(CARD, 'space-y-3')}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="min-w-0 flex-1">
            <label className={LABEL} htmlFor="kn-lib-q">Search</label>
            <Input id="kn-lib-q" className="h-12 text-[16px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title or text" />
          </div>
          <div className="md:w-44">
            <label className={LABEL} htmlFor="kn-lib-status">Status</label>
            <select id="kn-lib-status" className={FIELD} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="archived">Archived</option>
            </select>
          </div>
          <div className="md:w-44">
            <label className={LABEL} htmlFor="kn-lib-topic">Topic</label>
            <select id="kn-lib-topic" className={FIELD} value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">All topics</option>{topics.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="accent" onClick={() => setEdit({ id: null, entry: null })}><Plus /> Add entry</Button>
          <Button variant="outline" disabled={!!job} onClick={() => fileRef.current?.click()}><FileUp /> Import .jsonl</Button>
          <input ref={fileRef} type="file" accept=".jsonl,.json,.txt,application/json,text/plain" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
          <Button variant="outline" disabled={!!job || !selectable.length}
            onClick={() => setPicked((cur) => (cur.size === selectable.length ? new Set() : new Set(selectable.map((e) => e.id))))}>
            {picked.size === selectable.length && selectable.length ? 'Clear selection' : `Select all drafts (${selectable.length})`}
          </Button>
          <Button disabled={!!job || !picked.size} onClick={() => void approveSelected()}><CheckCheck /> Approve selected{picked.size ? ` (${picked.size})` : ''}</Button>
        </div>
        {job && (
          <div role="status" aria-live="polite" className="space-y-2">
            <p className="flex items-center gap-2 font-dashbody text-[15px] font-bold text-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {job.label} {job.done} of {job.total}…</p>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((job.done / Math.max(1, job.total)) * 100)}%` }} /></div>
          </div>
        )}
        <p className={HINT}>Imported entries always land as drafts, even if they were approved before. Approving an entry adds it to search.</p>
      </div>

      {err ? <ErrorBox message={err} onRetry={() => void load()} />
        : items === null ? <ListSkeleton />
        : items.length === 0 ? <Empty title="No entries" body="Import a .jsonl file or add one by hand." />
        : (
          <>
            <ul className="space-y-2">
              {items.map((e) => (
                <li key={e.id} className="flex items-stretch gap-1 rounded-xl border border-border bg-card shadow-sm">
                  <label className="flex min-h-[56px] w-12 shrink-0 cursor-pointer items-center justify-center" aria-label={`Select ${e.title}`}>
                    <input type="checkbox" className="h-5 w-5 accent-[#07545b]" disabled={e.status !== 'draft'} checked={picked.has(e.id)} onChange={() => togglePick(e.id)} />
                  </label>
                  <button type="button" onClick={() => setEdit({ id: e.id, entry: e })}
                    className="flex min-h-[56px] min-w-0 flex-1 flex-col items-start gap-1 rounded-r-xl py-3 pr-4 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex w-full flex-wrap items-center gap-2">
                      <span className="font-dash text-[16px] font-bold text-foreground">{e.title}</span>
                      <StatusChip s={e.status} />
                      {e.topic && <Badge variant="outline" className="text-[13px]">{cap(e.topic)}</Badge>}
                    </span>
                    <span className="line-clamp-2 text-[15px] font-semibold text-muted-foreground">{e.text}</span>
                    {e.source && <span className={HINT}>Source: {e.source}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {items.length >= 100 && <p className={HINT}>Showing the newest 100. Use search or filters to narrow the list.</p>}
          </>
        )}

      <EntryDrawer state={edit} onClose={() => setEdit(null)} onChanged={() => void load()} />
    </div>
  );
}

function EntryDrawer({ state, onClose, onChanged }: { state: { id: string | null; entry: TraditionEntry | null } | null; onClose: () => void; onChanged: () => void }) {
  const [f, setF] = useState<TraditionFields>(blank());
  const [busy, setBusy] = useState<'' | 'save' | 'approve' | 'archive'>('');
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string>('draft');
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    if (!state) return;
    const e = state.entry;
    setF(e ? { topic: e.topic, title: e.title, text: e.text, source: e.source, lang: e.lang || 'en', graha: e.graha, weekday: e.weekday, deity: e.deity } : blank());
    setStatus(e?.status ?? 'draft'); setId(state.id); setErr(''); setWarn(false); setDirty(false); setBusy('');
  }, [state]);

  const set = <K extends keyof TraditionFields>(k: K, v: TraditionFields[K]) => { setF((cur) => ({ ...cur, [k]: v })); setDirty(true); setWarn(false); };
  const words = wordCount(f.text);

  async function save(): Promise<string | null> {
    if (!f.title.trim() || !f.text.trim()) { setErr('A title and the text are both required.'); return null; }
    setBusy('save'); setErr(''); setWarn(false);
    try {
      let rid = id; let st = status;
      if (id) { const r = await knowledgeApi.update(id, f); st = r.status; }
      else { const r = await knowledgeApi.create(f); rid = r.id; st = r.status; setId(r.id); }
      setStatus(st); setDirty(false); onChanged();
      toast.success(status === 'approved' && st === 'draft' ? 'Saved. The entry is back in draft until approved again.' : 'Saved as draft');
      return rid;
    } catch (e) { captureException(e, { where: 'admin_tradition_save' }); setErr(errMessage(e, 'Could not save the entry.')); return null; }
    finally { setBusy(''); }
  }

  async function approve() {
    let rid = id;
    if (dirty || !rid) { rid = await save(); if (!rid) return; }
    setBusy('approve'); setErr('');
    try {
      const r = await knowledgeApi.approve(rid);
      capture('admin_tradition_approved', { id: rid, bulk: false, indexed: r.indexed });
      toast.success(r.indexed ? 'Approved and added to search' : 'Approved', r.indexed ? undefined : { description: r.reason ? `Not indexed: ${r.reason}` : 'Use Re-index in Search test.' });
      setStatus('approved'); onChanged(); onClose();
    } catch (e) { captureException(e, { where: 'admin_tradition_approve' }); setErr(errMessage(e, 'Could not approve the entry.')); }
    finally { setBusy(''); }
  }

  async function archive() {
    if (!id) return;
    setBusy('archive'); setErr('');
    try { await knowledgeApi.archive(id); toast.success('Archived and removed from search'); onChanged(); onClose(); }
    catch (e) { captureException(e, { where: 'admin_tradition_archive' }); setErr(errMessage(e, 'Could not archive the entry.')); }
    finally { setBusy(''); }
  }

  const working = busy !== '';
  return (
    <Sheet open={!!state} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full space-y-4 sm:max-w-xl">
        <SheetHeader className="text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2 font-dash text-[20px]">{id ? 'Edit entry' : 'New entry'} {id && <StatusChip s={status} />}</SheetTitle>
          <SheetDescription className="text-[15px] font-semibold">{REVIEW_NOTICE}</SheetDescription>
        </SheetHeader>

        <div className="grid gap-4">
          <div><label className={LABEL} htmlFor="kn-e-title">Title</label>
            <Input id="kn-e-title" className="h-12 text-[16px]" value={f.title} maxLength={200} onChange={(e) => set('title', e.target.value)} /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className={LABEL} htmlFor="kn-e-topic">Topic</label>
              <input id="kn-e-topic" list="kn-topics" className={FIELD} value={f.topic} maxLength={80} onChange={(e) => set('topic', e.target.value)} />
              <datalist id="kn-topics">{KNOWN_TOPICS.map((t) => <option key={t} value={t} />)}</datalist></div>
            <div><label className={LABEL} htmlFor="kn-e-deity">Deity</label>
              <input id="kn-e-deity" className={FIELD} value={f.deity ?? ''} maxLength={60} onChange={(e) => set('deity', e.target.value.trim() ? e.target.value : null)} /></div>
            <div><label className={LABEL} htmlFor="kn-e-graha">Graha</label>
              <select id="kn-e-graha" className={FIELD} value={f.graha ?? ''} onChange={(e) => set('graha', e.target.value || null)}>
                <option value="">None</option>{GRAHAS.map((g) => <option key={g} value={g}>{grahaLabel(g)}</option>)}
              </select></div>
            <div><label className={LABEL} htmlFor="kn-e-day">Weekday</label>
              <select id="kn-e-day" className={FIELD} value={f.weekday ?? ''} onChange={(e) => set('weekday', e.target.value || null)}>
                <option value="">None</option>{WEEKDAYS.map((d) => <option key={d} value={d}>{cap(d)}</option>)}
              </select></div>
          </div>
          <div><label className={LABEL} htmlFor="kn-e-source">Source</label>
            <Input id="kn-e-source" className="h-12 text-[16px]" value={f.source} maxLength={300} placeholder="Book, scripture or teacher" onChange={(e) => set('source', e.target.value)} /></div>
          <div>
            <div className="flex items-baseline justify-between gap-2"><label className={LABEL} htmlFor="kn-e-text">Text</label><span className={HINT}>{words} {words === 1 ? 'word' : 'words'}</span></div>
            <textarea id="kn-e-text" rows={10} className={cn(TEXTAREA, 'min-h-[220px] text-[16px]')} value={f.text} onChange={(e) => set('text', e.target.value)} />
          </div>
        </div>

        {warn && (
          <div className="rounded-xl border border-dashed border-amber-500/60 bg-amber-50 p-3 font-dashbody text-[15px] font-bold text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" role="alertdialog">
            This entry is approved. Saving sends it back to draft and removes it from search until you approve it again.
            <div className="mt-3 flex flex-wrap gap-2"><Button disabled={working} onClick={() => void save()}>Save as draft</Button><Button variant="outline" onClick={() => setWarn(false)}>Cancel</Button></div>
          </div>
        )}
        {err && <p role="alert" className="font-dashbody text-[15px] font-bold text-destructive">{err}</p>}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="outline" disabled={working || (!dirty && !!id)} onClick={() => (status === 'approved' ? setWarn(true) : void save())}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          <Button variant="accent" disabled={working || (status === 'approved' && !dirty)} onClick={() => void approve()}>{busy === 'approve' ? 'Approving…' : status === 'approved' ? 'Save and approve' : 'Approve'}</Button>
          {id && status !== 'archived' && <Button variant="destructive" disabled={working} onClick={() => void archive()}>{busy === 'archive' ? 'Archiving…' : 'Archive'}</Button>}
        </div>
      </SheetContent>
    </Sheet>
  );
}
