/* [HF-CHANNEL-WEB-1] Small hero islands of the channel page: the voice introduction button and the Share button.
 * The voice clip is the influencer's OWN recording (admin approved) and is labelled so. Share opens the phone's share sheet when there is
 * one, otherwise a small menu (WhatsApp, X, Copy link); every link carries ?utm_source=share&utm_medium=<network>.
 * Telemetry: profile_share_clicked { own, network }. */
import { useEffect, useRef, useState } from 'react';
import { capture } from '../../lib/analytics';
import { fmtDuration } from '../../lib/channelKit';
import { shareUrl, whatsappHref, xHref, type ShareNetwork } from '../../lib/merchShare';

export function VoiceIntro({ src, seconds, name }: { src: string; seconds: number | null; name: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const bars = [10, 22, 14, 26, 16, 22, 10];
  const toggle = () => {
    const a = audio.current; if (!a) return;
    if (a.paused) { void a.play().then(() => setOn(true)).catch(() => setOn(false)); } else { a.pause(); setOn(false); }
  };
  return <span>
    <button type="button" className="voice" onClick={toggle} aria-pressed={on} aria-label={`${on ? 'Pause' : 'Play'} ${name}’s voice introduction`}>
      <span className="pl" aria-hidden="true">{on ? '❚❚' : '▶'}</span>
      <span className="wv" aria-hidden="true">{bars.map((h, i) => <i key={i} style={{ height: h }} />)}</span>
      <span className="nun">Hear my voice{seconds ? ` · ${fmtDuration(seconds)}` : ''}</span>
    </button>
    <audio ref={audio} src={src} preload="none" onEnded={() => setOn(false)} onPause={() => setOn(false)} />
    <span className="voice-note" style={{ display: 'block' }}>Recorded by the influencer</span>
  </span>;
}

export function ShareButton({ url, text }: { url: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const track = (network: ShareNetwork) => capture('profile_share_clicked', { own: false, network });
  const click = async () => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      track('native');
      try { await navigator.share({ title: text, text, url: shareUrl(url, 'native') }); } catch { /* the person closed the sheet */ }
      return;
    }
    setOpen(o => !o);
  };
  const copy = async () => {
    track('copy');
    const link = shareUrl(url, 'copy');
    try { await navigator.clipboard.writeText(link); }
    catch {
      const t = document.createElement('textarea'); t.value = link; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { window.prompt('Copy this link', link); }
      t.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 2200); setOpen(false);
  };
  return <span className="sharewrap" ref={box}>
    <button type="button" className="ibtn" aria-label="Share" aria-haspopup="menu" aria-expanded={open} onClick={click}>↗</button>
    {open && <div className="sharemenu" role="menu">
      <a role="menuitem" href={whatsappHref(url, text)} target="_blank" rel="noopener noreferrer" onClick={() => track('whatsapp')}>WhatsApp</a>
      <a role="menuitem" href={xHref(url, text)} target="_blank" rel="noopener noreferrer" onClick={() => track('x')}>X</a>
      <button role="menuitem" type="button" onClick={() => void copy()}>Copy link</button>
    </div>}
    <span className="vh" role="status" aria-live="polite">{copied ? 'Link copied' : ''}</span>
    {copied && <span className="sharemenu" style={{ padding: '8px 14px', minWidth: 0, whiteSpace: 'nowrap' }} aria-hidden="true">Link copied</span>}
  </span>;
}
