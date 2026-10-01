/* Tradition library › Search test — [AUMFE-KNOWLEDGE-ADMIN-UI-1 2026-10-01]
 * Try the same search the AI runs. GET /api/admin/v2/knowledge/search?index=tradition|catalog&q=…;
 * POST /knowledge/reindex {index} rebuilds an index from the approved rows. */
import { useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import { Empty } from '../peopleKit';
import { CARD, H2, HINT, LABEL } from '../AiKit';
import { WhyThisPreview } from './TraditionNotePanel';
import { cap, knowledgeApi, type CatalogHit, type TraditionHit } from './knowledgeApi';

type Index = 'tradition' | 'catalog';
const DAY: Record<string, string> = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };
const score = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '—');

export default function SearchTestTab() {
  const [index, setIndex] = useState<Index>('tradition');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<(TraditionHit | CatalogHit)[] | null>(null);
  const [shown, setShown] = useState<Index>('tradition');
  const [err, setErr] = useState('');
  const [reindexing, setReindexing] = useState<Index | null>(null);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await knowledgeApi.search(index, q.trim());
      setHits(r); setShown(index);
      capture('admin_knowledge_search', { index, hits: r.length });
    } catch (er) { captureException(er, { where: 'admin_knowledge_search', index }); setErr(errMessage(er, 'The search failed.')); setHits(null); }
    finally { setBusy(false); }
  }

  async function reindex(i: Index) {
    setReindexing(i);
    try {
      const r = await knowledgeApi.reindex(i);
      capture('admin_knowledge_reindexed', { index: i, ok: r.ok, failed: r.failed });
      const why = Object.entries(r.reasons ?? {}).map(([k, v]) => `${v} ${k}`).join(', ');
      (r.failed ? toast.error : toast.success)(`${cap(i)} index rebuilt: ${r.ok} indexed${r.failed ? `, ${r.failed} failed` : ''}`, { description: why || `${(r.ms / 1000).toFixed(1)}s` });
    } catch (er) { captureException(er, { where: 'admin_knowledge_reindex', index: i }); toast.error(errMessage(er, 'Re-index failed.')); }
    finally { setReindexing(null); }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={run} className={`${CARD} space-y-3`}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="md:w-56">
            <label className={LABEL} htmlFor="kn-st-index">Index</label>
            <select id="kn-st-index" value={index} onChange={(e) => { setIndex(e.target.value as Index); setHits(null); }}
              className="h-12 w-full rounded-md border border-input bg-background px-3 font-dashbody text-[16px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="tradition">Tradition library</option>
              <option value="catalog">Product catalog</option>
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <label className={LABEL} htmlFor="kn-st-q">Question</label>
            <Input id="kn-st-q" className="h-12 text-[16px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder={index === 'tradition' ? 'e.g. why is Saturday linked to Shani?' : 'e.g. a shirt for Thursday for Guru'} />
          </div>
          <Button type="submit" variant="accent" disabled={busy || !q.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Search />} Search</Button>
        </div>
        <p className={HINT}>Only approved entries are searchable. Scores are similarity (higher is closer).</p>
      </form>

      {err && <p role="alert" className="font-dashbody text-[15px] font-bold text-destructive">{err}</p>}
      {hits !== null && (hits.length === 0
        ? <Empty title="Nothing matched" body="Approve more entries, or try different words. If entries are approved but missing, use Re-index below." />
        : <ol className="space-y-3" aria-label="Search results">
          {hits.map((h, i) => shown === 'tradition' ? <TradHit key={i} h={h as TraditionHit} /> : <CatHit key={i} h={h as CatalogHit} />)}
        </ol>)}

      <section className={`${CARD} space-y-3`}>
        <h2 className={H2}>Re-index</h2>
        <p className={HINT}>Rebuilds an index from every approved row. Use it after changing the AI model or if approved entries do not show up. It can take a minute.</p>
        <div className="flex flex-wrap gap-2">
          {(['tradition', 'catalog'] as const).map((i) => (
            <Button key={i} variant="outline" disabled={reindexing !== null} onClick={() => void reindex(i)}>
              {reindexing === i ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-index {i === 'tradition' ? 'tradition library' : 'product catalog'}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}

function TradHit({ h }: { h: TraditionHit }) {
  return (
    <li className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="accent" className="text-[13px]">Score {score(h.score)}</Badge>
        {h.topic && <Badge variant="outline" className="text-[13px]">{cap(h.topic)}</Badge>}
        <span className="font-dash text-[16px] font-bold text-foreground">{h.title}</span>
      </div>
      <p className="mt-2 line-clamp-4 text-[15px] font-semibold leading-relaxed text-foreground">{h.text}</p>
      {h.source && <p className={`${HINT} mt-2`}>Source: {h.source}</p>}
    </li>
  );
}

function CatHit({ h }: { h: CatalogHit }) {
  return (
    <li className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex gap-3">
        {h.image_url ? <img src={h.image_url} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" /> : <span className="h-16 w-16 shrink-0 rounded-lg bg-muted" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="accent" className="text-[13px]">Score {score(h.score)}</Badge>
            <Badge variant="outline" className="text-[13px]">{h.subject_kind === 'event' ? 'Event' : 'Product'}</Badge>
          </div>
          <p className="mt-1 font-dash text-[16px] font-bold text-foreground">{h.title}</p>
          <p className={HINT}>
            {[h.deity && cap(h.deity), h.chakra && `${cap(h.chakra)} chakra`, h.price_inr != null && `₹${h.price_inr}`].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      {h.wear_days?.length > 0 && (
        <p className="mt-3 text-[15px] font-bold text-foreground">Wear on: <span className="font-semibold">{h.wear_days.map((d) => DAY[d] ?? cap(d)).join(', ')}</span></p>
      )}
      {h.tradition_note && <p className="mt-2 line-clamp-3 text-[15px] font-semibold leading-relaxed text-muted-foreground">{h.tradition_note}</p>}
      <WhyThisPreview reasons={h.why ?? []} />
    </li>
  );
}
