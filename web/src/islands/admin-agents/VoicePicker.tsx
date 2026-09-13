// [AGENT-LIVE-1] Voice picker: 12 chips, each with a one-line personality
// label (BUILD SPEC §6). Server-sourced labels (adminVoices()) are shown as a
// small caption under the house personality line when they differ from the
// bare id, so a future worker-side label change is visible without a redeploy.
import { useEffect, useState } from 'react';
import { adminVoices, type AdminVoice } from '../../lib/agentLive';
import { VOICE_IDS, VOICE_PERSONALITY, type VoiceId } from './types';

export default function VoicePicker({ value, onChange }: {
  value: string;
  onChange: (voice: VoiceId | string) => void;
}) {
  const [serverVoices, setServerVoices] = useState<AdminVoice[] | null>(null);

  useEffect(() => {
    let alive = true;
    void adminVoices().then((v) => { if (alive) setServerVoices(v); }).catch(() => { /* falls back to static ids */ });
    return () => { alive = false; };
  }, []);

  const ids = serverVoices?.length ? serverVoices.map((v) => String(v.id)) : VOICE_IDS;
  const labelFor = (id: string): string | null => {
    const server = serverVoices?.find((v) => String(v.id) === id)?.label;
    return server && server !== id ? server : null;
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {ids.map((id) => {
        const active = value === id;
        const serverLabel = labelFor(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={`flex flex-col items-start gap-1 rounded-zineField border-zine px-3 py-2 text-left shadow-zine-xs transition-colors ${
              active ? 'border-ink bg-lime' : 'border-ink bg-paper hover:bg-paper2'
            }`}
          >
            <span className="font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink">{id}</span>
            <span className="font-body text-[12px] font-bold leading-snug text-inkSoft">
              {VOICE_PERSONALITY[id] ?? 'A distinct GPT-Live-1 voice.'}
            </span>
            {serverLabel && (
              <span className="font-body text-[11px] font-bold text-inkMute">{serverLabel}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
