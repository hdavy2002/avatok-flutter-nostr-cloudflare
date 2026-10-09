/* [HF-LANE-VERIFY-1] Client for the protected-lane routes, and a lane-caller flavour of the Aadhaar client.
 * The Aadhaar steps are the host-onboarding ones (OTP first, DigiLocker fallback); only the role and the return path differ. */
import { call, kycGender, otpFailure, realApi } from '../host-onboarding/api_real';
import type { OnboardingApi } from '../host-onboarding/types';

export type Lane = 'women' | 'lgbtq';
export const parseLane = (v: string | null | undefined): Lane | null => (v === 'women' || v === 'lgbtq' ? v : null);
export const laneReturnPath = (lane: Lane) => `/verify/lane?lane=${lane}&dl=return`;

export interface LaneMe {
  whatsappVerified: boolean; aadhaarVerified: boolean; gender: 'F' | 'M' | 'T' | null;
  lanes: { women: { eligible: boolean; granted: boolean }; lgbtq: { declared: boolean; granted: boolean } };
}

export async function fetchLaneMe(): Promise<{ ok: true; me: LaneMe } | { ok: false; status: number; error: string; code?: string }> {
  const r = await call<LaneMe>('GET', '/api/hf/lanes/me', undefined, 'We could not load your details. Please try again.');
  return r.ok ? { ok: true, me: r.data } : { ok: false, status: r.status, error: r.error ?? '', code: r.code };
}

export async function joinLane(lane: Lane): Promise<{ ok: boolean; error?: string; code?: string }> {
  const body = lane === 'lgbtq' ? { declare: true, ack18: true } : { ack18: true };
  const r = await call<{ ok: boolean }>('POST', `/api/hf/lanes/${lane}/join`, body, 'We could not open this space for you. Please try again.');
  return r.ok ? { ok: true } : { ok: false, error: r.error, code: r.code };
}

export async function leaveLane(lane: Lane): Promise<boolean> {
  const r = await call<{ ok: boolean }>('DELETE', `/api/hf/lanes/${lane}`, undefined, 'We could not do that. Please try again.');
  return r.ok;
}

/** Host-onboarding Aadhaar client with role "lane_caller" and a return path back to this page. */
export function makeLaneAadhaarApi(lane: Lane): OnboardingApi {
  return {
    ...realApi,
    async aadhaarSendOtp(aadhaar, consent) {
      const r = await call<{ ok: boolean; already_verified?: boolean; gender?: string | null; last4?: string }>(
        'POST', '/api/hosts/kyc/aadhaar/otp', { aadhaar: aadhaar.replace(/\D/g, ''), consent, role: 'lane_caller' }, 'We could not send the OTP. Please check the number.');
      if (!r.ok) return otpFailure(r);
      if (r.data.already_verified) return { ok: true, alreadyVerified: { gender: kycGender(r.data.gender ?? null), last4: r.data.last4 || '' } };
      return { ok: true };
    },
    async digilockerStart(consent, returnPath) {
      const r = await call<{ ok: boolean; url?: string; already_verified?: boolean; gender?: string | null; last4?: string }>(
        'POST', '/api/hosts/kyc/digilocker/start', { consent, role: 'lane_caller', returnPath: returnPath || laneReturnPath(lane) },
        'We could not open DigiLocker right now. Please try again.');
      if (!r.ok) return { ok: false, error: r.error };
      if (r.data.already_verified) return { ok: true, alreadyVerified: { gender: kycGender(r.data.gender ?? null), last4: r.data.last4 || '' } };
      if (!r.data.url) return { ok: false, error: 'We could not open DigiLocker right now. Please try again.' };
      return { ok: true, url: r.data.url };
    },
  };
}
