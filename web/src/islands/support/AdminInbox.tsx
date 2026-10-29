// [HF-SUPPORT-DESK] The staff inbox (design: AdminInbox): folders with counts, filters, a bulk bar, and rows with priority dot,
// role, category chip and SLA text. Keyboard: j/k move, Enter opens, x selects, r reply, n note, e solve, ! spam, / search.
// [HF-SUPPORT-SKIN] Same behaviour, desi look: a colour hero, tinted number tiles, folder icon tiles, pill filters, art in empty states.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, errMessage, isAbort, type ListParams } from './api';
import { IconTile, Kpi, PageHero, Corner, type IconName, type StickerName, type Tone } from './desi';
import { agoShort, initials, plural, slaText } from './format';
import { Link, navigate, setQuery, useLoc } from './router';
import { DeskHeader, SHORTCUTS, useHotkeys, useStaff } from './staff';
import { CATEGORIES, FOLDERS, PRIORITIES, categoryShort, type AdminList, type AdminRow, type FolderKey } from './types';
import { Chip, Empty, ErrorBox, Menu, MenuItem, Modal, PRIORITY_DOT, PRIORITY_LABEL, Spinner, categoryTone, useDebounced, useInterval, usePageVisible, useToast } from './ui';

const ROLE_LABEL: Record<string, string> = { fan: 'Fan', influencer: 'Influencer', unverified: 'Not verified' };
const ROLE_INK: Record<string, string> = { fan: '#6D4FD0', influencer: '#0E7C86', unverified: '#C0262D' };
const FOLDER_KEYS = FOLDERS.map((f) => f.key);

/** Per folder: its icon tile, its hero wash, the Hinglish line, a sticker and the words for an empty folder. */
const FOLDER_ART: Record<FolderKey, { icon: IconName; tone: Tone; hero: 'lav' | 'rani' | 'gold' | 'tea' | 'saffron' | 'plum'; line: string; ghost: string; sticker: StickerName; empty: string }> = {
  unassigned: { icon: 'inbox', tone: 'rani', hero: 'lav', line: 'Kisi ne kuch poochha hai', ghost: 'Sawaal', sticker: 'chai', empty: 'Sab shaant hai' },
  mine: { icon: 'user', tone: 'lav', hero: 'lav', line: 'Aapke hisse ka kaam', ghost: 'Mera', sticker: 'chai', empty: 'Aapki plate khaali hai' },
  open: { icon: 'layers', tone: 'gold', hero: 'gold', line: 'Jo chal raha hai, sab yahan', ghost: 'Chalu', sticker: 'yaari', empty: 'Sab nipat gaya' },
  waiting: { icon: 'hourglass', tone: 'tea', hero: 'tea', line: 'Unke jawab ka intezaar', ghost: 'Intezaar', sticker: 'mohmaya', empty: 'Kisi ka intezaar nahi' },
  on_hold: { icon: 'pause', tone: 'tea', hero: 'tea', line: 'Thoda ruko, phir dekhte hain', ghost: 'Ruko', sticker: 'mohmaya', empty: 'Kuch ruka nahi hai' },
  solved: { icon: 'check', tone: 'lav', hero: 'lav', line: 'Kaam khatam, chai shuru', ghost: 'Solve', sticker: 'kyabaat', empty: 'Abhi tak kuch solve nahi hua' },
  closed: { icon: 'archive', tone: 'grey', hero: 'saffron', line: 'Band hua, yaad rahega', ghost: 'Band', sticker: 'lkk', empty: 'Koi band ticket nahi' },
  spam: { icon: 'spam', tone: 'rani', hero: 'rani', line: 'Nazar na lage', ghost: 'Nazar', sticker: 'nazar', empty: 'Spam nahi, shukar hai' },
  trash: { icon: 'trash', tone: 'grey', hero: 'saffron', line: 'Sab moh maya hai', ghost: 'Maya', sticker: 'mohmaya', empty: 'Kachra khaali hai' },
};
const KPI_FOLDERS: { key: FolderKey; tone: 'rani' | 'lav' | 'gold' | 'tea'; label: string }[] = [
  { key: 'unassigned', tone: 'rani', label: 'Unassigned' },
  { key: 'mine', tone: 'lav', label: 'My tickets' },
  { key: 'open', tone: 'gold', label: 'All open' },
  { key: 'waiting', tone: 'tea', label: 'Waiting on customer' },
];
const shortCount = (n: number | undefined) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The list the ticket page steps through with j/k. */
export function rememberList(folder: string, numbers: string[]): void {
  try { sessionStorage.setItem('hfs-list', JSON.stringify({ folder, numbers })); } catch { /* ignore */ }
}
export function readList(): { folder: string; numbers: string[] } | null {
  try { return JSON.parse(sessionStorage.getItem('hfs-list') ?? 'null'); } catch { return null; }
}

export default function AdminInbox({ initial, onCounts }: { initial: AdminList | null; onCounts: (c: AdminList['counts']) => void }) {
  const loc = useLoc();
  const me = useStaff();
  const toast = useToast();
  const visible = usePageVisible();
  const searchRef = useRef<HTMLInputElement>(null);

  const folder = (FOLDER_KEYS.includes(loc.params.get('f') as FolderKey) ? loc.params.get('f') : 'unassigned') as FolderKey;
  const f = {
    q: loc.params.get('q') ?? '', category: loc.params.get('category') ?? '', priority: loc.params.get('priority') ?? '',
    channel: loc.params.get('channel') ?? '', assignee: loc.params.get('assignee') ?? '', all: loc.params.get('all') === '1',
  };
  const filterKey = JSON.stringify([folder, f]);
  const params: ListParams = useMemo(() => ({
    folder: f.q && f.all ? 'all' : folder, q: f.q || undefined, category: f.category || undefined, priority: f.priority || undefined,
    channel: f.channel || undefined, assignee: f.assignee || undefined,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filterKey]);

  const [rows, setRows] = useState<AdminRow[]>(() => (initial && folder === 'unassigned' && !f.q ? initial.rows : []));
  const [counts, setCounts] = useState<AdminList['counts']>(initial?.counts ?? {});
  const [cursor, setCursor] = useState<string | null>(initial?.nextCursor ?? null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(initial && folder === 'unassigned' && !f.q ? 'ready' : 'loading');
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hi, setHi] = useState(0);
  const [modal, setModal] = useState<'help' | 'merge' | null>(null);
  const [busy, setBusy] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const first = useRef(true);

  const load = useCallback(async (quiet = false) => {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    if (!quiet) setPhase('loading');
    try {
      const r = await adminApi.list(params, c.signal);
      if (c.signal.aborted) return;
      setRows(r.rows); setCursor(r.nextCursor); setCounts(r.counts); onCounts(r.counts); setPhase('ready');
      rememberList(folder, r.rows.map((x) => x.number));
    } catch (e) {
      if (isAbort(e) || c.signal.aborted) return;
      if (!quiet) { setError(errMessage(e, 'Could not load tickets.')); setPhase('error'); }
    }
  }, [params, folder, onCounts]);

  useEffect(() => {
    if (first.current && initial && folder === 'unassigned' && !f.q && !f.category && !f.priority && !f.channel && !f.assignee) { first.current = false; rememberList(folder, rows.map((x) => x.number)); onCounts(initial.counts); return; }
    first.current = false;
    setSel(new Set()); setHi(0);
    void load();
    return () => ctl.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);
  useInterval(() => void load(true), visible ? 60_000 : null);

  const more = async () => {
    if (!cursor) return;
    try { const r = await adminApi.list({ ...params, cursor }); setRows((l) => [...l, ...r.rows]); setCursor(r.nextCursor); }
    catch (e) { toast(errMessage(e), 'error'); }
  };

  /* selection + bulk */
  const toggle = (n: string) => setSel((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const allOn = rows.length > 0 && sel.size === rows.length;
  const bulk = async (action: string, value?: string, done?: string) => {
    if (!sel.size || busy) return;
    if (!me.canWrite) { toast('You have read-only access.', 'error'); return; }
    setBusy(true);
    try { await adminApi.bulk([...sel], action, value); toast(done ?? `Updated ${plural(sel.size, 'ticket')}`); setSel(new Set()); await load(true); }
    catch (e) { toast(errMessage(e), 'error'); }
    finally { setBusy(false); }
  };
  const doMerge = async () => {
    const nums = [...sel].sort();
    const target = nums[0];
    setBusy(true);
    try {
      for (const n of nums.slice(1)) await adminApi.merge(n, target);
      toast(`Merged ${nums.length} tickets into ${target}`);
      setSel(new Set()); setModal(null); await load(true);
    } catch (e) { toast(errMessage(e), 'error'); }
    finally { setBusy(false); }
  };

  /* keyboard */
  const quick = async (n: string, action: string, done: string) => {
    if (!me.canWrite) { toast('You have read-only access.', 'error'); return; }
    try { await adminApi.bulk([n], action); toast(`${n} ${done}`); await load(true); } catch (er) { toast(errMessage(er), 'error'); }
  };
  const cur = rows[Math.min(hi, rows.length - 1)];
  useHotkeys({
    j: () => setHi((i) => Math.min(i + 1, rows.length - 1)),
    k: () => setHi((i) => Math.max(i - 1, 0)),
    Enter: () => { if (cur) navigate(`/desk/t/${cur.number}`); },
    o: () => { if (cur) navigate(`/desk/t/${cur.number}`); },
    x: () => { if (cur) toggle(cur.number); },
    r: () => { if (cur) navigate(`/desk/t/${cur.number}?focus=reply`); },
    n: () => { if (cur) navigate(`/desk/t/${cur.number}?focus=note`); },
    e: () => { if (sel.size) void bulk('solve', undefined, 'Solved'); else if (cur) void quick(cur.number, 'solve', 'solved'); },
    '!': () => { if (sel.size) void bulk('spam', undefined, 'Marked as spam'); else if (cur) void quick(cur.number, 'spam', 'marked as spam'); },
    '/': (e) => { e.preventDefault(); searchRef.current?.focus(); },
    '?': () => setModal('help'),
  });
  useEffect(() => { document.querySelector('.hfs-arow.is-hi')?.scrollIntoView({ block: 'nearest' }); }, [hi]);

  const folderLabel = FOLDERS.find((x) => x.key === folder)?.label ?? 'Inbox';
  const art = FOLDER_ART[folder];
  const setF = (patch: Record<string, string | null>) => setQuery(patch);
  const selected = [...sel];
  const mergeTarget = selected.length ? [...selected].sort()[0] : '';
  const anyFilter = !!(f.category || f.priority || f.channel || f.assignee || f.q);
  const search = useDebounced(f.q, 0);
  const here = counts[folder];

  return (
    <div className="hfs hfs-admin">
      <DeskHeader search={search} searchRef={searchRef} onSearch={(q) => setF({ q: q || null })} />
      <div className="hfs-shell hfs-in hfs-inbox">
        <nav className="hfs-folders" aria-label="Folders">
          <p className="hfs-folders__h">Folders</p>
          {FOLDERS.map((x) => (
            <Link key={x.key} to={`/desk?f=${x.key}`} className={`hfs-folder${folder === x.key ? ' is-on' : ''}`} aria-current={folder === x.key ? 'page' : undefined}>
              <IconTile name={FOLDER_ART[x.key].icon} tone={FOLDER_ART[x.key].tone} size={18} />
              <span className="hfs-folder__l">{x.label}</span>
              <span className="hfs-folder__n">{shortCount(counts[x.key])}</span>
            </Link>
          ))}
          <p className="hfs-folders__h">Desk</p>
          <Link to="/desk/queues" className="hfs-folder"><IconTile name="queue" tone="tea" size={18} /><span className="hfs-folder__l">Queues</span><span /></Link>
          <Link to="/desk/reports" className="hfs-folder"><IconTile name="chart" tone="gold" size={18} /><span className="hfs-folder__l">Reports</span><span /></Link>
          <Link to="/desk/settings" className="hfs-folder"><IconTile name="gear" tone="lav" size={18} /><span className="hfs-folder__l">Settings</span><span /></Link>
          <p className="hfs-folders__tip"><kbd>?</kbd> keyboard shortcuts</p>
        </nav>

        <main className="hfs-inbox__main">
          <PageHero tone={art.hero} eyebrow="Support desk" title={folderLabel} ghost={art.ghost} sticker={art.sticker}
            sub={<>{art.line}{here != null && <> · {plural(here, 'ticket')}</>}</>} />

          <div className="hfs-kpis" aria-label="Folders at a glance">
            {KPI_FOLDERS.map((k) => (
              <Kpi key={k.key} tone={k.tone} icon={FOLDER_ART[k.key].icon} label={k.label} value={counts[k.key] != null ? shortCount(counts[k.key]) : '–'} to={`/desk?f=${k.key}`} />
            ))}
          </div>

          <div className="hfs-filters" role="group" aria-label="Filters">
            <label className={`hfs-select${folder !== 'unassigned' ? ' is-set' : ''}`}><span className="hfs-sr">Status</span>
              <select value={folder} onChange={(e) => navigate(`/desk?f=${e.target.value}`)}>{FOLDERS.map((x) => <option key={x.key} value={x.key}>Status: {x.label}</option>)}</select>
            </label>
            <label className={`hfs-select${f.category ? ' is-set' : ''}`}><span className="hfs-sr">Category</span>
              <select value={f.category} onChange={(e) => setF({ category: e.target.value || null })}><option value="">Category: Any</option>{CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}</select>
            </label>
            <label className={`hfs-select${f.priority ? ' is-set' : ''}`}><span className="hfs-sr">Priority</span>
              <select value={f.priority} onChange={(e) => setF({ priority: e.target.value || null })}><option value="">Priority: Any</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select>
            </label>
            <label className={`hfs-select${f.channel ? ' is-set' : ''}`}><span className="hfs-sr">Channel</span>
              <select value={f.channel} onChange={(e) => setF({ channel: e.target.value || null })}><option value="">Channel: Any</option><option value="Email">Email</option><option value="App">App</option><option value="Web">Web</option></select>
            </label>
            <label className={`hfs-select${f.assignee ? ' is-set' : ''}`}><span className="hfs-sr">Assignee</span>
              <select value={f.assignee} onChange={(e) => { me.loadTeam(); setF({ assignee: e.target.value || null }); }} onFocus={me.loadTeam}>
                <option value="">Assignee: Anyone</option><option value="me">Me</option><option value="none">Unassigned</option>
                {me.team.filter((t) => t.uid && t.uid !== me.uid).map((t) => <option key={t.id} value={t.uid ?? ''}>{t.name || t.email}</option>)}
              </select>
            </label>
            {anyFilter && <button type="button" className="hfs-linkbtn" onClick={() => setF({ q: null, category: null, priority: null, channel: null, assignee: null, all: null })}>Clear filters</button>}
          </div>

          {f.q && (
            <p className="hfs-searchnote">
              Results for “{f.q}” {f.all ? 'in all folders' : `in ${folderLabel}`}.{' '}
              <button type="button" className="hfs-linkbtn" onClick={() => setF({ all: f.all ? null : '1' })}>{f.all ? `Only search ${folderLabel}` : 'Search all folders'}</button>
            </p>
          )}

          {sel.size > 0 && (
            <div className="hfs-bulk" role="toolbar" aria-label="Bulk actions">
              <span className="hfs-bulk__n">{sel.size} selected</span>
              <Menu className="hfs-btn hfs-btn--white hfs-btn--sm" label="Assign" disabled={!me.canWrite}>
                {(close) => (<>
                  <MenuItem onClick={() => { close(); void bulk('assign', me.uid, 'Assigned to you'); }}>Assign to me</MenuItem>
                  {me.team.filter((t) => t.uid && t.uid !== me.uid).map((t) => <MenuItem key={t.id} onClick={() => { close(); void bulk('assign', t.uid ?? '', `Assigned to ${t.name || t.email}`); }}>{t.name || t.email}</MenuItem>)}
                  <MenuItem onClick={() => { close(); void bulk('assign', '', 'Unassigned'); }}>Unassign</MenuItem>
                </>)}
              </Menu>
              <button type="button" className="hfs-btn hfs-btn--white hfs-btn--sm" disabled={busy || !me.canWrite} onClick={() => void bulk('solve', undefined, 'Solved')}>Solve</button>
              <button type="button" className="hfs-btn hfs-btn--white hfs-btn--sm" disabled={busy || !me.canWrite} onClick={() => void bulk('close', undefined, 'Closed')}>Close</button>
              <Menu className="hfs-btn hfs-btn--white hfs-btn--sm" label="Priority" disabled={!me.canWrite}>
                {(close) => PRIORITIES.map((p) => <MenuItem key={p} onClick={() => { close(); void bulk('priority', p); }}>{PRIORITY_LABEL[p]}</MenuItem>)}
              </Menu>
              <Menu className="hfs-btn hfs-btn--white hfs-btn--sm" label="Category" disabled={!me.canWrite}>
                {(close) => CATEGORIES.map((c) => <MenuItem key={c.slug} onClick={() => { close(); void bulk('category', c.slug); }}>{c.label}</MenuItem>)}
              </Menu>
              <button type="button" className="hfs-btn hfs-btn--white hfs-btn--sm" disabled={busy || sel.size < 2 || !me.canWrite} title={sel.size < 2 ? 'Select two or more tickets to merge' : ''} onClick={() => setModal('merge')}>Merge</button>
              <button type="button" className="hfs-btn hfs-btn--red hfs-btn--sm" disabled={busy || !me.canWrite} onClick={() => void bulk('spam', undefined, 'Marked as spam')}>Mark spam</button>
              <button type="button" className="hfs-linkbtn hfs-bulk__clear" onClick={() => setSel(new Set())}>Clear</button>
            </div>
          )}

          <div className="hfs-card hfs-alist" role="table" aria-label={folderLabel}>
            {phase === 'loading' && <div className="hfs-center"><Spinner /></div>}
            {phase === 'error' && <ErrorBox message={error} onRetry={() => void load()} />}
            {phase === 'ready' && rows.length === 0 && (
              <Empty sticker={anyFilter ? 'chugli' : art.sticker} hi={anyFilter ? 'Kuch mila nahi' : art.empty} title={anyFilter ? 'No tickets match these filters' : `Nothing in ${folderLabel}`}>
                {anyFilter ? 'Try clearing a filter.' : 'New tickets will appear here as soon as they arrive.'}
              </Empty>
            )}
            {phase === 'ready' && rows.length > 0 && (
              <>
                <div className="hfs-ahead" role="row">
                  <label className="hfs-ahead__all"><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.number)))} />Select all</label>
                  <span className="hfs-ahead__n">{plural(rows.length, 'ticket')}{cursor ? '+' : ''}</span>
                  <span className="hfs-ahead__art" aria-hidden="true"><Corner kind="yellow" size={34} /></span>
                </div>
                {rows.map((r, i) => {
                  const sla = slaText(r.sla);
                  const ct = categoryTone(r.category);
                  const checked = sel.has(r.number);
                  return (
                    <div
                      key={r.number} role="row"
                      className={`hfs-arow${checked ? ' is-sel' : ''}${i === hi ? ' is-hi' : ''}${r.unread ? ' is-unread' : ''}`}
                      onClick={(e) => { if ((e.target as HTMLElement).closest('input,label,a,button')) return; navigate(`/desk/t/${r.number}`); }}
                    >
                      <input type="checkbox" className="hfs-arow__cb" aria-label={`Select ${r.number}`} checked={checked} onChange={() => toggle(r.number)} />
                      <span className="hfs-arow__dot" title={PRIORITY_LABEL[r.priority]} style={{ background: PRIORITY_DOT[r.priority], color: PRIORITY_DOT[r.priority] }} />
                      <span className="hfs-arow__no">{r.number}</span>
                      <span className="hfs-arow__who">
                        <span className={`hfs-arow__av is-${r.customer.role}`} aria-hidden="true">{initials(r.customer.name)}</span>
                        <span className="hfs-arow__id">
                          <span className="hfs-arow__name">{r.customer.name}</span>
                          <span className="hfs-arow__role" style={{ color: ROLE_INK[r.customer.role] }}>{ROLE_LABEL[r.customer.role] ?? r.customer.role}</span>
                        </span>
                      </span>
                      <Link to={`/desk/t/${r.number}`} className="hfs-arow__subj"><b>{r.subject}</b><span> · {r.preview}</span></Link>
                      <Chip tint={ct.tint} ink={ct.ink} className="hfs-arow__cat">{categoryShort(r.category)}</Chip>
                      <span className={`hfs-arow__sla is-${sla.state}`}>{sla.text}</span>
                      <span className="hfs-arow__when">{agoShort(r.updatedAt)}</span>
                      {r.assignee && <span className="hfs-arow__assignee" title={`Assigned to ${r.assignee.name}`}>{r.assignee.name}</span>}
                    </div>
                  );
                })}
              </>
            )}
          </div>
          {cursor && phase === 'ready' && <div className="hfs-more"><button type="button" className="hfs-btn hfs-btn--ghost" onClick={() => void more()}>Load more</button></div>}
          <p className="hfs-fineprint hfs-fineprint--pad">Reply targets: first reply 24 h, Urgent 2 h · Mon–Sat 10 am–7 pm IST · the clock pauses outside hours · press ? for keyboard shortcuts</p>
        </main>
      </div>

      {modal === 'merge' && (
        <Modal title="Merge tickets" onClose={() => setModal(null)}>
          <p>Merge {selected.length} tickets into <strong>{mergeTarget}</strong> (the oldest). Their messages move into it and the others close.</p>
          <div className="hfs-modal__actions">
            <button type="button" className="hfs-btn hfs-btn--primary" disabled={busy} onClick={() => void doMerge()}>{busy ? 'Merging…' : 'Merge'}</button>
            <button type="button" className="hfs-btn hfs-btn--ghost" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {modal === 'help' && <Modal title="Keyboard shortcuts" onClose={() => setModal(null)}><ShortcutList /></Modal>}
    </div>
  );
}

export function ShortcutList() {
  return (
    <dl className="hfs-keys">
      {SHORTCUTS.map(([k, v]) => (<div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>))}
    </dl>
  );
}
