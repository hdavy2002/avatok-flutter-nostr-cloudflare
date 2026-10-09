import { useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import PreviewCard from '../PreviewCard';
import { TOPICS } from '../data';
import type { GeneratedProfile, StepProps } from '../types';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function PreviewStep({ draft, update, api, setAction, goTo, avatars }: StepProps) {
  const g = draft.generated as GeneratedProfile;
  const avatar = avatars.find(a => a.id === draft.avatarId) || null;
  const [introUrl, setIntroUrl] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [editing, setEditing] = useState<'tagline' | 'about' | null>(null);
  const [text, setText] = useState('');
  const [editErr, setEditErr] = useState('');
  const [submitErr, setSubmitErr] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setAction({
      label: 'Looks good — send for review',
      run: async () => {
        setSubmitErr('');
        const r = await api.submitForReview(draft);
        if (!r.ok) { setSubmitErr(r.error || 'We could not send your profile. Please try again.'); return false; }
        update({ submitted: true });
        return true;
      },
    });
  }, [api, draft, update, setAction]);

  // The host's own introduction (real mode: fetched with the sign-in token; mock: nothing to play).
  useEffect(() => {
    if (!api.fetchMyVoice || !draft.voice.recorded) return;
    let live = true;
    let made: string | null = null;
    void api.fetchMyVoice().then(u => { made = u; if (live) setIntroUrl(u); else if (u) URL.revokeObjectURL(u); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const n = g?.gallery.length || 0;
  useEffect(() => {
    if (lightbox === null) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      else if (e.key === 'ArrowRight') setLightbox(i => (i === null ? i : (i + 1) % n));
      else if (e.key === 'ArrowLeft') setLightbox(i => (i === null ? i : (i - 1 + n) % n));
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); lastFocus.current?.focus(); };
  }, [lightbox, n]);

  if (!g) return <p className="hob-lead">Your profile is not ready yet.</p>;

  const patch = (p: Partial<GeneratedProfile>) => update({ generated: { ...g, ...p } });
  const startEdit = (k: 'tagline' | 'about') => { setEditing(k); setText(g[k]); };
  const saveEdit = async () => {
    if (editing && text.trim()) {
      setEditErr('');
      const r = await api.editGenerated(editing === 'tagline' ? { tagline: text.trim() } : { aboutPolished: text.trim() });
      if (!r.ok) { setEditErr(r.error || 'We could not save that. Please try again.'); return; }
      patch({ [editing]: text.trim() } as Partial<GeneratedProfile>);
    }
    setEditing(null);
  };
  const topicLabels = draft.topics.map(s => TOPICS.find(t => t.slug === s)?.label || s);

  return (
    <div>
      <h1 className="hob-h1">This is how callers will see you</h1>
      <p className="hob-lead">Have a look. You can change the tagline and the about text.</p>

      <h2 className="hob-f-h2">Your card</h2>
      <div className="hob-f-cardwrap"><PreviewCard draft={draft} avatar={avatar} /></div>

      <h2 className="hob-f-h2">Your profile page</h2>
      <section className="hob-card hob-f-profile">
        <div className="hob-f-hero">
          <img src={g.profileImage} alt={`${draft.displayName}, AI avatar`} />
          <span className="hob-ai-label">AI avatar chosen by the host</span>
        </div>
        <h3 className="hob-f-name">{draft.displayName}</h3>

        {editing === 'tagline' ? (
          <div className="hob-field">
            <label className="hob-label" htmlFor="hob-f-tag">Tagline</label>
            <input id="hob-f-tag" className="hob-input" value={text} maxLength={80} onChange={e => setText(e.target.value)} />
            <div className="hob-f-editrow">
              <button type="button" className="hob-btn hob-btn-primary" onClick={() => { void saveEdit(); }}>Save</button>
              <button type="button" className="hob-btn hob-btn-ghost" onClick={() => { setEditing(null); setEditErr(''); }}>Cancel</button>
            </div>
            {editErr && <p className="hob-error" role="alert">{editErr}</p>}
          </div>
        ) : (
          <p className="hob-f-tagline">{g.tagline} <button type="button" className="hob-f-link" onClick={() => startEdit('tagline')}>Edit tagline</button></p>
        )}

        <blockquote className="hob-f-quote">“{g.quote}”</blockquote>
        {topicLabels.length > 0 && <div className="hob-f-chips">{topicLabels.map(t => <span key={t} className="hob-f-pill">{t}</span>)}</div>}

        <h3 className="hob-f-h3">About</h3>
        {editing === 'about' ? (
          <div className="hob-field">
            <label className="hob-label" htmlFor="hob-f-about">About</label>
            <textarea id="hob-f-about" className="hob-input" rows={6} value={text} maxLength={800} onChange={e => setText(e.target.value)} />
            <div className="hob-f-editrow">
              <button type="button" className="hob-btn hob-btn-primary" onClick={() => { void saveEdit(); }}>Save</button>
              <button type="button" className="hob-btn hob-btn-ghost" onClick={() => { setEditing(null); setEditErr(''); }}>Cancel</button>
            </div>
            {editErr && <p className="hob-error" role="alert">{editErr}</p>}
          </div>
        ) : (
          <>
            <p className="hob-f-about">{g.about}</p>
            <button type="button" className="hob-f-link" onClick={() => startEdit('about')}>Edit about</button>
          </>
        )}
      </section>

      <h2 className="hob-f-h2">Your voice introduction</h2>
      <section className="hob-card hob-f-clip">
        <span className="hob-ai-label">Recorded by you</span>
        {draft.voice.recorded ? (
          <>
            {introUrl && <audio className="hob-f-audio" controls preload="none" src={introUrl} aria-label="Your recorded introduction" style={{ width: '100%', minHeight: 48, marginTop: 8 }} />}
            <p className="hob-help">Length {mmss(draft.voice.durationSec)}. Our team listens to it before it goes live on your card and profile.</p>
          </>
        ) : (
          <p className="hob-help">You have not recorded your introduction yet. <button type="button" className="hob-f-link" onClick={() => goTo('voice')}>Record it now</button></p>
        )}
      </section>

      <h2 className="hob-f-h2">Avatar gallery</h2>
      <p className="hob-help">AI images</p>
      <div className="hob-f-gallery">
        {g.gallery.map((it, i) => (
          <button type="button" key={i} className="hob-f-tile" aria-label={`Open picture: ${it.caption}`}
            onClick={(e) => { lastFocus.current = e.currentTarget; setLightbox(i); }}>
            <img src={it.image} alt={it.caption} loading="lazy" />
            <span className="hob-ai-label">AI image</span>
            <span className="hob-f-cap">{it.caption}</span>
          </button>
        ))}
      </div>

      <aside className="hob-card hob-f-privacy">
        <Icon name="shield" />
        <p>To protect our hosts' privacy, the photos on host profiles are AI-generated from an avatar the host chose. The voice introduction is the host's own recording. The person callers talk to is the real, KYC-verified host.</p>
      </aside>

      {submitErr && <p className="hob-error" role="alert" aria-live="polite">{submitErr}</p>}
      <button type="button" className="hob-btn hob-btn-ghost" onClick={() => goTo('review')}>Change something</button>

      {lightbox !== null && (
        <div className="hob-f-lb" role="dialog" aria-modal="true" aria-label="Picture viewer" onClick={() => setLightbox(null)}>
          <div className="hob-f-lb-in" onClick={e => e.stopPropagation()}>
            <button ref={closeRef} type="button" className="hob-f-lb-close" onClick={() => setLightbox(null)} aria-label="Close"><Icon name="x" /></button>
            <img src={g.gallery[lightbox].image} alt={g.gallery[lightbox].caption} />
            <span className="hob-ai-label">AI image</span>
            <p className="hob-f-lb-cap">{g.gallery[lightbox].caption}</p>
            <div className="hob-f-lb-nav">
              <button type="button" className="hob-btn hob-btn-ghost" onClick={() => setLightbox((lightbox - 1 + n) % n)}>Previous</button>
              <span>{lightbox + 1} / {n}</span>
              <button type="button" className="hob-btn hob-btn-ghost" onClick={() => setLightbox((lightbox + 1) % n)}>Next</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
