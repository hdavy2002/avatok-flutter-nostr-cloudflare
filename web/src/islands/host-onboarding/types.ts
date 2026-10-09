/* [HF-HOST-ONBOARD-1] Host onboarding — shared contract.
 * Phase 1 is a clickable mock: every screen talks to `OnboardingApi`, which is a
 * fake (api.ts) today and the real worker client later. Screens never call fetch().
 * The same React code is wrapped into the Android/iOS app with Capacitor, so:
 * no hover-only UI, no window.alert/confirm, all browser storage behind storage.ts.
 * Spec: Specs/SPEC-2026-10-09-HF-HOST-ONBOARDING.md */

export type StepKey =
  | 'welcome' | 'phone' | 'kyc' | 'aadhaar'
  | 'avatar' | 'about' | 'languages' | 'topics' | 'price' | 'hours'
  | 'voice' | 'review' | 'generating' | 'preview' | 'done';

export type StepGroup = 'start' | 'verify' | 'profile' | 'voice' | 'finish';

export type Gender = 'woman' | 'man';
export type AgeBand = '20s' | '30s' | '40s' | '50s+';
export type AvatarStyle = 'traditional' | 'casual' | 'office';

export interface Avatar {
  id: string;
  image: string;          // public path, e.g. /assets/callvaal/scrapbook/portrait-7.png
  gender: Gender;
  age: AgeBand;
  style: AvatarStyle;
  takenBy?: string | null; // locked to another host (exclusive avatars)
}

export interface GeneratedProfile {
  tagline: string;
  about: string;
  quote: string;
  /** ~20 s two-voice sample conversation, shown as a transcript in the mock. */
  conversation: { speaker: 'caller' | 'host'; text: string }[];
  /** 5 AI gallery images (mock: avatar image + scene caption). */
  gallery: { image: string; caption: string }[];
  profileImage: string;
}

export interface Draft {
  phone: string;               // 10 digits, no +91
  phoneVerified: boolean;
  kycDone: boolean;
  kycGender: Gender | null;    // what video KYC reports (mock: chosen on the KYC screen)
  aadhaarDone: boolean;
  aadhaarLast4: string;
  avatarId: string | null;
  displayName: string;
  about: string;               // host's own words, 40–500 chars
  languages: string[];
  style: string | null;        // conversation style label
  topics: string[];            // mood slugs, 1..6
  pricePerMin: number;         // one price for all topics (owner decision 2026-10-09), ₹5 floor
  hours: { days: string[]; from: string; to: string };
  healthConsent: boolean;
  lgbtqLane: boolean;          // private LGBTQ+ lane, offered to all genders, callers must be verified
  lgbtqShowOnProfile: boolean; // separate opt-in: show 'LGBTQ+ friendly' publicly (only when lgbtqLane)
  womenOnlyLane: boolean;      // only offered when kycGender === 'woman'
  voice: { recorded: boolean; durationSec: number; consent: boolean; source: 'mic' | 'upload' | null };
  agreements: { rules: boolean; agreement: boolean; welfare: boolean };
  generated: GeneratedProfile | null;
  submitted: boolean;
}

export type GenerationStage = 'text' | 'images' | 'voice' | 'conversation' | 'safety';

export interface OnboardingApi {
  sendOtp(phone: string): Promise<{ ok: boolean; error?: string }>;
  verifyOtp(phone: string, code: string): Promise<{ ok: boolean; error?: string }>;
  /** Mock: resolves after a short delay with the gender passed in. */
  runVideoKyc(mockGender: Gender): Promise<{ ok: boolean; gender: Gender }>;
  sendAadhaarOtp(aadhaar: string): Promise<{ ok: boolean; error?: string }>;
  verifyAadhaarOtp(code: string): Promise<{ ok: boolean; last4?: string; error?: string }>;
  listAvatars(): Promise<Avatar[]>;
  uploadVoice(blob: Blob, durationSec: number): Promise<{ ok: boolean; url?: string }>;
  generateProfile(draft: Draft, onStage: (stage: GenerationStage) => void): Promise<GeneratedProfile>;
  submitForReview(draft: Draft): Promise<{ ok: boolean }>;
}

/** What the shell's sticky bottom bar does on this step. A step sets it with
 *  `setAction`; when a step sets nothing, the bar shows "Continue" (enabled). */
export interface StepAction {
  label: string;
  disabled?: boolean;
  /** Return true to move to the next step. May be async (OTP verify etc.). */
  run?: () => boolean | Promise<boolean>;
  /** Hide the bottom bar entirely (welcome, generating, done own their buttons). */
  hidden?: boolean;
}

export interface StepProps {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  api: OnboardingApi;
  setAction: (action: StepAction) => void;
  /** Move forward without the bottom bar (e.g. welcome "Start", generating finished). */
  goNext: () => void;
  goTo: (step: StepKey) => void;
  avatars: Avatar[];
}
