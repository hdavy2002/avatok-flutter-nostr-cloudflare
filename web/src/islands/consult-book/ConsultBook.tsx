/* [AUMFE-CONSULT-F2-1 2026-10-02] /guides/<slug>/book — the booking wizard. Visuals are the approved mockups
 * (Specs/consultants-mockup BookDetails / BookNumerology / BookPalm / BookFace / BookTarot / BookSlotPay / BookDone);
 * the gates, UPI pay panel and idempotent request key follow islands/shop-checkout.
 *
 * Flow: sign in + verified WhatsApp -> 1 details (per discipline) -> 2 photos (palmistry / face) or cards (tarot)
 *       -> 3+4 time, questions, price, pay method, refund tickbox -> Pay -> [UPI panel | wallet] -> done.
 * The booking (and the 10-minute slot hold) is created when Pay is pressed, because the contract needs the slot and
 * both tickboxes in the POST. Photos picked at step 2 stay in memory and are uploaded to the new booking right after
 * it exists; a rejected photo sends the customer back to retake (the retake uploads straight away, the booking is held).
 * Changing details / slot / questions after a booking exists cancels the held booking and makes a fresh one.
 * NOTE FOR AI: never type the brand; BRAND only. No green. Telemetry: consult_book_step, consult_photo_capture (in
 * PhotoStep), consult_tarot_drawn (TarotStep), consult_pay_started, consult_pay_result; failures captureException.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useUser } from '@clerk/clerk-react';
import { ClerkIsland, getActiveToken, getActiveTokenWaited } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { getPhoneStatus } from '../auth/passwordless';
import { hasClerkSessionHint } from '../../lib/sessionHint';
import { capture, captureException } from '../../lib/analytics';
import { ApiError, request } from '../../lib/apiClient';
import { usePreview } from '../../lib/preview';
import { copyFor } from '../../lib/eventTypes';
import { YouStep } from '../saathum-checkout/YouStep';
import { getProfile } from '../saathum-checkout/profile';
import {
  cancelBooking, consultMessage, createBooking, getBooking, getConsultant, payWallet, uploadPhoto, walletSpendable,
} from '../../lib/consultApi';
import type { PayInfo } from '../../lib/consultApi';
import { DISCIPLINES, DISCIPLINE_LABEL } from '../../lib/consultTypes';
import type { BookingDTO, ConsultantDetail, Discipline, Intake, PhotoKind } from '../../lib/consultTypes';
import {
  EMPTY_BIRTH, astroIntake, astroProblem, faceIntake, intakeSignature, numeroIntake, numeroProblem, palmIntake, palmProblem,
  photoKinds, tarotIntake, tarotProblem,
} from './bookLogic';
import type { AstroForm, FaceForm, NumeroForm, PalmForm, TarotForm } from './bookLogic';
import { AstroDetails, FaceDetails, NumeroDetails, PalmDetails, TarotDetails, stepTitle } from './Forms';
import { PhotoStep } from './PhotoStep';
import type { PhotoItem } from './PhotoStep';
import { TarotStep } from './TarotStep';
import { SlotPay } from './SlotPay';
import type { PayMethod } from './SlotPay';
import { UpiPanel } from './UpiPanel';
import { DonePanel } from './Done';
import '../saathum-checkout/checkout.css';
import '../../styles/consultants.css';
import './consultBook.css';

type Screen = 'details' | 'media' | 'slotpay' | 'upi' | 'done';
type Gate = 'checking' | 'out' | 'unverified' | 'ok';

const CAT: Record<Discipline, string> = { astrology: 'cat-astro', numerology: 'cat-numero', palmistry: 'cat-palm', face_reading: 'cat-face', tarot: 'cat-tarot' };
const YOU_COPY = copyFor({ event_type: 'havan' }); // YouStep wants an event copy object; shop mode never reads it
const KEY_ACTIVE = 'consult:active';
const KEY_RK = 'consult:rk';

function ss(op: 'get' | 'set' | 'del', key: string, value?: string): string | null {
  try {
    if (op === 'get') return window.sessionStorage.getItem(key);
    if (op === 'set') window.sessionStorage.setItem(key, value ?? '');
    else window.sessionStorage.removeItem(key);
  } catch { /* private mode — in-memory state still works for this page */ }
  return null;
}
function newKey(): string { const k = crypto.randomUUID(); ss('set', KEY_RK, k); return k; }
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

interface AstroProfileResp { profile: { name?: string | null; gender?: string | null; dob?: string | null; tob?: string | null; tob_unknown?: boolean; place?: string | null; lat?: number | null; lon?: number | null; tzone?: number | null } | null }

function Inner({ slug }: { slug: string }) {
  const { user, isLoaded: userLoaded } = useUser();
  const preview = usePreview();
  const [gate, setGate] = useState<Gate>('checking');
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const [sessionHint, setSessionHint] = useState(false);
  const [waMasked, setWaMasked] = useState<string | null>(null);
  const [consultant, setConsultant] = useState<ConsultantDetail | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle');
  const [discipline, setDiscipline] = useState<Discipline>('astrology');
  const [screen, setScreen] = useState<Screen>('details');

  const [prefilled, setPrefilled] = useState(false);
  const [astro, setAstro] = useState<AstroForm>({ birth: { ...EMPTY_BIRTH }, gotra: '', marital: '', city: '', focus: [], partnerOn: false, partner: { ...EMPTY_BIRTH } });
  const [numero, setNumero] = useState<NumeroForm>({ birthName: '', usedName: '', dob: '', mobile: '', names: ['', ''] });
  const [palm, setPalm] = useState<PalmForm>({ hand: 'right', age: '', gender: '', occupation: '', focus: [] });
  const [face, setFace] = useState<FaceForm>({ gender: '', dob: '', focus: [] });
  const [tarot, setTarot] = useState<TarotForm>({ name: '', dob: '', question: '', picks: [], reversed: [], yesNo: true, yesNoCard: null });
  const [photos, setPhotos] = useState<Partial<Record<PhotoKind, PhotoItem>>>({});
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const [problem, setProblem] = useState<string | null>(null);

  const [slotMs, setSlotMs] = useState<number | null>(null);
  const [questions, setQuestions] = useState<string[]>(['', '']);
  const [method, setMethod] = useState<PayMethod>('upi');
  const [wallet, setWallet] = useState<number | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);

  const [booking, setBooking] = useState<BookingDTO | null>(null);
  const [pay, setPay] = useState<PayInfo | null>(null);
  const created = useRef<{ sig: string; booking: BookingDTO; pay: PayInfo } | null>(null);
  const reported = useRef(false);
  const gateStarted = useRef(false);
  const gateBusy = useRef(false);
  const prefilledOnce = useRef(false);

  const you = user?.fullName ?? '';
  tokenRef.current = token;

  useEffect(() => {
    setSessionHint(hasClerkSessionHint());
    const q = new URL(window.location.href).searchParams;
    const s = Number(q.get('slot'));
    if (Number.isFinite(s) && s > Date.now()) setSlotMs(s);
    const d = q.get('d');
    if (d && (DISCIPLINES as readonly string[]).includes(d)) setDiscipline(d as Discipline);
  }, []);

  // ── gate: signed in + verified WhatsApp (same as shop checkout) ──
  const checkGate = useCallback(async () => {
    if (!user || gateBusy.current) return;
    gateBusy.current = true;
    try {
      const t = await getActiveTokenWaited().catch(() => null);
      if (!t) { setGate('unverified'); return; }
      setToken(t);
      try {
        const status = await getPhoneStatus();
        if (status.verified) { setWaMasked(status.phone); setGate('ok'); } else setGate('unverified');
      } catch (e) { captureException(e, { where: 'consult_book_phone_status' }); setGate('unverified'); }
    } finally { gateBusy.current = false; }
  }, [user]);

  useEffect(() => {
    if (!userLoaded) return;
    if (!user) { setGate('out'); return; }
    if (gateStarted.current) return;
    gateStarted.current = true;
    void checkGate();
  }, [userLoaded, user, checkGate]);

  const hasToken = !!token;
  useEffect(() => {
    if (!hasToken) return;
    const id = window.setInterval(() => { getActiveToken().then((t) => { if (t) setToken(t); }).catch(() => undefined); }, 40_000);
    return () => window.clearInterval(id);
  }, [hasToken]);

  const freshAuth = useCallback(async (): Promise<string> => {
    const t = (await getActiveToken().catch(() => null)) ?? tokenRef.current;
    if (!t) throw new Error('signed_out');
    setToken(t);
    return t;
  }, []);

  // ── consultant + prefill + resume, once the gate is open ──
  useEffect(() => {
    if (gate !== 'ok' || !token || loadState !== 'idle') return;
    setLoadState('loading');
    getConsultant(slug, token).then((r) => {
      setConsultant(r.consultant);
      const want = new URL(window.location.href).searchParams.get('d');
      setDiscipline(want && (r.consultant.disciplines as string[]).includes(want) ? (want as Discipline) : r.consultant.disciplines[0]);
      setLoadState('ready');
    }).catch((e) => {
      if (e instanceof ApiError && e.status === 404) setLoadState('missing');
      else { captureException(e, { where: 'consult_book_consultant' }); setLoadState('error'); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, token, slug]);

  useEffect(() => {
    if (gate !== 'ok' || !token || prefilledOnce.current) return;
    prefilledOnce.current = true;
    void (async () => {
      try {
        const [prof, ap] = await Promise.all([
          getProfile(token).catch(() => null),
          request<AstroProfileResp>('/api/me/astro-profile', { auth: token }).catch(() => ({ profile: null } as AstroProfileResp)),
        ]);
        const p = ap.profile;
        const name = (p?.name || prof?.name || you || '').trim();
        const gender = (p?.gender || '').toLowerCase();
        const g = gender === 'male' || gender === 'female' || gender === 'other' ? gender : '';
        const geo = p?.lat != null && p?.lon != null ? { lat: p.lat, lon: p.lon, tzone: p.tzone ?? null } : null;
        setAstro((a) => ({
          ...a,
          birth: { ...a.birth, name: a.birth.name || name, gender: a.birth.gender || g, dob: a.birth.dob || p?.dob || '', tob: a.birth.tob || p?.tob || '', tobUnknown: a.birth.tobUnknown || !!p?.tob_unknown, place: a.birth.place || p?.place || '', geo: a.birth.place ? a.birth.geo : geo },
          gotra: a.gotra || prof?.gotra || '',
        }));
        setNumero((n) => ({ ...n, birthName: n.birthName || name, dob: n.dob || p?.dob || '' }));
        setTarot((t) => ({ ...t, name: t.name || name, dob: t.dob || p?.dob || '' }));
        setFace((f) => ({ ...f, gender: f.gender || g, dob: f.dob || p?.dob || '' }));
        setPalm((f) => ({ ...f, gender: f.gender || g }));
        if (p?.dob) setPrefilled(true);
      } catch (e) { captureException(e, { where: 'consult_book_prefill' }); }
      try { setWallet(await walletSpendable(token)); } catch { setWallet(null); }
      // resume a held / paying booking made earlier in this tab
      try {
        const raw = ss('get', KEY_ACTIVE);
        if (!raw) return;
        const saved = JSON.parse(raw) as { slug: string; id: string; pay: PayInfo };
        if (saved.slug !== slug) return;
        const r = await getBooking(saved.id, token);
        const b = r.booking;
        if (b.status === 'confirmed' || b.status === 'in_call' || b.status === 'completed') { setBooking(b); setScreen('done'); ss('del', KEY_ACTIVE); }
        else if (b.status === 'held' || b.status === 'awaiting_review') { setBooking(b); setPay(saved.pay); setScreen('upi'); }
        else ss('del', KEY_ACTIVE);
      } catch { ss('del', KEY_ACTIVE); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, token]);

  useEffect(() => { capture('consult_book_step', { step: screen === 'media' ? (discipline === 'tarot' ? 'cards' : 'photos') : screen === 'slotpay' ? 'time_pay' : screen, discipline }); }, [screen, discipline]);
  function go(s: Screen) { setScreen(s); setProblem(null); window.scrollTo(0, 0); }

  // ── photos ──
  const setPhoto = useCallback((kind: PhotoKind, patch: Partial<PhotoItem>) => {
    setPhotos((p) => (p[kind] ? { ...p, [kind]: { ...p[kind]!, ...patch } } : p));
  }, []);
  async function uploadOne(id: string, kind: PhotoKind, blob: Blob): Promise<boolean> {
    setPhoto(kind, { status: 'uploading', reason: null });
    try {
      const v = await uploadPhoto(id, kind, blob, await freshAuth());
      setPhoto(kind, { status: v.status, reason: v.reason });
      capture('consult_photo_verdict', { kind, ok: v.status === 'accepted', reason: v.reason ?? 'accepted' });
      return v.status === 'accepted';
    } catch (e) {
      captureException(e, { where: 'consult_book_photo_upload', kind });
      setPhoto(kind, { status: 'error', reason: 'We couldn’t upload that photo.' });
      return false;
    }
  }
  function onShot(kind: PhotoKind, blob: Blob) {
    const old = photosRef.current[kind];
    if (old) URL.revokeObjectURL(old.url);
    setPhotos((p) => ({ ...p, [kind]: { blob, url: URL.createObjectURL(blob), status: 'local' } }));
    const c = created.current;
    if (c && c.booking.status === 'held') void uploadOne(c.booking.id, kind, blob); // booking exists: retake goes straight up
  }
  function onClearPhoto(kind: PhotoKind) {
    const old = photosRef.current[kind];
    if (old) URL.revokeObjectURL(old.url);
    setPhotos((p) => { const n = { ...p }; delete n[kind]; return n; });
  }
  const badPhoto = Object.entries(photos).find(([, v]) => v && (v.status === 'rejected' || v.status === 'error'));
  const photoIssue = badPhoto ? `${badPhoto[1]!.reason || 'We couldn’t read one of your photos.'}` : null;

  // ── intake ──
  function buildIntake(): Intake {
    switch (discipline) {
      case 'astrology': return astroIntake(astro);
      case 'numerology': return numeroIntake(numero);
      case 'palmistry': return palmIntake(palm);
      case 'face_reading': return faceIntake(face);
      default: return tarotIntake(tarot);
    }
  }
  function detailsProblem(): string | null {
    if (discipline === 'astrology') return astroProblem(astro);
    if (discipline === 'numerology') return numeroProblem(numero);
    if (discipline === 'palmistry') return palmProblem(palm);
    if (discipline === 'tarot') return !tarot.name.trim() ? 'Please add your name.' : null;
    return null;
  }
  const hasMedia = discipline === 'palmistry' || discipline === 'face_reading' || discipline === 'tarot';
  const kinds = photoKinds(discipline, palm.hand);
  function afterDetails() {
    const p = detailsProblem();
    if (p) { setProblem(p); return; }
    go(hasMedia ? 'media' : 'slotpay');
  }
  function afterMedia() {
    if (discipline === 'tarot') {
      const p = tarotProblem(tarot);
      if (p) { setProblem(p); return; }
    } else if (!photos[kinds[0].kind]) { setProblem('Please add your photo first.'); return; }
    go('slotpay');
  }

  // ── booking + pay ──
  async function ensureBooking(auth: string, intake: Intake, slot: number, qs: string[]) {
    const sig = discipline + intakeSignature(intake, slot, qs);
    const cur = created.current;
    if (cur && cur.sig === sig && cur.booking.status === 'held' && (cur.booking.expires_at ?? 0) > Date.now() + 5000) return cur;
    if (cur) {
      await cancelBooking(cur.booking.id, auth).catch((e) => captureException(e, { where: 'consult_book_recancel' }));
      created.current = null;
      newKey();
      setPhotos((p) => {
        const n: Partial<Record<PhotoKind, PhotoItem>> = {};
        for (const [k, v] of Object.entries(p) as [PhotoKind, PhotoItem][]) n[k] = { ...v, status: 'local', reason: null };
        return n;
      });
    }
    const key = ss('get', KEY_RK) || newKey();
    const r = await createBooking({ slug, discipline, slot_start_ms: slot, intake, questions: qs, request_key: key, terms: true, refund_policy: true }, auth);
    const made = { sig, booking: r.booking, pay: r.pay };
    created.current = made;
    ss('set', KEY_ACTIVE, JSON.stringify({ slug, id: r.booking.id, pay: r.pay }));
    return made;
  }
  const onBooking = useCallback((b: BookingDTO) => {
    setBooking(b);
    if ((b.status === 'confirmed' || b.status === 'in_call' || b.status === 'completed') && !reported.current) {
      reported.current = true;
      capture('consult_pay_result', { method: ss('get', 'consult:method') || 'upi', ok: true, reason: 'confirmed' });
      ss('del', KEY_ACTIVE); ss('del', KEY_RK);
      created.current = null;
      setScreen('done'); window.scrollTo(0, 0);
    } else if ((b.status === 'expired' || b.status === 'cancelled') && !reported.current) {
      reported.current = true;
      capture('consult_pay_result', { method: 'upi', ok: false, reason: b.status });
    }
  }, []);

  async function handlePay() {
    if (!slotMs || !agree) return;
    setBusy(true); setPayErr(null); reported.current = false;
    ss('set', 'consult:method', method);
    capture('consult_pay_started', { method, discipline });
    try {
      const auth = await freshAuth();
      const qs = questions.map((q) => q.trim()).filter(Boolean);
      const c = await ensureBooking(auth, buildIntake(), slotMs, qs);
      if (hasMedia && discipline !== 'tarot') {
        let ok = true;
        for (const [k, v] of Object.entries(photosRef.current) as [PhotoKind, PhotoItem][]) {
          if (v.status === 'accepted') continue;
          if (!(await uploadOne(c.booking.id, k, v.blob))) ok = false;
        }
        if (!ok) { capture('consult_pay_result', { method, ok: false, reason: 'photo_rejected' }); go('media'); setProblem('One of your photos needs to be retaken.'); return; }
      }
      if (method === 'wallet') {
        await payWallet(c.booking.id, auth);
        let b = (await getBooking(c.booking.id, auth)).booking;
        for (let i = 0; i < 3 && b.status !== 'confirmed'; i++) { await new Promise((r) => window.setTimeout(r, 1200)); b = (await getBooking(c.booking.id, auth)).booking; }
        if (b.status === 'confirmed') onBooking(b);
        else { setPayErr('Your wallet payment went through but the booking is still confirming. Check My consultations in a minute.'); capture('consult_pay_result', { method, ok: false, reason: 'confirming' }); }
      } else {
        setBooking(c.booking); setPay(c.pay); go('upi');
      }
    } catch (e) {
      const reason = e instanceof ApiError ? e.error : 'error';
      captureException(e, { where: 'consult_book_pay', method });
      capture('consult_pay_result', { method, ok: false, reason });
      if (e instanceof ApiError && e.status === 409) { setSlotMs(null); created.current = null; ss('del', KEY_ACTIVE); newKey(); }
      setPayErr(consultMessage(e, 'We couldn’t start your payment. Please try again.'));
    } finally { setBusy(false); }
  }
  function restart() {
    ss('del', KEY_ACTIVE); newKey();
    created.current = null; reported.current = false;
    setBooking(null); setPay(null); setSlotMs(null);
    go('slotpay');
  }

  // ── render ──
  const cat = CAT[discipline];
  const rootCls = `consult-ui cb-root ${cat}`;
  const gateChecking = gate === 'checking' && (Boolean(user) || (!userLoaded && sessionHint));

  if (gate !== 'ok') {
    return (
      <div className={rootCls}>
        <div className="cb-body">
          {gateChecking ? <p role="status">Checking your account…</p> : (
            <div className="sthc">
              <YouStep shop signedIn={Boolean(user)} listingId="consult" eventType="havan" copy={YOU_COPY} stepIndex={1} totalSteps={4}
                onSignedIn={() => { gateStarted.current = true; void checkGate(); }} onVerified={() => { gateStarted.current = true; void checkGate(); }} />
            </div>
          )}
        </div>
      </div>
    );
  }
  if (!consultant && !(screen === 'done' && booking)) {
    return (
      <div className={rootCls}>
        <div className="cb-state">
          {loadState === 'missing' || loadState === 'error'
            ? <><h2>{loadState === 'missing' && !preview.loading ? 'This consultant isn’t available yet' : 'We couldn’t load this page'}</h2><p className="muted" style={{ marginTop: 8 }}>{loadState === 'missing' ? 'Please check back soon.' : 'Please refresh and try again.'}</p><p style={{ marginTop: 16 }}><a className="btn ghost" href="/">Back to home</a></p></>
            : <p role="status">Loading…</p>}
        </div>
      </div>
    );
  }

  const label = DISCIPLINE_LABEL[discipline].en;
  const first = consultant ? firstName(consultant.name) : '';
  const header: ReactNode = consultant && (
    <header className="topbar cb-head">
      <img className="sticker" src={consultant.photo_url} alt="" />
      <div className="cb-head-txt"><strong>{consultant.name}</strong><span className="hint">{label} · {consultant.slot_minutes} min{preview.preview ? ' · Preview' : ''}</span></div>
    </header>
  );
  const back = (to: Screen, text: string) => <button type="button" className="edit left" onClick={() => go(to)}>← {text}</button>;
  const catBtn = discipline === 'astrology' ? 'btn' : 'btn cat';

  if (screen === 'done' && booking) {
    return <div className={rootCls}><DonePanel booking={booking} waMasked={waMasked} email={user?.primaryEmailAddress?.emailAddress ?? ''} /></div>;
  }

  if (screen === 'media' && (discipline === 'palmistry' || discipline === 'face_reading')) {
    return (
      <div className={rootCls} style={{ background: 'transparent' }}>
        <PhotoStep discipline={discipline} kinds={kinds} hand={palm.hand} photos={photos} onShot={onShot} onClear={onClearPhoto}
          onBack={() => go('details')} onDone={() => afterMedia()} />
        {problem && <p className="cb-err" role="alert" style={{ padding: '0 16px 16px' }}>{problem}</p>}
      </div>
    );
  }

  let body: ReactNode;
  if (screen === 'details') {
    const nextText = discipline === 'palmistry' || discipline === 'face_reading' ? 'Continue — add your photo' : discipline === 'tarot' ? 'Continue — draw your cards' : 'Continue — pick a time';
    body = (
      <div className="cb-body">
        <div className="cb-prog"><div className="steps"><span className="on" /><span /><span /><span /></div><span className="label">Step 1 of 4 · {stepTitle(discipline)}</span></div>
        {consultant && consultant.disciplines.length > 1 && (
          <div className="cb-chips" role="group" aria-label="What kind of session">
            {consultant.disciplines.map((d) => (
              <button key={d} type="button" className={`slot${d === discipline ? ' on' : ''}`} aria-pressed={d === discipline} onClick={() => { setDiscipline(d); setProblem(null); }}>{DISCIPLINE_LABEL[d].en}</button>
            ))}
          </div>
        )}
        {discipline === 'astrology' && <AstroDetails f={astro} set={setAstro} prefilled={prefilled} consultant={first} />}
        {discipline === 'numerology' && <NumeroDetails f={numero} set={setNumero} consultant={first} />}
        {discipline === 'palmistry' && <PalmDetails f={palm} set={setPalm} />}
        {discipline === 'face_reading' && <FaceDetails f={face} set={setFace} />}
        {discipline === 'tarot' && <TarotDetails f={tarot} set={setTarot} />}
        {problem && <p className="cb-err" role="alert">{problem}</p>}
        <button type="button" className={catBtn} onClick={afterDetails}>{nextText}</button>
      </div>
    );
  } else if (screen === 'media' && discipline === 'tarot') {
    body = (
      <div className="cb-body">
        {back('details', 'Back to your details')}
        <div className="cb-prog"><div className="steps"><span className="on" /><span className="on" /><span /><span /></div><span className="label">Step 2 of 4 · Draw your cards</span></div>
        <TarotStep f={tarot} set={setTarot} error={problem} onContinue={afterMedia} />
      </div>
    );
  } else if (screen === 'slotpay' && consultant && token) {
    body = (
      <div className="cb-body wide">
        {back(hasMedia ? 'media' : 'details', hasMedia ? 'Back' : 'Back to your details')}
        <SlotPay slug={slug} auth={token} consultantFirst={first} slotMs={slotMs} onSlot={setSlotMs} questions={questions} onQuestions={setQuestions}
          price={booking?.price ?? consultant.price} walletBalance={wallet} method={method} onMethod={setMethod} agree={agree} onAgree={setAgree}
          busy={busy} error={payErr} photoIssue={photoIssue} onRetakePhotos={() => go('media')} onPay={() => void handlePay()} />
      </div>
    );
  } else if (screen === 'upi' && booking && pay) {
    body = (
      <div className="cb-body">
        <div className="cb-prog"><div className="steps"><span className="on" /><span className="on" /><span className="on" /><span className="on" /></div><span className="label">Step 4 of 4 · Pay</span></div>
        <UpiPanel booking={booking} pay={pay} getAuth={freshAuth} onBooking={onBooking} onRestart={restart} />
      </div>
    );
  } else {
    body = <div className="cb-state"><p role="status">Loading…</p></div>;
  }
  return <div className={rootCls}>{header}{body}</div>;
}

export function ConsultBook({ slug }: { slug: string }) {
  return (
    <IslandBoundary island="consult-book">
      <ClerkIsland>
        <Inner slug={slug} />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default ConsultBook;
