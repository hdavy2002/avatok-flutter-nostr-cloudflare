import { useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import type { StepProps, Gender, AgeBand, AvatarStyle } from '../types';

type GF = 'all' | Gender;
type AF = 'all' | AgeBand;
type SF = 'all' | AvatarStyle;

function Filter<T extends string>({ legend, value, onChange, options }: {
  legend: string; value: T; onChange: (v: T) => void; options: [T, string][];
}) {
  return (
    <fieldset className="hob-p-fieldset">
      <legend className="hob-label">{legend}</legend>
      <div className="hob-p-chips">
        {options.map(([v, l]) => (
          <button key={v} type="button" className="hob-chip" aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </fieldset>
  );
}

export default function AvatarStep({ draft, update, setAction, avatars, api }: StepProps) {
  const [claimErr, setClaimErr] = useState('');
  const [claiming, setClaiming] = useState(false);
  const real = api.mode === 'real';
  const pick = async (id: string) => {
    if (claiming || id === draft.avatarId) return;
    setClaimErr('');
    setClaiming(true);
    const r = await api.claimAvatar(id);
    setClaiming(false);
    if (!r.ok) { setClaimErr(r.error || 'We could not choose that avatar. Please try another.'); return; }
    update({ avatarId: id });
  };
  const [g, setG] = useState<GF>('all');
  const [a, setA] = useState<AF>('all');
  const [s, setS] = useState<SF>('all');

  const shown = useMemo(
    () => avatars.filter((x) => (g === 'all' || x.gender === g) && (a === 'all' || x.age === a) && (s === 'all' || x.style === s)),
    [avatars, g, a, s],
  );

  useEffect(() => {
    setAction({ label: 'Continue', disabled: !draft.avatarId, run: () => true });
  }, [draft.avatarId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="hob-p-step">
      <h1 className="hob-h1">Choose your avatar</h1>
      <p className="hob-lead">This picture represents you. Your real face is never shown — callers see this AI avatar.</p>

      <div className="hob-p-filters">
        <Filter<GF> legend="Gender" value={g} onChange={setG} options={[['all', 'All'], ['woman', 'Women'], ['man', 'Men']]} />
        <Filter<AF> legend="Age" value={a} onChange={setA} options={[['all', 'All'], ['20s', '20s'], ['30s', '30s'], ['40s', '40s'], ['50s+', '50s+']]} />
        <Filter<SF> legend="Look" value={s} onChange={setS} options={[['all', 'All'], ['traditional', 'Traditional'], ['casual', 'Casual'], ['office', 'Office']]} />
      </div>

      {shown.length === 0 ? (
        <div className="hob-card hob-p-empty">
          <p>No avatars match these filters.</p>
          <button type="button" className="hob-btn hob-btn-ghost" onClick={() => { setG('all'); setA('all'); setS('all'); }}>Show all avatars</button>
        </div>
      ) : (
        <div className="hob-p-avatar-grid">
          {shown.map((av) => {
            const taken = !!av.takenBy;
            const sel = draft.avatarId === av.id;
            return (
              <button
                key={av.id}
                type="button"
                className={`hob-p-avatar${sel ? ' is-selected' : ''}${taken ? ' is-taken' : ''}`}
                aria-pressed={sel}
                disabled={taken || claiming}
                aria-label={`${av.gender === 'woman' ? 'Woman' : 'Man'}, ${av.age}, ${av.style} look${taken ? ', taken' : ''}`}
                onClick={() => { void pick(av.id); }}
              >
                <img src={av.image} alt="" loading="lazy" />
                <span className="hob-ai-label hob-p-ai">AI avatar</span>
                {taken && <span className="hob-p-taken">Taken</span>}
                {sel && <span className="hob-p-check" aria-hidden="true"><Icon name="check" size={18} /></span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="hob-error" role="alert" aria-live="polite">{claimErr}</p>
      <p className="hob-help hob-p-note">Once you pick an avatar it becomes yours only.{real ? '' : ' Sample avatars shown in this preview.'}</p>
    </div>
  );
}
