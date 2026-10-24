/* [HF-CREATOR-SPACES-1] "Video KYC verified" (green, the only green on the site) + "Women-only channel" / "LGBTQ+ channel" tag.
 * Missing fields (older worker) render nothing. Telemetry: hf_video_kyc_badge_shown {surface}, once per mount. */
import { useEffect } from 'react';
import { capture } from '../../lib/analytics';
import { KYC_ONLY_NOTE, SPACE_TAG, channelLabel, parseSpace } from '../../lib/hfSpaces';
import '../../styles/hf-spaces.css';

export function KycCheck() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" opacity=".16" /><path d="m7.5 12.5 3 3 6-6.5" /></svg>;
}
function SpaceIcon({ space }: { space: 'women' | 'lgbtq' }) {
  return space === 'women'
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="9" r="5" /><path d="M12 14v8M8.5 18.5h7" /></svg>
    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z" /></svg>;
}

export interface ChannelInfo { verified?: boolean; platform?: string | null; followers?: number | null }

/** [HF-CREATOR-BADGES-1] Stacked badges: channel verified (platform + followers), green Video KYC, space tag, and a small "Only video-KYC callers" note. */
export default function SpaceBadges({ videoKyc, space, surface, large, channel, callerLevel }: { videoKyc?: boolean; space?: unknown; surface: string; large?: boolean; channel?: ChannelInfo | boolean | null; callerLevel?: unknown }) {
  const sp = parseSpace(space);
  const ch: ChannelInfo | null = channel === true ? { verified: true } : channel && typeof channel === 'object' && channel.verified === true ? channel : null;
  const kycOnly = callerLevel === 'video_kyc' && !sp;
  useEffect(() => { if (videoKyc === true) { try { capture('hf_video_kyc_badge_shown', { surface }); } catch { /* ignore */ } } }, [videoKyc, surface]);
  if (videoKyc !== true && !sp && !ch && !kycOnly) return null;
  return (
    <ul className={`hf-sb${large ? ' hf-sb-lg' : ''}`} aria-label="Verification and channel type">
      {ch && <li className="hf-ch-pill" title="Channel checked and approved"><KycCheck />{channelLabel(ch.platform, ch.followers)}</li>}
      {videoKyc === true && <li className="hf-kyc-pill" title="Aadhaar checked and selfie video approved"><KycCheck />Video KYC verified</li>}
      {sp && <li className="hf-space-tag"><SpaceIcon space={sp} />{SPACE_TAG[sp]}</li>}
      {kycOnly && <li className="hf-kyc-note">{KYC_ONLY_NOTE}</li>}
    </ul>
  );
}
