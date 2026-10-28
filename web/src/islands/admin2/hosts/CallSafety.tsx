/* [HF-CALL-SAFETY-WEB] Admin "Call safety": calls the AI was not sure about, appeals, fan reports and paused accounts, oldest first.
 * Owner-approved artboards: Main (this page) and AdminBan (the ban confirm). Contract: HF-CALL-SAFETY-CONTRACT.md "Admin".
 * Safety reviewers only (the server enforces it; this page just reports a 403 calmly). Every transcript open is logged by the server. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Clock, Flag, ListChecks, MessageSquareQuote, Pause, Phone, Play, ShieldAlert, Siren } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { toMs } from '../../../lib/hfCallsApi';
import { REASON_TITLE, safetyDay } from '../../../lib/hfSafetyApi';
import {
  safetyAdminApi, STRIKE_REASONS,
  type BanPreview, type BanStrike, type HistoryItem, type RowKind, type SafetyDetail, type SafetyRow, type SafetySummary, type SafetyTab, type TranscriptLine, type Verdict, type Who,
} from '../../../lib/hfSafetyAdminApi';
import { errMessage } from '../adminApi';
import { dateIST } from '../consultants/kit';
import { DesiAvatar, DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis, Marigold } from '../desi';
import { HBanner } from './hostsKit';
import '../../../styles/hf-admin-safety.css';

export type SafetyAdminApi = typeof safetyAdminApi;
export const SAFETY_PENDING_EVENT = 'hf-safety-admin:pending';
export const SAFETY_PENDING_KEY = 'admin2:hf-safety-pending';

const TABS: { key: SafetyTab; label: string }[] = [
  { key: 'review', label: 'Needs review' }, { key: 'strikes', label: 'Strikes' }, { key: 'paused', label: 'Paused & banned' }, { key: 'access', label: 'Access log' },
];
const VERDICT: Record<Verdict, string> = {
  clean: 'Clean', selling: 'Selling', outside_payment: 'Outside payment', contact_sharing: 'Contact sharing', abuse: 'Abusive or rude', sexual: 'Sexual talk', danger: 'Danger',
};
const WHO: Record<Who, string> = { fan: 'Fan', influencer: 'Influencer' };
/** The backend may say 'unknown' (or nothing): that is shown as 'Not sure', never guessed as Influencer. */
const whoOf = (s: string | null | undefined): Who | null => (s === 'fan' || s === 'influencer' ? s : null);
const whoLabel = (s: string | null | undefined): string => { const w = whoOf(s); return w ? WHO[w] : 'Not sure'; };
const track = (e: string, p: Record<string, unknown> = {}) => { try { capture(e, p as never); } catch { /* telemetry must never break the page */ } };

const waitText = (ms: number | null | undefined) => {
  const m = Math.max(0, Math.round((ms ?? 0) / 60000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const rs = (paise: number | null | undefined) => {
  const v = (paise ?? 0) / 100;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const score = (n: number | null | undefined) => (typeof n === 'number' ? n.toFixed(2) : '—');
const firstName = (n: string | null | undefined) => (n || 'This person').trim().split(/\s+/)[0];
const isTrue = (v: unknown) => v === true || v === 1;
const callWhen = (r: SafetyRow) => { const t = toMs(r.callAt); return t ? dateIST(t) : '—'; };

function announce(n: number) {
  try { sessionStorage.setItem(SAFETY_PENDING_KEY, String(n)); } catch { /* storage blocked: the nav badge just will not persist */ }
  window.dispatchEvent(new CustomEvent(SAFETY_PENDING_EVENT, { detail: n }));
}

function strikeLine(s: BanStrike): string {
  const day = safetyDay(toMs(s.callAt ?? s.at));
  const why = s.reasonText || (s.reason ? REASON_TITLE[s.reason as keyof typeof REASON_TITLE] ?? String(s.reason) : 'Strike');
  const by = s.source ?? s.by;
  return [day, why + (by ? ` (${by})` : ''), s.appealStatus === 'rejected' || s.appeal === 'rejected' ? 'appeal rejected' : ''].filter(Boolean).join(' · ');
}
function historyText(h: (HistoryItem | string)[] | undefined, name: string | null): string {
  const items = (h ?? []).map((x) => typeof x === 'string' ? x
    : [safetyDay(toMs(x.at)), x.reasonText || x.reason || x.kind || x.text, x.expiresAt ? `ends ${safetyDay(toMs(x.expiresAt))}` : ''].filter(Boolean).join(' '));
  return `${firstName(name)}’s history: ${items.length ? items.join(' · ') : 'no earlier strikes or appeals'}`;
}

/* ── the page ─────────────────────────────────────────────────────────── */
export default function CallSafety({ api = safetyAdminApi }: { api?: SafetyAdminApi }) {
  const [tab, setTab] = useState<SafetyTab>(() => {
    try { const t = new URLSearchParams(location.search).get('tab'); return TABS.some((x) => x.key === t) ? (t as SafetyTab) : 'review'; } catch { return 'review'; }
  });
  const [summary, setSummary] = useState<SafetySummary | null>(null);
  const [rows, setRows] = useState<SafetyRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [ban, setBan] = useState<{ uid: string; name: string; role: Who } | null>(null);
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  const loadSummary = useCallback(async () => {
    try { const s = await api.summary(); setSummary(s); announce(s.waiting ?? 0); } catch (e) { captureException(e, { where: 'hf_safety_summary' }); }
  }, [api]);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setRows(null); setError(null); setOpenId(null); setNext(null);
    try {
      const r = await api.queue(tab);
      if (my !== seq.current) return;
      setRows(r.items); setNext(r.next);
      setOpenId(tab === 'review' || tab === 'paused' ? r.items[0]?.id ?? null : null);
    } catch (e) {
      if (my !== seq.current) return;
      captureException(e, { where: 'hf_safety_queue', tab });
      setRows([]); setError(errMessage(e, 'Could not load this list. Please try again.'));
    }
  }, [api, tab]);

  useEffect(() => { void loadSummary(); track('hf_safety_admin_view', {}); }, [loadSummary]);
  useEffect(() => { void load(); track('hf_safety_admin_tab', { tab }); }, [load, tab]);

  const pick = (t: SafetyTab) => {
    setTab(t);
    try { const u = new URL(location.href); u.searchParams.set('tab', t); history.replaceState(null, '', u); } catch { /* url sync is a nicety */ }
  };
  const loadMore = async () => {
    if (!next || more) return;
    setMore(true);
    try { const r = await api.queue(tab, next); setRows((p) => [...(p ?? []), ...r.items]); setNext(r.next); }
    catch (e) { toast.error(errMessage(e, 'Could not load more.')); } finally { setMore(false); }
  };
  /** A row was decided: take it off the list, open the next one, refresh the numbers. */
  const done = (row: SafetyRow, message: string) => {
    toast.success(message);
    const rest = (rows ?? []).filter((x) => x.id !== row.id);
    setRows(rest); setOpenId(rest[0]?.id ?? null);
    void loadSummary();
  };

  const danger = tab === 'review' ? rows?.find((r) => r.kind === 'danger') : undefined;
  const expandable = tab === 'review' || tab === 'paused';

  // Consecutive collapsed rows share one card, like the artboard.
  const blocks: ReactNode[] = [];
  let group: SafetyRow[] = [];
  const flush = () => {
    if (!group.length) return;
    const g = group; group = [];
    blocks.push(
      <DesiCard key={`g${g[0].id}`} className="hsa-rows" tone="white">
        {g.map((r) => <CollapsedRow key={r.id} row={r} tab={tab} onOpen={expandable ? () => { setOpenId(r.id); track('hf_safety_admin_open', { kind: r.kind }); } : undefined} />)}
      </DesiCard>,
    );
  };
  for (const r of rows ?? []) {
    if (expandable && r.id === openId) {
      flush();
      blocks.push(
        r.kind === 'appeal' ? <AppealCard key={r.id} api={api} row={r} onDone={done} />
          : r.kind === 'paused' ? <PausedCard key={r.id} api={api} row={r} onBan={() => setBan({ uid: r.uid, name: r.name ?? 'this person', role: r.role })} onDone={done} />
          : <CaseCard key={r.id} api={api} row={r} onBan={() => setBan({ uid: r.uid, name: r.name ?? 'this person', role: r.role })} onDone={done} />,
      );
    } else group.push(r);
  }
  flush();

  return (
    <div className="hfa-stack">
      {danger && (
        <div className="hsa-strip" role="status">
          <span className="hsa-strip-tag">Aaj ki khabar</span>
          <span className="hsa-strip-text">
            Danger: {danger.role === 'fan' ? 'fan' : 'influencer'} {danger.name ?? 'unknown'}{danger.summary ? ` · ${danger.summary}` : ''} · {waitText(danger.waitingMs)} ago ·{' '}
            <button type="button" onClick={() => { setOpenId(danger.id); track('hf_safety_admin_danger_open', {}); }}>open it first</button>
          </span>
        </div>
      )}

      <DesiKpis>
        <DesiKpi tone="rani" label="calls checked today" value={summary ? summary.checkedToday : '—'} icon={<Phone />} />
        <DesiKpi tone="gold" label="flagged" value={summary ? summary.flaggedToday : '—'} icon={<Flag />} />
        <DesiKpi tone="lav" label="strikes given" value={summary ? summary.strikesToday : '—'} icon={<ShieldAlert />} />
        <DesiKpi tone="tea" label="waiting for you" value={summary ? summary.waiting : '—'} icon={<ListChecks />} />
        <DesiKpi tone="plum" label="oldest waiting" value={summary ? (summary.waiting ? waitText(summary.oldestWaitingMs) : 'None') : '—'} icon={<Clock />} />
      </DesiKpis>

      <div className="hfa-pills" role="tablist" aria-label="Call safety lists">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} aria-pressed={tab === t.key} className="hfa-pill" onClick={() => pick(t.key)}>
            {t.label}{t.key === 'review' && summary ? ` · ${summary.waiting}` : ''}
          </button>
        ))}
      </div>

      {error && <HBanner tone="error">{error} <button type="button" className="hfa-btn ghost" onClick={() => void load()}>Try again</button></HBanner>}
      {rows === null && <div aria-busy="true" className="hfa-stack">{[0, 1].map((i) => <div key={i} className="admin2-pulse h-40 rounded-xl bg-muted" />)}<span className="sr-only">Loading…</span></div>}
      {rows && !rows.length && !error && (
        <DesiCard tone="white"><DesiEmpty text={tab === 'review' ? 'Nothing waiting. Sab shaant hai.' : tab === 'strikes' ? 'No strikes yet.' : tab === 'paused' ? 'Nobody is paused or banned.' : 'No one has opened a call yet.'} /></DesiCard>
      )}
      {blocks}
      {next && <div><button type="button" className="hfa-btn ghost hsa-b" onClick={() => void loadMore()} disabled={more}>{more ? 'Loading…' : 'Load more'}</button></div>}

      {ban && <BanDialog api={api} target={ban} onClose={() => setBan(null)} onDone={(m) => { setBan(null); const r = rows?.find((x) => x.uid === ban.uid); if (r) done(r, m); else { toast.success(m); void load(); void loadSummary(); } }} />}
    </div>
  );
}

/* ── collapsed row ────────────────────────────────────────────────────── */
const KIND_ICON: Record<RowKind, { bg: string; fg: string; icon: ReactNode }> = {
  appeal: { bg: '#f1ebff', fg: '#6d4fd0', icon: <MessageSquareQuote size={22} aria-hidden="true" /> },
  fan_report: { bg: '#fff1d6', fg: '#b45309', icon: <Flag size={22} aria-hidden="true" /> },
  review: { bg: '#fff1d6', fg: '#b45309', icon: <Flag size={22} aria-hidden="true" /> },
  paused: { bg: '#ffe6ef', fg: '#d81b72', icon: <Pause size={22} aria-hidden="true" fill="currentColor" /> },
  danger: { bg: '#fde8e8', fg: '#c0262d', icon: <Siren size={22} aria-hidden="true" /> },
};
function rowTitle(r: SafetyRow, tab: SafetyTab): string {
  const n = r.name ?? 'Unknown';
  if (tab === 'access') return `${r.by ?? 'A reviewer'} ${r.action ?? 'opened a call'}`;
  if (tab === 'strikes') return `Strike · ${n}`;
  if (r.kind === 'appeal') return `Appeal · ${n}`;
  if (r.kind === 'fan_report') return `Fan report · ${n}`;
  if (r.kind === 'paused') return `Paused · ${n} · ${r.activeStrikes} strike${r.activeStrikes === 1 ? '' : 's'}`;
  if (r.kind === 'danger') return `Danger · ${n}`;
  return `${r.verdict ? VERDICT[r.verdict] : 'Review'} · ${n}`;
}
function CollapsedRow({ row, tab, onOpen }: { row: SafetyRow; tab: SafetyTab; onOpen?: () => void }) {
  const k = KIND_ICON[row.kind] ?? KIND_ICON.review;
  const sub = tab === 'access' ? [row.name, row.reason ?? row.summary].filter(Boolean).join(' · ')
    : tab === 'strikes' ? [row.verdict ? VERDICT[row.verdict] : '', row.summary, row.expiresAt ? `ends ${safetyDay(toMs(row.expiresAt))}` : ''].filter(Boolean).join(' · ')
    : row.summary ?? '';
  const age = tab === 'access' || tab === 'strikes' ? dateIST(toMs(row.at ?? row.callAt)) : waitText(row.waitingMs);
  const body = (
    <>
      <span className="hsa-ico" style={{ background: k.bg, color: k.fg }}>{k.icon}</span>
      <span className="mid"><span className="t">{rowTitle(row, tab)}</span><br /><span className="s">{sub}</span></span>
      {isTrue(row.womenLane) && <DesiChip tone="rani">Women-only call</DesiChip>}
      <span className="age">{age}</span>
      {onOpen && <span className="go" aria-hidden="true"><ChevronRight size={20} /></span>}
    </>
  );
  return onOpen
    ? <button type="button" className="hsa-row" onClick={onOpen} aria-label={`Open: ${rowTitle(row, tab)}`}>{body}</button>
    : <div className="hsa-row">{body}</div>;
}

/* ── shared pieces ────────────────────────────────────────────────────── */
function CaseHeader({ row, aiChip }: { row: SafetyRow; aiChip?: ReactNode }) {
  const n = row.name ?? 'Unknown';
  return (
    <div className="hsa-head">
      <DesiAvatar name={n} seed={row.uid} photo={row.photo} size={52} />
      <div className="hsa-who">
        <div className="hsa-name">{n} <DesiChip tone={row.role === 'influencer' ? 'tea' : 'lav'}>{WHO[row.role]}</DesiChip></div>
        <div className="hsa-sub">Call with {row.role === 'influencer' ? 'a fan' : 'an influencer'} · {callWhen(row)}{row.durationSec ? ` · ${Math.max(1, Math.round(row.durationSec / 60))} min` : ''}</div>
      </div>
      {row.verdict && <DesiChip tone="gold">{VERDICT[row.verdict]}</DesiChip>}
      {aiChip}
      {isTrue(row.womenLane) && <DesiChip tone="rani">Women-only call</DesiChip>}
      <DesiChip tone="rani">Strikes {row.activeStrikes} / 3</DesiChip>
      <span className="hsa-waited">waited {waitText(row.waitingMs)}</span>
    </div>
  );
}

function useDetail(api: SafetyAdminApi, id: string | null | undefined) {
  const [detail, setDetail] = useState<SafetyDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setDetail(null); setErr(null);
    api.detail(id).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) { captureException(e, { where: 'hf_safety_detail' }); setErr(errMessage(e, 'Could not load this call.')); } });
    return () => { live = false; };
  }, [api, id, n]);
  return { detail, err, retry: () => setN((x) => x + 1) };
}

/** Flagged line ±2 on bahi-khata paper, the 15 s clip, and the full transcript (asks for a typed reason; the server logs every open). */
function Evidence({ api, reviewId, detail, speaker, speakerScore }: { api: SafetyAdminApi; reviewId: string; detail: SafetyDetail; speaker: string | null; speakerScore: number | null }) {
  const [lines, setLines] = useState<TranscriptLine[]>(detail.lines ?? []);
  const [full, setFull] = useState(false);
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [clip, setClip] = useState<string | null>(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [err, setErr] = useState('');
  const clipRef = useRef<string | null>(null);
  useEffect(() => () => { if (clipRef.current) URL.revokeObjectURL(clipRef.current); }, []);
  const audioUntil = toMs(detail.audioUntil);

  const play = async () => {
    if (clip) return;
    setClipBusy(true); setErr('');
    try { const u = await api.clip(reviewId); clipRef.current = u; setClip(u); track('hf_safety_admin_clip_play', {}); }
    catch (e) { setErr(errMessage(e, 'Could not load the clip. It may have been deleted.')); } finally { setClipBusy(false); }
  };
  const openFull = async () => {
    if (why.trim().length < 8) { setErr('Write why you need the full call (a few words).'); return; }
    setBusy(true); setErr('');
    try { setLines(await api.transcript(reviewId, why.trim())); setFull(true); setAsking(false); track('hf_safety_admin_transcript_open', { reason_len: why.trim().length }); }
    catch (e) { setErr(errMessage(e, 'Could not open the full transcript.')); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="hsa-kicker">{full ? 'Full transcript · this open is logged' : 'Flagged line · 2 lines each side'}</div>
      <div className="hsa-bahi" tabIndex={0} aria-label="Call lines">
        {lines.length ? lines.map((l, i) => (
          <div key={i} className={l.flagged ? 'hit' : undefined}><b>{l.t} {whoLabel(l.speaker)}</b> · {l.text}</div>
        )) : <div className="gap">No lines were kept for this call.</div>}
      </div>
      <div className="hsa-line">
        <button type="button" className="hfa-btn ghost hsa-b" onClick={() => void play()} disabled={clipBusy || (!audioUntil && !clip)}>
          <Play size={18} aria-hidden="true" />{clipBusy ? 'Loading…' : 'Play clip · 15 s'}
        </button>
        {!full && <button type="button" className="hfa-btn ghost hsa-b" onClick={() => setAsking((a) => !a)} aria-expanded={asking}>Full transcript (reason needed)</button>}
        <span>
          {whoOf(speaker) ? <>Said by <b>{whoLabel(speaker)}</b>{speakerScore != null ? ` (AI ${score(speakerScore)} sure)` : ''}</> : 'Not sure who said it'}
          {' · '}{audioUntil ? `audio kept till ${safetyDay(audioUntil)}` : 'audio already deleted'}
        </span>
      </div>
      {clip && <audio className="hsa-audio" src={clip} controls autoPlay preload="auto" aria-label="Flagged clip" />}
      {asking && (
        <div className="hsa-reasonbox">
          <label htmlFor={`why-${reviewId}`} className="hsa-lab">Why do you need the full call? (saved with your name)</label>
          <textarea id={`why-${reviewId}`} className="hsa-field" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} />
          <button type="button" className="hfa-btn gold hsa-b" disabled={busy} onClick={() => void openFull()}>{busy ? 'Opening…' : 'Open full transcript'}</button>
        </div>
      )}
      {err && <div className="hsa-err" role="alert">{err}</div>}
      <div className="hsa-muted">{historyText(detail.history, detail.name)}</div>
    </>
  );
}

/* ── expanded: a call to decide (review, danger, fan report) ──────────── */
function CaseCard({ api, row, onBan, onDone }: { api: SafetyAdminApi; row: SafetyRow; onBan: () => void; onDone: (r: SafetyRow, m: string) => void }) {
  const { detail, err, retry } = useDetail(api, row.id);
  const spk = whoOf(row.speaker);
  const sure = spk !== null && (row.speakerScore ?? 0) >= 0.9;
  const [target, setTarget] = useState<Who | null>(spk);
  const [reason, setReason] = useState<string>(STRIKE_REASONS.some((r) => r.key === row.verdict) ? (row.verdict as string) : STRIKE_REASONS[0].key);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(t); }, [armed]);

  const decide = async (action: 'confirm_strike' | 'dismiss' | 'pause') => {
    setBusy(true); setMsg('');
    try {
      await api.decide(row.id, { action, target: target ?? row.role, reason: action === 'dismiss' ? 'not_a_problem' : reason, note: note.trim() || undefined });
      track('hf_safety_admin_decision', { action, target, reason, kind: row.kind, verdict: row.verdict, score: row.score, waited_h: Math.round((row.waitingMs ?? 0) / 3600000) });
      onDone(row, action === 'confirm_strike' ? 'Strike given. They are told on WhatsApp.' : action === 'pause' ? 'Account paused.' : 'Marked as not a problem.');
    } catch (e) {
      setMsg(errMessage(e, 'That did not go through. Please try again.')); setBusy(false);
    }
  };
  const aiChip = row.kind === 'fan_report'
    ? <DesiChip tone="lav">AI said {row.verdict ? VERDICT[row.verdict].toLowerCase() : 'clean'} ({score(row.score)})</DesiChip>
    : <DesiChip tone="lav">AI {score(row.score)} · {(row.score ?? 0) >= 0.9 ? 'very sure' : 'not sure'}</DesiChip>;

  return (
    <DesiCard tone="gold" corner="yellow" className="hsa-case" id={`case-${row.id}`}>
      <CaseHeader row={row} aiChip={aiChip} />
      <div className="hsa-grid">
        <div className="hsa-left">
          {err ? <HBanner tone="error">{err} <button type="button" className="hfa-btn ghost" onClick={retry}>Try again</button></HBanner>
            : !detail ? <div className="admin2-pulse h-40 rounded-xl bg-muted" aria-busy="true" />
            : <Evidence api={api} reviewId={row.id} detail={detail} speaker={row.speaker} speakerScore={row.speakerScore} />}
        </div>
        <div className="hsa-right">
          {!sure && (
            <>
              <span className="hsa-lab" id={`tg-${row.id}`}>Who said it?{target === null ? ' Not sure. Pick one.' : ''}</span>
              <div className="hfa-pills" role="group" aria-labelledby={`tg-${row.id}`}>
                {(['fan', 'influencer'] as Who[]).map((w) => <button key={w} type="button" className="hfa-pill" aria-pressed={target === w} onClick={() => setTarget(w)}>{WHO[w]}</button>)}
              </div>
            </>
          )}
          <label htmlFor={`reason-${row.id}`} className="hsa-lab">Reason (sent on WhatsApp)</label>
          <select id={`reason-${row.id}`} className="hsa-field" value={reason} onChange={(e) => setReason(e.target.value)}>
            {STRIKE_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <label htmlFor={`note-${row.id}`} className="hsa-lab">Note (optional)</label>
          <textarea id={`note-${row.id}`} className="hsa-field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Please take all payments through the app." />
          <button type="button" className="hfa-btn gold hsa-b wide" disabled={busy || target === null} onClick={() => void decide('confirm_strike')}>{busy ? 'Please wait…' : 'Confirm strike'}</button>
          <div className="hsa-trio">
            <button type="button" className="hfa-btn ghost hsa-b" disabled={busy} onClick={() => void decide('dismiss')}>Not a problem</button>
            <button type="button" className={`hfa-btn hsa-b ${armed ? 'armed' : 'amber'}`} disabled={busy || target === null} onClick={() => (armed ? void decide('pause') : setArmed(true))}>{armed ? 'Tap again to pause' : 'Pause now'}</button>
            <button type="button" className="hfa-btn red hsa-b" disabled={busy} onClick={onBan}>Ban…</button>
          </div>
          {msg && <div className="hsa-err" role="alert">{msg}</div>}
        </div>
      </div>
    </DesiCard>
  );
}

/* ── expanded: an appeal ──────────────────────────────────────────────── */
function AppealCard({ api, row, onDone }: { api: SafetyAdminApi; row: SafetyRow; onDone: (r: SafetyRow, m: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState(false);
  const { detail, err } = useDetail(api, show ? row.reviewId : null);
  const decide = async (decision: 'accept' | 'reject') => {
    setBusy(true); setMsg('');
    try {
      await api.decideAppeal(row.id, decision, note.trim() || undefined);
      track('hf_safety_admin_appeal_decision', { decision, waited_h: Math.round((row.waitingMs ?? 0) / 3600000) });
      onDone(row, decision === 'accept' ? 'Appeal accepted. The strike is removed.' : 'Appeal rejected. They are told on WhatsApp.');
    } catch (e) { setMsg(errMessage(e, 'That did not go through. Please try again.')); setBusy(false); }
  };
  return (
    <DesiCard tone="lav" corner="hibiscus" id={`appeal-${row.id}`}>
      <CaseHeader row={row} aiChip={<DesiChip tone="lav">Appeal</DesiChip>} />
      <div className="hsa-grid">
        <div className="hsa-left">
          <div className="hsa-kicker">What {firstName(row.name)} says</div>
          <div className="hsa-bahi"><div>{row.summary || 'No message was written.'}</div></div>
          {row.reviewId && !show && <div><button type="button" className="hfa-btn ghost hsa-b" onClick={() => setShow(true)}>Show the call</button></div>}
          {show && err && <div className="hsa-err" role="alert">{err}</div>}
          {show && !err && !detail && <div className="admin2-pulse h-32 rounded-xl bg-muted" aria-busy="true" />}
          {show && detail && row.reviewId && <Evidence api={api} reviewId={row.reviewId} detail={detail} speaker={detail.speaker} speakerScore={detail.speakerScore} />}
        </div>
        <div className="hsa-right">
          <label htmlFor={`an-${row.id}`} className="hsa-lab">Note to them (optional)</label>
          <textarea id={`an-${row.id}`} className="hsa-field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <button type="button" className="hfa-btn gold hsa-b wide" disabled={busy} onClick={() => void decide('accept')}>{busy ? 'Please wait…' : 'Accept · remove the strike'}</button>
          <button type="button" className="hfa-btn ghost hsa-b wide" disabled={busy} onClick={() => void decide('reject')}>Reject appeal</button>
          {msg && <div className="hsa-err" role="alert">{msg}</div>}
        </div>
      </div>
    </DesiCard>
  );
}

/* ── expanded: a paused account (restore with the strikes to take back, or ban) ── */
function PausedCard({ api, row, onBan, onDone }: { api: SafetyAdminApi; row: SafetyRow; onBan: () => void; onDone: (r: SafetyRow, m: string) => void }) {
  const [pv, setPv] = useState<BanPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    api.banPreview(row.uid).then((p) => { if (live) setPv(p); }).catch((e) => { if (live) setErr(errMessage(e, 'Could not load this account.')); });
    return () => { live = false; };
  }, [api, row.uid]);
  const toggle = (id: string) => setPick((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const restore = async () => {
    setBusy(true); setMsg('');
    try {
      await api.restore(row.uid, [...pick]);
      track('hf_safety_admin_restore', { removed: pick.size });
      onDone(row, 'Account restored.');
    } catch (e) { setMsg(errMessage(e, 'Could not restore. Please try again.')); setBusy(false); }
  };
  return (
    <DesiCard tone="rani" corner="hibiscus" id={`paused-${row.id}`}>
      <div className="hsa-head">
        <DesiAvatar name={row.name} seed={row.uid} photo={row.photo} size={52} />
        <div className="hsa-who">
          <div className="hsa-name">{row.name ?? 'Unknown'} <DesiChip tone={row.role === 'influencer' ? 'tea' : 'lav'}>{WHO[row.role]}</DesiChip></div>
          <div className="hsa-sub">{row.summary ?? 'Paused after 3 strikes'}</div>
        </div>
        <DesiChip tone="rani">Strikes {row.activeStrikes} / 3</DesiChip>
        <span className="hsa-waited">waiting {waitText(row.waitingMs)}</span>
      </div>
      <div className="hsa-grid">
        <div className="hsa-left">
          <div className="hsa-kicker">Take back strikes, then restore</div>
          {err ? <HBanner tone="error">{err}</HBanner> : !pv ? <div className="admin2-pulse h-24 rounded-xl bg-muted" aria-busy="true" />
            : pv.strikes.length ? (
              <div className="hsa-checks" role="group" aria-label="Strikes to take back">
                {pv.strikes.map((s, i) => (
                  <label key={s.id ?? i} className="hsa-check">
                    <input type="checkbox" disabled={!s.id} checked={!!s.id && pick.has(s.id)} onChange={() => s.id && toggle(s.id)} />
                    <span>{strikeLine(s)}</span>
                  </label>
                ))}
              </div>
            ) : <div className="hsa-muted">No active strikes are listed.</div>}
          {pv && pv.heldPaise > 0 && <div className="hsa-muted">{rs(pv.heldPaise)} of earnings is held until this review ends.</div>}
        </div>
        <div className="hsa-right">
          <button type="button" className="hfa-btn gold hsa-b wide" disabled={busy || pick.size === 0} onClick={() => void restore()}>{busy ? 'Please wait…' : 'Restore account'}</button>
          <div className="hsa-muted">Tick at least one strike to take back. Restoring with 3 active strikes would pause it again.</div>
          <button type="button" className="hfa-btn red hsa-b wide" disabled={busy} onClick={onBan}>Ban…</button>
          {msg && <div className="hsa-err" role="alert">{msg}</div>}
        </div>
      </div>
    </DesiCard>
  );
}

/* ── ban confirm (artboard AdminBan) ──────────────────────────────────── */
function BanDialog({ api, target, onClose, onDone }: { api: SafetyAdminApi; target: { uid: string; name: string; role: Who }; onClose: () => void; onDone: (message: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pv, setPv] = useState<BanPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
    track('hf_safety_admin_ban_open', { role: target.role });
    let live = true;
    api.banPreview(target.uid).then((p) => { if (live) setPv(p); }).catch((e) => { if (live) setErr(errMessage(e, 'Could not load the money details.')); });
    return () => { live = false; };
  }, [api, target.uid, target.role]);

  const refunds = pv?.refunds ?? [];
  const money = !!pv && (target.role === 'influencer' || pv.heldPaise > 0 || refunds.length > 0);
  const ban = async () => {
    if (reason.trim().length < 8) { setMsg('Write the reason, a few words at least. It is sent on WhatsApp.'); return; }
    setBusy(true); setMsg('');
    try {
      await api.ban(target.uid, reason.trim());
      track('hf_safety_admin_ban', { role: target.role, refunds: refunds.length, refund_paise: pv?.refundTotalPaise ?? 0, held_paise: pv?.heldPaise ?? 0 });
      onDone(`${firstName(target.name)} is banned.${refunds.length ? ' Fans are being refunded.' : ''}`);
    } catch (e) { setMsg(errMessage(e, 'Could not ban. Please try again.')); setBusy(false); }
  };
  const pos = target.role === 'influencer' ? 'Their reel and profile disappear, and this WhatsApp number can’t sign up again.' : 'Their account is closed for good, and this WhatsApp number can’t sign up again.';
  return (
    <dialog ref={ref} className="hsa-dlg" aria-labelledby="ban-t" onClose={onClose} onCancel={(e) => { if (busy) e.preventDefault(); }}>
      <section className="hsa-sheet">
        <span className="fl" style={{ right: -14, top: -16 }}><Marigold size={80} /></span>
        <span className="fl" style={{ right: 58, top: 8 }}><Marigold size={40} tone={1} /></span>
        <div className="hsa-perm">PERMANENT</div>
        <h2 id="ban-t">Ban {target.name}?</h2>
        <p>{pos}</p>
        {err && <HBanner tone="error">{err}</HBanner>}
        {!pv && !err && <div className="admin2-pulse h-28 rounded-xl bg-muted" aria-busy="true" />}
        {pv && (
          <div className="hsa-box">
            <b className="h">Active strikes</b>
            {pv.strikes.length ? pv.strikes.map((s, i) => <span key={i}>{strikeLine(s)}</span>) : <span>No active strikes.</span>}
          </div>
        )}
        {money && pv && (
          <div className="hsa-hisaab">
            <div className="zig" />
            <span className="pu l" aria-hidden="true" /><span className="pu r" aria-hidden="true" />
            <div className="in">
              <div className="hsa-kicker">Hisaab · held money</div>
              <div className="l"><span>Earnings held</span><b>{rs(pv.heldPaise)}</b></div>
              <div className="l"><span>Refund to {refunds.length} fan{refunds.length === 1 ? '' : 's'} on flagged calls</span><b style={{ color: 'var(--a-bad)' }}>− {rs(pv.refundTotalPaise)}</b></div>
              <div className="dash" />
              <div className="l"><span>Paid to their UPI after review</span><b style={{ fontSize: 20, color: 'var(--a-plum)' }}>{rs(pv.payoutPaise)}</b></div>
            </div>
          </div>
        )}
        <label htmlFor="br" className="hsa-lab">Reason (required, sent on WhatsApp)</label>
        <textarea id="br" className="hsa-field" style={{ marginTop: -6 }} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} placeholder="Repeated selling on calls after two warnings." />
        {msg && <div className="hsa-err" role="alert">{msg}</div>}
        <div className="hsa-acts">
          <button type="button" className="hfa-btn ghost" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
          <button type="button" className="hfa-btn red" onClick={() => void ban()} disabled={busy || !pv}>{busy ? 'Please wait…' : refunds.length ? 'Ban and refund fans' : 'Ban'}</button>
        </div>
      </section>
    </dialog>
  );
}
