/* [HF-HOST-ONBOARD-1] Live card preview. Same markup/classes as components/callvaal/ProfileCard.astro,
 * filled from the draft. Page imports profile-card.css. */
import { TOPICS } from './data';
import type { Avatar, Draft } from './types';
import Icon from './Icon';

const WAVE = [20, 35, 55, 30, 65, 90, 50, 35, 70, 45, 25, 55, 80, 40, 65, 100, 70, 45, 30, 60, 80, 50, 35, 65, 40, 25, 50, 75, 45, 30];

export default function PreviewCard({ draft, avatar }: { draft: Draft; avatar: Avatar | null }) {
  const name = draft.displayName.trim() || 'Your name';
  const price = draft.pricePerMin;
  const topicLabel = (slug: string) => TOPICS.find(t => t.slug === slug)?.label ?? slug;
  return (
    <div className="people-grid hob-preview-grid">
      <article className="profile-card" aria-label="Live preview of your card">
        <div className="portrait-wrap">
          {avatar
            ? <img className="person-portrait" src={avatar.image} alt="Illustrative avatar chosen by the host" width={1254} height={1254} />
            : <div className="hob-portrait-empty">Pick an avatar</div>}
          <span className="hob-ai-label">AI avatar chosen by the host</span>
          <p className="person-status is-preview"><span aria-hidden="true" />Preview</p>
        </div>
        <div className="person-copy">
          <div className="profile-card-heading">
            <div className="person-heading"><h3>{name}</h3></div>
          </div>
          <p className="person-tagline">{draft.generated?.tagline || 'Your tagline appears here'}</p>
          <div className="profile-card-stats">
            <div><Icon name="user" size={25} /><p className="person-talks"><strong>0 people yet</strong><span>have talked to {draft.displayName.trim() || 'you'}</span></p></div>
            <div><Icon name="clock" size={25} /><p className="person-regulars"><strong>New host</strong><span>just joining</span></p></div>
          </div>
          <div className="profile-card-voice" aria-label="Sample conversation">
            <button type="button" disabled aria-label="Sample conversation, not available in preview"><Icon name="play" size={22} /></button>
            <div><span>Sample conversation</span><div className="profile-card-wave" aria-hidden="true">{WAVE.map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}</div></div>
            <small>0:20</small>
          </div>
          <dl className="profile-card-facts">
            <div><dt><Icon name="globe" size={25} />Languages</dt><dd>{draft.languages.length ? draft.languages.join(', ') : 'Not chosen yet'}</dd></div>
            <div><dt><Icon name="sparkle" size={25} />Conversation style</dt><dd>{draft.style || 'Not chosen yet'}</dd></div>
          </dl>
          <div className="profile-card-topics">
            <h4>Let’s talk about</h4>
            {draft.topics.length
              ? <ul className="person-moods">{draft.topics.map(s => <li key={s}><Icon name="chat" size={18} /><span>{topicLabel(s)}</span></li>)}</ul>
              : <p className="hob-help">Topics you pick appear here.</p>}
          </div>
          <div className="profile-card-footer">
            <div className="person-actions">
              <div className="profile-card-price"><strong className="person-price">₹{price}/min</strong><small>10 min ≈ ₹{price * 10}</small></div>
              <button type="button" className="sample-call hob-call-off" disabled><Icon name="phone" size={22} />Call</button>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
