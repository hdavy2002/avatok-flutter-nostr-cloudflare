/* [HF-INTRO-B2] "New influencers": review the intro-video applications (Specs/HF-INTRO-VIDEO-1.md D12/D13, API doc section 2).
 * Rows slide open to the vertical video + details; Approve (with a confirm) or Reject with ready-made reasons. Admin guard comes from Admin2.astro.
 * [HF-MOD-ADMIN-UI] The AI safety check: a verdict badge per row, an AI filter + KPIs + queue card, the verdict panel in the opened row
 * (passed / flagged / needs a look / still checking), a blurred video for flagged ones, and the "AI is wrong - approve anyway" path.
 * Every AI field may be missing on old data: missing = unknown, and ai.status 'off' hides all AI UI. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, CalendarDays, Check, ChevronDown, Clock, ExternalLink, Lock, MessageCircle, RefreshCw, Users, Video, Volume2, X } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import {
  introAdminApi, type AiDetail, type AiScores, type AiStatus, type AiSummary, type CallOption, type DecisionResult, type IntroDetail,
  type IntroListItem, type IntroStatus, type IntroVerify, type ModerationQueue, type RejectReason,
} from '../../../lib/hfIntroAdminApi';
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
const SOCIAL_ORDER = ['instagram', 'youtube', 'facebook'] as const;
const W2W = 'women_to_women';
const PENDING_EVENT = 'hf-intro-admin:pending';
const PENDING_KEY = 'admin2:hf-intro-pending';
const QUEUE_POLL_MS = 12_000;

/** Dev-only mock (page passes mock): loaded lazily so its sample data never lands in the production chunk. */
const loadMock = () => import('./newInfluencersMock').then((m) => m.mockIntroApi);
const lazyMockApi: typeof introAdminApi = {
  list: (...a) => loadMock().then((m) => m.list(...(a as [IntroStatus]))),
  detail: (id) => loadMock().then((m) => m.detail(id)),
  approve: (id, note) => loadMock().then((m) => m.approve(id, note)),
  reject: (id, r, n) => loadMock().then((m) => m.reject(id, r, n)),
  queue: () => loadMock().then((m) => m.queue()),
};

const langName = (c: string | null | undefined) => (c ? LANGS[c] ?? c : '—');
const optionLabel = (o: CallOption | undefined) => (o === 'B' ? 'Bookings + live' : o === 'A' ? 'Bookings only' : 'Not chosen');
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const rupees = (n: number | null | undefined) => (typeof n === 'number' ? `₹${n}/min` : '—');
const fullDate = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fullDateTime = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST' : '');
const pct = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100);
const humanize = (code: string) => { const t = code.replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n));
const followerWord = (platform: string) => (platform === 'youtube' ? 'subscribers' : 'followers');
const platformLabel = (p: string) => PLATFORMS[p] ?? humanize(p);

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

/* ───────────────────────── AI helpers ([HF-MOD-ADMIN-UI]) ───────────────────────── */

type AiFilter = 'all' | 'passed' | 'flagged' | 'look';
type Tone = 'ok' | 'bad' | 'look' | 'wait' | 'lock';

/** Which filter bucket a verdict belongs to. 'wait' = still checking / unknown, 'none' = AI is off or absent. */
function bucketOf(a?: { status: AiStatus }): AiFilter | 'wait' | 'none' {
  switch (a?.status) {
    case 'passed': return 'passed';
    case 'flagged': return 'flagged';
    case 'needs_look': case 'failed': return 'look';
    case 'queued': case 'checking': case 'missing': return 'wait';
    default: return 'none';
  }
}
function toneOf(a: { status: AiStatus; childSafety?: boolean }): Tone {
  if (a.status === 'passed') return 'ok';
  if (a.status === 'flagged') return a.childSafety ? 'lock' : 'bad';
  if (a.status === 'needs_look' || a.status === 'failed') return 'look';
  return 'wait';
}

/** The video questions. val() = chance of the BAD thing (for no_face: 1 - face). */
const QUESTIONS: Record<string, { ok: string; title: string; label: string; val: (s: AiScores) => number }> = {
  no_face: { ok: 'Face is visible', title: 'No clear face in the video', label: 'No clear face', val: (s) => 1 - s.face },
  nudity: { ok: 'No nudity', title: 'Nudity in the intro video', label: 'Nudity', val: (s) => s.nudity },
  sexual: { ok: 'No sexual content', title: 'Sexual content in the intro video', label: 'Sexual content', val: (s) => s.sexual },
  minor: { ok: 'No child-safety signal', title: 'The person may be under 18', label: 'Under 18', val: (s) => s.minor },
  poor_quality: { ok: 'Good picture quality', title: 'The video is too dark or blurry', label: 'Too dark or blurry', val: (s) => s.quality },
};
const QUESTION_ORDER = ['no_face', 'nudity', 'sexual', 'minor', 'poor_quality'];
const SHORT: Record<string, string> = { no_face: 'face not clear', poor_quality: 'video too dark or blurry', nudity: 'Nudity', sexual: 'Sexual content', minor: 'Person may be under 18' };

const likely = (code: string, sc: AiScores | null | undefined): number | null => { const q = QUESTIONS[code]; return q && sc ? pct(q.val(sc)) : null; };

/** One-line summary under the list badge: "Nudity 92% · cover photo". */
function aiLine(a: AiSummary): string {
  const parts = a.reasons.map((c) => { const p = likely(c, a.scores); const t = SHORT[c] ?? humanize(c); return p !== null && (c === 'nudity' || c === 'sexual' || c === 'minor') ? `${t} ${p}%` : t; });
  if (a.posterReasons.length) parts.push('cover photo');
  return parts.join(' · ');
}
const reasonCount = (a: AiSummary) => a.reasons.length + (a.posterReasons.length ? 1 : 0);

/** Which of the admin's ready-made reject reasons match what the AI found (so they can be pre-ticked). Tries a few likely codes. */
function aiRejectPicks(a: AiSummary | undefined, options: RejectReason[]): string[] {
  if (!a || a.status === 'off') return [];
  const has = (c: string) => options.some((o) => o.code === c);
  const first = (...cs: string[]) => cs.find(has);
  const out = new Set<string>();
  for (const code of a.reasons) {
    const m = code === 'nudity' || code === 'sexual' ? first(code, `ai_${code}`, 'nudity', 'unsuitable')
      : code === 'minor' ? first('minor', 'ai_minor', 'unsuitable')
      : code === 'no_face' ? first('no_face', 'face_unclear')
      : code === 'poor_quality' ? first('poor_quality', 'video_dark') : undefined;
    if (m) out.add(m);
  }
  if (a.posterReasons.length) { const m = first('cover_unsuitable', 'poster_unsuitable', 'cover_photo', 'unsuitable'); if (m) out.add(m); }
  return [...out];
}

function AiIcon({ tone }: { tone: Tone }) {
  if (tone === 'ok') return <Check size={22} strokeWidth={3.2} aria-hidden="true" />;
  if (tone === 'bad') return <X size={22} strokeWidth={3.2} aria-hidden="true" />;
  if (tone === 'lock') return <Lock size={20} strokeWidth={2.8} aria-hidden="true" />;
  if (tone === 'look') return <span aria-hidden="true" className="hfi-q">?</span>;
  return <Clock size={22} strokeWidth={2.6} aria-hidden="true" />;
}

/** The verdict pill on a list row. Renders nothing when the AI is off or the field is missing. */
function AiBadge({ ai, avgWaitMs }: { ai?: AiSummary; avgWaitMs?: number | null }) {
  if (!ai || ai.status === 'off') return null;
  const tone = toneOf(ai);
  let title = ''; let sub = '';
  switch (ai.status) {
    case 'passed': title = 'AI check passed'; sub = 'Video, photo and cover · all clear'; break;
    case 'flagged':
      if (ai.childSafety) { title = 'AI flagged · child safety'; sub = 'Person may be under 18 · reject only'; }
      else { const n = reasonCount(ai); title = `AI flagged · ${n} reason${n === 1 ? '' : 's'}`; sub = aiLine(ai); }
      break;
    case 'needs_look': title = 'Needs a human look'; sub = aiLine(ai) || 'The AI was not sure'; break;
    case 'failed': title = 'AI check failed'; sub = 'Could not check it · look yourself'; break;
    case 'checking': title = 'AI is checking…'; sub = typeof avgWaitMs === 'number' && avgWaitMs > 0 ? `Usually about ${waitText(avgWaitMs)}` : 'Watching the video now'; break;
    case 'queued': title = 'AI is checking…'; sub = 'Waiting in the queue'; break;
    default: title = 'No AI check yet'; sub = 'Look at it yourself'; break;
  }
  return <span className={`hfi-ai t-${tone}`}><span className="hfi-ai-dot"><AiIcon tone={tone} /></span><span>{title}{sub && <small>{sub}</small>}</span></span>;
}

function waitText(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return 'under 1 s';
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/* ───────────────────────── verification pills (list) ───────────────────────── */

function VerifyPills({ item }: { item: IntroListItem }) {
  const v: IntroVerify = item.verify ?? {
    aadhaar: { verified: item.aadhaar.status === 'verified', gender: item.aadhaar.female ? 'F' : null },
    socials: (item.socialPlatforms ?? []).map((p) => ({ platform: p as 'youtube', handle: '', followers: null, url: null })),
    whatsapp: false,
  };
  const w2w = item.categories.some((c) => c.id === W2W);
  const socials = [...v.socials].sort((a, b) => SOCIAL_ORDER.indexOf(a.platform) - SOCIAL_ORDER.indexOf(b.platform));
  return <span className="hfi-ver">
    {v.aadhaar.verified
      ? <span className="hfi-vb v-kyc"><i><Check size={14} strokeWidth={3.4} aria-hidden="true" /></i>Aadhaar verified{v.aadhaar.gender && <small>· {v.aadhaar.gender === 'F' ? 'Female' : 'Male'}</small>}</span>
      : <span className="hfi-vb v-no"><i>–</i>Aadhaar not done</span>}
    {socials.map((s) => <span key={s.platform + s.handle} className="hfi-vb v-soc"><i><Check size={14} strokeWidth={3.4} aria-hidden="true" /></i>
      {platformLabel(s.platform)}{s.platform === 'facebook' ? ' page' : ''}{typeof s.followers === 'number' && <small>· {compact(s.followers)} {followerWord(s.platform)}</small>}</span>)}
    {!socials.length && (item.hasSocials && !item.verify
      ? <span className="hfi-vb v-soc"><i><Check size={14} strokeWidth={3.4} aria-hidden="true" /></i>Social channel</span>
      : <span className="hfi-vb v-no"><i>–</i>No social channel{w2w && <small>· allowed for Women-to-Women</small>}</span>)}
  </span>;
}

/* ───────────────────────── page ───────────────────────── */

const FILTERS: { key: AiFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'passed', label: '✓ Passed' }, { key: 'flagged', label: 'Flagged' }, { key: 'look', label: 'Needs a look' },
];

export default function NewInfluencers({ mock = false }: { mock?: boolean }) {
  const api = import.meta.env.MODE === 'development' && mock ? lazyMockApi : introAdminApi;
  const [tab, setTab] = useState<IntroStatus>('submitted');
  const [items, setItems] = useState<IntroListItem[] | null>(null);
  const [reasons, setReasons] = useState<RejectReason[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<AiFilter>('all');
  const [queue, setQueue] = useState<ModerationQueue | null>(null);

  const loadQueue = useCallback(async () => {
    try { setQueue(await api.queue()); } catch { setQueue(null); /* the queue card is a nice-to-have: hide it when the call fails */ }
  }, [api]);

  const load = useCallback(async () => {
    setItems(null); setError(null); setOpenId(null);
    void loadQueue();
    try {
      const r = await api.list(tab, (c) => { setItems(c.items); setReasons((prev) => (c.rejectReasons.length ? c.rejectReasons : prev)); });
      setItems(r.items);
      if (r.rejectReasons.length) setReasons(r.rejectReasons);
    } catch (err) {
      captureException(err, { where: 'hf_intro_admin_list', tab });
      setItems([]); setError(errMessage(err, 'Could not load the applications. Please try again.'));
    }
  }, [api, tab, loadQueue]);
  useEffect(() => { setFilter('all'); void load(); }, [load]);
  // Dev-only (mock + ?open=1 / ?reject=1 / ?row=N): lets the screenshot script open a row without clicking.
  const dev = import.meta.env.MODE === 'development' && mock && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  useEffect(() => {
    if (dev?.get('open') || dev?.get('reject') || dev?.get('row')) { if (items?.length && !openId) setOpenId(items[Math.max(0, Number(dev.get('row') ?? 1) - 1)]?.id ?? items[0].id); }
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (tab === 'submitted' && items && !error) announcePending(items.length); }, [tab, items, error]);

  // While anything is waiting for the AI, quietly re-fetch so the grey badges turn into verdicts without a click.
  const busy = !!items?.some((i) => i.ai?.status === 'queued' || i.ai?.status === 'checking');
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => {
      api.list(tab).then((r) => setItems((cur) => (cur ? r.items : cur))).catch(() => { /* next tick tries again */ });
      void loadQueue();
    }, QUEUE_POLL_MS);
    return () => window.clearInterval(t);
  }, [busy, api, tab, loadQueue]);

  const done = (item: IntroListItem, decision: 'approve' | 'reject', reasonsN: number, res: DecisionResult, extra?: { override?: boolean }) => {
    capture('hf_admin_review_ui', { decision, reasons_n: reasonsN, ai_status: item.ai?.status ?? 'unknown', ai_override: !!extra?.override });
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
    void loadQueue();
  };

  const stats = useMemo(() => {
    const list = items ?? [];
    return {
      w2w: list.filter((i) => i.categories.some((c) => c.id === W2W)).length,
      live: list.filter((i) => i.callOption === 'B').length,
      passed: list.filter((i) => bucketOf(i.ai) === 'passed').length,
      flagged: list.filter((i) => bucketOf(i.ai) === 'flagged').length,
      look: list.filter((i) => bucketOf(i.ai) === 'look').length,
      aiOn: list.some((i) => i.ai && i.ai.status !== 'off'),
    };
  }, [items]);
  const shown = useMemo(() => (items ? items.filter((i) => filter === 'all' || bucketOf(i.ai) === filter) : null), [items, filter]);
  const tabLabel = TABS.find((t) => t.key === tab)?.label ?? '';
  const filterCount = (k: AiFilter) => (k === 'passed' ? stats.passed : k === 'flagged' ? stats.flagged : k === 'look' ? stats.look : (items?.length ?? 0));

  return <div className="hfa-stack hfi">
    <div className="hfi-bar">
      <div role="tablist" aria-label="Application status" className="hfa-pills">
        {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="hfa-pill hfi-pill" onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      <div className="hfi-bar-r">
        {stats.aiOn && <div className="hfi-flt" role="group" aria-label="AI check filter">
          <span className="hfi-flt-l">AI check:</span>
          {FILTERS.map((f) => <button key={f.key} type="button" aria-pressed={filter === f.key} className={`hfi-fchip f-${f.key}`} onClick={() => setFilter(f.key)}>
            {f.label}{f.key !== 'all' && <> · {filterCount(f.key)}</>}</button>)}
        </div>}
        <button type="button" className="hfa-btn ghost" onClick={() => void load()} disabled={items === null}><RefreshCw size={18} aria-hidden="true" />Refresh</button>
      </div>
    </div>

    <DesiKpis>
      <DesiKpi tone={stats.aiOn ? 'lav' : 'plum'} label={tabLabel} value={items ? items.length : '…'} sub="applications in this list" icon={<Video aria-hidden="true" />} />
      {stats.aiOn ? <>
        <DesiKpi tone="tea" label="AI passed" value={items ? stats.passed : '…'} sub="green tick, safe to approve" icon={<Check aria-hidden="true" />} />
        <DesiKpi tone="rani" label="AI flagged" value={items ? stats.flagged : '…'} sub="red, open to see the reasons" alert={stats.flagged > 0} icon={<X aria-hidden="true" />} />
        <DesiKpi tone="gold" label="Needs a human look" value={items ? stats.look : '…'} sub="AI was not sure" icon={<Users aria-hidden="true" />} />
      </> : <>
        <DesiKpi tone="rani" label="Women-to-Women" value={items ? stats.w2w : '…'} sub="in this list" icon={<Users aria-hidden="true" />} />
        <DesiKpi tone="tea" label="Bookings + live" value={items ? stats.live : '…'} sub="chose to take live calls" icon={<Volume2 aria-hidden="true" />} />
      </>}
    </DesiKpis>

    {queue && (stats.aiOn || queueTotals(queue).total > 0) && <QueueCard queue={queue} />}

    {error && <HBanner tone="error">{error}</HBanner>}
    {items === null && <DesiCard tone="cream" pattern="dots"><p role="status" className="hfa-note">Loading applications…</p></DesiCard>}
    {items?.length === 0 && !error && <DesiCard tone="lav" corner="marigold"><DesiEmpty text={tab === 'submitted' ? 'No new influencers waiting. Chai peeke aaram karo.' : `Nothing in ${tabLabel.toLowerCase()} yet.`} /></DesiCard>}
    {items && items.length > 0 && shown?.length === 0 && <DesiCard tone="cream" pattern="dots"><p role="status" className="hfa-note">Nothing here matches that AI filter. Choose “All” to see every application.</p></DesiCard>}

    <div className="hfi-list">
      {shown?.map((item) => <Row key={item.id} api={api} item={item} reasons={reasons} avgWaitMs={queue?.avgWaitMs ?? null} open={openId === item.id} onToggle={() => setOpenId((cur) => (cur === item.id ? null : item.id))} onDone={done} />)}
    </div>

    {stats.aiOn && <div className="hfi-legend">
      <span><b className="l-ok">Green tick</b> AI found nothing wrong in the video, profile photo or cover.</span>
      <span><b className="l-bad">Red</b> AI found a problem. Open it to see what and where.</span>
      <span><b className="l-look">Amber</b> AI could not decide (dark, blurry, no face).</span>
      <span><b className="l-wait">Grey</b> still checking. You cannot approve until it finishes.</span>
      <span><b className="l-ok">Green pill</b> Aadhaar verified. <b className="l-soc">Indigo pill</b> social channel verified by signing in with it. <b className="l-no">Dashed</b> not done.</span>
    </div>}
  </div>;
}

function queueTotals(q: ModerationQueue) {
  let waiting = 0; let checking = 0; let failed = 0;
  for (const c of q.counts ?? []) {
    const st = String(c.status ?? '').toLowerCase();
    if (/fail|error/.test(st)) failed += c.n;
    else if (/check|run|process|progress/.test(st)) checking += c.n;
    else if (/queue|wait|pend/.test(st)) waiting += c.n;
  }
  return { waiting, checking, failed, total: waiting + checking + failed };
}

/** Small "Queue" card: how many uploads wait for the AI, are being checked, or failed, and the average wait. */
function QueueCard({ queue }: { queue: ModerationQueue }) {
  const t = queueTotals(queue);
  return <section className="hfi-queue" aria-label="AI check queue">
    <h3 className="hfi-queue-h"><Clock size={20} aria-hidden="true" />Queue</h3>
    <dl className="hfi-queue-dl">
      <div><dt>Waiting</dt><dd>{t.waiting}</dd></div>
      <div><dt>Checking</dt><dd>{t.checking}</dd></div>
      <div className={t.failed ? 'is-bad' : ''}><dt>Failed</dt><dd>{t.failed}</dd></div>
      <div><dt>Average wait</dt><dd>{waitText(queue.avgWaitMs)}</dd></div>
    </dl>
  </section>;
}

function Row({ api, item, reasons, avgWaitMs, open, onToggle, onDone }: {
  api: typeof introAdminApi; item: IntroListItem; reasons: RejectReason[]; avgWaitMs: number | null; open: boolean; onToggle: () => void;
  onDone: (item: IntroListItem, decision: 'approve' | 'reject', reasonsN: number, res: DecisionResult, extra?: { override?: boolean }) => void;
}) {
  const w2w = item.categories.some((c) => c.id === W2W);
  const shown = item.categories.slice(0, 4);
  const more = item.categories.length - shown.length;
  const panelId = `hfi-panel-${item.id}`;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (open) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [open]);
  const aiOn = !!item.ai && item.ai.status !== 'off';

  return <article ref={ref} className={`hfi-row ${w2w ? 'is-w2w' : ''} ${open ? 'is-open' : ''}`}>
    {aiOn && item.ai && <span className={`hfi-stripe t-${toneOf(item.ai)}`} aria-hidden="true" />}
    <span className="hfa-corner hfi-flower" aria-hidden="true"><Marigold size={96} /></span>
    <button type="button" className="hfi-head" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
      <DesiAvatar name={item.name} seed={item.uid} photo={item.photoUrl} size={72} />
      <span className="hfi-main">
        <span className="hfi-name">{item.name || 'No name yet'}</span>
        <span className="hfi-chips">
          {w2w && <DesiChip tone="rani"><span aria-hidden="true">♀</span>Women-to-Women</DesiChip>}
          {shown.filter((c) => c.id !== W2W).map((c) => <DesiChip key={c.id} tone="lav">{c.label}</DesiChip>)}
          {more > 0 && <DesiChip tone="grey">+{more} more</DesiChip>}
        </span>
        <VerifyPills item={item} />
        <span className="hfi-meta">
          <span>{langName(item.lang)}</span><span aria-hidden="true">·</span><span>{rupees(item.ratePerMin)}</span><span aria-hidden="true">·</span>
          <span>{optionLabel(item.callOption)}</span><span aria-hidden="true">·</span><span>{item.submittedAt ? dateIST(item.submittedAt) : 'not submitted'}</span>
        </span>
      </span>
      <span className="hfi-badges"><AiBadge ai={item.ai} avgWaitMs={avgWaitMs} /></span>
      <ChevronDown className="hfi-chev" size={28} aria-hidden="true" />
    </button>
    {open && <Detail api={api} item={item} reasons={reasons} panelId={panelId} onDone={onDone} />}
  </article>;
}

/* ───────────────────────── opened row ───────────────────────── */

type Mode = 'view' | 'confirm' | 'reject' | 'override';
const BLOCKS_APPROVE: AiStatus[] = ['queued', 'checking', 'missing', 'failed'];
const VIDEO_BAD = ['nudity', 'sexual', 'minor'];

function Detail({ api, item, reasons: listReasons, panelId, onDone }: {
  api: typeof introAdminApi; item: IntroListItem; reasons: RejectReason[]; panelId: string;
  onDone: (item: IntroListItem, decision: 'approve' | 'reject', reasonsN: number, res: DecisionResult, extra?: { override?: boolean }) => void;
}) {
  const [d, setD] = useState<IntroDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const devReject = import.meta.env.MODE === 'development' && typeof location !== 'undefined' && !!new URLSearchParams(location.search).get('reject');
  const [mode, setMode] = useState<Mode>(devReject ? 'reject' : 'view');
  const [picked, setPicked] = useState<string[]>(devReject ? ['video_dark', 'audio_unclear'] : []);
  const [note, setNote] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [showHost, setShowHost] = useState(false);
  const [showCover, setShowCover] = useState(false);
  const seeded = useRef(false);
  const video = useRef<HTMLVideoElement>(null);

  const aiStatus = item.ai?.status;
  useEffect(() => {
    let live = true;
    setD(null); setLoadErr(null);
    api.detail(item.id).then((r) => { if (live) setD(r); }).catch((e) => {
      captureException(e, { where: 'hf_intro_admin_detail', id: item.id });
      if (live) setLoadErr(errMessage(e, 'Could not load this application.'));
    });
    return () => { live = false; };
  }, [api, item.id, aiStatus]);

  const options = d?.rejectReasons?.length ? d.rejectReasons : listReasons;
  const aiFound = useMemo(() => aiRejectPicks(d?.ai ?? item.ai, options), [d, item.ai, options]);
  // A flagged application opens straight on the reject box with the AI's reasons ticked (artboard "Flagged").
  useEffect(() => {
    if (!d || seeded.current || devReject || item.status !== 'submitted') return;
    if ((d.ai ?? item.ai)?.status === 'flagged') { seeded.current = true; setPicked(aiFound); setMode('reject'); }
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickedReasons = options.filter((r) => picked.includes(r.code));
  const needsNote = picked.includes('other');
  const canSend = picked.length > 0 && (!needsNote || note.trim().length > 2);
  const pending = item.status === 'submitted';
  const name = d?.host.name || item.name;

  const run = async (decision: 'approve' | 'reject', approveNote?: string) => {
    setBusy(true); setErr(null);
    try {
      const res = decision === 'approve' ? await api.approve(item.id, approveNote) : await api.reject(item.id, picked, note.trim());
      onDone(item, decision, decision === 'reject' ? picked.length : 0, res, { override: decision === 'approve' && !!approveNote });
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

  const ai: AiDetail | undefined = d.ai ?? item.ai;
  const aiSt: AiStatus = ai?.status ?? 'off';
  const aiOn = !!ai && aiSt !== 'off';
  const flagged = aiSt === 'flagged';
  const child = flagged && !!ai?.childSafety;
  const videoBad = flagged && !!ai && (ai.childSafety || ai.reasons.some((c) => VIDEO_BAD.includes(c)));
  const blurred = videoBad && !reveal;
  const approveBlocked = BLOCKS_APPROVE.includes(aiSt);
  const effMode: Mode = pending && flagged && mode === 'view' ? 'reject' : mode;
  const startReject = () => { setErr(null); setPicked((cur) => (cur.length ? cur : aiFound)); setMode('reject'); };

  const cal = calendarSummary(d.calendar);
  const prev = (d.history ?? []).filter((h) => h.id !== d.application.id);
  const topic = d.application.topic ?? d.video?.topic;
  return <div id={panelId} className="hfi-panel" role="region" aria-label={`Details for ${name ?? 'applicant'}`}>
    <div className="hfi-grid">
      <div className="hfi-videocol">
        {d.video?.videoUrl ? <div className={`hfi-video ${flagged ? 'is-flagged' : ''} ${aiSt === 'passed' || flagged ? 'has-badge' : ''}`}>
          <video ref={video} className={blurred ? 'is-blurred' : ''} src={d.video.videoUrl} poster={d.video.posterUrl ?? undefined} autoPlay muted loop playsInline controls={!blurred} preload="auto" aria-label={`Intro video from ${name ?? 'applicant'}`} />
          {aiSt === 'passed' && <span className="hfi-vbadge ok"><span><Check size={20} strokeWidth={3.4} aria-hidden="true" /></span>AI safe</span>}
          {flagged && <span className="hfi-vbadge bad"><span><X size={18} strokeWidth={3.4} aria-hidden="true" /></span>Flagged</span>}
          {blurred && <div className="hfi-veil">
            <b>Blurred for your safety</b>
            <span>{child ? 'The AI thinks the person may be under 18. Look only if you need to.' : 'The AI found nudity or sexual content in this video. Look only if you need to.'}</span>
            <button type="button" className="hfi-reveal" onClick={() => setReveal(true)}>Show the video</button>
          </div>}
          {muted && !blurred && <button type="button" className="hfi-sound" onClick={sound}><Volume2 size={20} aria-hidden="true" />Tap for sound</button>}
        </div> : d.video?.deletedAt ? <div className="hfi-gone" role="note">
          {/* [HF-INTRO-DELETE-1] artboard AdminRejected: lotus + "Video deleted" instead of the player */}
          <Lotus size={68} />
          <strong>Video deleted</strong>
          <span>Removed from storage on {dateIST(d.video.deletedAt)}, when it was {d.video.deletedReason === 'replaced' ? 'replaced by a newer one' : d.video.deletedReason === 'draft_expired' ? 'never sent' : 'rejected'}</span>
        </div> : <div className="hfi-video hfi-novideo"><Video size={40} aria-hidden="true" /><p>No video on this application.</p></div>}
        {videoBad && !blurred && <button type="button" className="hfa-btn ghost hfi-blur-again" onClick={() => setReveal(false)}>Blur again</button>}
        {/* [HF-ADMIN-FACECHECK] The accounts she logged in with, next to the video, so a person can compare the face. */}
        <div className="hfi-facecheck" role="group" aria-label="Face check">
          <p className="hfi-facecheck-h">Face check</p>
          {d.socials.length ? <>
            <p className="hfa-note">Open the accounts she logged in with and check it is the same person as in this video.</p>
            <ul className="hfi-facecheck-list">{d.socials.map((s) => <li key={'fc' + s.platform + s.handle}>
              <a className="hfi-facecheck-btn" href={s.url} target="_blank" rel="noopener noreferrer">
                <BadgeCheck size={18} aria-hidden="true" />Open {PLATFORMS[s.platform] ?? s.platform} · {s.handle}<ExternalLink size={16} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>)}</ul>
          </> : <p className="hfi-warn">No social account. She proved who she is with Aadhaar{d.aadhaar.done ? '' : ' (not done yet)'}; check the face against the Aadhaar check instead.</p>}
        </div>
        {d.video?.durationMs ? <p className="hfa-note hfi-center">{Math.round(d.video.durationMs / 1000)} seconds{d.video.width && d.video.height ? ` · ${d.video.width}×${d.video.height}` : ''}{flagged && ai?.where ? ` · AI's rough guess: ${ai.where} of the video` : ''}</p> : null}
      </div>

      <div className="hfi-info">
        <div className="hfi-hrow">
          <h3 className="hfi-h">{name || 'No name yet'}</h3>
          {aiOn && <AiBadge ai={ai} />}
        </div>
        <p className="hfi-desc">{d.host.description || <span className="hfa-note">No description written.</span>}</p>

        <IdentityBox d={d} />
        {aiOn && ai && <AiPanel ai={ai} d={d} showHost={showHost} showCover={showCover} onHost={() => setShowHost((v) => !v)} onCover={() => setShowCover((v) => !v)} />}

        <dl className="hfi-dl">
          <dt>Categories</dt><dd className="hfi-chips">{(d.application.categories ?? item.categories).map((c) => <DesiChip key={c.id} tone={c.id === W2W ? 'rani' : 'lav'}>{c.label}</DesiChip>)}</dd>
          <dt>Language</dt><dd>{langName(d.application.lang ?? item.lang)}</dd>
          <dt>Topic</dt><dd>{topic && topic !== 'general' ? topic.replace(/_/g, ' ') : 'General'}</dd>
          <dt>Rate</dt><dd>{rupees(d.host.ratePerMin)}</dd>
          <dt>Call option</dt><dd>{optionLabel(d.application.callOption ?? item.callOption)}</dd>
          <dt>Time slots</dt>
          <dd>{cal.length ? <ul className="hfi-cal">{cal.map((l) => <li key={l}><CalendarDays size={16} aria-hidden="true" />{l}</li>)}</ul> : <span className="hfi-warn">No weekly slots set{d.calendar?.timezone ? ` (${d.calendar.timezone})` : ''}</span>}</dd>
          <dt>Account created</dt><dd>{d.host.createdAt ? dateIST(d.host.createdAt) : '—'}{d.application.submittedAt ? <span className="hfa-note"> · submitted {dateIST(d.application.submittedAt)}</span> : null}</dd>
          {d.womenToWomen && <><dt>Channel</dt><dd><DesiChip tone="rani"><span aria-hidden="true">♀</span>Women-to-Women (female Aadhaar)</DesiChip></dd></>}
          {prev.length > 0 && <><dt>Earlier tries</dt><dd>{prev.length} earlier application{prev.length > 1 ? 's' : ''}{prev[0]?.rejectReasons?.length ? ` · last: ${prev[0].rejectReasons.map((r) => r.text).join('; ')}` : ''}</dd></>}
          {!pending && d.application.rejectReasons?.length ? <><dt>Rejected for</dt><dd><ul className="hfi-cal">{d.application.rejectReasons.map((r) => <li key={r.code}>{r.text}</li>)}</ul>{d.application.rejectNote && <p className="hfa-note">Note: {d.application.rejectNote}</p>}</dd></> : null}
        </dl>

        {d.video?.deletedAt && <p className="hfi-gone-note">The details and reasons are kept for the record. The video and its thumbnail are gone. If she records again, the new video shows under <b>Pending</b>.</p>}

        {err && <HBanner tone="error">{err}</HBanner>}

        {pending && effMode === 'view' && <>
          {approveBlocked && <p className="hfi-hold" role="note">{aiSt === 'failed' ? 'The AI check failed, so Approve is switched off. You can still reject, or wait for a retry.' : 'The AI is still checking. Approve switches on when it finishes (this page updates by itself).'}</p>}
          <div className="hfh-acts hfi-acts">
            <button type="button" className="hfa-btn tea hfi-big" disabled={approveBlocked} onClick={() => { setErr(null); setMode('confirm'); }}><Check size={20} aria-hidden="true" />Approve</button>
            <button type="button" className="hfa-btn danger hfi-big" onClick={startReject}>Reject…</button>
          </div>
        </>}

        {pending && effMode === 'confirm' && <div className="hfi-confirm" role="alertdialog" aria-labelledby={`${panelId}-c`}>
          <p id={`${panelId}-c`}><b>Make {name || 'this person'} live?</b> They appear in the reels feed and get a WhatsApp saying they are live.</p>
          <div className="hfh-acts">
            <button type="button" className="hfa-btn tea hfi-big" disabled={busy} onClick={() => void run('approve')} autoFocus>{busy ? 'Approving…' : 'Yes, approve'}</button>
            <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setMode('view')}>Not yet</button>
          </div>
        </div>}

        {pending && effMode === 'reject' && <fieldset className="hfi-reject" disabled={busy}>
          <legend>{flagged ? 'Send it back with these reasons' : 'Why are you sending this back?'}</legend>
          <div className="hfi-reasons">
            {options.map((r) => <label key={r.code} className={`hfi-reason ${picked.includes(r.code) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.includes(r.code)} onChange={() => toggle(r.code)} />
              <span>{r.text}{aiFound.includes(r.code) && <small className="hfi-aitag">AI found this</small>}</span>
            </label>)}
          </div>
          <label className="hfh-field" htmlFor={`${panelId}-note`}>{needsNote ? 'Note (required for “Other”)' : 'Note (optional)'}
            <textarea id={`${panelId}-note`} rows={3} maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} />
          </label>
          <div className="hfi-wa">
            <p className="hfi-wa-h"><MessageCircle size={18} aria-hidden="true" />WhatsApp they will get (preview)</p>
            {picked.length ? <pre>{whatsappPreview(name ?? null, pickedReasons, note)}</pre> : <p className="hfa-note">Tick at least one reason to see the message.</p>}
          </div>
          {child && <p className="hfi-hold" role="note">Child-safety flag: there is no approve button. This application can only be rejected.</p>}
          <div className="hfh-acts">
            <button type="button" className="hfa-btn rani hfi-big" disabled={!canSend || busy} onClick={() => void run('reject')}>{busy ? 'Sending…' : 'Reject & send WhatsApp'}</button>
            {flagged && !child
              ? <button type="button" className="hfa-btn ghost hfi-big" disabled={busy} onClick={() => { setErr(null); setMode('override'); }}>AI is wrong — approve anyway…</button>
              : !flagged && <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setMode('view')}>Cancel</button>}
          </div>
        </fieldset>}

        {pending && effMode === 'override' && <div className="hfi-override">
          <h4>Approve against the AI?</h4>
          <p className="hfi-hold">The AI flagged this. If you approve, your name and your note are saved with the decision.</p>
          <label className="hfh-field" htmlFor={`${panelId}-why`}>Why is the AI wrong? (required)
            <textarea id={`${panelId}-why`} rows={3} maxLength={500} value={why} onChange={(ev) => setWhy(ev.target.value)} placeholder="Example: it is a skin-coloured top, not nudity. Watched the whole video myself." />
          </label>
          <div className="hfh-acts">
            <button type="button" className="hfa-btn hfi-solid-tea hfi-big" disabled={busy || why.trim().length < 3} onClick={() => void run('approve', why.trim())}>{busy ? 'Approving…' : 'Yes, approve'}</button>
            <button type="button" className="hfa-btn ghost hfi-big" disabled={busy} onClick={() => { setErr(null); setMode('reject'); }}>Cancel</button>
          </div>
        </div>}
      </div>
    </div>
  </div>;
}

/* ───────────────────────── identity + AI panels ───────────────────────── */

function IdentityBox({ d }: { d: IntroDetail }) {
  const gender = d.aadhaar.gender === 'F' || d.aadhaar.female ? 'Female' : d.aadhaar.gender === 'M' ? 'Male' : d.aadhaar.gender ? `Gender ${d.aadhaar.gender}` : 'Gender unknown';
  const by = new Map(d.socials.map((s) => [s.platform, s]));
  return <section className="hfi-idbox" aria-label="Identity and channels">
    <h4 className="hfi-idh">Identity and channels</h4>
    <div className="hfi-idgrid">
      {d.aadhaar.done
        ? <div className="hfi-vc kyc"><i><Check size={18} strokeWidth={3.4} aria-hidden="true" /></i><div><b>Aadhaar verified</b><span>{d.aadhaar.name ? `Name on Aadhaar: ${d.aadhaar.name} · ` : ''}{gender}</span>{d.aadhaar.verifiedAt ? <span>Verified {fullDate(d.aadhaar.verifiedAt)}</span> : null}</div></div>
        : <div className="hfi-vc no"><i>–</i><div><b>Aadhaar not done</b></div></div>}
      {SOCIAL_ORDER.map((p) => {
        const s = by.get(p);
        const word = p === 'youtube' ? 'channel' : p === 'facebook' ? 'page' : 'profile';
        return s
          ? <div key={p} className="hfi-vc soc"><i><Check size={18} strokeWidth={3.4} aria-hidden="true" /></i><div>
            <b>{platformLabel(p)} {p === 'facebook' ? 'page ' : ''}verified</b>
            <span>{s.handle}{typeof s.followers === 'number' ? ` · ${s.followers.toLocaleString('en-IN')} ${followerWord(p)}` : ''}</span>
            {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer">Open {word} ↗<span className="sr-only"> (opens in a new tab)</span></a>}
          </div></div>
          : <div key={p} className="hfi-vc no"><i>–</i><div><b>{platformLabel(p)} not connected</b></div></div>;
      })}
      {d.whatsappVerified
        ? <div className="hfi-vc kyc"><i><Check size={18} strokeWidth={3.4} aria-hidden="true" /></i><div><b>WhatsApp verified</b></div></div>
        : <div className="hfi-vc no"><i>–</i><div><b>WhatsApp not verified</b></div></div>}
    </div>
  </section>;
}

function Meter({ value, tone }: { value: number; tone: 'ok' | 'bad' | 'look' }) {
  return <div className="hfi-meter" aria-hidden="true"><i className={`m-${tone}`} style={{ width: `${Math.max(value > 0 ? 2 : 0, value)}%` }} /></div>;
}

function AiPanel({ ai, d, showHost, showCover, onHost, onCover }: {
  ai: AiDetail; d: IntroDetail; showHost: boolean; showCover: boolean; onHost: () => void; onCover: () => void;
}) {
  const st = ai.status;
  if (st === 'off') return null;
  const tone = toneOf(ai);
  const sc = ai.scores;
  const audit = [
    ai.checkedAt ? `Checked ${fullDateTime(ai.checkedAt)}` : '', ai.policyVersion ? `policy ${ai.policyVersion}` : '', ai.jobId ? `job ${ai.jobId}` : '',
  ].filter(Boolean).join(' · ');
  const overrideLine = ai.override ? `Approved against the AI by ${ai.override.by}: “${ai.override.note}”` : '';

  if (st === 'queued' || st === 'checking' || st === 'missing' || st === 'failed') {
    const head = st === 'failed' ? 'AI check failed' : st === 'missing' ? 'No AI check on this one' : 'AI is still checking';
    const text = st === 'failed' ? 'The AI could not check this application. Approve is switched off. You can reject it, or wait for the check to be retried.'
      : st === 'missing' ? 'This application has no AI result. Watch the video and look at the photos yourself before you decide.'
        : 'This page updates by itself when the check finishes. You cannot approve until then.';
    return <section className={`hfi-aip t-${tone}`} aria-label="AI safety check" aria-live="polite">
      <div className="hfi-aip-h"><span className="hfi-aip-big"><AiIcon tone={tone} /></span><div><h4>{head}</h4><p>{text}</p></div></div>
      {audit && <p className="hfi-audit">{audit}</p>}
    </section>;
  }

  type Item = { key: string; title: string; sub: string; value: number | null; hint: boolean };
  const items: Item[] = ai.reasons.map((code) => {
    const q = QUESTIONS[code]; const p = likely(code, sc);
    return { key: code, title: q?.title ?? humanize(code), sub: p !== null && q ? `${q.label}: ${p}% likely` : '', value: p, hint: VIDEO_BAD.includes(code) && !!ai.where };
  });
  const posterBad = ai.posterReasons.length > 0 || d.photos?.poster.status === 'refused';
  const hostBad = d.photos?.host.status === 'refused';
  if (posterBad) items.push({ key: 'poster', title: 'Channel cover is not suitable', sub: ai.posterReasons.map(humanize).join(', '), value: null, hint: false });
  if (hostBad) items.push({ key: 'host', title: 'Profile photo is not suitable', sub: d.photos?.host.reason ?? '', value: null, hint: false });
  const okChecks = QUESTION_ORDER.filter((c) => !ai.reasons.includes(c));

  const head = st === 'passed' ? 'AI check passed' : st === 'needs_look' ? 'The AI was not sure' : ai.childSafety ? 'AI flagged a child-safety problem' : 'AI flagged this application';
  const headP = st === 'passed' ? 'The AI checked the whole video, the profile photo and the channel cover.'
    : st === 'needs_look' ? 'It could not decide, so a person has to look. Watch the video and decide.'
      : ai.childSafety ? 'It stays hidden from everyone. This can only be rejected: there is no approve button.' : 'It stays hidden from everyone until you decide. The AI suggests rejecting it.';
  const mt = st === 'flagged' ? 'bad' : 'look';

  return <section className={`hfi-aip t-${tone}`} aria-label="AI safety check">
    <div className="hfi-aip-h"><span className="hfi-aip-big"><AiIcon tone={tone} /></span><div><h4>{head}</h4><p>{headP}</p></div></div>

    {st !== 'passed' && items.length > 0 && <ol className="hfi-reasonlist">
      {items.map((it, i) => <li key={it.key} className="hfi-rs">
        <span className="hfi-rs-n">{i + 1}</span>
        <div className="hfi-rs-b">
          <b>{it.title}</b>
          {it.sub && <span>{it.sub}</span>}
          {it.value !== null && <Meter value={it.value} tone={mt} />}
          {it.hint && ai.where && <span className="hfi-hint">Rough guess where to look: {ai.where} · watch to confirm</span>}
        </div>
        {it.value !== null && <span className="hfi-sure">{it.value}% likely</span>}
      </li>)}
    </ol>}

    {st === 'passed' && <ul className="hfi-checks">
      {QUESTION_ORDER.map((code) => {
        const q = QUESTIONS[code]; if (!q) return null;
        const bad = sc ? pct(q.val(sc)) : null;
        const sub = !sc ? '' : code === 'no_face' ? `AI is ${pct(sc.face)}% sure` : `${q.label}: ${bad}% likely`;
        return <li key={code} className="hfi-ck"><span className="hfi-ck-ic"><Check size={16} strokeWidth={3.4} aria-hidden="true" /></span>
          <div><b>{q.ok}</b>{sub && <span>{sub}</span>}{sc && <Meter value={code === 'no_face' ? pct(sc.face) : bad ?? 0} tone="ok" />}</div></li>;
      })}
    </ul>}

    {st !== 'passed' && okChecks.length > 0 && <>
      <p className="hfi-fh">Passed checks</p>
      <ul className="hfi-pchecks">{okChecks.map((c) => <li key={c}><span className="hfi-ck-ic"><Check size={15} strokeWidth={3.4} aria-hidden="true" /></span>{QUESTIONS[c]?.ok}</li>)}</ul>
    </>}

    <p className="hfi-how">Clef watches the whole video (2 pictures a second, with sound) and answers each question with how likely it is. It gives one score per question, not a list of frames.{st !== 'passed' && ai.where ? ' The “where to look” hint is a second, rougher question asked only when something is flagged.' : ''}</p>

    <p className="hfi-fh">Other uploads</p>
    <div className="hfi-uploads">
      <UploadItem label="Profile photo" url={d.photos?.host.url ?? d.host.photoUrl}
        text={hostBad ? (d.photos?.host.reason || 'Not suitable') : d.photos?.host.status === 'checking' ? 'AI is still checking' : d.photos?.host.status === 'failed' ? 'AI check failed' : d.photos?.host.status === 'active' ? 'Checked · all clear' : (d.photos?.host.url ?? d.host.photoUrl) ? 'Not checked yet' : 'No profile photo'}
        mark={hostBad ? 'bad' : d.photos?.host.status === 'checking' ? 'wait' : d.photos?.host.status === 'active' ? 'ok' : null}
        blurred={hostBad && !showHost} canReveal={hostBad} onToggle={onHost} />
      <UploadItem label="Channel cover" wide url={d.video?.posterUrl ?? null}
        text={posterBad ? (ai.posterReasons.length ? `Blurred · ${ai.posterReasons.map(humanize).join(', ').toLowerCase()}` : 'Not suitable') : d.photos?.poster.status === 'checking' ? 'AI is still checking' : st === 'passed' ? 'No nudity · no problems found' : 'No problem found'}
        mark={posterBad ? 'bad' : d.photos?.poster.status === 'checking' ? 'wait' : 'ok'}
        blurred={posterBad && !showCover} canReveal={posterBad} onToggle={onCover} />
    </div>

    {(audit || overrideLine) && <p className="hfi-audit">{[audit, overrideLine].filter(Boolean).join(' · ')}</p>}
  </section>;
}

function UploadItem({ label, url, wide, text, mark, blurred, canReveal, onToggle }: {
  label: string; url: string | null; wide?: boolean; text: string; mark: 'ok' | 'bad' | 'wait' | null; blurred: boolean; canReveal: boolean; onToggle: () => void;
}) {
  return <div className={`hfi-up ${mark === 'bad' ? 'is-bad' : ''}`}>
    <span className={`hfi-th ${wide ? 'wide' : ''}`}>{url ? <img src={url} alt="" className={blurred ? 'is-blurred' : ''} /> : <span className="hfi-th-empty" aria-hidden="true" />}</span>
    <div className="hfi-up-t"><b>{label}</b><span>{text}</span>
      {canReveal && url && <button type="button" className="hfi-mini" onClick={onToggle}>{blurred ? 'Show it' : 'Blur again'}</button>}</div>
    {mark && <span className={`hfi-mk m-${mark}`}>{mark === 'ok' ? <Check size={18} strokeWidth={3.4} aria-hidden="true" /> : mark === 'bad' ? <X size={18} strokeWidth={3.4} aria-hidden="true" /> : <Clock size={18} strokeWidth={2.8} aria-hidden="true" />}
      <span className="sr-only">{mark === 'ok' ? 'Passed' : mark === 'bad' ? 'Flagged' : 'Still checking'}</span></span>}
  </div>;
}
