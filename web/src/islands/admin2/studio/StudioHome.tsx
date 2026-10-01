/* StudioHome — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] /admin/shop/studio — exact replica of Specs/studio-mockup/Main.dc.html
 * (KPI tiles, status tabs, design cards, "How your artwork becomes a product"). Data: GET designs. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { STEP_LABEL, STEP_ORDER, errMessage, listDesigns, stepHref, type DesignCard, type DesignList } from '../../../lib/studioApi';
import { LoadError, Loading, Page } from './StudioKit';

type Tab = 'all' | 'draft' | 'ready' | 'live' | 'retired';
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'draft', label: 'Drafts' }, { key: 'ready', label: 'Ready' }, { key: 'live', label: 'Live' }, { key: 'retired', label: 'Retired' },
];

function statusChip(s: DesignCard['status']): { cls: string; text: string } {
  if (s === 'live') return { cls: 'ok', text: 'Live' };
  if (s === 'ready') return { cls: 'info', text: 'Ready' };
  if (s === 'retired') return { cls: 'bad', text: 'Retired' };
  return { cls: 'warn', text: 'Draft' };
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
      <div className="kpis">
        <div className="kpi"><small>Drafts</small><b>{count('draft')}</b><em style={{ color: '#6b4a2b' }}>waiting for you</em></div>
        <div className="kpi"><small>Ready to publish</small><b>{count('ready')}</b><em style={{ color: '#6b4a00' }}>one click left</em></div>
        <div className="kpi"><small>Live from Studio</small><b>{count('live')}</b><em>products on the shop</em></div>
        <div className="kpi"><small>Orders sent to print</small><b>{data.counts?.orders_sent ?? '—'}</b><em style={{ color: '#6b4a2b' }}>this month</em></div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <span key={t.key} role="tab" aria-selected={tab === t.key} tabIndex={0} className={tab === t.key ? 'on' : ''} style={{ cursor: 'pointer' }}
            onClick={() => setTab(t.key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setTab(t.key); }}>
            {t.label}{t.key === 'all' ? ` (${count('all')})` : ''}
          </span>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="panel"><h2>Nothing here yet</h2><p className="lead" style={{ margin: 0 }}>Press “+ New product from my artwork” to start with the picture you made.</p></div>
      ) : (
        <div className="g3">
          {shown.map((d) => {
            const chip = statusChip(d.status);
            const si = Math.max(0, STEP_ORDER.indexOf(d.step));
            const img = d.print_preview_url || d.art_preview_url;
            const dark = d.colours[0] ? /black|navy|maroon|green/i.test(d.colours[0]) : false;
            return (
              <div className="card" key={d.id}>
                {img
                  ? <div className="ph chk" style={{ height: 200, borderStyle: 'solid', padding: 10 }}><img src={img} alt="" style={{ maxWidth: '100%', maxHeight: 178, objectFit: 'contain' }} loading="lazy" /></div>
                  : <div className={`ph${dark ? ' dark' : ''}`} style={{ height: 200 }}>Your artwork on the shirt</div>}
                <div className="row"><span className={`chip ${chip.cls}`}>{chip.text}</span></div>
                <h3>{d.name || 'Untitled'}</h3>
                <p>{d.products_label || 'Not chosen yet'}{d.colours.length ? ` · ${d.colours.join(', ')}` : ''}</p>
                <p style={{ color: '#6b4a2b' }}>
                  {d.status === 'live' ? `Live on shop${typeof d.photo_count === 'number' ? ` · ${d.photo_count} photos` : ''}`
                    : d.status === 'retired' ? 'Replaced by a new version'
                      : `Step ${si + 1} of 5 · ${STEP_LABEL[d.step]}`}
                </p>
                <div className="row">
                  {d.status === 'live' && <a className="btn ghost sm" href={d.product_slug ? `/shop/p/${encodeURIComponent(d.product_slug)}` : '/admin/shop/products'}>Open product</a>}
                  {(d.status === 'draft' || d.status === 'ready') && <a className="btn teal sm" href={stepHref(d.id, d.step)}>Continue</a>}
                  {d.status === 'retired' && <a className="btn ghost sm" href={stepHref(d.id, 'publish')}>View history</a>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="panel" style={{ marginTop: 20 }}>
        <h2>How your artwork becomes a product</h2>
        <p className="lead">You bring the art and the photos. The Studio checks the art fits, places it on the shirt and lists it. Nothing reaches Printrove until a customer has paid.</p>
        <div className="row">
          {STEP_ORDER.map((s, i) => <span key={s} className="chip info">{i + 1}. {STEP_LABEL[s]}</span>)}
        </div>
      </div>
    </Page>
  );
}
