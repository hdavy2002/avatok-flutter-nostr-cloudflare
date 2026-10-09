/* [HF-HOST-ONBOARD-1] Host onboarding — shared contract.
 * Phase 1 is a clickable mock: every screen talks to `OnboardingApi`, which is a
 * fake (api.ts) today and the real worker client later. Screens never call fetch().
 * The same React code is wrapped into the Android/iOS app with Capacitor, so:
 * no hover-only UI, no window.alert/confirm, all browser storage behind storage.ts.
 * Spec: Specs/SPEC-2026-10-09-HF-HOST-ONBOARDING.md */

export type StepKey =
  | 'welcome' | 'phone' | 'aadhaar' | 'selfie' | 'payout'
  | 'avatar' | 'about' | 'languages' | 'topics' | 'price' | 'hours'
  | 'voice' | 'review' | 'generating' | 'preview' | 'done';

export type StepGroup = 'start' | 'verify' | 'profile' | 'voice' | 'finish';

export type Gender = 'woman' | 'man';
/** What the (mock) UIDAI record says; avatars stay woman/man. */
export type KycGender = Gender | 'transgender';
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
  /** Real mode: public URL of the AI sample-conversation audio (null when the voice stage was skipped). */
  sampleAudioUrl?: string | null;
  /** Real mode: voice + conversation stages were skipped (voice provider not connected yet). */
  voiceSkipped?: boolean;
}

export interface Draft {
  phone: string;               // 10 digits, no +91
  phoneVerified: boolean;
  kycGender: KycGender | null; // gender on the Aadhaar record (mock: chosen on the Aadhaar screen)
  aadhaarDone: boolean;
  aadhaarLast4: string;
  aadhaarName: string;         // name as read from Aadhaar (payout name must match)
  selfie: { recorded: boolean; consent: boolean; code: string };
  /** Never holds the full account number: only the last 4 digits. */
  payout: { upi: string; accountLast4: string; ifsc: string; nameAtBank: string; verified: boolean };
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
export type StageState = 'waiting' | 'working' | 'done' | 'skipped' | 'failed';
export type StageStates = Record<GenerationStage, StageState>;

/** Result shape shared by calls that can fail with a human message. `field` names the form field a server validation error belongs to. */
export interface ApiResult { ok: boolean; error?: string; field?: string; code?: string }

/** What the worker knows about this host when the page opens (real mode). */
export interface ServerDraft {
  draft: Partial<Draft>;
  hostStatus: string | null;
}

export interface OnboardingApi {
  /** 'mock' = clickable preview, nothing is sent. 'real' = talks to the worker. */
  readonly mode: 'mock' | 'real';
  sendOtp(phone: string): Promise<{ ok: boolean; error?: string }>;
  verifyOtp(phone: string, code: string): Promise<{ ok: boolean; error?: string }>;
  sendAadhaarOtp(aadhaar: string): Promise<{ ok: boolean; error?: string; alreadyVerified?: { gender: KycGender | null; last4: string } }>;
  /** Mock: `mockGender` is what the fake UIDAI record returns. Real mode ignores it (gender comes from Aadhaar). */
  verifyAadhaarOtp(code: string, mockGender: KycGender): Promise<{ ok: boolean; last4?: string; name?: string; gender?: KycGender; age?: number; error?: string }>;
  /** The number the host must say out loud in the selfie video. */
  getSelfieCode(): Promise<{ ok: boolean; code?: string; error?: string }>;
  /** Mock: stores nothing; the real one uploads the 10-second video with the spoken code. */
  uploadSelfie(blob: Blob, code: string): Promise<{ ok: boolean; error?: string; codeExpired?: boolean }>;
  /** Mock: penny-drop check. Real one compares nameAtBank with the Aadhaar name. */
  verifyPayout(input: { upi: string; account: string; ifsc: string }): Promise<{ ok: boolean; nameAtBank?: string; match?: boolean; error?: string }>;
  listAvatars(): Promise<Avatar[]>;
  /** Real: takes the avatar for this host (exclusive). Mock: always ok. */
  claimAvatar(id: string): Promise<ApiResult>;
  /** Mock: stores nothing. Real: keeps the blob; call commitVoice() once the host has agreed to the voice-use notice. */
  uploadVoice(blob: Blob, durationSec: number): Promise<{ ok: boolean; url?: string; error?: string }>;
  /** Real only: sends the recording kept by uploadVoice (needs the consent header). */
  commitVoice?(consent: boolean): Promise<ApiResult>;
  /** Real only: what the server already has for this host. Null in mock. */
  loadServerDraft(): Promise<ServerDraft | null>;
  /** Real only: debounced autosave of the profile fields (800 ms). Each field is sent on its own so one bad field never blocks the rest. */
  saveServerDraft(draft: Draft, onResult: (errors: Record<string, string>) => void): void;
  /** Real only: send any pending autosave right now. */
  flushServerDraft(): Promise<void>;
  /** Streams stage states while the profile is made; resolves with the finished profile. */
  generateProfile(draft: Draft, onStages: (stages: StageStates) => void): Promise<GeneratedProfile>;
  /** Real only: host edits of the generated tagline / about / quote. */
  editGenerated(patch: { tagline?: string; aboutPolished?: string; quote?: string }): Promise<ApiResult>;
  submitForReview(draft: Draft): Promise<ApiResult>;
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
  /** Real mode: server validation messages by field name (displayName, about, languages, ...). Empty in mock. */
  errors: Record<string, string>;
}
