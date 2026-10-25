/* [HF-VERIFIED-BLIP-1 2026-10-25] The verified tick beside a creator's name, on every surface that shows one.
 * Owner rule: green tick = Video KYC verified (Aadhaar + approved selfie video; the site's one allowed green),
 * indigo tick = a social channel verified but no Video KYC yet, no tick = only the WhatsApp number is checked.
 * Interactive by default: tapping opens a small sheet listing every check. Pass `still` where the tick sits inside a link.
 * Telemetry: hf_verified_tick_shown {surface, level} once per mount, hf_verified_tick_tap {surface, level}. */
import { useEffect, useRef, useState } from 'react';
import { capture } from '../../lib/analytics';
import { SPACE_TAG, parseSpace } from '../../lib/hfSpaces';
import '../../styles/hf-spaces.css';

export type TickLevel = 'kyc' | 'channel';
export function tickLevel(videoKyc?: unknown, channel?: unknown): TickLevel | null {
  return videoKyc === true ? 'kyc' : channel === true ? 'channel' : null;
}
const LABEL: Record<TickLevel, string> = { kyc: 'Video KYC verified', channel: 'Channel verified' };
const PLATFORM: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', tiktok: 'TikTok' };

function Check() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 12.5 4 4 8-9" /></svg>;
}

interface Props {
  name: string; videoKyc?: boolean; channel?: boolean; platform?: string | null; phone?: boolean; space?: unknown;
  surface: string; still?: boolean; size?: 'sm' | 'md' | 'lg';
}

export default function VerifiedTick({ name, videoKyc, channel, platform, phone, space, surface, still, size = 'md' }: Props) {
  const level = tickLevel(videoKyc, channel);
  const dlg = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (level) { try { capture('hf_verified_tick_shown', { surface, level }); } catch { /* ignore */ } } }, [level, surface]);
  useEffect(() => { const d = dlg.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  if (!level) return null;
  const cls = `hf-vt hf-vt-${level} hf-vt-${size}`;
  if (still) return <span className={cls} role="img" aria-label={LABEL[level]} title={LABEL[level]}><Check /></span>;
  const first = name.trim().split(/\s+/)[0] || name;
  const sp = parseSpace(space);
  const plat = platform ? PLATFORM[String(platform).toLowerCase()] ?? 'Social channel' : 'Social channel';
  const rows: { ok: boolean; t: string; d: string; kyc?: boolean }[] = [
    { ok: videoKyc === true, kyc: true, t: 'Video KYC', d: videoKyc ? 'Aadhaar checked and a selfie video approved by our team.' : 'Not done yet.' },
    ...(phone ? [{ ok: true, t: 'WhatsApp number', d: 'Confirmed with a one-time code. Never shown to callers.' }] : []),
    { ok: channel === true, t: channel ? `${plat} channel` : 'Social channel', d: channel ? 'Ownership checked with a code in the bio.' : videoKyc ? 'Not connected. Video KYC already proves who they are.' : 'Not connected.' },
    ...(sp ? [{ ok: true, t: SPACE_TAG[sp], d: sp === 'women' ? 'Only verified women can call.' : 'Only verified LGBTQ+ members can call.' }] : []),
  ];
  return (
    <>
      <button type="button" className={cls} aria-label={`${LABEL[level]}. See what we checked`} title={LABEL[level]}
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true); try { capture('hf_verified_tick_tap', { surface, level }); } catch { /* ignore */ } }}><Check /></button>
      <dialog ref={dlg} className="hf-vt-sheet" onClose={() => setOpen(false)} onClick={e => { if (e.target === dlg.current) setOpen(false); }} aria-labelledby={`hfvt-${surface}`}>
        <div className="hf-vt-in">
          <p className="hf-vt-h" id={`hfvt-${surface}`}>{first} is verified <span className={`hf-vt hf-vt-${level} hf-vt-sm`} aria-hidden="true"><Check /></span></p>
          <p className="hf-vt-sub">What we checked before {first} could take calls.</p>
          <ul>{rows.map(r => <li key={r.t}><span className={`hf-vt-ic${r.ok ? (r.kyc ? ' ok kyc' : ' ok') : ''}`} aria-hidden="true">{r.ok ? <Check /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M7 12h10" /></svg>}</span><span><b>{r.t}</b>{r.d}</span></li>)}</ul>
          <button type="button" className="hf-vt-close" onClick={() => setOpen(false)}>Close</button>
        </div>
      </dialog>
    </>
  );
}
