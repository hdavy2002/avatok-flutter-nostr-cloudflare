/* Tradition library › Product notes — [AUMFE-KNOWLEDGE-ADMIN-UI-1 2026-10-01]
 * Every shop product with the status of its tradition note. Products come from the shop admin's own list API
 * (GET /api/admin/v2/shop/products); each note status is fetched lazily, four at a time, from
 * GET /api/admin/v2/knowledge/notes/shop_product/:id. "Draft missing notes with AI" loops POST notes/draft-missing. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../../components/ui/sheet';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import { Empty, ErrorBox, ListSkeleton } from '../peopleKit';
import { CARD, HINT, LABEL } from '../AiKit';
import { listProducts, type AdminProduct } from '../shop/shopApi';
import { cap, isMissingRoute, knowledgeApi } from './knowledgeApi';
import TraditionNotePanel from './TraditionNotePanel';

type NoteState = 'none' | 'draft' | 'approved' | 'rejected' | 'unknown';
const VARIANT: Record<NoteState, 'muted' | 'secondary' | 'accent' | 'destructive' | 'outline'> = {
  none: 'outline', draft: 'secondary', approved: 'accent', rejected: 'destructive', unknown: 'muted',
};
const LABELS: Record<NoteState, string> = { none: 'No note', draft: 'Draft', approved: 'Approved', rejected: 'Rejected', unknown: 'Checking…' };

export default function ProductNotesTab() {
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [err, setErr] = useState('');
  const [notes, setNotes] = useState<Record<string, NoteState>>({});
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'' | NoteState>('');
  const [open, setOpen] = useState<AdminProduct | null>(null);
  const [job, setJob] = useState<{ drafted: number; failed: number; remaining: number | null } | null>(null);
  const [aiMissing, setAiMissing] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadNotes = useCallback(async (list: AdminProduct[]) => {
    const queue = list.map((p) => p.id);
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        let st: NoteState = 'unknown';
        try { const n = await knowledgeApi.getNote('shop_product', id); st = (n?.status as NoteState) ?? 'none'; }
        catch (e) { captureException(e, { where: 'admin_note_status' }); }
        if (!alive.current) return;
        setNotes((cur) => ({ ...cur, [id]: st }));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }, []);

  const load = useCallback(async () => {
    setErr('');
    try {
      const r = await listProducts('all');
      const live = r.items.filter((p) => p.status !== 'archived');
      setProducts(live); setNotes({}); void loadNotes(live);
    } catch (e) {
      captureException(e, { where: 'admin_notes_products' });
      setErr(errMessage(e, 'Could not load the products.'));
    }
  }, [loadNotes]);
  useEffect(() => { void load(); }, [load]);

  const missing = useMemo(() => (products ?? []).filter((p) => notes[p.id] === 'none').length, [products, notes]);
  const shown = useMemo(() => (products ?? []).filter((p) => {
    if (q.trim() && !p.name.toLowerCase().includes(q.trim().toLowerCase())) return false;
    return !filter || (notes[p.id] ?? 'unknown') === filter;
  }), [products, notes, q, filter]);

  async function draftMissing() {
    setAiMissing(false); setJob({ drafted: 0, failed: 0, remaining: null });
    let drafted = 0; let failed = 0; let remaining: number | null = null;
    try {
      for (let i = 0; i < 200; i++) {
        const r = await knowledgeApi.draftMissing();
        drafted += r.drafted; failed += r.failed; remaining = r.remaining;
        setJob({ drafted, failed, remaining });
        // No progress in a round (everything left keeps failing) would loop forever: stop and report.
        if (r.remaining <= 0 || (r.drafted === 0)) break;
      }
      capture('admin_note_drafted', { bulk: true, drafted, failed, remaining });
      (failed || (remaining ?? 0) > 0 ? toast.error : toast.success)(`${drafted} notes drafted${failed ? `, ${failed} failed` : ''}`,
        { description: (remaining ?? 0) > 0 ? `${remaining} still without a note. Run it again, or open a product to draft it by hand.` : 'Read each one, then approve it.' });
    } catch (e) {
      if (isMissingRoute(e)) setAiMissing(true);
      else { captureException(e, { where: 'admin_note_draft_missing' }); toast.error(errMessage(e, 'Drafting stopped. Try again.')); }
    } finally { if (alive.current) { setJob(null); void load(); } }
  }

  return (
    <div className="space-y-4">
      <div className={`${CARD} space-y-3`}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="min-w-0 flex-1">
            <label className={LABEL} htmlFor="kn-pn-q">Search products</label>
            <Input id="kn-pn-q" className="h-12 text-[16px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Product name" />
          </div>
          <div className="md:w-48">
            <label className={LABEL} htmlFor="kn-pn-f">Note status</label>
            <select id="kn-pn-f" value={filter} onChange={(e) => setFilter(e.target.value as '' | NoteState)}
              className="h-12 w-full rounded-md border border-input bg-background px-3 font-dashbody text-[16px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">All</option><option value="none">No note</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
            </select>
          </div>
          <Button variant="accent" disabled={!!job || !products?.length} onClick={() => void draftMissing()}>
            {job ? <Loader2 className="animate-spin" /> : <Sparkles />} Draft missing notes with AI{missing ? ` (${missing})` : ''}
          </Button>
        </div>
        {job && (
          <p role="status" aria-live="polite" className="font-dashbody text-[15px] font-bold text-foreground">
            Drafted {job.drafted}{job.failed ? `, ${job.failed} failed` : ''}{job.remaining !== null ? `, ${job.remaining} left` : ''}… keep this page open.
          </p>
        )}
        {aiMissing && <p role="status" className="rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3 font-dashbody text-[15px] font-bold text-foreground">AI drafting isn't available yet. You can still open a product and write its note by hand.</p>}
        <p className={HINT}>AI drafts are only drafts. A note reaches customers and the AI after you approve it.</p>
      </div>

      {err ? <ErrorBox message={err} onRetry={() => void load()} />
        : products === null ? <ListSkeleton />
        : shown.length === 0 ? <Empty title={products.length ? 'No products match' : 'No products yet'} body={products.length ? 'Change the search or the status filter.' : 'Add products under Shop › Products first.'} />
        : (
          <ul className="space-y-2">
            {shown.map((p) => {
              const st = notes[p.id] ?? 'unknown';
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => setOpen(p)}
                    className="flex min-h-[64px] w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left shadow-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {p.image_url ? <img src={p.image_url} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg object-cover" /> : <span className="h-12 w-12 shrink-0 rounded-lg bg-muted" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-dash text-[16px] font-bold text-foreground">{p.name}</span>
                      <span className={HINT}>{cap(p.status)}{p.collection ? ` · ${p.collection.name}` : ''}</span>
                    </span>
                    <Badge variant={VARIANT[st]} className="whitespace-nowrap text-[13px]">{LABELS[st]}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

      <Sheet open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl">
          <SheetHeader className="text-left">
            <SheetTitle className="font-dash text-[20px]">{open?.name}</SheetTitle>
            <SheetDescription className="text-[15px] font-semibold">Tradition note for this product.</SheetDescription>
          </SheetHeader>
          {open && <TraditionNotePanel key={open.id} kind="shop_product" id={open.id} title={open.name} onStatus={(s) => setNotes((cur) => ({ ...cur, [open.id]: s as NoteState }))} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
