/* StudioHome — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] /admin/shop/studio — the design adda: coloured KPI tiles, status pills,
 * drafts hung as gold-framed artwork, a saffron "Start a new design" card, and the journey. Data: GET designs. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { STEP_LABEL, STEP_ORDER, errMessage, listDesigns, stepHref, type DesignCard, type DesignList } from '../../../lib/studioApi';
import { DesiCard, DesiChip, DesiEmpty, DesiJourney, DesiKpi, DesiKpis, Marigold } from '../desi';
import { LoadError, Loading, Page, STEP_TONE } from './StudioKit';

type Tab = 'all' | 'draft' | 'ready' | 'live' | 'retired';
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'draft', label: 'Drafts' }, { key: 'ready', label: 'Ready' }, { key: 'live', label: 'Live' }, { key: 'retired', label: 'Retired' },
];

function statusChip(s: DesignCard['status']): { tone: 'tea' | 'lav' | 'grey' | 'gold'; text: string } {
  if (s === 'live') return { tone: 'tea', text: 'Live' };
  if (s === 'ready') return { tone: 'lav', text: 'Ready' };
  if (s === 'retired') return { tone: 'grey', text: 'Retired' };
  return { tone: 'gold', text: 'Draft' };
}

export default function StudioHome() {
  const [data, setData] = useState<DesignList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');

  const load = useCallback(async () => {
    try { setData(await listDesigns()); setErr(null); } catch (e) {
      captureException(e, { where: 'studio_list' });
      setErr(errMessage(e, 'Could not load your designs.'));
    }
  }, []);
  useEffect(() => { capture('studio_viewed', { step: 'home' }); void load(); }, [load]);

  if (err) return <Page><LoadError message={err} onRetry={() => void load()} /></Page>;
  if (!data) return <Page><Loading what="Loading your designs…" /></Page>;

  const items = data.items;
  const count = (k: Tab): number => (k === 'all' ? (data.counts?.all ?? items.length) : (data.counts?.[k] ?? items.filter((d) => d.status === k).length));
  const shown = tab === 'all' ? items : items.filter((d) => d.status === tab);

  return (
    <Page>
      <DesiCard tone="saffron" corner="yellow" className="sa-start-card">
        <div className="sa-start">
          <div>
            <h2>Start a new design</h2>
            <p>Bring the picture you made. We check it, place it on the shirt and list it.</p>
          </div>
          <a className="hfa-btn rani" href={stepHref(null, 'upload')}>+ New product from my artwork</a>
        </div>
      </DesiCard>

      <DesiKpis>
        <DesiKpi tone="plum" label="Drafts" value={count('draft')} sub="waiting for you" />
        <DesiKpi tone="gold" label="Ready to publish" value={count('ready')} sub="one click left" corner />
        <DesiKpi tone="tea" label="Live from Studio" value={count('live')} sub="products on the shop" corner />
        <DesiKpi tone="rani" label="Orders sent to print" value={data.counts?.orders_sent ?? '—'} sub="this month" corner />
      </DesiKpis>

      <div className="hfa-pills" role="tablist" aria-label="Design status">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} aria-pressed={tab === t.key} className={`hfa-pill${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}{t.key === 'all' ? ` (${count('all')})` : ''}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <DesiCard tone="cream" pattern="dots" corner="marigold">
          <DesiEmpty text={<><b>Nothing here yet</b><br />Press “+ New product from my artwork” to start with the picture you made.</>}>
            <a className="hfa-btn rani" href={stepHref(null, 'upload')}>+ New product from my artwork</a>
          </DesiEmpty>
        </DesiCard>
      ) : (
        <div className="sa-wall">
          {shown.map((d) => {
            const chip = statusChip(d.status);
            const si = Math.max(0, STEP_ORDER.indexOf(d.step));
            const img = d.print_preview_url || d.art_preview_url;
            const dark = d.colours[0] ? /black|navy|maroon|green/i.test(d.colours[0]) : false;
            return (
              <article className="sa-frame" key={d.id}>
                <div className="sa-gilt"><div className="sa-mat">
                  {img
                    ? <div className="sa-art"><img src={img} alt="" loading="lazy" /></div>
                    : <div className={`sa-art empty${dark ? ' dark' : ''}`}>Your artwork on the shirt</div>}
                </div></div>
                <div className="sa-plaque">
                  <div className="row"><DesiChip tone={chip.tone}>{chip.text}</DesiChip></div>
                  <h3>{d.name || 'Untitled'}</h3>
                  <p>{d.products_label || 'Not chosen yet'}{d.colours.length ? ` · ${d.colours.join(', ')}` : ''}</p>
                  <p>
                    {d.status === 'live' ? `Live on shop${typeof d.photo_count === 'number' ? ` · ${d.photo_count} photos` : ''}`
                      : d.status === 'retired' ? 'Replaced by a new version'
                        : `Step ${si + 1} of 5 · ${STEP_LABEL[d.step]}`}
                  </p>
                  <div className="row">
                    {d.status === 'live' && <a className="hfa-btn ghost sm" href={d.product_slug ? `/shop/p/${encodeURIComponent(d.product_slug)}` : '/admin/shop/products'}>Open product</a>}
                    {(d.status === 'draft' || d.status === 'ready') && <a className="hfa-btn tea sm" href={stepHref(d.id, d.step)}>Continue</a>}
                    {d.status === 'retired' && <a className="hfa-btn ghost sm" href={stepHref(d.id, 'publish')}>View history</a>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <DesiCard tone="lav" corner="jasmine" title="How your artwork becomes a product" note="You bring the art and the photos. The Studio checks the art fits, places it on the shirt and lists it. Nothing reaches Printrove until a customer has paid.">
        <DesiJourney label="Studio steps" steps={STEP_ORDER.map((s) => ({ tone: STEP_TONE[s], title: STEP_LABEL[s], icon: <Marigold size={26} /> }))} />
      </DesiCard>
    </Page>
  );
}
