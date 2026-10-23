/* [HF-SHARE-WEB-1] Lets a live influencer share her public page (/h/<slug>) so fans come to book a call or buy merch.
 * variant "card" = full card (Overview, Profile); "row" = compact "Share your shop" row (Merch).
 * Every link carries ?utm_source=share&utm_medium=<network>. Telemetry: profile_share_clicked {own: true, network}.
 * The slug comes from the caller or, when the caller has none, from GET /api/hosts/me (the same call Overview uses). */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { brandUrl } from '../../../lib/brand';
import { capture } from '../../../lib/analytics';
import { hfCall } from '../../../lib/hfCallsApi';
import { facebookHref, shareUrl, whatsappHref, xHref, type ShareNetwork } from '../../../lib/merchShare';
import { Card, Ic } from '../v3/ui';
import './share.css';

interface Props { slug?: string | null; name?: string | null; variant?: 'card' | 'row' }

export default function ShareMyPage({ slug: slugProp, name: nameProp, variant = 'card' }: Props) {
  const [slug, setSlug] = useState<string | null>(slugProp ?? null);
  const [name, setName] = useState<string | null>(nameProp ?? null);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [igTip, setIgTip] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (slugProp) setSlug(slugProp); }, [slugProp]);
  useEffect(() => {
    if (slugProp) return;
    let live = true;
    void hfCall<{ host: { slug: string | null; displayName: string | null; status: string } | null }>('GET', '/api/hosts/me').then(r => {
      if (live && r.ok && r.data.host?.status === 'live' && r.data.host.slug) { setSlug(r.data.host.slug); setName(r.data.host.displayName); }
    });
    return () => { live = false; };
  }, [slugProp]);
  useEffect(() => () => clearTimeout(t.current), []);
  const base = slug ? brandUrl(`/h/${slug}`) : '';
  useEffect(() => {
    if (variant !== 'card' || !base) return;
    let live = true;
    QRCode.toDataURL(shareUrl(base, 'qr'), { width: 640, margin: 2, color: { dark: '#46113e', light: '#ffffff' } }).then(u => { if (live) setQr(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [base, variant]);
  if (!slug) return null;

  const text = name ? `Talk to ${name} — book a call or get my merch` : 'Book a call with me or get my merch';
  const track = (network: ShareNetwork) => capture('profile_share_clicked', { own: true, network });
  const canNative = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copy = async () => {
    track('copy');
    const link = shareUrl(base, 'copy');
    try { await navigator.clipboard.writeText(link); }
    catch {
      const a = document.createElement('textarea'); a.value = link; a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select();
      try { document.execCommand('copy'); } catch { window.prompt('Copy this link', link); }
      a.remove();
    }
    setCopied(true); clearTimeout(t.current); t.current = setTimeout(() => setCopied(false), 2500);
  };
  const native = async () => { track('native'); try { await navigator.share({ title: text, text, url: shareUrl(base, 'native') }); } catch { /* sheet closed */ } };
  const insta = () => { track('instagram'); setIgTip(true); void copy2(); };
  const copy2 = async () => { try { await navigator.clipboard.writeText(shareUrl(base, 'instagram')); setCopied(true); clearTimeout(t.current); t.current = setTimeout(() => setCopied(false), 2500); } catch { /* the link is shown above */ } };

  const btns = <div className="sm-btns">
    <button type="button" className="h3-btn rani" onClick={() => void copy()}><Ic name="down" className="i" />{copied ? 'Copied' : 'Copy link'}</button>
    <a className="h3-btn" href={whatsappHref(base, text)} target="_blank" rel="noopener noreferrer" onClick={() => track('whatsapp')}>WhatsApp</a>
    <a className="h3-btn" href={xHref(base, text)} target="_blank" rel="noopener noreferrer" onClick={() => track('x')}>X</a>
    <a className="h3-btn" href={facebookHref(base)} target="_blank" rel="noopener noreferrer" onClick={() => track('facebook')}>Facebook</a>
    <button type="button" className="h3-btn ghost" onClick={insta}>Instagram</button>
    {canNative && <button type="button" className="h3-btn ghost" onClick={() => void native()}>More…</button>}
  </div>;
  const tip = igTip && <p className="sm-tip small" role="status">Link copied. On Instagram, open Edit profile and paste it in your bio, so fans can tap through to your page.</p>;

  if (variant === 'row') return <section className="sm-row sm-card" aria-label="Share your shop"><b>Share your shop</b>{btns}{tip}</section>;
  return <Card title="Share my page" note="Send this link to your fans so they can book a call or buy your merch" className="sm-card">
    <div className="sm-link"><code>{base}</code></div>
    {btns}{tip}
    {qr && <div className="sm-qr"><img src={qr} alt="QR code for your page" width={132} height={132} /><a className="h3-btn ghost" href={qr} download={`${slug}-qr.png`} style={{ minHeight: 56, display: 'inline-flex', alignItems: 'center' }} onClick={() => track('qr')}>Download QR</a></div>}
  </Card>;
}
