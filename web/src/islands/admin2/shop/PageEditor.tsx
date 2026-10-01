/* PageEditor — [SAATHUM-SHOP-EDITOR-1 2026-10-01] The visual editor for the /shop home page (Puck, https://puckeditor.com).
 * Mounted by pages/admin/shop/editor.astro inside the Admin2 shell (AdminNav owns the Clerk provider + admin gate; calls go
 * through adminApi()). This is the ONLY place @puckeditor/core is imported — keep it out of every public bundle.
 *
 * Behaviour: loads draft ?? published ?? the built-in default; every change autosaves a DRAFT after 2 s (the live page does not
 * change); "Publish" (confirmed) makes it live; "Previous versions" restores one of the last 5 live pages; "Discard draft" goes
 * back to the live page. The canvas renders the same block components as the live page, with prices/products resolved by the
 * worker (POST /page/resolve) so it looks identical. Worker contract: routes/admin2_shop_catalog.ts.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Puck, createUsePuck } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import '../../../styles/saathum-folk.css';
import '../../../styles/shop-cart.css';
import '../../../styles/shop.css';
import './pageEditor.css';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import { shopPageConfig } from '../../shop/blocks/config';
import { EditCtx, type EditProduct } from '../../shop/blocks/editorCtx';
import { emptyResolved, type CollectionInfo, type PageData, type ShopResolved } from '../../shop/blocks/types';
import { realPageApi, type PageApi, type PageHistoryEntry, type PageState } from './pageApi';

type Save = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
const VIEWPORTS = [
  { width: 1440, label: 'Desktop (1440)', icon: 'Monitor' as const },
  { width: 820, label: 'Tablet (820)', icon: 'Tablet' as const },
  { width: 390, label: 'Phone (390)', icon: 'Smartphone' as const },
];
// The first block is selected on load so the right-hand panel shows its fields (not an empty "Page" box).
const initialUi = { itemSelector: { index: 0 } };
const AUTOSAVE_MS = 2000;
const RESOLVE_MS = 700;

/** Only these parts of the page change what the server has to resolve (products / rail contents). */
function resolveKey(d: PageData): string {
  return JSON.stringify(d.content.map((it) => {
    const p = it.props as unknown as Record<string, unknown>;
    return it.type === 'ShopHero' ? [p.id, p.hotspots] : it.type === 'FeaturedBanner' ? [p.id, p.product]
      : it.type === 'ProductRail' ? [p.id, p.source, p.collection, p.products, p.count] : p.id;
  }));
}

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');

interface UiCtx {
  save: Save; hasDraft: boolean; history: PageHistoryEntry[]; busy: boolean;
  publish: (d: PageData) => void; discard: () => void; openVersions: () => void;
}

/** Rendered inside <Puck> (it needs usePuck), replaces the stock header buttons. */
const UiContext = createContext<UiCtx | null>(null);

const usePuckData = createUsePuck();

function HeaderActions() {
  const ui = useContext(UiContext)!;
  const data = usePuckData((s) => s.appState.data) as unknown as PageData;
  const label = ui.save === 'saving' ? 'Saving draft…' : ui.save === 'saved' ? 'Draft saved' : ui.save === 'dirty' ? 'Unsaved changes…' : ui.save === 'error' ? 'Could not save the draft' : ui.hasDraft ? 'Draft' : 'Showing the live page';
  return (
    <>
      <span className={'pe-status' + (ui.save === 'error' ? ' is-err' : '')} role="status" aria-live="polite">{label}</span>
      <button type="button" className="pe-btn pe-btn--ghost" disabled={ui.busy || ui.history.length === 0} onClick={ui.openVersions}>Previous versions</button>
      <button type="button" className="pe-btn pe-btn--ghost" disabled={ui.busy || !ui.hasDraft} onClick={ui.discard}>Discard draft</button>
      <a className="pe-btn pe-btn--ghost" href="/shop" target="_blank" rel="noopener noreferrer">View live page</a>
      <button type="button" className="pe-btn" disabled={ui.busy} onClick={() => ui.publish(data)}>Publish</button>
    </>
  );
}

export function PageEditorView({ api }: { api: PageApi }) {
  const [state, setState] = useState<PageState | null>(null);
  const [lists, setLists] = useState<{ products: EditProduct[]; collections: CollectionInfo[] } | null>(null);
  const [resolved, setResolved] = useState<ShopResolved>(emptyResolved());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<Save>('idle');
  const [hasDraft, setHasDraft] = useState(false);
  const [history, setHistory] = useState<PageHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState(false);
  const [mountKey, setMountKey] = useState(0);
  const latest = useRef<PageData | null>(null);
  const saved = useRef<string>('');
  const resolvedFor = useRef<string>('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCapture = useRef(0);
  const dirtyRef = useRef(false);

  const refreshResolved = useCallback(async (d: PageData) => {
    const key = resolveKey(d);
    if (key === resolvedFor.current) return;
    try { setResolved(await api.resolve(d)); resolvedFor.current = key; }
    catch (e) { captureException(e, { where: 'admin2_shop_page_resolve' }); }
  }, [api]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, products, collections] = await Promise.all([api.load(), api.products(), api.collections()]);
      latest.current = s.data; saved.current = JSON.stringify(s.data); dirtyRef.current = false;
      setLists({ products, collections }); setHasDraft(s.has_draft); setHistory(s.history); setState(s); setSave('idle');
      void refreshResolved(s.data);
      setMountKey((k) => k + 1);
    } catch (e) {
      captureException(e, { where: 'admin2_shop_page_load' });
      setLoadError(errMessage(e, 'Could not load the shop page.'));
    }
  }, [api, refreshResolved]);
  useEffect(() => { void load(); }, [load]);

  const flush = useCallback(async () => {
    const d = latest.current;
    if (!d) return;
    const json = JSON.stringify(d);
    if (json === saved.current) { setSave(hasDraft ? 'saved' : 'idle'); return; }
    setSave('saving');
    try {
      await api.saveDraft(d);
      saved.current = json; dirtyRef.current = latest.current !== null && JSON.stringify(latest.current) !== json;
      setHasDraft(true); setSave(dirtyRef.current ? 'dirty' : 'saved');
      if (Date.now() - lastCapture.current > 60_000) { lastCapture.current = Date.now(); capture('admin2_shop_page_draft_saved', { blocks: d.content.length }); }
    } catch (e) {
      captureException(e, { where: 'admin2_shop_page_draft' });
      setSave('error');
    }
  }, [api, hasDraft]);

  const onChange = useCallback((d: unknown) => {
    const data = d as PageData;
    latest.current = data;
    if (JSON.stringify(data) === saved.current) return;
    dirtyRef.current = true; setSave('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    resolveTimer.current = setTimeout(() => void refreshResolved(data), RESOLVE_MS);
  }, [flush, refreshResolved]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); if (resolveTimer.current) clearTimeout(resolveTimer.current); }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyRef.current || save === 'saving') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save]);

  const adopt = useCallback((data: PageData, hist: PageHistoryEntry[], draft: boolean) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    latest.current = data; saved.current = JSON.stringify(data); dirtyRef.current = false;
    setHistory(hist); setHasDraft(draft); setSave('idle'); setMountKey((k) => k + 1);
    void refreshResolved(data);
  }, [refreshResolved]);

  const publish = useCallback(async (d: PageData) => {
    if (!window.confirm('This updates the live shop page for every visitor. Publish now?')) return;
    setBusy(true);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const r = await api.publish(d);
      adopt(d, r.history, false);
      capture('admin2_shop_page_published', { blocks: d.content.length });
      toast.success('Published — the live page updates within a minute.');
    } catch (e) {
      captureException(e, { where: 'admin2_shop_page_publish' });
      toast.error(errMessage(e, 'Could not publish the page.'));
    } finally { setBusy(false); }
  }, [api, adopt]);

  const discard = useCallback(async () => {
    if (!window.confirm('Throw away your unpublished changes and go back to the live page?')) return;
    setBusy(true);
    try { await api.discardDraft(); await load(); toast.success('Draft discarded'); }
    catch (e) { captureException(e, { where: 'admin2_shop_page_discard' }); toast.error(errMessage(e, 'Could not discard the draft.')); }
    finally { setBusy(false); }
  }, [api, load]);

  const revert = useCallback(async (h: PageHistoryEntry) => {
    if (!window.confirm(`Make the version from ${when(h.at)} the live shop page again? The current live page stays in Previous versions.`)) return;
    setBusy(true);
    try {
      const r = await api.revert(h.index);
      setVersions(false); adopt(r.data, r.history, false);
      capture('admin2_shop_page_reverted', {});
      toast.success('Earlier version is live again.');
    } catch (e) {
      captureException(e, { where: 'admin2_shop_page_revert' });
      toast.error(errMessage(e, 'Could not restore that version.'));
    } finally { setBusy(false); }
  }, [api, adopt]);

  const ctx = useMemo(() => ({
    products: lists?.products ?? [], collections: lists?.collections ?? [], resolved, upload: api.upload,
  }), [lists, resolved, api]);

  const ui: UiCtx = { save, hasDraft, history, busy, publish: (d) => void publish(d), discard: () => void discard(), openVersions: () => setVersions(true) };
  const overrides = useMemo(() => ({ headerActions: () => <HeaderActions /> }), []);

  return (
    <div className="pe-root">
      <div className="pe-top">
        <a href="/admin/shop">← Back to Shop admin</a>
        <b>Edit shop page</b>
        <span className="pe-status">Click any text on the page to edit it. Nothing goes live until you press Publish.</span>
        <span className="pe-spacer" />
      </div>
      <div className="pe-body">
        {loadError && <div className="pe-state"><div><p>{loadError}</p><button type="button" className="pe-btn" onClick={() => void load()}>Try again</button></div></div>}
        {!loadError && !state && <div className="pe-state">Loading the shop page…</div>}
        {!loadError && state && (
          <EditCtx.Provider value={ctx}>
            <UiContext.Provider value={ui}>
            <Puck
              key={mountKey}
              config={shopPageConfig}
              data={latest.current as never}
              onChange={onChange}
              viewports={VIEWPORTS}
              iframe={{ enabled: true, waitForStyles: true }}
              headerTitle="Shop page"
              ui={initialUi}
              overrides={overrides}
            />
            </UiContext.Provider>
          </EditCtx.Provider>
        )}
      </div>
      {versions && (
        <div className="pe-modal" role="dialog" aria-modal="true" aria-label="Previous versions" onClick={() => setVersions(false)}>
          <div className="pe-modal-box" onClick={(e) => e.stopPropagation()}>
            <h2>Previous versions</h2>
            <p>The last pages that were live. Restoring one makes it live right away.</p>
            {history.length === 0 && <p>No earlier versions yet.</p>}
            {history.map((h) => (
              <div className="pe-ver" key={h.index}><span>{when(h.at)}</span><button type="button" className="pe-btn pe-btn--teal" disabled={busy} onClick={() => void revert(h)}>Make this live</button></div>
            ))}
            <div style={{ marginTop: 14 }}><button type="button" className="pe-btn pe-btn--ghost" onClick={() => setVersions(false)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PageEditor() {
  return <PageEditorView api={realPageApi} />;
}
