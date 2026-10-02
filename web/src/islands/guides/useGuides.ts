/* [AUMFE-GUIDES-FRONT-1] Shared hooks: load the guides once a previewer is confirmed; fire guides_ad_seen once. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { loadGuides, type GuidesData } from './api';

/** Fetches /api/voice/agents only when `enabled`. A failed call leaves `data` null (callers show the static design). */
export function useGuides(enabled: boolean): GuidesData | null {
  const [data, setData] = useState<GuidesData | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadGuides().then((d) => { if (alive) setData(d); }).catch((e) => captureException(e, { where: 'guides_agents' }));
    return () => { alive = false; };
  }, [enabled]);
  return data;
}

/** guides_ad_seen {surface} the first time the section is at least 30% on screen. */
export function useSeen(ref: RefObject<HTMLElement | null>, surface: 'home' | 'explore', active: boolean) {
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || done.current) return;
    const fire = () => { if (!done.current) { done.current = true; capture('guides_ad_seen', { surface }); } };
    if (typeof IntersectionObserver === 'undefined') { fire(); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { fire(); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, surface, active]);
}

export const clicked = (surface: 'home' | 'explore', target: string) => capture('guides_ad_clicked', { surface, target });
