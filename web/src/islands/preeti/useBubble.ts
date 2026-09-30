// [SAATHUM-PREETI-1] Draggable-bubble position logic.
// Persisted shape (localStorage "preeti_bubble_pos_v1"): {side:'left'|'right', y:0..1}
// where y is the bubble's vertical position as a ratio of the free travel range
// (0 = top margin, 1 = resting above the bottom edge). Ratio + side survive
// viewport changes; pixels are recomputed (and clamped) on every render/resize.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { KEY_BUBBLE, lsGet, lsSet } from './storage';

export const BUBBLE = 60;
export const EDGE = 16;
const TAP_SLOP = 6;

export interface BubblePos { side: 'left' | 'right'; y: number }
const DEFAULT_POS: BubblePos = { side: 'right', y: 1 };

function loadPos(): BubblePos {
  const raw = lsGet(KEY_BUBBLE);
  if (!raw) return DEFAULT_POS;
  try {
    const o = JSON.parse(raw) as Partial<BubblePos>;
    if ((o.side === 'left' || o.side === 'right') && typeof o.y === 'number' && Number.isFinite(o.y)) {
      return { side: o.side, y: Math.min(1, Math.max(0, o.y)) };
    }
  } catch { /* corrupt value - use default */ }
  return DEFAULT_POS;
}

function safeInsetBottom(): number {
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)';
    document.body.appendChild(probe);
    const v = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
    return v;
  } catch {
    return 0;
  }
}

export interface Rect { x: number; y: number }

export function useBubble(onTap: () => void) {
  const [pos, setPos] = useState<BubblePos>(DEFAULT_POS);
  const [vp, setVp] = useState({ w: 1024, h: 768, inset: 0 });
  const [drag, setDrag] = useState<Rect | null>(null);
  const start = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean; id: number } | null>(null);

  useEffect(() => {
    setPos(loadPos());
    const measure = () => setVp({ w: window.innerWidth, h: window.innerHeight, inset: safeInsetBottom() });
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  const minY = EDGE;
  const maxY = Math.max(minY, vp.h - BUBBLE - EDGE - vp.inset);
  const clampY = (y: number) => Math.min(maxY, Math.max(minY, y));
  const clampX = (x: number) => Math.min(Math.max(EDGE, vp.w - BUBBLE - EDGE), Math.max(EDGE, x));
  const restX = pos.side === 'left' ? EDGE : vp.w - BUBBLE - EDGE;
  const restY = clampY(minY + pos.y * (maxY - minY));
  const rect: Rect = drag ?? { x: restX, y: restY };

  const onPointerDown = useCallback((e: RPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture unsupported - drag still works while over the button */ }
    start.current = { px: e.clientX, py: e.clientY, ox: restX, oy: restY, moved: false, id: e.pointerId };
  }, [restX, restY]);

  const onPointerMove = useCallback((e: RPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    if (!s.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    s.moved = true;
    setDrag({ x: clampX(s.ox + dx), y: clampY(s.oy + dy) });
  }, [vp.w, vp.h, vp.inset]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = useCallback((e: RPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!s.moved) {
      setDrag(null);
      if (!cancelled) onTap();
      return;
    }
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    const x = clampX(s.ox + dx);
    const y = clampY(s.oy + dy);
    const side: 'left' | 'right' = x + BUBBLE / 2 < vp.w / 2 ? 'left' : 'right';
    const range = maxY - minY;
    const next: BubblePos = { side, y: range > 0 ? Math.min(1, Math.max(0, (y - minY) / range)) : 1 };
    setPos(next);
    setDrag(null);
    lsSet(KEY_BUBBLE, JSON.stringify(next));
  }, [onTap, vp.w, vp.h, vp.inset]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    rect,
    restRect: { x: restX, y: restY } as Rect,
    side: pos.side,
    vp,
    dragging: drag !== null,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: RPointerEvent<HTMLElement>) => finish(e, false),
      onPointerCancel: (e: RPointerEvent<HTMLElement>) => finish(e, true),
    },
  };
}
