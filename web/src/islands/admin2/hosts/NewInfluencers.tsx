/* [HF-INTRO-B2] "New influencers": review the intro-video applications (Specs/HF-INTRO-VIDEO-1.md D12/D13, API doc section 2).
 * Rows slide open to the vertical video + details; Approve (with a confirm) or Reject with ready-made reasons. Admin guard comes from Admin2.astro. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BadgeCheck, CalendarDays, Check, ChevronDown, ExternalLink, IdCard, MessageCircle, RefreshCw, Users, Video, Volume2 } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { introAdminApi, type CallOption, type DecisionResult, type IntroDetail, type IntroListItem, type IntroStatus, type RejectReason } from '../../../lib/hfIntroAdminApi';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import { dateIST } from '../consultants/kit';
import { DesiAvatar, DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis, Lotus, Marigold } from '../desi';
import { HBanner } from './hostsKit';
import '../../../styles/hf-admin-intro.css';

const TABS: { key: IntroStatus; label: string }[] = [
  { key: 'submitted', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];
const LANGS: Record<string, string> = { hi: 'Hindi', en: 'English', mr: 'Marathi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', gu: 'Gujarati', pa: 'Punjabi', kn: 'Kannada', ml: 'Malayalam' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PLATFORMS: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };
const W2W = 'women_to_women';
const PENDING_EVENT = 'hf-intro-admin:pending';
const PENDING_KEY = 'admin2:hf-intro-pending';

/** Dev-only mock (page passes mock): loaded lazily so its sample data never lands in the production chunk. */
const loadMock = () => import('./newInfluencersMock').then((m) => m.mockIntroApi);
const lazyMockApi: typeof introAdminApi = {
  list: (...a) => loadMock().then((m) => m.list(...(a as [IntroStatus]))),
  detail: (id) => loadMock().then((m) => m.detail(id)),
  approve: (id) => loadMock().then((m) => m.approve(id)),
  reject: (id, r, n) => loadMock().then((m) => m.reject(id, r, n)),
};

const langName = (c: string | null | undefined) => (c ? LANGS[c] ?? c : '—');
const optionLabel = (o: CallOption | undefined) => (o === 'B' ? 'Bookings + live' : o === 'A' ? 'Bookings only' : 'Not chosen');
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const rupees = (n: number | null | undefined) => (typeof n === 'number' ? `₹${n}/min` : '—');

function announcePending(n: number) {
  try { sessionStorage.setItem(PENDING_KEY, String(n)); } catch { /* storage blocked: the badge just will not persist */ }
  window.dispatchEvent(new CustomEvent(PENDING_EVENT, { detail: n }));
}

function calendarSummary(c: IntroDetail['calendar']): string[] {
  if (!c || c.empty || !c.weekly?.length) return [];
  return c.weekly
    .filter((d) => d.ranges?.length)
    .sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7))
    .map((d) => `${DAYS[d.weekday % 7] ?? d.weekday}  ${d.ranges.map((r) => `${hhmm(r.startMin)}–${hhmm(r.endMin)}`).join(', ')}`);
}

/** Approximate preview of the WhatsApp the person gets. The server builds the real text from the same reason texts + note. */
function whatsappPreview(name: string | null, reasons: RejectReason[], note: string): string {
  const first = (name || 'there').trim().split(/\s+/)[0];
  const lines = [`Hi ${first}, thank you for sending your intro. We could not approve it yet:`, ...reasons.map((r) => `• ${r.text}`)];
  if (note.trim()) lines.push('', `Note from our team: ${note.trim()}`);
  lines.push('', 'Please fix this and send it again.');
  return lines.join('\n');
}

export default function NewInfluencers({ mock = false }: { mock?: boolean }) {
  const api = import.meta.env.MODE === 'development' && mock ? lazyMockApi : introAdminApi;
  const [tab, setTab] = useState<IntroStatus>('submitted');
  const [items, setItems] = useState<IntroListItem[] | null>(null);
  const [reasons, setReasons] = useState<RejectReason[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(null); setError(null); setOpenId(null);
    try {
      const r = await api.list(tab, (c) => { setItems(c.items); setReasons((prev) => (c.rejectReasons.length ? c.rejectReasons : prev)); });
      setItems(r.items);
      if (r.rejectReasons.length) setReasons(r.rejectReasons);
    } catch (err) {
      captureException(err, { where: 'hf_intro_admin_list', tab });
      setItems([]); setError(errMessage(err, 'Could not load the applications. Please try again.'));
    }
  }, [api, tab]);
  useEffect(() => { void load(); }, [load]);
  // Dev-only (mock + ?open=1 / ?reject=1): lets the screenshot script open the first row without clicking.
  const dev = import.meta.env.MODE === 'development' && mock && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  useEffect(() => { if (dev?.get('open') || dev?.get('reject')) { if (items?.length && !openId) setOpenId(items[0].id); } }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (tab === 'submitted' && items && !error) announcePending(items.length); }, [tab, items, error]);

  const done = (item: IntroListItem, decision: 'approve' | 'reject', reasonsN: number, res: DecisionResult) => {
    capture('hf_admin_review_ui', { decision, reasons_n: reasonsN });
    const name = item.name || 'The person';
    if (decision === 'approve') {
      toast.success(res.notified ? 'Approved — WhatsApp sent' : 'Approved — WhatsApp not sent', {
        description: res.notified ? `${name} is live and has been told.` : `${name} is live. ${res.notifyReason ? `WhatsApp: ${res.notifyReason}` : 'The WhatsApp message did not go out.'}`,
      });
    } else {
      toast.success(res.notified ? 'Sent back — WhatsApp sent' : 'Sent back — WhatsApp not sent', {
        description: res.notified ? `${name} will fix it and send again.` : `${name} was marked rejected. ${res.notifyReason ? `WhatsApp: ${res.notifyReason}` : 'The WhatsApp message did not go out.'}`,
      });
    }
    setOpenId(null);
    setItems((cur) => (cur ? cur.filter((i) => i.id !== item.id) : cur));
  };

  const stats = useMemo(() => ({
    w2w: items?.filter((i) => i.categories.some((c) => c.id === W2W)).length ?? 0,
    live: items?.filter((i) => i.callOption === 'B').length ?? 0,
  }), [items]);
  const tabLabel = TABS.find((t) => t.key === tab)?.label ?? '';

  return <div className="hfa-stack hfi">
    <div className="hfi-bar">
      <div role="tablist" aria-label="Application status" className="hfa-pills">
        {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="hfa-pill hfi-pill" onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      <button type="button" className="hfa-btn ghost" onClick={() => void load()} disabled={items === null}><RefreshCw size={18} aria-hidden="true" />Refresh</button>
    </div>

    <DesiKpis>
      <DesiKpi tone="plum" label={tabLabel} value={items ? items.length : '…'} sub="applications in this list" icon={<Video aria-hidden="true" />} />
      <DesiKpi tone="rani" label="Women-to-Women" value={items ? stats.w2w : '…'} sub="in this list" icon={<Users aria-hidden="true" />} />
      <DesiKpi tone="tea" label="Bookings + live" value={items ? stats.live : '…'} sub="chose to take live calls" icon={<Volume2 aria-hidden="true" />} />
    </DesiKpis>

    {error && <HBanner tone="error">{error}</HBanner>}
    {items === null && <DesiCard tone="cream" pattern="dots"><p role="status" className="hfa-note">Loading applications…</p></DesiCard>}
    {items?.length === 0 && !error && <DesiCard tone="lav" corner="marigold"><DesiEmpty text={tab === 'submitted' ? 'No new influencers waiting. Chai peeke aaram karo.' : `Nothing in ${tabLabel.toLowerCase()} yet.`} /></DesiCard>}

    <div className="hfi-list">
      {items?.map((item) => <Row key={item.id} api={api} item={item} reasons={reasons} open={openId === item.id} onToggle={() => setOpenId((cur) => (cur === item.id ? null : item.id))} onDone={done} />)}
    </div>
  </div>;
}

function Row({ api, item, reasons, open, onToggle, onDone }: {
  api: typeof introAdminApi; item: IntroListItem; reasons: RejectReason[]; open: boolean; onToggle: () => void;
  onDone: (item: IntroListItem, decision: 'approve' | 'reject', reasonsN: number, res: DecisionResult) => void;
}) {
  const w2w = item.categories.some((c) => c.id === W2W);
  const shown = item.categories.slice(0, 4);
  const more = item.categories.length - shown.length;
  const panelId = `hfi-panel-${item.id}`;
  const platforms = item.socialPlatforms?.length ? item.socialPlatforms : [];
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (open) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [open]);

  return <article ref={ref} className={`hfi-row ${w2w ? 'is-w2w' : ''} ${open ? 'is-open' : ''}`}>
    <span className="hfa-corner hfi-flower" aria-hidden="true"><Marigold size={96} /></span>
    <button type="button" className="hfi-head" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
      <DesiAvatar name={item.name} seed={item.uid} photo={item.photoUrl} size={72} />
      <span className="hfi-main">
        <span className="hfi-name">{item.name || 'No name yet'}</span>
        <span className="hfi-chips">
          {shown.map((c) => <DesiChip key={c.id} tone={c.id === W2W ? 'rani' : 'lav'}>{c.label}</DesiChip>)}
          {more > 0 && <DesiChip tone="grey">+{more} more</DesiChip>}
        </span>
        <span className="hfi-meta">
          <span>{langName(item.lang)}</span><span aria-hidden="true">·</span><span>{rupees(item.ratePerMin)}</span><span aria-hidden="true">·</span>
          <span>{optionLabel(item.callOption)}</span><span aria-hidden="true">·</span><span>{item.submittedAt ? dateIST(item.submittedAt) : 'not submitted'}</span>
        </span>
      </span>
      <span className="hfi-badges">
        {w2w && <DesiChip tone="rani"><span aria-hidden="true">♀</span>Women-to-Women</DesiChip>}
        {item.aadhaar.status === 'verified' && <DesiChip tone="tea"><IdCard size={16} aria-hidden="true" />Aadhaar ✓</DesiChip>}
        {item.aadhaar.female && <DesiChip tone="tea">Female ✓</DesiChip>}
        {platforms.length ? platforms.map((p) => <DesiChip key={p} tone="gold"><BadgeCheck size={16} aria-hidden="true" />{PLATFORMS[p] ?? p} ✓</DesiChip>)
          : item.hasSocials && <DesiChip tone="gold"><BadgeCheck size={16} aria-hidden="true" />Social ✓</DesiChip>}
      </span>
      <ChevronDown className="hfi-chev" size={28} aria-hidden="true" />
    </button>
    {open && <Detail api={api} item={item} reasons={reasons} panelId={panelId} onDone={onDone} />}
  </article>;
}

function Detail({ api, item, reasons: listReasons, panelId, onDone }: {
  api: typeof introAdminApi; item: IntroListItem; reasons: RejectReason[]; panelId: string;
  onDone: (item: IntroListItem, decision: 'approve' | 'reject', reasonsN: number, res: DecisionResult) => void;
}) {
  const [d, setD] = useState<IntroDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const devReject = import.meta.env.MODE === 'development' && typeof location !== 'undefined' && !!new URLSearchParams(location.search).get('reject');
  const [mode, setMode] = useState<'view' | 'confirm' | 'reject'>(devReject ? 'reject' : 'view');
  const [picked, setPicked] = useState<string[]>(devReject ? ['video_dark', 'audio_unclear'] : []);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let live = true;
    setD(null); setLoadErr(null);
    api.detail(item.id).then((r) => { if (live) setD(r); }).catch((e) => {
      captureException(e, { where: 'hf_intro_admin_detail', id: item.id });
      if (live) setLoadErr(errMessage(e, 'Could not load this application.'));
    });
    return () => { live = false; };
  }, [api, item.id]);

  const options = d?.rejectReasons?.length ? d.rejectReasons : listReasons;
  const pickedReasons = options.filter((r) => picked.includes(r.code));
  const needsNote = picked.includes('other');
  const canSend = picked.length > 0 && (!needsNote || note.trim().length > 2);
  const pending = item.status === 'submitted';
  const name = d?.host.name || item.name;

  const run = async (decision: 'approve' | 'reject') => {
    setBusy(true); setErr(null);
    try {
      const res = decision === 'approve' ? await api.approve(item.id) : await api.reject(item.id, picked, note.trim());
      onDone(item, decision, decision === 'reject' ? picked.length : 0, res);
    } catch (e) {
      captureException(e, { where: 'hf_intro_admin_decision', decision, id: item.id });
      const miss = (e as { body?: { missing?: string[] } })?.body?.missing;
      setErr(`${errMessage(e, 'That did not work. Please try again.')}${miss?.length ? ` Missing: ${miss.join(', ')}.` : ''}`);
      setBusy(false);
    }
  };
  const toggle = (code: string) => setPicked((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]));
  const sound = () => { const v = video.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); if (!v.muted) void v.play().catch(() => { /* browser refused: the controls still work */ }); };

  if (loadErr) return <div id={panelId} className="hfi-panel"><HBanner tone="error">{loadErr}</HBanner></div>;
  if (!d) return <div id={panelId} className="hfi-panel"><p role="status" className="hfa-note">Loading the video and details…</p></div>;

  const cal = calendarSummary(d.calendar);
  const prev = (d.history ?? []).filter((h) => h.id !== d.application.id);
  const topic = d.application.topic ?? d.video?.topic;
  return <div id={panelId} className="hfi-panel" role="region" aria-label={`Details for ${name ?? 'applicant'}`}>
    <div className="hfi-grid">
      <div className="hfi-videocol">
        {d.video?.videoUrl ? <div className="hfi-video">
          <video ref={video} src={d.video.videoUrl} poster={d.video.posterUrl ?? undefined} autoPlay muted loop playsInline controls preload="auto" aria-label={`Intro video from ${name ?? 'applicant'}`} />
          {muted && <button type="button" className="hfi-sound" onClick={sound}><Volume2 size={20} aria-hidden="true" />Tap for sound</button>}
        </div> : d.video?.deletedAt ? <div className="hfi-gone" role="note">
          {/* [HF-INTRO-DELETE-1] artboard AdminRejected: lotus + "Video deleted" instead of the player */}
          <Lotus size={68} />
          <strong>Video deleted</strong>
          <span>Removed from storage on {dateIST(d.video.deletedAt)}, when it was {d.video.deletedReason === 'replaced' ? 'replaced by a newer one' : d.video.deletedReason === 'draft_expired' ? 'never sent' : 'rejected'}</span>
        </div> : <div className="hfi-video hfi-novideo"><Video size={40} aria-hidden="true" /><p>No video on this application.</p></div>}
        {d.video?.durationMs ? <p className="hfa-note hfi-center">{Math.round(d.video.durationMs / 1000)} seconds{d.video.width && d.video.height ? ` · ${d.video.width}×${d.video.height}` : ''}</p> : null}
      </div>

      <div className="hfi-info">
        <h3 className="hfi-h">{name || 'No name yet'}</h3>
        <p className="hfi-desc">{d.host.description || <span className="hfa-note">No description written.</span>}</p>
        <dl className="hfi-dl">
          <dt>Categories</dt><dd className="hfi-chips">{(d.application.categories ?? item.categories).map((c) => <DesiChip key={c.id} tone={c.id === W2W ? 'rani' : 'lav'}>{c.label}</DesiChip>)}</dd>
          <dt>Language</dt><dd>{langName(d.application.lang ?? item.lang)}</dd>
          <dt>Topic</dt><dd>{topic && topic !== 'general' ? topic.replace(/_/g, ' ') : 'General'}</dd>
          <dt>Rate</dt><dd>{rupees(d.host.ratePerMin)}</dd>
          <dt>Call option</dt><dd>{optionLabel(d.application.callOption ?? item.callOption)}</dd>
          <dt>Time slots</dt>
          <dd>{cal.length ? <ul className="hfi-cal">{cal.map((l) => <li key={l}><CalendarDays size={16} aria-hidden="true" />{l}</li>)}</ul> : <span className="hfi-warn">No weekly slots set{d.calendar?.timezone ? ` (${d.calendar.timezone})` : ''}</span>}</dd>
          <dt>Socials</dt>
          <dd>{d.socials.length ? <ul className="hfi-links">{d.socials.map((s) => <li key={s.platform + s.handle}><a href={s.url} target="_blank" rel="noopener noreferrer"><BadgeCheck size={18} aria-hidden="true" />{PLATFORMS[s.platform] ?? s.platform} · {s.handle}<ExternalLink size={16} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>{typeof s.followers === 'number' && <span className="hfa-note"> {s.followers.toLocaleString('en-IN')} followers</span>}</li>)}</ul> : <span className="hfi-warn">No verified social account</span>}</dd>
          <dt>Aadhaar</dt><dd><span className="hfi-ticks">
            <Tick on={d.aadhaar.done}>{d.aadhaar.done ? 'Aadhaar verified' : 'Aadhaar not done'}</Tick>
            {d.aadhaar.done && <Tick on={d.aadhaar.female}>{d.aadhaar.gender === 'F' || d.aadhaar.female ? 'Female' : d.aadhaar.gender === 'M' ? 'Male' : d.aadhaar.gender ? `Gender ${d.aadhaar.gender}` : 'Gender unknown'}</Tick>}
          </span></dd>
          <dt>WhatsApp</dt><dd><Tick on={d.whatsappVerified}>{d.whatsappVerified ? 'WhatsApp number verified' : 'WhatsApp not verified'}</Tick></dd>
          <dt>Account created</dt><dd>{d.host.createdAt ? dateIST(d.host.createdAt) : '—'}{d.application.submittedAt ? <span className="hfa-note"> · submitted {dateIST(d.application.submittedAt)}</span> : null}</dd>
          {d.womenToWomen && <><dt>Channel</dt><dd><DesiChip tone="rani"><span aria-hidden="true">♀</span>Women-to-Women (female Aadhaar)</DesiChip></dd></>}
          {prev.length > 0 && <><dt>Earlier tries</dt><dd>{prev.length} earlier application{prev.length > 1 ? 's' : ''}{prev[0]?.rejectReasons?.length ? ` · last: ${prev[0].rejectReasons.map((r) => r.text).join('; ')}` : ''}</dd></>}
          {!pending && d.application.rejectReasons?.length ? <><dt>Rejected for</dt><dd><ul className="hfi-cal">{d.application.rejectReasons.map((r) => <li key={r.code}>{r.text}</li>)}</ul>{d.application.rejectNote && <p className="hfa-note">Note: {d.application.rejectNote}</p>}</dd></> : null}
        </dl>

        {d.video?.deletedAt && <p className="hfi-gone-note">The details and reasons are kept for the record. The video and its thumbnail are gone. If she records again, the new video shows under <b>Pending</b>.</p>}

        {err && <HBanner tone="error">{err}</HBanner>}

        {pending && mode === 'view' && <div className="hfh-acts hfi-acts">
          <button type="button" className="hfa-btn tea hfi-big" onClick={() => { setErr(null); setMode('confirm'); }}><Check size={20} aria-hidden="true" />Approve</button>
          <button type="button" className="hfa-btn danger hfi-big" onClick={() => { setErr(null); setMode('reject'); }}>Reject…</button>
        </div>}

        {pending && mode === 'confirm' && <div className="hfi-confirm" role="alertdialog" aria-labelledby={`${panelId}-c`}>
          <p id={`${panelId}-c`}><b>Make {name || 'this person'} live?</b> They appear in the reels feed and get a WhatsApp saying they are live.</p>
          <div className="hfh-acts">
            <button type="button" className="hfa-btn tea hfi-big" disabled={busy} onClick={() => void run('approve')} autoFocus>{busy ? 'Approving…' : 'Yes, approve'}</button>
            <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setMode('view')}>Not yet</button>
          </div>
        </div>}

        {pending && mode === 'reject' && <fieldset className="hfi-reject" disabled={busy}>
          <legend>Why are you sending this back?</legend>
          <div className="hfi-reasons">
            {options.map((r) => <label key={r.code} className={`hfi-reason ${picked.includes(r.code) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.includes(r.code)} onChange={() => toggle(r.code)} /><span>{r.text}</span>
            </label>)}
          </div>
          <label className="hfh-field" htmlFor={`${panelId}-note`}>{needsNote ? 'Note (required for “Other”)' : 'Note (optional)'}
            <textarea id={`${panelId}-note`} rows={3} maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} />
          </label>
          <div className="hfi-wa">
            <p className="hfi-wa-h"><MessageCircle size={18} aria-hidden="true" />WhatsApp they will get (preview)</p>
            {picked.length ? <pre>{whatsappPreview(name ?? null, pickedReasons, note)}</pre> : <p className="hfa-note">Tick at least one reason to see the message.</p>}
          </div>
          <div className="hfh-acts">
            <button type="button" className="hfa-btn rani hfi-big" disabled={!canSend || busy} onClick={() => void run('reject')}>{busy ? 'Sending…' : 'Reject & send WhatsApp'}</button>
            <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setMode('view')}>Cancel</button>
          </div>
        </fieldset>}
      </div>
    </div>
  </div>;
}

function Tick({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`hfh-tick ${on ? 'on' : 'off'}`}>{on ? <Check size={16} aria-hidden="true" /> : <span aria-hidden="true">✕</span>}<span className="sr-only">{on ? 'Yes: ' : 'No: '}</span>{children}</span>;
}
