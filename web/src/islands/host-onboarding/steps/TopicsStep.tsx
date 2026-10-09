import { useEffect } from 'react';
import { TOPICS, TOPIC_GROUPS, MAX_TOPICS } from '../data';
import type { StepProps } from '../types';

export default function TopicsStep({ draft, update, setAction }: StepProps) {
  const n = draft.topics.length;
  const full = n >= MAX_TOPICS;
  useEffect(() => {
    setAction({ label: 'Continue', disabled: n < 1, run: () => true });
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (slug: string) =>
    update({ topics: draft.topics.includes(slug) ? draft.topics.filter((x) => x !== slug) : [...draft.topics, slug] });

  return (
    <div className="hob-p-step">
      <h1 className="hob-h1">What do you like to talk about?</h1>
      <p className="hob-lead">Callers search by these. Pick only topics you are comfortable with.</p>

      <div className="hob-p-sticky" aria-live="polite">
        <strong>{n} of {MAX_TOPICS} chosen</strong>
        {full && <span> — that is the most. Remove one to pick another.</span>}
      </div>

      {TOPIC_GROUPS.map((grp) => (
        <fieldset key={grp} className="hob-p-fieldset">
          <legend className="hob-p-group">{grp}</legend>
          <div className="hob-p-chips">
            {TOPICS.filter((t) => t.group === grp).map((t) => {
              const on = draft.topics.includes(t.slug);
              return (
                <button key={t.slug} type="button" className="hob-chip" aria-pressed={on}
                  disabled={full && !on} onClick={() => toggle(t.slug)}>{t.label}</button>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
