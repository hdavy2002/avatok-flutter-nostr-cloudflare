/* VideoCropEditor — [SAATHUM-FREEVID-ADMIN-1 2026-10-01] Draw the part of the YouTube
 * picture the public may see. Contract: Specs/SPEC-2026-10-01-FREE-EVENTS-VIDEO-CROP.md.
 *
 * MATH: a crop is {x,y,w,h}, fractions (0..1) of the FULL 16:9 frame (web/src/components/dash2/crop.ts).
 * The stage is exactly 16:9, so a pointer position maps to a frame fraction by dividing by the
 * stage's width/height. A locked shape is a ratio r = width/height of the PICTURE in pixels, so in
 * frame fractions h = w * 16 / (9 * r) (a frame is wider than tall, so equal fractions are not a square).
 * Drawing and corner-resizing share one rule: the fixed corner is the anchor, the pointer is the
 * opposite corner, and the box is clamped inside the frame, never below CROP_MIN.
 * While dragging, only local state changes; the parent gets one onChange on release (keeps the
 * big event form from re-rendering on every pointer move).
 */
import { lazy, Suspense, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Maximize2, Monitor, RotateCcw, Scissors, Smartphone } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { CROP_MIN, cropAspect, toCrop, type VideoCrop } from '../../components/dash2/crop';

// Non-critical: the real player (and YouTube's script) only load once the editor is on screen.
const GuardedPlayer = lazy(() => import('../../components/dash2/YouTubeGuardedPlayer'));

type Shape = 'free' | '16:9' | '4:3' | '1:1' | '9:16';
const SHAPES: { key: Shape; label: string; r: number | null }[] = [
  { key: 'free', label: 'Free shape', r: null },
  { key: '16:9', label: '16:9 wide', r: 16 / 9 },
  { key: '4:3', label: '4:3', r: 4 / 3 },
  { key: '1:1', label: '1:1 square', r: 1 },
  { key: '9:16', label: '9:16 phone', r: 9 / 16 },
];
const FULL: VideoCrop = { x: 0, y: 0, w: 1, h: 1 };
const AUTO_TRIM: VideoCrop = { x: 0.125, y: 0, w: 0.75, h: 1 };
const STEP = 0.01;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Frame-fraction height for a frame-fraction width at picture ratio r. */
const hFor = (w: number, r: number) => (w * 16) / (9 * r);

/** Box with one fixed corner (ax,ay) and the pointer (px,py) as the opposite corner, inside the frame. */
function boxFromAnchor(ax: number, ay: number, px: number, py: number, r: number | null): VideoCrop {
  const sx = px >= ax ? 1 : -1;
  const sy = py >= ay ? 1 : -1;
  const availW = sx > 0 ? 1 - ax : ax;
  const availH = sy > 0 ? 1 - ay : ay;
  let w = Math.min(Math.abs(px - ax), availW);
  let h = Math.min(Math.abs(py - ay), availH);
  if (r !== null) {
    h = hFor(w, r);
    if (h > availH) { h = availH; w = (h * 9 * r) / 16; }
    if (h < CROP_MIN) { h = CROP_MIN; w = (h * 9 * r) / 16; }
    if (w < CROP_MIN) { w = CROP_MIN; h = hFor(w, r); }
    if (h > availH) { h = availH; w = (h * 9 * r) / 16; }
  } else {
    w = Math.max(w, CROP_MIN);
    h = Math.max(h, CROP_MIN);
  }
  w = Math.min(w, availW, 1);
  h = Math.min(h, availH, 1);
  const x = clamp(sx > 0 ? ax : ax - w, 0, 1 - w);
  const y = clamp(sy > 0 ? ay : ay - h, 0, 1 - h);
  return { x, y, w, h };
}

/** Re-shape `box` to picture ratio r around its centre, never bigger than `box`, kept inside the frame. */
function fitRatio(box: VideoCrop, r: number): VideoCrop {
  let w = box.w;
  let h = hFor(w, r);
  if (h > box.h) { h = box.h; w = (h * 9 * r) / 16; }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

const pctText = (v: number) => `${Math.round(v * 1000) / 10}%`;
const keyOf = (c: VideoCrop | null) => (c ? `${c.x},${c.y},${c.w},${c.h}` : '');

type Drag =
  | { mode: 'draw'; ax: number; ay: number; moved: boolean }
  | { mode: 'resize'; ax: number; ay: number }
  | { mode: 'move'; sx: number; sy: number; start: VideoCrop };

const HANDLES: { key: 'nw' | 'ne' | 'sw' | 'se'; left: string; top: string; cursor: string }[] = [
  { key: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { key: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { key: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { key: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
];

export interface VideoCropEditorProps {
  videoId: string;
  title: string;
  /** Current crop; null = whole video. */
  value: VideoCrop | null;
  /** The crop stored on the server — what "Reset" goes back to. */
  saved: VideoCrop | null;
  onChange: (c: VideoCrop | null) => void;
  disabled?: boolean;
}

export default function VideoCropEditor({ videoId, title, value, saved, onChange, disabled }: VideoCropEditorProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const liveRef = useRef<VideoCrop | null>(null);
  const [live, setLive] = useState<VideoCrop | null>(null);
  const [shape, setShape] = useState<Shape>('free');
  const [view, setView] = useState<'desktop' | 'phone'>('desktop');
  const [thumb, setThumb] = useState<'max' | 'hq'>('max');

  const ratio = SHAPES.find((s) => s.key === shape)?.r ?? null;
  const box = live ?? value; // what the stage draws
  const vid = encodeURIComponent(videoId);
  const src = `https://i.ytimg.com/vi/${vid}/${thumb === 'max' ? 'maxresdefault' : 'hqdefault'}.jpg`;

  const point = (e: PointerEvent): { px: number; py: number } => {
    const r = stageRef.current!.getBoundingClientRect();
    return { px: clamp((e.clientX - r.left) / r.width, 0, 1), py: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };
  const setLiveBox = (b: VideoCrop | null) => { liveRef.current = b; setLive(b); };

  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (disabled || e.button > 0) return;
    const t = e.target as HTMLElement;
    const handle = t.closest<HTMLElement>('[data-handle]')?.dataset.handle;
    const inBox = !!t.closest('[data-crop-box]');
    const { px, py } = point(e);
    if (handle && value) {
      const ax = handle.includes('w') ? value.x + value.w : value.x;
      const ay = handle.includes('n') ? value.y + value.h : value.y;
      dragRef.current = { mode: 'resize', ax, ay };
    } else if (inBox && value) {
      dragRef.current = { mode: 'move', sx: px, sy: py, start: value };
    } else {
      dragRef.current = { mode: 'draw', ax: px, ay: py, moved: false };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    e.preventDefault();
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const { px, py } = point(e);
    if (d.mode === 'move') {
      const s = d.start;
      setLiveBox({ ...s, x: clamp(s.x + px - d.sx, 0, 1 - s.w), y: clamp(s.y + py - d.sy, 0, 1 - s.h) });
    } else {
      if (d.mode === 'draw' && !d.moved) {
        if (Math.abs(px - d.ax) < 0.01 && Math.abs(py - d.ay) < 0.01) return; // a click, not a drag yet
        d.moved = true;
      }
      setLiveBox(boxFromAnchor(d.ax, d.ay, px, py, ratio));
    }
  }

  function onUp() {
    const d = dragRef.current;
    dragRef.current = null;
    const b = liveRef.current;
    setLiveBox(null);
    if (!d || !b) return;
    onChange(toCrop(b));
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled || !value) return;
    const dx = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    const dy = e.key === 'ArrowUp' ? -STEP : e.key === 'ArrowDown' ? STEP : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    onChange(toCrop({ ...value, x: clamp(value.x + dx, 0, 1 - value.w), y: clamp(value.y + dy, 0, 1 - value.h) }));
  }

  function pickShape(s: (typeof SHAPES)[number]) {
    setShape(s.key);
    if (s.r !== null) onChange(toCrop(fitRatio(value ?? FULL, s.r)));
  }

  const aspect = cropAspect(value);
  const phone = view === 'phone';

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border/70 bg-background p-3 sm:p-4">
      <div>
        <h3 className="font-dash text-[16px] font-bold text-grand-teal">Crop the video</h3>
        <p className="mt-1 text-[14px] font-semibold text-muted-foreground">
          Drag on the picture to draw a box. Everyone watching sees only what is inside it. Drag the box to move it, drag a corner to resize.
        </p>
      </div>

      {/* Stage: exactly 16:9, so pointer position / size = frame fraction. */}
      <div
        ref={stageRef}
        role="group"
        tabIndex={0}
        aria-label="Video crop area. Use the arrow keys to move the crop box by 1 percent."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        className={cn(
          'relative aspect-video w-full select-none overflow-hidden rounded-lg border border-border bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-crosshair',
        )}
        style={{ touchAction: 'none' }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          onError={() => { if (thumb === 'max') setThumb('hq'); }}
          onLoad={(e) => { if (thumb === 'max' && e.currentTarget.naturalWidth <= 120) setThumb('hq'); }}
        />
        {box && (
          <div
            data-crop-box=""
            className={cn('absolute border-2 border-white', !disabled && 'cursor-move')}
            style={{
              left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)',
            }}
          >
            {/* rule of thirds */}
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/50" />
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/50" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/50" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/50" />
            <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[13px] font-bold tabular-nums text-white">
              {pctText(box.w)} × {pctText(box.h)}
            </span>
            {!disabled && HANDLES.map((h) => (
              <span
                key={h.key}
                data-handle={h.key}
                className="absolute flex h-8 w-8 items-center justify-center"
                style={{ left: h.left, top: h.top, transform: 'translate(-50%, -50%)', cursor: h.cursor }}
              >
                <span className="block h-4 w-4 rounded-[3px] border-2 border-accent bg-white shadow" />
              </span>
            ))}
          </div>
        )}
        {!box && (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[13px] font-bold text-white">
            Showing the full video. Drag to crop.
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Crop shape">
        {SHAPES.map((s) => (
          <Button key={s.key} type="button" size="sm" variant={shape === s.key ? 'default' : 'outline'} aria-pressed={shape === s.key}
            disabled={disabled} onClick={() => pickShape(s)} className="min-h-[40px]">
            {s.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} className="min-h-[40px]"
          onClick={() => { setShape('free'); onChange(AUTO_TRIM); }}>
          <Scissors /> Auto-trim black bars
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || !value} className="min-h-[40px]" onClick={() => onChange(null)}>
          <Maximize2 /> Show full video
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled || keyOf(value) === keyOf(saved)} className="min-h-[40px]" onClick={() => onChange(saved)}>
          <RotateCcw /> Reset
        </Button>
      </div>

      <p className="text-[14px] font-semibold tabular-nums text-foreground" aria-live="polite">
        {value
          ? <>Left {pctText(value.x)} · Top {pctText(value.y)} · Width {pctText(value.w)} · Height {pctText(value.h)} <span className="text-muted-foreground">· picture shape {aspect.toFixed(2)}:1</span></>
          : <span className="text-muted-foreground">No crop — the whole video is shown.</span>}
      </p>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[15px] font-bold text-foreground">What the public sees</span>
          <div className="flex gap-1" role="group" aria-label="Preview size">
            <Button type="button" size="sm" variant={!phone ? 'default' : 'outline'} aria-pressed={!phone} onClick={() => setView('desktop')} className="min-h-[40px]">
              <Monitor /> Desktop
            </Button>
            <Button type="button" size="sm" variant={phone ? 'default' : 'outline'} aria-pressed={phone} onClick={() => setView('phone')} className="min-h-[40px]">
              <Smartphone /> Phone
            </Button>
          </div>
        </div>
        <div className="flex justify-center rounded-lg bg-muted/60 p-3">
          <div className={cn('min-w-0', phone ? 'w-[220px] rounded-[26px] border-4 border-foreground/80 bg-black p-1' : 'w-full max-w-[520px]')}>
            <Suspense fallback={<div className="aspect-video w-full animate-pulse rounded bg-muted" aria-label="Loading preview" />}>
              <GuardedPlayer videoId={videoId} title={title || 'Preview'} crop={value} />
            </Suspense>
          </div>
        </div>
        <p className="text-[13px] font-semibold text-muted-foreground">This is the real player. Press play to check the crop on the live picture.</p>
      </div>
    </div>
  );
}
