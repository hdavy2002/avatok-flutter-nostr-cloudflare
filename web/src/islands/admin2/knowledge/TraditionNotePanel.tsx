/* TraditionNotePanel — [AUMFE-KNOWLEDGE-ADMIN-UI-1 2026-10-01]
 * The tradition note behind one shop product (or event): design facts, wear days, the pandit-reviewed
 * explanation, and the ordered "Why this?" reasons customers see. Mounted in the shop ProductModal and in the
 * Tradition library "Product notes" tab. API: /api/admin/v2/knowledge/notes/:kind/:id (+ /draft, /approve, /reject).
 * Saving an approved note sends it back to draft (and out of search) — the panel warns first. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import {
  CHAKRAS, DESIGN_TYPES, GRAHAS, WEEKDAYS, cap, grahaLabel, isMissingRoute, knowledgeApi, parseAny, parseList,
  type MatchReason, type MatchStep, type NoteBody, type NoteRow,
} from './knowledgeApi';
import './knowledge.css';

const STEP_ORDER: MatchStep[] = ['deity', 'chakra', 'print_colour', 'shirt_colour'];
const STEP_LABEL: Record<string, string> = { deity: 'Deity', chakra: 'Chakra', print_colour: 'Print colour', shirt_colour: 'Shirt colour' };
const DAY_SHORT: Record<string, string> = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

interface Form {
  design_type: string; design_elements: string[]; print_colours: string[]; shirt_colour: string; deity: string; graha: string; chakra: string;
  wear_days: string[]; occasions: string[]; mantra: string; tradition_note: string; story: string;
}
const EMPTY: Form = {
  design_type: '', design_elements: [], print_colours: [], shirt_colour: '', deity: '', graha: '', chakra: '',
  wear_days: [], occasions: [], mantra: '', tradition_note: '', story: '',
};
const fromRow = (n: NoteRow | null): Form => !n ? EMPTY : {
  design_type: n.design_type ?? '', design_elements: parseList(n.design_elements_json), print_colours: parseList(n.print_colours_json),
  shirt_colour: n.shirt_colour ?? '', deity: n.deity ?? '', graha: n.graha ?? '', chakra: n.chakra ?? '',
  wear_days: parseList(n.wear_days_json), occasions: parseList(n.occasions_json), mantra: n.mantra ?? '',
  tradition_note: n.tradition_note ?? '', story: n.story ?? '',
};
const nn = (s: string) => (s.trim() ? s.trim() : null);
const toBody = (f: Form, n: NoteRow | null): NoteBody => ({
  design_type: nn(f.design_type), design_elements: f.design_elements, print_colours: f.print_colours, shirt_colour: nn(f.shirt_colour),
  deity: nn(f.deity), graha: nn(f.graha), chakra: nn(f.chakra), wear_days: f.wear_days, occasions: f.occasions, mantra: nn(f.mantra),
  tradition_note: f.tradition_note, story: f.story,
  // The worker owns these: send them back untouched so a save never wipes the sources or the reasons.
  sources: parseAny(n?.sources_json), match_reasons: parseAny(n?.match_reasons_json) as MatchReason[],
});

function ChipInput({ id, label, hint, value, onChange, placeholder }: {
  id: string; label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase()) && next.length < 50) next.push(p);
    onChange(next); setDraft('');
  };
  return (
    <div className="kn-field kn-full">
      <label htmlFor={id}>{label}</label>
      <div className="kn-chips">
        {value.map((v, i) => (
          <span className="kn-chip" key={v + i}>{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((_, k) => k !== i))}>×</button></span>
        ))}
        <input
          id={id} value={draft} placeholder={placeholder} enterKeyHint="done"
          onChange={(e) => { if (e.target.value.includes(',')) add(e.target.value); else setDraft(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1)); }}
          onBlur={() => add(draft)}
        />
      </div>
      {hint && <span className="kn-hint">{hint}</span>}
    </div>
  );
}

/** What the customer sees under "Why this?": steps in the fixed order deity → chakra → print colour → shirt colour. */
export function WhyThisPreview({ reasons }: { reasons: MatchReason[] }) {
  const ordered = useMemo(() => {
    const rank = (s: string) => { const i = STEP_ORDER.indexOf(s as MatchStep); return i < 0 ? 99 : i; };
    return reasons.filter((r) => r && r.fact).map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.step) - rank(b.r.step) || a.i - b.i).map((x) => x.r);
  }, [reasons]);
  return (
    <div className="kn-why" aria-label="Why this? preview">
      <h4>Why this?</h4>
      {ordered.length === 0
        ? <p className="kn-hint" style={{ margin: '4px 0 0' }}>No reasons yet. They are written when the note is drafted or saved, and customers only see them once the note is approved.</p>
        : <ol>{ordered.map((r, i) => <li key={i}><div><b>{STEP_LABEL[r.step] ?? cap(String(r.step))}</b><span>{r.fact}</span></div></li>)}</ol>}
    </div>
  );
}

const sourceText = (s: unknown): string => {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') {
    const o = s as Record<string, unknown>;
    return [o.title, o.source, o.id].filter((x) => typeof x === 'string' && x).join(' — ') || JSON.stringify(s);
  }
  return String(s);
};

export default function TraditionNotePanel({ kind, id, title, onStatus }: {
  kind: 'shop_product' | 'event'; id: string; title?: string; onStatus?: (status: string) => void;
}) {
  const [note, setNote] = useState<NoteRow | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<'' | 'save' | 'draft' | 'approve' | 'reject'>('');
  const [err, setErr] = useState('');
  const [aiMissing, setAiMissing] = useState(false);
  const [confirm, setConfirm] = useState<'' | 'save' | 'draft'>('');
  const [dirty, setDirty] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // onStatus is usually an inline arrow: read it through a ref so it never retriggers the load effect.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const apply = useCallback((n: NoteRow | null) => { setNote(n); setForm(fromRow(n)); setDirty(false); onStatusRef.current?.(n?.status ?? 'none'); }, []);

  const load = useCallback(async () => {
    setPhase('loading'); setErr('');
    try { apply(await knowledgeApi.getNote(kind, id)); setPhase('ready'); }
    catch (e) { captureException(e, { where: 'admin_note_load', kind }); setErr(errMessage(e, 'Could not load this note.')); setPhase('error'); }
  }, [kind, id, apply]);
  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); setConfirm(''); };
  const status = note?.status ?? 'none';
  const isApproved = status === 'approved';

  async function save(silent = false): Promise<NoteRow | null> {
    setBusy('save'); setErr(''); setConfirm('');
    try {
      const n = await knowledgeApi.putNote(kind, id, toBody(form, note));
      apply(n);
      if (!silent) toast.success(isApproved ? 'Saved. The note is back in draft until you approve it again.' : 'Draft saved');
      return n;
    } catch (e) {
      captureException(e, { where: 'admin_note_save', kind });
      setErr(errMessage(e, 'The note could not be saved.')); return null;
    } finally { if (alive.current) setBusy(''); }
  }

  async function draftWithAi() {
    setBusy('draft'); setErr(''); setConfirm(''); setAiMissing(false);
    try {
      const n = await knowledgeApi.draftNote(kind, id, toBody(form, note));
      apply(n);
      capture('admin_note_drafted', { kind, subject_id: id });
      toast.success('AI draft ready', { description: 'Read it through, then approve it.' });
    } catch (e) {
      if (isMissingRoute(e)) setAiMissing(true);
      else { captureException(e, { where: 'admin_note_draft', kind }); setErr(errMessage(e, 'The AI draft failed. Try again.')); }
    } finally { if (alive.current) setBusy(''); }
  }

  async function approve() {
    setErr('');
    if (!form.tradition_note.trim()) { setErr('Write (or draft) the tradition note before approving.'); return; }
    if (dirty || !note) { const n = await save(true); if (!n) return; }
    setBusy('approve');
    try {
      const r = await knowledgeApi.approveNote(kind, id);
      capture('admin_note_approved', { kind, subject_id: id, indexed: r.indexed });
      toast.success(r.indexed ? 'Approved and added to search' : 'Approved', r.indexed ? undefined : { description: r.reason ? `Not indexed: ${r.reason}` : 'It will be searchable after the next re-index.' });
      apply(await knowledgeApi.getNote(kind, id));
    } catch (e) {
      captureException(e, { where: 'admin_note_approve', kind });
      setErr(errMessage(e, 'Could not approve the note.'));
    } finally { if (alive.current) setBusy(''); }
  }

  async function reject() {
    setBusy('reject'); setErr('');
    try {
      await knowledgeApi.rejectNote(kind, id);
      toast.success('Note rejected and removed from search');
      apply(await knowledgeApi.getNote(kind, id));
    } catch (e) {
      captureException(e, { where: 'admin_note_reject', kind });
      setErr(errMessage(e, 'Could not reject the note.'));
    } finally { if (alive.current) setBusy(''); }
  }

  const reasons = useMemo(() => parseAny(note?.match_reasons_json) as MatchReason[], [note]);
  const sources = useMemo(() => parseAny(note?.sources_json), [note]);
  const uid = `kn-${kind}-${id}`;
  const working = busy !== '';

  if (phase === 'loading') return <section className="kn" aria-busy="true"><p className="kn-lede" style={{ margin: 0 }}>Loading the tradition note…</p></section>;
  if (phase === 'error') return (
    <section className="kn" role="alert">
      <p className="kn-err" style={{ marginTop: 0 }}>{err}</p>
      <div className="kn-actions"><button type="button" className="kn-btn kn-btn--ghost" onClick={() => void load()}>Try again</button></div>
    </section>
  );

  return (
    <section className="kn" aria-label={title ? `Tradition note for ${title}` : 'Tradition note'}
      // Mounted inside the product <form>: Enter in a plain field must not submit (save) the product.
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault(); }}>
      <div className="kn-head">
        <h3>Tradition note</h3>
        <span className={`kn-status is-${status}`}>{status === 'none' ? 'No note yet' : status}</span>
      </div>
      <p className="kn-lede">What the shirt means and who it suits. Only approved notes are used by the AI and shown to customers. Entries are drafts until a qualified pandit has reviewed them.</p>

      <div className="kn-grid">
        <div className="kn-field">
          <label htmlFor={`${uid}-dt`}>Design type</label>
          <select id={`${uid}-dt`} value={form.design_type} onChange={(e) => set('design_type', e.target.value)}>
            <option value="">Not set</option>
            {DESIGN_TYPES.map((d) => <option key={d} value={d}>{cap(d)}</option>)}
          </select>
        </div>
        <div className="kn-field">
          <label htmlFor={`${uid}-deity`}>Deity</label>
          <input id={`${uid}-deity`} value={form.deity} maxLength={60} placeholder="e.g. ganesha" onChange={(e) => set('deity', e.target.value)} />
        </div>
        <div className="kn-field">
          <label htmlFor={`${uid}-graha`}>Graha (planet)</label>
          <select id={`${uid}-graha`} value={form.graha} onChange={(e) => set('graha', e.target.value)}>
            <option value="">Not set</option>
            {GRAHAS.map((g) => <option key={g} value={g}>{grahaLabel(g)}</option>)}
          </select>
        </div>
        <div className="kn-field">
          <label htmlFor={`${uid}-chakra`}>Chakra</label>
          <select id={`${uid}-chakra`} value={form.chakra} onChange={(e) => set('chakra', e.target.value)}>
            <option value="">None</option>
            {CHAKRAS.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
          </select>
        </div>
        <div className="kn-field">
          <label htmlFor={`${uid}-shirt`}>Shirt colour</label>
          <input id={`${uid}-shirt`} value={form.shirt_colour} maxLength={60} placeholder="e.g. saffron" onChange={(e) => set('shirt_colour', e.target.value)} />
        </div>
        <div className="kn-field">
          <label htmlFor={`${uid}-mantra`}>Mantra</label>
          <input id={`${uid}-mantra`} value={form.mantra} maxLength={300} onChange={(e) => set('mantra', e.target.value)} />
        </div>
        <ChipInput id={`${uid}-el`} label="Design elements" hint="Press Enter or comma to add each one, e.g. trishul, damaru, lotus." value={form.design_elements} onChange={(v) => set('design_elements', v)} placeholder="Add an element" />
        <ChipInput id={`${uid}-pc`} label="Print colours" value={form.print_colours} onChange={(v) => set('print_colours', v)} placeholder="Add a colour" />
        <div className="kn-field kn-full">
          <span id={`${uid}-days`}>Wear on these days</span>
          <div className="kn-days" role="group" aria-labelledby={`${uid}-days`}>
            {WEEKDAYS.map((d) => {
              const on = form.wear_days.includes(d);
              return <button key={d} type="button" className="kn-day" aria-pressed={on} onClick={() => set('wear_days', on ? form.wear_days.filter((x) => x !== d) : [...form.wear_days, d])}>{DAY_SHORT[d]}</button>;
            })}
          </div>
        </div>
        <ChipInput id={`${uid}-occ`} label="Occasions" value={form.occasions} onChange={(v) => set('occasions', v)} placeholder="e.g. Navratri, daily wear" />
        <div className="kn-field kn-full">
          <label htmlFor={`${uid}-tn`}>Tradition note</label>
          <textarea id={`${uid}-tn`} rows={5} maxLength={4000} value={form.tradition_note} onChange={(e) => set('tradition_note', e.target.value)} />
          <span className="kn-hint">Plain, source-based. Say "traditionally" and avoid promises about luck or health.</span>
        </div>
        <div className="kn-field kn-full">
          <label htmlFor={`${uid}-story`}>Story</label>
          <textarea id={`${uid}-story`} rows={5} maxLength={8000} value={form.story} onChange={(e) => set('story', e.target.value)} />
        </div>
      </div>

      <WhyThisPreview reasons={reasons} />
      {sources.length > 0 && (
        <>
          <p className="kn-hint" style={{ margin: '14px 0 0', fontWeight: 800 }}>Sources</p>
          <ul className="kn-sources">{sources.map((s, i) => <li key={i}>{sourceText(s)}</li>)}</ul>
        </>
      )}

      {confirm && (
        <div className="kn-warn" role="alertdialog" aria-label="Confirm">
          {confirm === 'save'
            ? 'This note is approved. Saving it sends it back to draft and removes it from search until you approve it again.'
            : 'This note is approved. A new AI draft replaces these fields, sends the note back to draft and removes it from search until you approve it again.'}
          <div className="kn-actions">
            <button type="button" className="kn-btn kn-btn--red" disabled={working} onClick={() => void (confirm === 'save' ? save() : draftWithAi())}>{confirm === 'save' ? 'Save as draft' : 'Draft anyway'}</button>
            <button type="button" className="kn-btn kn-btn--ghost" onClick={() => setConfirm('')}>Keep approved note</button>
          </div>
        </div>
      )}
      {aiMissing && <p className="kn-warn" role="status">AI drafting isn't available yet. You can still fill the note in by hand and save it.</p>}
      {err && <p className="kn-err" role="alert">{err}</p>}

      <div className="kn-actions">
        <button type="button" className="kn-btn kn-btn--teal" disabled={working} onClick={() => (isApproved ? setConfirm('draft') : void draftWithAi())}>{busy === 'draft' ? 'Drafting…' : 'Draft with AI'}</button>
        <button type="button" className="kn-btn kn-btn--ghost" disabled={working || (!dirty && !!note)} onClick={() => (isApproved ? setConfirm('save') : void save())}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
        <button type="button" className="kn-btn kn-btn--red" disabled={working || (isApproved && !dirty)} onClick={() => void approve()}>{busy === 'approve' ? 'Approving…' : isApproved && dirty ? 'Save and approve' : 'Approve'}</button>
        <button type="button" className="kn-btn kn-btn--danger" disabled={working || !note || status === 'rejected'} onClick={() => void reject()}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
      </div>
    </section>
  );
}
