// [SAATHUM-FREEVID-BASE-1 2026-10-01] Video crop — the part of a 16:9 YouTube frame
// the public is allowed to see. Owner decision 2026-10-01: an admin draws a box over
// the video in the event form; every player then shows ONLY that box.
//
// A crop is four FRACTIONS of the full 16:9 player frame (0..1), so it fits any screen
// size: x/y = top-left corner, w/h = size. null = no crop (show the whole frame).
// The worker validates the same rules (worker/src/lib/video_crop.ts) — keep in step.

import type { CSSProperties } from 'react';

export interface VideoCrop { x: number; y: number; w: number; h: number }

/** Smallest side an admin may draw, as a fraction of the frame. */
export const CROP_MIN = 0.05;

/** True when `c` is a usable crop box (finite, inside the frame, not too small). */
export function isValidCrop(c: unknown): c is VideoCrop {
  if (!c || typeof c !== 'object') return false;
  const { x, y, w, h } = c as Record<string, unknown>;
  if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  const [X, Y, W, H] = [x, y, w, h] as number[];
  return X >= 0 && Y >= 0 && W >= CROP_MIN && H >= CROP_MIN && X + W <= 1.0001 && Y + H <= 1.0001;
}

/** A crop that covers (almost) the whole frame is the same as no crop. */
export function isFullFrame(c: VideoCrop | null | undefined): boolean {
  return !c || (c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999);
}

/** Normalise anything (API payload, form state) to a crop or null. */
export function toCrop(c: unknown): VideoCrop | null {
  if (!isValidCrop(c)) return null;
  const r = (v: number) => Math.round(v * 10_000) / 10_000;
  const out = { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h) };
  return isFullFrame(out) ? null : out;
}

/** Width ÷ height of the visible (cropped) picture. 16/9 with no crop. */
export function cropAspect(c: VideoCrop | null | undefined): number {
  if (isFullFrame(c)) return 16 / 9;
  return (c!.w * 16) / (c!.h * 9);
}

/**
 * Style for the element that holds the FULL 16:9 picture (YouTube's iframe host, or a
 * poster image) inside a frame that is already sized to `cropAspect`. Scaling it up and
 * shifting it left/up leaves only the crop box inside the frame's overflow:hidden.
 */
export function cropInnerStyle(c: VideoCrop | null | undefined): CSSProperties {
  if (isFullFrame(c)) return { position: 'absolute', inset: 0 };
  const k = c!;
  return {
    position: 'absolute',
    width: `${100 / k.w}%`,
    height: `${100 / k.h}%`,
    left: `${(-k.x / k.w) * 100}%`,
    top: `${(-k.y / k.h) * 100}%`,
    maxWidth: 'none',
  };
}
