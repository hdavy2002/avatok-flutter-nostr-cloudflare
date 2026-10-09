/* [HF-HOST-PLATFORM-1] Real hosts on Explore and the home page.
 * Loads late (client:visible), fetches GET /api/hosts/public and prepends one card per live host into the existing
 * `.people-grid`, with the same markup/classes as components/callvaal/ProfileCard.astro. Renders nothing if the API
 * answers 404 (flag hostsPublicEnabled off), is empty, or fails. The sample cards stay exactly as they are. */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE } from '../../lib/env';
import { moods } from '../../lib/callvaalHomeReference';
import Icon from '../host-onboarding/Icon';
import '../../styles/profile-card.css';
import '../../styles/live-hosts.css';

interface HostCard {
  slug: string; displayName: string; tagline: string | null; avatarUrl: string | null; languages: string[]; style: string | null; topics: string[];
  pricePerMin: number; lgbtqFriendly: boolean; sampleAudioUrl: string | null;
}
const STYLE_LABEL: Record<string, string> = {
  warm: 'Steady & encouraging', energetic: 'Cheerful & chatty', calm: 'Calm listener',
  playful: 'Funny & light', straightforward: 'Straight-talking', thoughtful: 'Gentle & patient',
};
const moodLabel = (slug: string) => moods.find(m => m.slug === slug)?.label ?? slug;

function Card({ h }: { h: HostCard }) {
  const href = `/h/${h.slug}`;
  return (
    <article className="profile-card hf-live-card" data-live-host={h.slug}>
      <div className="portrait-wrap">
        {h.avatarUrl && <img className="person-portrait" src={h.avatarUrl} alt={`${h.displayName}, an AI avatar chosen by the host`} width={1254} height={1254} loading="lazy" />}
        <span className="hf-live-ai">AI avatar chosen by the host</span>
        <p className="person-status is-offline"><span aria-hidden="true" />Calls open soon</p>
      </div>
      <div className="person-copy">
        <div className="profile-card-heading">
          <div className="person-heading"><h3><a className="person-detail-link" href={href}>{h.displayName}</a></h3></div>
        </div>
        <p className="person-tagline">{h.tagline || 'A little time for a good conversation'}</p>
        {h.sampleAudioUrl && (
          <div>
            <audio className="hf-live-clip" controls preload="none" src={h.sampleAudioUrl} aria-label={`AI voice clip, sample conversation with ${h.displayName}`} />
            <small className="hf-live-clip-label">AI voice clip · Sample conversation — not a real call</small>
          </div>
        )}
        <dl className="profile-card-facts">
          {h.languages.length > 0 && <div><dt><Icon name="globe" size={25} />Languages</dt><dd>{h.languages.join(', ')}</dd></div>}
          {h.style && <div><dt><Icon name="sparkle" size={25} />Conversation style</dt><dd>{STYLE_LABEL[h.style] ?? h.style}</dd></div>}
        </dl>
        {h.lgbtqFriendly && <ul className="person-moods"><li><Icon name="sparkle" size={18} /><span>LGBTQ+ friendly</span></li></ul>}
        {h.topics.length > 0 && (
          <div className="profile-card-topics">
            <h4>Let’s talk about</h4>
            <ul className="person-moods">{h.topics.slice(0, 5).map(s => <li key={s}><Icon name="chat" size={18} /><span>{moodLabel(s)}</span></li>)}</ul>
          </div>
        )}
        <div className="profile-card-footer">
          <div className="person-actions">
            <div className="profile-card-price"><strong className="person-price">₹{h.pricePerMin}/min</strong><small>10 min ≈ ₹{h.pricePerMin * 10}</small></div>
            <button type="button" className="sample-call hf-call-soon" disabled aria-disabled="true"><Icon name="bell" size={22} />Calls open soon</button>
          </div>
          <a className="profile-card-link" href={href}>View full profile <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </article>
  );
}

export default function LiveHostCards() {
  const [hosts, setHosts] = useState<HostCard[]>([]);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Plain fetch, not apiClient: a flag-off 404 is normal here and must not be reported as an API error.
        const res = await fetch(`${API_BASE}/api/hosts/public?limit=24`, { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const list = (await res.json()) as HostCard[];
        if (!live || !Array.isArray(list) || list.length === 0) return;
        const grid = document.querySelector<HTMLElement>('#people .people-grid') ?? document.querySelector<HTMLElement>('.people-grid');
        if (!grid) return;
        const wrap = document.createElement('div');
        wrap.className = 'hf-live-wrap';
        grid.insertBefore(wrap, grid.firstChild);
        setMount(wrap);
        setHosts(list);
      } catch { /* offline or flag off: the sample cards stay */ }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => () => { mount?.remove(); }, [mount]);

  // The 1px sentinel gives client:visible something to watch before any card exists.
  return (
    <>
      <span className="hf-live-sentinel" aria-hidden="true" />
      {mount && hosts.length > 0 ? createPortal(<>{hosts.map(h => <Card key={h.slug} h={h} />)}</>, mount) : null}
    </>
  );
}
