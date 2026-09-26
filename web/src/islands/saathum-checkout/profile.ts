/* [SAATHUM-CHECKOUT-UI 2026-09-26] Prefill/save against the EXISTING profile
 * API (GET/PUT /api/me/profile — Specs/SPEC-2026-09-25-DASHBOARD-2.md, read
 * from dashboard2/Profile.tsx). We do NOT own that endpoint or its full
 * shape; this only reads/writes the subset the checkout needs (sankalp +
 * address + phone.verified), the same fields the profile screen itself
 * saves, so a booking here shows up prefilled there and vice versa.
 */
import { request } from '../../lib/apiClient';
import type { Address, Sankalp } from './types';

interface ProfileFamilyMember { name: string; relation?: string }
export interface CheckoutProfile {
  name: string | null;
  gotra?: string;
  family: (string | ProfileFamilyMember)[];
  phone: { e164_masked: string | null; verified: boolean };
  address?: { name: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; pin: string | null; country: string | null };
}

export function getProfile(auth: string): Promise<CheckoutProfile> {
  return request<CheckoutProfile>('/api/me/profile', { auth });
}

export function familyNames(family: CheckoutProfile['family']): string[] {
  return family.map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
}

/** Best-effort prefill for the sankalp step — never blocks the UI on failure. */
export function sankalpFromProfile(p: CheckoutProfile | null): Sankalp {
  if (!p) return { name: '' };
  return { name: p.name ?? '', gotra: p.gotra ?? '', family: familyNames(p.family) };
}

/** Best-effort prefill for the shipping address — India-only shape (pincode). */
export function addressFromProfile(p: CheckoutProfile | null): Address | null {
  const a = p?.address;
  if (!a || !a.line1) return null;
  return {
    name: a.name ?? p?.name ?? '',
    phone: p?.phone?.e164_masked ?? '',
    line1: a.line1 ?? '',
    line2: a.line2 ?? '',
    city: a.city ?? '',
    state: a.state ?? '',
    pincode: a.pin ?? '',
  };
}

// Note: POST /api/saathum/checkout itself saves sankalp + address back to the
// profile (spec §HTTP contract, "Signed in"), so this module only prefills —
// it never writes, avoiding a second, possibly racing PUT /api/me/profile.
