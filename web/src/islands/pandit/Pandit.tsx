/* [AUMFE-PANDIT-WEB-1] /pandit — the Pandit ji chat page. Signed out -> gate; account owes a WhatsApp number -> the
 * existing phone gate; launch flag off -> "opening soon"; no birth details -> birth card; otherwise the chat.
 * Built to the approved mockups (Gate / Onboard / Phone / Tablet / Chat). Phone < 768px, iPad 768-1099px (kundli strip),
 * desktop >= 1100px (kundli + memory column). Wire contract: islands/pandit/types.ts.
 *
 * Auth: ClerkIsland provides the single Clerk provider (same as /talk). A signed-out visitor sees the gate here instead of
 * being redirected, and its buttons go to /sign-in and come back. The WhatsApp rule is the same as Dashboard 2 / Voice:
 * state.needs_phone -> finishUrl() (the /sign-up?finish=1 phone gate) and back.
 * Speed: this island is only on /pandit; the homepage band is static HTML. Brand name only through BRAND. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { signInUrlForHere } from '../../lib/authRedirect';
import { capture, captureException } from '../../lib/analytics';
import { finishUrl, getPhoneStatus } from '../auth/passwordless';
import { RichText } from '../preeti/richText';
import { ApiError } from '../../lib/apiClient';
import { deleteMemory, errMessage, getState, saveConsent, saveProfile, SignedOutError, streamChat } from './api';
import { BirthCard, CardView, KundliPanel, MemoryPanel, PanditAvatar, PanelsDrawer, SignInGate, WhySheet } from './parts';
import type { Card, PanditChart, PanditMemory, PanditMessage, PanditProfile, PanditState, ProfileInput } from './types';
import './pandit.css';

const GUEST_JWT_KEY = 'saathum_guest_jwt';

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* blocked storage: the choice just is not remembered */ } }
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ── auth state (hooks chosen once per build: with or without a Clerk key) ─────────────── */

interface AuthView { status: 'loading' | 'out' | 'in'; firstName: string | null }

function useAuthClerk(): AuthView {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  if (!isLoaded) return { status: 'loading', firstName: null };
  if (isSignedIn || lsGet(GUEST_JWT_KEY)) return { status: 'in', firstName: user?.firstName ?? null };
  return { status: 'out', firstName: null };
}
function useAuthGuest(): AuthView {
  return { status: lsGet(GUEST_JWT_KEY) ? 'in' : 'out', firstName: null };
}
const useAuthView = CLERK_PUBLISHABLE_KEY ? useAuthClerk : useAuthGuest;

/* ── languages: a hint only — the model answers in the language the person writes ───────── */

const LANGS: { label: string; speech: string; placeholder: string }[] = [
  { label: 'हिन्दी', speech: 'hi-IN', placeholder: 'पंडित जी से पूछिए…' },
  { label: 'English', speech: 'en-IN', placeholder: 'Ask Pandit ji…' },
  { label: 'Hinglish', speech: 'hi-IN', placeholder: 'Pandit ji se poochhiye…' },
  { label: 'தமிழ்', speech: 'ta-IN', placeholder: 'பண்டிட் ஜியிடம் கேளுங்கள்…' },
  { label: 'తెలుగు', speech: 'te-IN', placeholder: 'పండిట్ జీని అడగండి…' },
  { label: 'বাংলা', speech: 'bn-IN', placeholder: 'পণ্ডিত জিকে জিজ্ঞাসা করুন…' },
  { label: 'मराठी', speech: 'mr-IN', placeholder: 'पंडित जींना विचारा…' },
  { label: 'ગુજરાતી', speech: 'gu-IN', placeholder: 'પંડિત જીને પૂછો…' },
  { label: 'ಕನ್ನಡ', speech: 'kn-IN', placeholder: 'ಪಂಡಿತ್ ಜಿಯನ್ನು ಕೇಳಿ…' },
];
const LANG_KEY = 'pandit_lang';
const QUICK = ['Aaj ka shubh rang', 'Meri kundli samjhaiye', 'Puja suggest kijiye'];

function LangButton({ idx, onPick }: { idx: number; onPick: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="pd-lang" ref={wrap}>
      <button type="button" className="pd-lang-btn" aria-label="Change language" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{LANGS[idx].label} ▾</button>
      {open && (
        <div className="pd-lang-menu" role="group" aria-label="Language">
          {LANGS.map((l, i) => (
            <button key={l.label} type="button" aria-pressed={i === idx} onClick={() => { onPick(i); setOpen(false); }}>{l.label}</button>
          ))}
          <p>Just write in your language — Pandit ji replies in it.</p>
        </div>
      )}
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────────── */

type View = 'loading' | 'gate' | 'soon' | 'onboard' | 'chat' | 'error';

function Pandit() {
  const auth = useAuthView();
  const [view, setView] = useState<View>('loading');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [profile, setProfile] = useState<PanditProfile | null>(null);
  const [consent, setConsent] = useState(false);
  const [chart, setChart] = useState<PanditChart | null>(null);
  const [memories, setMemories] = useState<PanditMemory[]>([]);
  const [convId, setConvId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<PanditMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [why, setWhy] = useState<Card | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [langIdx, setLangIdx] = useState(1);
  const [listening, setListening] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const whyOpener = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);
  const shownCards = useRef<Set<string>>(new Set());
  const recRef = useRef<{ stop: () => void } | null>(null);

  const apply = useCallback((s: PanditState) => {
    setProfile(s.profile); setConsent(s.consent); setChart(s.chart); setMemories(s.memories ?? []);
  }, []);

  /* first paint: page view, saved language, ?ask= prefill */
  useEffect(() => {
    capture('pandit_page_view', { surface: 'pandit' });
    const saved = Number(lsGet(LANG_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < LANGS.length) setLangIdx(saved);
    try {
      const ask = new URLSearchParams(location.search).get('ask');
      if (ask) setDraft(ask.slice(0, 500));
    } catch { /* no URL support: ignore */ }
  }, []);

  /* load state once we know who this is */
  useEffect(() => {
    if (auth.status === 'loading') return undefined;
    if (auth.status === 'out') {
      setView('gate');
      capture('pandit_gate_shown', { surface: 'pandit' });
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const s = await getState();
        if (cancelled) return;
        // [AUMFE-PANDIT-WEB-2] Same WhatsApp rule as /talk and Dashboard 2 (getPhoneStatus), not the guides API's
        // raw contact read, which disagreed and looped verified users through /sign-up?finish=1. Fail open.
        let needsPhone = false;
        try { needsPhone = (await getPhoneStatus()).needs_phone === true; } catch (pe) { captureException(pe, { where: 'pandit_phone_gate' }); }
        if (cancelled) return;
        if (needsPhone) {
          capture('whatsapp_gate_shown', { surface: 'pandit' });
          location.replace(finishUrl(location.pathname + location.search));
          return;
        }
        apply(s);
        if (!s.can_use) { setView('soon'); return; } // can_use already covers the flag OR the admin list
        if (s.conversation) { setConvId(s.conversation.id); setMessages(s.conversation.messages ?? []); }
        setView(s.profile?.dob ? 'chat' : 'onboard');
      } catch (e) {
        if (cancelled) return;
        if (e instanceof SignedOutError || (e instanceof ApiError && e.status === 401)) {
          setView('gate');
          capture('pandit_gate_shown', { surface: 'pandit', reason: 'session_expired' });
          return;
        }
        captureException(e, { where: 'pandit_state' });
        setLoadErr(errMessage(e, 'We could not open Pandit ji just now. Please try again.'));
        setView('error');
      }
    })();
    return () => { cancelled = true; };
  }, [auth.status, apply]);

  /* keep the newest line in view unless the person scrolled up */
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, view]);
  useEffect(() => () => { abortRef.current?.abort(); recRef.current?.stop(); }, []);

  const refresh = useCallback(async () => {
    try { apply(await getState()); } catch { /* the panels just keep their last values */ }
  }, [apply]);

  const patchLast = useCallback((fn: (m: PanditMessage) => PanditMessage) => {
    setMessages((cur) => (cur.length ? [...cur.slice(0, -1), fn(cur[cur.length - 1])] : cur));
  }, []);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || streaming) return;
    stickRef.current = true;
    setDraft('');
    setMessages((cur) => [...cur, { role: 'user', text }, { role: 'assistant', text: '', cards: [] }]);
    setStreaming(true);
    capture('pandit_message_sent', { length: text.length, has_conversation: !!convId });
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = nowMs();
    let gotFirst = false;
    try {
      await streamChat({ conversation_id: convId, text }, {
        signal: ac.signal,
        onEvent: (ev) => {
          if (ev.type === 'meta') setConvId(ev.conversation_id);
          else if (ev.type === 'delta') {
            if (!gotFirst) { gotFirst = true; capture('pandit_first_token_ms', { ms: Math.round(nowMs() - t0) }); }
            patchLast((m) => ({ ...m, text: m.text + ev.text }));
          } else if (ev.type === 'card') {
            const key = `${ev.card.kind}:${ev.card.subject_id}`;
            if (!shownCards.current.has(key)) { shownCards.current.add(key); capture('pandit_card_shown', { kind: ev.card.kind, subject_id: ev.card.subject_id }); }
            patchLast((m) => ({ ...m, cards: [...(m.cards ?? []), ev.card] }));
          } else if (ev.type === 'error') {
            captureException(new Error(`pandit_stream_${ev.code}`), { where: 'pandit_stream', code: ev.code });
            patchLast((m) => ({ ...m, text: m.text || ev.message || 'Pandit ji could not answer just now. Please try again.' }));
          }
          /* 'tool' and 'done' need no UI beyond the streaming state */
        },
      });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        if (e instanceof SignedOutError || (e instanceof ApiError && e.status === 401)) {
          setView('gate');
        } else {
          captureException(e, { where: 'pandit_send' });
          const msg = e instanceof ApiError && e.status === 429
            ? 'Pandit ji is receiving many questions. Please wait a moment and try again.'
            : errMessage(e, 'Pandit ji could not answer just now. Please try again.');
          patchLast((m) => ({ ...m, text: m.text || msg }));
        }
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      void refresh();
    }
  }, [convId, streaming, patchLast, refresh]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  function onSubmit(e: FormEvent) { e.preventDefault(); void send(draft); }

  async function onSaveProfile(p: ProfileInput, wantConsent: boolean) {
    setSaving(true); setSaveErr(null);
    try {
      await saveProfile(p);
      await saveConsent(wantConsent);
      capture('pandit_profile_saved', { has_tob: !p.tob_unknown, consent: wantConsent });
      await refresh();
      setView('chat');
    } catch (e) {
      captureException(e, { where: 'pandit_profile_save' });
      setSaveErr(errMessage(e, 'We could not save your details. Please check them and try again.'));
    } finally { setSaving(false); }
  }

  async function onForget(id: string) {
    const before = memories;
    setMemories((m) => m.filter((x) => x.id !== id));
    try { await deleteMemory(id); } catch (e) { setMemories(before); captureException(e, { where: 'pandit_memory_delete' }); }
  }

  function openWhy(c: Card, opener: HTMLElement | null) {
    whyOpener.current = opener;
    setWhy(c);
    capture('pandit_why_opened', { subject_id: c.subject_id, kind: c.kind });
  }
  function closeWhy() {
    setWhy(null);
    const o = whyOpener.current;
    if (o) setTimeout(() => o.focus(), 0);
  }
  function onAdd(c: Card) { capture('pandit_add_to_cart', { subject_id: c.subject_id, kind: c.kind, price_inr: c.price_inr }); }

  function newTopic() {
    if (streaming) return;
    setConvId(undefined); setMessages([]); shownCards.current = new Set();
  }

  function pickLang(i: number) { setLangIdx(i); lsSet(LANG_KEY, String(i)); }

  function listen() {
    if (listening) { recRef.current?.stop(); return; }
    const W = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
    const Rec = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Rec) return;
    try {
      const r = new Rec();
      r.lang = LANGS[langIdx].speech; r.interimResults = false; r.maxAlternatives = 1;
      r.onresult = (ev: any) => { const t = ev.results?.[0]?.[0]?.transcript; if (typeof t === 'string') setDraft((d) => (d ? `${d} ${t}` : t)); };
      r.onend = () => { setListening(false); recRef.current = null; };
      r.onerror = () => { setListening(false); recRef.current = null; };
      recRef.current = r; setListening(true); r.start();
    } catch (e) { setListening(false); captureException(e, { where: 'pandit_speech' }); }
  }
  const canSpeak = useMemo(() => typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition), []);

  const name = (profile?.name || auth.firstName || '').trim();
  const signInHref = useMemo(() => (typeof location === 'undefined' ? '/sign-in' : signInUrlForHere()), []);

  /* ── non-chat views ─────────────────────────────────────────────────── */
  if (view === 'loading') {
    return <div className="pd pd-center" aria-busy="true"><p className="pd-lede">Opening Pandit ji…</p></div>;
  }
  if (view === 'gate') {
    return <div className="pd pd-center"><SignInGate signInHref={signInHref} onClick={(method) => capture('pandit_gate_clicked', { method })} /></div>;
  }
  if (view === 'soon') {
    return (
      <div className="pd pd-center">
        <section className="pd-gate" aria-labelledby="pd-soon-h" role="status">
          <PanditAvatar size={112} className="pd-gate-avatar" />
          <h1 id="pd-soon-h" className="pd-hd pd-gate-title">Pandit ji is opening soon</h1>
          <p className="pd-gate-lede">We are getting everything ready. Please visit again in a little while — your pranam has been noted.</p>
          <a className="pd-btn pd-btn-outline" href="/">Back to home</a>
        </section>
      </div>
    );
  }
  if (view === 'error') {
    return (
      <div className="pd pd-center">
        <section className="pd-gate" role="alert">
          <h1 className="pd-hd pd-gate-title">Something went wrong</h1>
          <p className="pd-gate-lede">{loadErr}</p>
          <button type="button" className="pd-btn pd-btn-red" onClick={() => location.reload()}>Try again</button>
        </section>
      </div>
    );
  }

  const header = (
    <div className="pd-phone-head">
      <PanditAvatar size={44} />
      <div className="pd-phone-who"><strong>Pandit ji</strong><span>Online</span></div>
      <LangButton idx={langIdx} onPick={pickLang} />
      {view === 'chat' && <button type="button" className="pd-menu-btn" aria-label="Your kundli and memory" onClick={() => setDrawer(true)}>☰</button>}
    </div>
  );

  if (view === 'onboard') {
    return (
      <div className="pd pd-view-onboard">
        {header}
        <div className="pd-onboard-wrap">
          <BirthCard firstName={auth.firstName} profile={profile} initialConsent={consent} busy={saving} error={saveErr} onSubmit={(p, c) => void onSaveProfile(p, c)} />
          {profile?.dob && <button type="button" className="pd-link pd-cancel-edit" onClick={() => setView('chat')}>Back to chat</button>}
        </div>
      </div>
    );
  }

  /* ── chat ───────────────────────────────────────────────────────────── */
  const panels = (
    <>
      <KundliPanel profile={profile} chart={chart} onEdit={() => { setDrawer(false); setView('onboard'); }} />
      <MemoryPanel memories={memories} consent={consent} onDelete={(id) => void onForget(id)} />
    </>
  );
  const lastIdx = messages.length - 1;

  return (
    <div className="pd pd-view-chat">
      {header}
      <div className="pd-grid">
        <aside className="pd-aside" aria-label="Your chart and memory">{panels}</aside>

        <main className="pd-main" id="pd-main">
          <section className="pd-strip" aria-label="Your kundli">
            <strong>Aapki kundli</strong>
            {chart ? (
              <>
                <span><em>Lagna</em> <b>{chart.lagna}</b></span>
                <span><em>Rashi</em> <b>{chart.moon_sign}</b></span>
                <span><em>Nakshatra</em> <b>{chart.nakshatra}</b></span>
                <span><em>Dasha</em> <b>{chart.dasha}</b></span>
              </>
            ) : <span className="pd-strip-wait">Being prepared…</span>}
            <button type="button" className="pd-link pd-strip-more" onClick={() => setDrawer(true)}>Details &amp; memory</button>
          </section>

          <div className="pd-chat">
            <div className="pd-chat-head">
              <PanditAvatar size={52} className="pd-avatar-lg" />
              <div className="pd-chat-who"><strong>Pandit ji</strong><span>● Online</span></div>
              <LangButton idx={langIdx} onPick={pickLang} />
              <button type="button" className="pd-ghost-btn" onClick={newTopic} disabled={streaming}>New topic</button>
            </div>

            <div
              className="pd-log" ref={logRef} role="log" aria-live="polite" aria-busy={streaming} aria-label="Conversation with Pandit ji" tabIndex={0}
              onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
            >
              {messages.length === 0 && (
                <div className="pd-bubble pd-bubble-bot">Pranam{name ? ` ${name} ji` : ' ji'}! Aaj main aapki kya madad kar sakta hoon? Kaam, parivaar, sehat ya mann ki shanti — jo bhi poochhna ho, poochhiye.</div>
              )}
              {messages.map((m, i) => (
                m.role === 'user' ? (
                  <div key={i} className="pd-bubble pd-bubble-user">{m.text}</div>
                ) : (
                  <div key={i} className="pd-bot-block">
                    {(m.text || (streaming && i === lastIdx)) && (
                      <div className="pd-bubble pd-bubble-bot">
                        {m.text ? <RichText text={m.text} /> : <span className="pd-thinking">Pandit ji soch rahe hain…</span>}
                        {streaming && i === lastIdx && m.text && <span className="pd-caret" aria-hidden="true" />}
                      </div>
                    )}
                    {m.cards && m.cards.length > 0 && (
                      <div className="pd-cards">
                        {m.cards.map((c) => <CardView key={`${c.kind}-${c.subject_id}`} card={c} onWhy={openWhy} onAdd={onAdd} />)}
                      </div>
                    )}
                  </div>
                )
              ))}
            </div>

            <div className="pd-composer">
              <div className="pd-quick">
                {QUICK.map((q) => <button key={q} type="button" disabled={streaming} onClick={() => void send(q)}>{q}</button>)}
              </div>
              <form className="pd-input-row" onSubmit={onSubmit}>
                <label className="pd-input-label">
                  <span className="pd-sr">Message</span>
                  <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={LANGS[langIdx].placeholder} maxLength={2000} autoComplete="off" enterKeyHint="send" />
                </label>
                {canSpeak && (
                  <button type="button" className={`pd-round pd-round-mic ${listening ? 'pd-on' : ''}`} aria-label={listening ? 'Stop listening' : 'Speak'} aria-pressed={listening} onClick={listen}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
                  </button>
                )}
                {streaming ? (
                  <button type="button" className="pd-round pd-round-send" aria-label="Stop reply" onClick={stop}>
                    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="#fffaf0" /></svg>
                  </button>
                ) : (
                  <button type="submit" className="pd-round pd-round-send" aria-label="Send" disabled={!draft.trim()}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fffaf0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-2-7z" /></svg>
                  </button>
                )}
              </form>
              <p className="pd-fine">Traditional spiritual guidance — not a guarantee, and not medical, legal or financial advice.</p>
            </div>
          </div>
        </main>
      </div>

      {why && <WhySheet card={why} onClose={closeWhy} onAdd={onAdd} />}
      {drawer && <PanelsDrawer onClose={() => setDrawer(false)}>{panels}</PanelsDrawer>}
    </div>
  );
}

export default function PanditApp() {
  return (
    <IslandBoundary island="pandit">
      <ClerkIsland>
        <Pandit />
      </ClerkIsland>
    </IslandBoundary>
  );
}
