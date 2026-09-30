// [SAATHUM-PREETI-1 2026-09-30] Public chat widget for Preeti, the site AI helper.
// Spec: Specs/SPEC-2026-09-30-PREETI-AI-AGENT.md ("Web" + "Public API").
//
// Mounted lazily (client:idle) by components/PreetiMount.astro. Renders nothing
// when the agent is disabled or the config fetch fails - it must never break the
// host page. Auth: a <ClerkIsland> is mounted beside the widget ONLY for a signed-in visitor (WEB-PERF-1);
// the session call carries the Clerk bearer (lib/clerk.getActiveToken) when the
// visitor is signed in, otherwise the conversation is keyed by visitor_id only.
import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as RKeyboardEvent, ReactNode } from 'react';
// [WEB-PERF-1 2026-09-30] lib/clerk is NOT imported statically any more. It
// drags in @clerk/clerk-react plus ~300 KB of clerk-js from the Clerk CDN, and
// this widget mounts on the home, ritual and event pages for EVERY visitor.
// Signed-out visitors never need it (their chat is keyed by visitor_id), so it
// loads only when the Clerk session cookie says someone is signed in, and then
// in the background after the widget has already rendered.
const loadClerk = () => import('../../lib/clerk');
const LazyClerkIsland = lazy(() => loadClerk().then((m) => ({ default: m.ClerkIsland })));
/** Same cookie test the header uses (SiteHeader.astro) — no Clerk needed to ask. */
function hasClerkSessionHint(): boolean {
  try {
    const m = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
    return Boolean(m && m[1] && m[1] !== '0');
  } catch {
    return false;
  }
}
import { ApiError } from '../../lib/apiClient';
import { cfImage } from '../../lib/config';
import { capture, captureException } from '../../lib/analytics';
import { apiMessage, getPreetiConfig, identifyPreeti, openPreetiSession, streamPreetiChat } from '../../lib/preetiApi';
import type { PageCtx, PageKind, PreetiCard, PreetiPublicConfig } from '../../lib/preetiTypes';
import { CardView } from './Cards';
import { IdentityCard } from './IdentityCard';
import { RichText } from './richText';
import { BUBBLE, EDGE, useBubble } from './useBubble';
import { KEY_CONVERSATION, KEY_SKIP, getVisitorId, lsGet, lsSet } from './storage';
import './preeti.css';

const MAX_CHARS = 2000;
const COUNTER_AT = 1800;
const PANEL_W = 380;
const PANEL_H = 560;
const SIGNIN_TEXT = 'Mujhse baat karne ke liye kripya apne WhatsApp number se sign in karein 🙏 Isse chat surakshit rehti hai aur main aapki baat yaad rakh paungi.';
const RATE_TEXT = 'Thoda ruk kar phir likhiye 🙏';
const BUSY_TEXT = 'Abhi main thodi busy hoon. Kripya hamari team ko WhatsApp kariye, wo turant madad karenge 🙏';
const LANGS = ['Hinglish', 'हिंदी', 'English'];

interface ChatMsg {
  id: string;
  role: 'visitor' | 'preeti';
  text: string;
  cards: PreetiCard[];
  handoverUrl?: string;
}

class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { captureException(err, { island: 'preeti_chat' }); }
  render() { return this.state.failed ? null : this.props.children; }
}

function useMedia(query: string): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

function whatsappUrl(cfg: PreetiPublicConfig, conversationId: string): string {
  const digits = cfg.support_whatsapp_e164.replace(/\D/g, '');
  const text = `Hi, I was chatting with ${cfg.agent_name} on ${cfg.brand_name}. Ref: ${conversationId}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function Avatar({ cfg, size }: { cfg: PreetiPublicConfig; size: number }) {
  const [bad, setBad] = useState(false);
  const initial = (cfg.agent_name || '?').trim().charAt(0).toUpperCase();
  return (
    <span className="pt-avatar" style={{ width: size, height: size }}>
      {cfg.avatar_url && !bad ? (
        // [WEB-PERF-2 2026-09-30] The admin-uploaded avatar is the raw upload
        // (a 1.7 MB PNG). Served as-is it held the page's `load` event back
        // ~15 s on mobile data, and with it every "load later" task. Ask the
        // image service for a small AVIF at 2x the drawn size (~7 KB).
        <img src={cfImage(cfg.avatar_url, { width: size * 2, quality: 70 })} alt="" width={size} height={size} onError={() => setBad(true)} decoding="async" />
      ) : (
        <span className="pt-avatar-initial" aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}

function Widget({ kind, pageRef }: { kind: PageKind; pageRef?: string }) {
  const [cfg, setCfg] = useState<PreetiPublicConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [fs, setFs] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [needsIdentity, setNeedsIdentity] = useState(false);
  const [needsSignin, setNeedsSignin] = useState(false); // [SAATHUM-PREETI-SIGNIN-1]
  const [sessionState, setSessionState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [announce, setAnnounce] = useState('');
  const isPhone = useMedia('(max-width: 639.98px)');

  const seq = useRef(0);
  const nid = () => `m${++seq.current}`;
  const visitorRef = useRef('');
  const signedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const closeTimer = useRef<number | undefined>(undefined);

  const page: PageCtx = {
    path: typeof window !== 'undefined' ? window.location.pathname : '/',
    kind,
    ...(pageRef ? { ref: pageRef } : {}),
  };

  // ---- config (never breaks the page) ----
  useEffect(() => {
    const ctrl = new AbortController();
    getPreetiConfig(ctrl.signal)
      .then((c) => { if (c?.enabled) setCfg(c); })
      .catch((e) => {
        if (!ctrl.signal.aborted) captureException(e, { surface: 'preeti_config' });
      });
    return () => { ctrl.abort(); abortRef.current?.abort(); window.clearTimeout(closeTimer.current); };
  }, []);

  // ---- hide while any player is fullscreen ----
  useEffect(() => {
    const on = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const bubble = useBubble(() => toggle());

  // ---- session ----
  const startSession = useCallback(async (c: PreetiPublicConfig) => {
    setSessionState('loading');
    visitorRef.current = getVisitorId();
    const saved = lsGet(KEY_CONVERSATION) ?? undefined;
    const body = { visitor_id: visitorRef.current, ...(saved ? { conversation_id: saved } : {}), page };
    try {
      let token = hasClerkSessionHint()
        ? await loadClerk().then((m) => m.getActiveTokenWaited(4000)).catch(() => null)
        : null;
      let sess;
      try {
        sess = await openPreetiSession(body, token);
        signedRef.current = Boolean(token);
      } catch (e) {
        if (token && e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          token = null;
          sess = await openPreetiSession(body, null);
          signedRef.current = false;
        } else throw e;
      }
      if (sess.needs_signin) {
        // [SAATHUM-PREETI-SIGNIN-1] Only signed-in visitors with a verified WhatsApp may chat.
        setNeedsSignin(true);
        setNeedsIdentity(false);
        setMessages([{ id: nid(), role: 'preeti', text: c.welcome_text, cards: [] }]);
        setSessionState('ready');
        return;
      }
      setNeedsSignin(false);
      lsSet(KEY_CONVERSATION, sess.conversation_id);
      setConvId(sess.conversation_id);
      const skipped = lsGet(KEY_SKIP) === sess.conversation_id;
      setNeedsIdentity(sess.needs_identity && !skipped);
      const hist: ChatMsg[] = sess.history.map((h) => ({ id: `h${h.id}`, role: h.role, text: h.text, cards: h.cards ?? [] }));
      if (hist.length === 0) {
        const first: ChatMsg[] = [{ id: nid(), role: 'preeti', text: c.welcome_text, cards: [] }];
        if (c.over_budget) first.push({ id: nid(), role: 'preeti', text: BUSY_TEXT, cards: [], handoverUrl: whatsappUrl(c, sess.conversation_id) });
        setMessages(first);
      } else {
        setMessages(hist);
      }
      setSessionState('ready');
    } catch (e) {
      captureException(e, { surface: 'preeti_session' });
      setMessages([{ id: nid(), role: 'preeti', text: BUSY_TEXT, cards: [], handoverUrl: whatsappUrl(c, visitorRef.current) }]);
      setSessionState('failed');
    }
  }, [kind, pageRef]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle() {
    if (open) closePanel();
    else openPanel();
  }

  function openPanel() {
    if (!cfg) return;
    window.clearTimeout(closeTimer.current);
    setMounted(true);
    setOpen(true);
    capture('preeti_opened', { page_kind: kind, ref: pageRef ?? null, signed_in: signedRef.current });
    if (sessionState === 'idle') void startSession(cfg);
  }

  function closePanel() {
    setOpen(false);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer.current = window.setTimeout(() => setMounted(false), reduce ? 0 : 180);
    bubbleRef.current?.focus();
  }

  // focus on open; lock page scroll on phones
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      (isPhone ? panelRef.current : inputRef.current)?.focus({ preventScroll: true });
    }, 30);
    let prev = '';
    if (isPhone) { prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    return () => { window.clearTimeout(t); if (isPhone) document.body.style.overflow = prev; };
  }, [open, isPhone]);

  // keep the thread pinned to the newest content
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing, needsIdentity, open, sessionState]);

  // autosize the textarea
  useLayoutEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(120, t.scrollHeight)}px`;
  }, [draft, open]);

  function onKeyDownPanel(e: RKeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape') { e.stopPropagation(); closePanel(); return; }
    if (e.key !== 'Tab') return;
    const nodes = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  // ---- sending ----
  const appendMsg = (m: Omit<ChatMsg, 'id'>) => setMessages((ms) => [...ms, { ...m, id: nid() }]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!cfg || !convId || !text || text.length > MAX_CHARS || busy) return;
    const pid = nid();
    setMessages((ms) => [...ms, { id: nid(), role: 'visitor', text, cards: [] }, { id: pid, role: 'preeti', text: '', cards: [] }]);
    setDraft('');
    setBusy(true);
    setTyping(true);
    stick.current = true;
    capture('preeti_message_sent', { length: text.length, page_kind: kind });
    const patch = (fn: (m: ChatMsg) => ChatMsg) => setMessages((ms) => ms.map((m) => (m.id === pid ? fn(m) : m)));
    const handover = (url: string, t: string) => appendMsg({ role: 'preeti', text: t, cards: [], handoverUrl: url });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let finalText = '';
    try {
      const auth = signedRef.current ? await loadClerk().then((m) => m.getActiveToken()).catch(() => null) : null;
      await streamPreetiChat(
        { conversation_id: convId, visitor_id: visitorRef.current, message: text, page },
        {
          auth,
          signal: ctrl.signal,
          onEvent: (ev) => {
            if (ev.type === 'delta') {
              setTyping(false);
              finalText += ev.text;
              patch((m) => ({ ...m, text: m.text + ev.text }));
            } else if (ev.type === 'card') {
              setTyping(false);
              patch((m) => ({ ...m, cards: [...m.cards, ev.card] }));
            } else if (ev.type === 'handover') {
              handover(ev.url, 'Aap seedha hamari team se WhatsApp par baat kar sakte hain.');
            } else if (ev.type === 'error') {
              if (ev.code === 'rate_limited') appendMsg({ role: 'preeti', text: RATE_TEXT, cards: [] });
              else {
                if (ev.code !== 'over_budget') captureException(new Error(`preeti_stream_error:${ev.code}`), { surface: 'preeti_chat', code: ev.code });
                handover(whatsappUrl(cfg, convId), BUSY_TEXT);
              }
            }
          },
        },
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        if (e instanceof ApiError && e.status === 429) appendMsg({ role: 'preeti', text: RATE_TEXT, cards: [] });
        else if (e instanceof ApiError && e.status === 401) { patch((m) => ({ ...m, text: SIGNIN_TEXT })); setNeedsSignin(true); }
        else {
          captureException(e, { surface: 'preeti_chat' });
          handover(whatsappUrl(cfg, convId), BUSY_TEXT);
        }
      }
    } finally {
      setBusy(false);
      setTyping(false);
      setMessages((ms) => ms.filter((m) => !(m.id === pid && !m.text && m.cards.length === 0)));
      if (finalText) setAnnounce(finalText.replace(/\*\*/g, ''));
      abortRef.current = null;
    }
  }, [cfg, convId, busy, kind, pageRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitIdentity = useCallback(async (name: string, whatsapp: string): Promise<string | null> => {
    if (!convId) return 'Please try again in a moment.';
    try {
      await identifyPreeti({ conversation_id: convId, visitor_id: visitorRef.current, name, whatsapp });
      capture('preeti_identified', { page_kind: kind, country_code: whatsapp.startsWith('+91') ? '+91' : 'intl' });
      setNeedsIdentity(false);
      appendMsg({ role: 'preeti', text: `Dhanyavaad, ${name} 🙏 Ab bataiye, main aapki kaise madad kar sakti hoon?`, cards: [] });
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) return apiMessage(e) ?? 'Please check your WhatsApp number.';
      captureException(e, { surface: 'preeti_identify' });
      return 'Something went wrong. You can skip for now and continue chatting.';
    }
  }, [convId, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  function skipIdentity() {
    if (convId) lsSet(KEY_SKIP, convId);
    setNeedsIdentity(false);
  }

  function trackHandover(source: string) {
    capture('preeti_handover', { source, page_kind: kind });
  }

  if (!cfg || fs) return null;

  const hasVisitorMsg = messages.some((m) => m.role === 'visitor');
  const overBudget = cfg.over_budget;
  const canType = sessionState === 'ready' && !overBudget && !needsSignin;
  const signInHref = typeof window === 'undefined' ? '/sign-in' : `/sign-in?redirect_url=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  const qr = cfg.quick_replies[kind === 'other' ? 'home' : kind] ?? [];
  const ref = convId ?? visitorRef.current;
  const humanUrl = whatsappUrl(cfg, ref);

  // desktop panel placement: beside the bubble, on whichever side has room
  const { vp } = bubble;
  const rest = bubble.restRect;
  const panelH = Math.min(PANEL_H, vp.h - 2 * EDGE);
  const roomLeft = rest.x - 12 - PANEL_W >= EDGE;
  const roomRight = rest.x + BUBBLE + 12 + PANEL_W <= vp.w - EDGE;
  const wantLeft = bubble.side === 'right' ? roomLeft || !roomRight : !roomRight && roomLeft;
  const px = Math.max(EDGE, Math.min(vp.w - EDGE - PANEL_W, wantLeft ? rest.x - 12 - PANEL_W : rest.x + BUBBLE + 12));
  const py = Math.max(EDGE, Math.min(vp.h - EDGE - panelH - vp.inset, rest.y + BUBBLE - panelH));

  const bubbleStyle = { transform: `translate3d(${bubble.rect.x}px, ${bubble.rect.y}px, 0)` };

  return (
    <div className="pt-root">
      {!(open && isPhone) && (
        <button
          ref={bubbleRef}
          type="button"
          className={`pt-bubble${bubble.dragging ? ' pt-bubble--drag' : ''}`}
          style={bubbleStyle}
          aria-label={open ? `Close chat with ${cfg.agent_name}` : `Chat with ${cfg.agent_name}, ${cfg.brand_name} AI helper`}
          aria-expanded={open}
          onClick={(e) => { if (e.detail === 0) toggle(); }}
          {...bubble.handlers}
        >
          <Avatar cfg={cfg} size={BUBBLE - 6} />
          <span className="pt-online" aria-hidden="true" />
        </button>
      )}

      {mounted && (
        <section
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="pt-title"
          tabIndex={-1}
          className={`pt-panel${isPhone ? ' pt-panel--sheet' : ''}${open ? '' : ' pt-panel--out'}`}
          style={isPhone ? undefined : { left: px, top: py, width: PANEL_W, height: panelH }}
          onKeyDown={onKeyDownPanel}
        >
          <header className="pt-head">
            <Avatar cfg={cfg} size={40} />
            <div className="pt-head-text">
              <h2 id="pt-title" className="pt-name">{cfg.agent_name}</h2>
              <p className="pt-sub">{`${cfg.brand_name} AI helper`}</p>
            </div>
            <a
              className="pt-btn pt-btn--human"
              href={humanUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackHandover('header')}
            >
              Talk to a human
            </a>
            <button type="button" className="pt-close" aria-label="Close chat" onClick={closePanel}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></svg>
            </button>
          </header>

          <div
            ref={listRef}
            className="pt-thread"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
          >
            {sessionState === 'loading' && <p className="pt-status">Ek minute...</p>}
            {messages.map((m) => (
              <div key={m.id} className={`pt-row pt-row--${m.role}`}>
                {(m.text || m.handoverUrl) && (
                  <div className={`pt-msg pt-msg--${m.role}`}>
                    {m.text && <RichText text={m.text} />}
                    {m.handoverUrl && (
                      <a
                        className="pt-btn pt-btn--wa"
                        href={m.handoverUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => trackHandover('message')}
                      >
                        Chat with our team on WhatsApp
                      </a>
                    )}
                  </div>
                )}
                {m.cards.map((c, i) => (
                  <CardView
                    key={`${m.id}-c${i}`}
                    card={c}
                    onClick={(type, id, action) => capture('preeti_card_clicked', { type, id, action, page_kind: kind })}
                  />
                ))}
              </div>
            ))}
            {typing && (
              <div className="pt-row pt-row--preeti" aria-hidden="true">
                <div className="pt-msg pt-msg--preeti pt-typing"><i /><i /><i /></div>
              </div>
            )}

            {sessionState === 'ready' && needsSignin && (
              <div className="pt-identity">
                <p className="pt-identity-help">{SIGNIN_TEXT}</p>
                <a className="pt-chip pt-chip--q" href={signInHref} onClick={() => capture('preeti_signin_clicked', { page_kind: kind })}>Sign in with WhatsApp to chat</a>
              </div>
            )}
            {sessionState === 'ready' && !needsSignin && !hasVisitorMsg && !overBudget && (
              <div className="pt-chips" role="group" aria-label="Choose a language">
                {LANGS.map((l) => (
                  <button key={l} type="button" className="pt-chip" onClick={() => void send(l)}>{l}</button>
                ))}
              </div>
            )}
            {sessionState === 'ready' && !needsSignin && needsIdentity && !overBudget && (
              <IdentityCard onSubmit={submitIdentity} onSkip={skipIdentity} />
            )}
            {sessionState === 'ready' && !needsSignin && !hasVisitorMsg && !overBudget && qr.length > 0 && (
              <div className="pt-chips" role="group" aria-label="Suggested questions">
                {qr.map((q) => (
                  <button key={q} type="button" className="pt-chip pt-chip--q" onClick={() => void send(q)}>{q}</button>
                ))}
              </div>
            )}
          </div>

          <form
            className="pt-composer"
            onSubmit={(e) => { e.preventDefault(); void send(draft); }}
          >
            <div className="pt-composer-row">
              <textarea
                ref={inputRef}
                className="pt-textarea"
                rows={1}
                maxLength={MAX_CHARS}
                value={draft}
                disabled={!canType}
                placeholder={canType ? 'Type your message...' : ''}
                aria-label="Your message"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button type="submit" className="pt-send" aria-label="Send message" disabled={!canType || busy || !draft.trim()}>
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 11.5L20.5 4l-6.5 16-3-6.5L3 11.5z" fill="currentColor" /></svg>
              </button>
            </div>
            {draft.length >= COUNTER_AT && (
              <p className="pt-counter" aria-live="polite">{draft.length}/{MAX_CHARS}</p>
            )}
          </form>
        </section>
      )}

      <div className="pt-sr" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>
  );
}

export default function PreetiChat({ kind, pageRef }: { kind: PageKind; pageRef?: string }) {
  // Decided once, on the client (this island is client-only via client:idle).
  const [withClerk] = useState(() => typeof document !== 'undefined' && hasClerkSessionHint());
  return (
    <>
      {withClerk && (
        <Quiet>
          <Suspense fallback={null}>
            <LazyClerkIsland>{null}</LazyClerkIsland>
          </Suspense>
        </Quiet>
      )}
      <Quiet>
        <Widget kind={kind} pageRef={pageRef} />
      </Quiet>
    </>
  );
}
