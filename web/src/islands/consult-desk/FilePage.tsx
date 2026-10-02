/* [AUMFE-CONSULT-F3-1 2026-10-02] /desk/bookings/:id — the customer's file + the live audio call, for the consultant.
 * Desktop (>=1180px): sidebar | file | call column (FileAstroDesktop). Phone: file cards + a sticky bottom call bar that keeps the call
 * alive while scrolling and expands to a bigger panel (FilePalmMobile). Cards render by key per discipline; every value is editable
 * (cardUi.tsx); unknown keys fall back to readable JSON. Private notes are saved by a debounced PUT. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import { CARD_KEYS, DISCIPLINE_LABEL } from '../../lib/consultTypes';
import type { DeskFileDTO, FileCard } from '../../lib/consultTypes';
import { errMessage, errStatus, getDeskFile, putNotes, patchCard, rerunFile } from '../../lib/consultDeskApi';
import { CallBar, CallPanel, joinWindowOpen, useConsultCall } from './callUi';
import { DeskRoot, DISC_CAT, DISC_CHIP, SideMenu, dayIst, inMinutes, slotRange, useDesk, useNow } from './shared';
import { humanize } from './cardData';
import type { J } from './cardData';
import { FileCtx, JsonCard, KvCard, Section, useFile } from './cardUi';
import { BirthDetails, ChartCard, CoreNumbers, DashaCard, DoshaCard, LoShuCard, PlanetsCard, RemediesCard, TextCard } from './renderersA';
import { DrawMore, FacePhotos, PalmPhotos, ReadingsCard, SeesCard, SpreadCard, TarotReadings, YesNoCard } from './renderersB';

function Questions() {
  const { file, customerFirst } = useFile();
  const qs = file.booking.questions.filter((q) => q.trim());
  if (!qs.length) return null;
  const frame = file.booking.discipline === 'face_reading';
  return (
    <Section title={qs.length === 1 ? `${customerFirst}’s question` : `${customerFirst}’s questions`} frame={frame}>
      {qs.length === 1 ? <p style={{ fontSize: 16 }}>{qs[0]}</p> : <ol style={{ margin: 0, paddingLeft: 22, fontSize: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>{qs.map((q, i) => <li key={i}>{q}</li>)}</ol>}
    </Section>
  );
}

function PastNotes() {
  const { file } = useFile();
  if (!file.past_notes.length) return null;
  return (
    <Section title="Last session’s notes" frame={file.booking.discipline === 'face_reading'}>
      {file.past_notes.map((n) => <p key={`${n.booking_id}${n.at}`} style={{ fontSize: 16 }}><strong>{dayIst(n.at, false)}</strong> · {n.note}</p>)}
    </Section>
  );
}

function renderCards(file: DeskFileDTO, have: (k: string) => boolean) {
  const d = file.booking.discipline;
  const known = new Set(CARD_KEYS[d]);
  const extra = file.cards.filter((c: FileCard) => !known.has(c.key));
  let body: React.ReactNode;
  switch (d) {
    case 'astrology':
      body = (
        <>
          <div className="cd-grid2"><BirthDetails /><ChartCard /></div>
          <div className="cd-grid2"><DashaCard /><DoshaCard /></div>
          <PlanetsCard />
          <Questions />
          <RemediesCard />
          <div className="cd-grid2">
            <KvCard cardKey="panchang" title="Panchang" />
            {have('match') ? <KvCard cardKey="match" title="Match (Ashtakoot)" /> : null}
          </div>
          <PastNotes />
        </>
      );
      break;
    case 'numerology':
      body = (
        <>
          <CoreNumbers />
          <LoShuCard />
          <div className="cd-grid2"><KvCard cardKey="names" title="Names and numbers" /><KvCard cardKey="lucky" title="Lucky table" /></div>
          <TextCard cardKey="report" title="Report" />
          {have('daily') ? <TextCard cardKey="daily" title="Daily" /> : null}
          <Questions /><PastNotes />
        </>
      );
      break;
    case 'palmistry':
      body = (
        <>
          <PalmPhotos />
          <SeesCard title="What the API sees" keys={['hand_type', 'lines', 'mounts']} />
          <ReadingsCard cardKey="readings" title="Readings" order={['career', 'money', 'love', 'marriage', 'health', 'luck']} />
          <Questions /><PastNotes />
        </>
      );
      break;
    case 'face_reading':
      body = (
        <>
          <FacePhotos />
          <SeesCard frame title="What the reader sees" keys={['features']} />
          <ReadingsCard frame cardKey="readings" title="Readings" order={['personality', 'career', 'wealth', 'marriage', 'family']} />
          <Questions /><PastNotes />
        </>
      );
      break;
    default:
      body = (<><SpreadCard /><TarotReadings /><YesNoCard /><DrawMore /><Questions /><PastNotes /></>);
  }
  return (
    <>
      {body}
      {extra.map((c) => <JsonCard key={c.key} card={c} />)}
    </>
  );
}

function subLine(file: DeskFileDTO): string {
  const b = file.booking; const it = file.intake; const c = b.customer;
  const parts: (string | null | undefined)[] = [];
  if (it.kind === 'numerology') parts.push(`Born ${dayIst(Date.parse(`${it.dob}T12:00:00+05:30`), false)} ${it.dob.slice(0, 4)}`);
  if (c.age != null && it.kind !== 'numerology') parts.push(String(c.age));
  if (it.kind === 'astrology') { parts.push(it.birth.gender ? humanize(it.birth.gender) : null); parts.push(c.city ? `Lives in ${c.city}` : it.current_city ? `Lives in ${it.current_city}` : null); if (it.gotra) parts.push(`Gotra ${it.gotra}`); if (it.marital_status) parts.push(humanize(it.marital_status)); }
  else {
    if (it.kind === 'palmistry' || it.kind === 'face_reading') parts.push(it.gender ? humanize(it.gender) : null);
    parts.push(c.city);
    if (it.kind === 'palmistry') { if (it.occupation) parts.push(it.occupation); parts.push(`${it.dominant_hand}-handed`); }
    if (it.kind === 'tarot') { /* focus shown as chips */ }
  }
  parts.push(c.repeat ? 'Repeat customer' : 'First session');
  return parts.filter(Boolean).join(' · ');
}
const focusOf = (file: DeskFileDTO): string[] => (file.intake.kind === 'astrology' || file.intake.kind === 'palmistry' || file.intake.kind === 'face_reading' ? file.intake.focus : []);

function NotesBox({ id, value, onChange, status }: { id: string; value: string; onChange: (v: string) => void; status: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>Private notes (only you see these)</label>
      <textarea id={id} className="cd-ta" style={{ minHeight: 160 }} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="hint" role="status">{status || 'Notes stay on this customer’s file for their next session.'}</span>
    </div>
  );
}

function FileLoaded({ initial, reload }: { initial: DeskFileDTO; reload: () => Promise<void> }) {
  const { me } = useDesk();
  const [file, setFile] = useState<DeskFileDTO>(initial);
  const [toast, setToast] = useState<string | null>(null);
  const b = file.booking;
  const first = b.customer.name.trim().split(/\s+/)[0] ?? b.customer.name;
  const now = useNow(1000);
  const { call, s } = useConsultCall({ bookingId: b.id, title: `${BRAND.name} session`, artist: b.customer.name, artworkUrl: me.consultant.photo_url, role: 'consultant' });

  useEffect(() => { setFile(initial); }, [initial]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { capture('consult_desk_viewed', { screen: 'file', discipline: b.discipline }); }, [b.discipline]);

  /* ── notes (debounced PUT) ── */
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [noteStatus, setNoteStatus] = useState('');
  const lastSaved = useRef(initial.notes ?? '');
  const onNotes = (v: string) => { setNotes(v); setNoteStatus('Typing…'); };
  useEffect(() => {
    if (notes === lastSaved.current) return undefined;
    const t = setTimeout(async () => {
      setNoteStatus('Saving…');
      try { await putNotes(b.id, notes); lastSaved.current = notes; setNoteStatus('Saved'); }
      catch (e) { captureException(e, { where: 'consult_desk_notes' }); setNoteStatus('Could not save these notes. We will keep trying while you type.'); }
    }, 800);
    return () => clearTimeout(t);
  }, [notes, b.id]);

  const cards = useMemo(() => Object.fromEntries(file.cards.map((c) => [c.key, c])) as Record<string, FileCard>, [file.cards]);

  const save = useCallback(async (key: string, override: J | null): Promise<boolean> => {
    const prev = file.cards;
    const by = override === null ? null : me.consultant.name;
    const at = override === null ? null : Date.now();
    const exists = prev.some((c) => c.key === key);
    const next: FileCard[] = exists ? prev.map((c) => (c.key === key ? { ...c, override, edited_by: by, edited_at: at } : c))
      : [...prev, { key, title: humanize(key), api: null, override, edited_by: by, edited_at: at, status: 'missing' }];
    setFile((f) => ({ ...f, cards: next }));
    try { await patchCard(b.id, key, override); capture('consult_card_edited', { key, undo: override === null }); return true; }
    catch (e) {
      captureException(e, { where: 'consult_card_edit', key });
      setFile((f) => ({ ...f, cards: prev }));
      setToast(errMessage(e, 'We could not save that change. Please try again.'));
      return false;
    }
  }, [file.cards, b.id, me.consultant.name]);

  const rerun = useCallback(async (tob: string): Promise<boolean> => {
    try { await rerunFile(b.id, tob); await reload(); return true; }
    catch (e) { captureException(e, { where: 'consult_rerun' }); setToast(errMessage(e, 'We could not re-run the chart. Please try again.')); return false; }
  }, [b.id, reload]);

  const connected = s.status === 'connected';
  const ctx = useMemo(() => ({ file, cards, save, rerun, connected, reveal: (c: { id: number; reversed: boolean; position: string }) => call.sendReveal(c), customerFirst: first }), [file, cards, save, rerun, connected, call, first]);

  const open = joinWindowOpen(b, now);
  const join = () => { capture('consult_desk_join_clicked', { discipline: b.discipline }); void call.start(); };
  const slotMinutes = Math.max(1, Math.round((b.slot_end_ms - b.slot_start_ms) / 60000));
  const over = now > b.slot_end_ms + 5 * 60_000 || !['confirmed', 'in_call'].includes(b.status);
  const joinNote = over ? (b.status === 'completed' ? 'This session is complete.' : 'This session is over.') : `Join opens in ${inMinutes(b.join_opens_ms - now)}.`;
  const have = (k: string) => k in cards;
  const d = b.discipline;
  const theme = d === 'face_reading' ? '#7d1820' : !open && !(s.status !== 'idle') ? '#17343c' : undefined;
  const chip = <span className={`chip ${DISC_CHIP[d] ?? ''}`}>{DISCIPLINE_LABEL[d].en}</span>;
  const notesBox = (id: string) => <NotesBox id={id} value={notes} onChange={onNotes} status={noteStatus} />;
  const partial = b.prep_status === 'partial' || b.prep_status === 'failed';

  return (
    <FileCtx.Provider value={ctx}>
      <div className={DISC_CAT[d] ?? ''}>
        <div className="cd-shell cd-has-aside">
          <SideMenu page="bookings" />
          <div className="cd-col">
            <header className="topbar cd-top">
              <a href="/desk" style={{ fontWeight: 800, textDecoration: 'none' }}>← Today</a>
              {chip}
            </header>
            <main className="cd-main cd-main-nonav">
              <div className="card cd-desktop-only" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <span className="label">Booking {b.ref} · {dayIst(b.slot_start_ms)}, {slotRange(b.slot_start_ms, b.slot_end_ms)}</span>
                  <h1 style={{ fontSize: 30 }}>{b.customer.name}</h1>
                  <span className="muted" style={{ fontSize: 16 }}>{subLine(file)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{focusOf(file).map((f) => <span key={f} className="chip">{humanize(f)}</span>)}</div>
              </div>
              <div className="cd-mobile-only" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <h1 style={{ fontSize: 26 }}>{b.customer.name}</h1>
                <span className="muted" style={{ fontSize: 15 }}>{subLine(file)}</span>
                <span className="hint">Booking {b.ref} · {dayIst(b.slot_start_ms)}, {slotRange(b.slot_start_ms, b.slot_end_ms)}</span>
                {focusOf(file).length ? <div className="cd-chips" style={{ marginTop: 6 }}>{focusOf(file).map((f) => <span key={f} className="chip">{humanize(f)}</span>)}</div> : null}
              </div>
              {partial ? <div className="card" role="status" style={{ background: '#fbe7c2', borderColor: '#e8cf96' }}><p style={{ fontWeight: 700, fontSize: 15 }}>{b.prep_status === 'failed' ? 'The file could not be prepared.' : 'Some cards could not be prepared.'} You can write the missing ones yourself, or ask for a re-run.</p></div> : null}
              {b.prep_status === 'pending' || b.prep_status === 'running' ? <div className="card" role="status" style={{ background: '#f6ead0' }}><p style={{ fontWeight: 700, fontSize: 15 }}>The file is still being prepared. It fills in by itself.</p></div> : null}
              {renderCards(file, have)}
              <div className="card cd-mobile-only" style={{ background: '#fff' }}>{notesBox('notes-m')}</div>
            </main>
          </div>
          <aside className="cd-aside" aria-label="Call">
            <CallPanel s={s} name={b.customer.name} slotMinutes={slotMinutes} canJoin={open} joinNote={joinNote} opensInMs={b.join_opens_ms - now}
              onJoin={join} onMute={() => call.toggleMute()} onEnd={() => call.end()} notes={<>{notesBox('notes-d')}</>} />
          </aside>
        </div>
        <CallBar s={s} name={b.customer.name} slotMinutes={slotMinutes} canJoin={open} joinNote={joinNote} opensInMs={b.join_opens_ms - now} startsAt={b.slot_start_ms} theme={theme}
          onJoin={join} onMute={() => call.toggleMute()} onEnd={() => call.end()} />
        {toast ? <div className="cd-toast" role="status">{toast}</div> : null}
      </div>
    </FileCtx.Provider>
  );
}

function FileBoot({ id }: { id: string }) {
  const [file, setFile] = useState<DeskFileDTO | null>(null);
  const [err, setErr] = useState<{ status?: number; message: string } | null>(null);
  const load = useCallback(async () => {
    try { setFile(await getDeskFile(id)); setErr(null); }
    catch (e) { captureException(e, { where: 'consult_desk_file' }); setErr({ status: errStatus(e), message: errMessage(e, 'We could not open this file. Please try again.') }); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  if (err) {
    const gone = err.status === 403 || err.status === 404;
    return (
      <div className="cd-center" role="alert"><div className="card" style={{ maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'center', background: '#fff' }}>
        <h1 style={{ fontSize: 22 }}>{gone ? 'This booking is not on your desk' : 'Something went wrong'}</h1>
        <p className="muted">{gone ? 'It may belong to another consultant, or it is not confirmed yet.' : err.message}</p>
        {gone ? <a className="btn" href="/desk">Back to Today</a> : <button type="button" className="btn" onClick={() => void load()}>Try again</button>}
      </div></div>
    );
  }
  if (!file) return <div className="cd-center" aria-busy="true"><p className="muted">Opening the file…</p></div>;
  return <FileLoaded initial={file} reload={load} />;
}

export default function FilePage({ bookingId }: { bookingId: string }) {
  return <DeskRoot page="bookings" bare><FileBoot id={bookingId} /></DeskRoot>;
}
