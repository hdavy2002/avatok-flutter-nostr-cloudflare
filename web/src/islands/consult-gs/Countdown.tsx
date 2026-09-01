/*
 * Countdown — ported from `web/src/islands/consult/Countdown.tsx` for the
 * GetStream consult lane [WEB-GS-CONSULT-1 2026-09-01]. Unchanged logic: a
 * zine pill ticking down to `target` (ms epoch), coral in the final two
 * minutes, fires `onZero` exactly once. Used both as the in-call session
 * timer (retargeted whenever an extension lands) and the "too early" gate.
 */
import { useEffect, useRef, useState } from 'react';

export interface CountdownProps {
  /** Target instant in ms since epoch. */
  target: number;
  /** Fired once when the remaining time reaches zero. */
  onZero?: () => void;
  /** Label shown before the value (e.g. "Ends in", "Opens in"). */
  label?: string;
  /** Tick interval, ms. */
  intervalMs?: number;
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function Countdown({ target, onZero, label = 'Ends in', intervalMs = 1000 }: CountdownProps) {
  const [remaining, setRemaining] = useState(() => target - Date.now());
  const fired = useRef(false);

  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const left = target - Date.now();
      setRemaining(left);
      if (left <= 0 && !fired.current) {
        fired.current = true;
        onZero?.();
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const urgent = remaining <= 120_000 && remaining > 0;
  const done = remaining <= 0;

  return (
    <span
      className={[
        'inline-flex items-center gap-2 rounded-zine-badge border-zine px-3 py-1.5',
        'font-mono font-bold text-[13px] tabular-nums',
        done
          ? 'border-ink bg-paper2 text-inkMute'
          : urgent
            ? 'border-coral bg-card text-coral shadow-zine-error'
            : 'border-ink bg-card text-ink shadow-zine-xs',
      ].join(' ')}
      role="timer"
      aria-live={urgent ? 'polite' : 'off'}
    >
      <span className="uppercase tracking-[0.08em] text-inkSoft">{label}</span>
      <span>{done ? '00:00' : fmt(remaining)}</span>
    </span>
  );
}

export default Countdown;
