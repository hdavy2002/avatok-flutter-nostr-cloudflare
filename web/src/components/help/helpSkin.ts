// [HELLO-FRAANDS-HELP-1 2026-10-08] Small helpers shared by the help landing
// (pages/help/index.astro) and article layout (layouts/Help.astro). The old
// Aum Fe help skin (temple artwork, section marks, pills) was removed with the
// puja articles; styling now lives in styles/hello-fraands-help.css.
import type { HelpEntry } from '../../lib/help';

/** Reading time from the markdown body, ~200 words a minute, never below 1. */
export function readMinutes(entry: HelpEntry): number {
  const words = (entry.body ?? '').replace(/<!--[\s\S]*?-->/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// Hand-rolled (not toLocaleDateString) — ICU data varies across build images.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dateLabel(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Schema values stay buyer/creator; on this site they mean callers/hosts. */
export const AUDIENCE_LABEL: Record<'buyer' | 'creator' | 'both', string> = {
  buyer: 'For callers',
  creator: 'For hosts',
  both: 'For everyone',
};

export function countLabel(n: number): string {
  return `${n} article${n === 1 ? '' : 's'}`;
}
