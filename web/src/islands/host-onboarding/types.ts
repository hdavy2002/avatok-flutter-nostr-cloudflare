/* [HF-HOST-ONBOARD-1] Host onboarding — shared contract.
 * Phase 1 is a clickable mock: every screen talks to `OnboardingApi`, which is a
 * fake (api.ts) today and the real worker client later. Screens never call fetch().
 * The same React code is wrapped into the Android/iOS app with Capacitor, so:
 * no hover-only UI, no window.alert/confirm, all browser storage behind storage.ts.
 * Spec: Specs/SPEC-2026-10-09-HF-HOST-ONBOARDING.md */

export type StepKey =
  | 'welcome' | 'phone' | 'trust' | 'channel' | 'aadhaar' | 'selfie' | 'space' | 'caller' | 'payout'
  | 'avatar' | 'about' | 'languages' | 'topics' | 'price' | 'hours'
  | 'voice' | 'review' | 'generating' | 'preview' | 'done';

export type StepGroup = 'start' | 'verify' | 'profile' | 'voice' | 'finish';

/** [HF-CREATOR-SPACES-1] Which kind of creator this person is becoming. */
export type CreatorPath = 'channel' | 'women' | 'lgbtq';
/** [HF-CREATOR-BADGES-1] A special space (one at a time, needs video KYC). */
export type SpaceKind = 'women' | 'lgbtq';
export type CallerLevel = 'everyone' | 'video_kyc';

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
  takenBy?: string | null; // locked to another influencer (exclusive avatars)
}

export interface GeneratedProfile {
  tagline: string;
  about: string;
  quote: string;
  /** 5 AI gallery images (mock: avatar image + scene caption). */
  gallery: { image: string; caption: string }[];
  profileImage: string;
}

export interface Draft {
  /** [HF-CREATOR-BADGES-1] "How will fans trust you?" - both can be ticked, at least one. */
  wantChannel: boolean;
  wantKyc: boolean;
  /** The space the creator joined (null = none). Never holds the private LGBTQ+ declaration itself, only that it was sent. */
  space: SpaceKind | null;
  callerLevel: CallerLevel;
  callerLocked: boolean;
  lgbtqDeclared: boolean;      // the declare step was sent to the server
  channelQualified: boolean;   // GET /api/hf/channels said qualified
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
  pricePerMin: number;         // legacy fallback only; ignored when hfStdPlan is enabled
  hours: { days: string[]; from: string; to: string };
  healthConsent: boolean;
  lgbtqLane: boolean;          // private LGBTQ+ lane, offered to all genders, callers must be verified
  lgbtqShowOnProfile: boolean; // separate opt-in: show 'LGBTQ+ friendly' publicly (only when lgbtqLane)
  womenOnlyLane: boolean;      // only offered when kycGender === 'woman'
  /** [HF-VOICE-INTRO-1] The host's OWN recorded introduction. `recorded` = saved on the server (real) or kept locally (mock).
   *  `status` is the admin review state; null until saved. */
  voice: { recorded: boolean; durationSec: number; consent: boolean; source: 'mic' | 'upload' | null; status: VoiceStatus };
  agreements: { rules: boolean; agreement: boolean; welfare: boolean };
  generated: GeneratedProfile | null;
  submitted: boolean;
}

export type VoiceStatus = 'pending' | 'approved' | 'rejected' | null;
export type GenerationStage = 'text' | 'images' | 'safety';
export type StageState = 'waiting' | 'working' | 'done' | 'skipped' | 'failed';
export type StageStates = Record<GenerationStage, StageState>;

/** Result shape shared by calls that can fail with a human message. `field` names the form field a server validation error belongs to. */
export interface ApiResult { ok: boolean; error?: string; field?: string; code?: string }

/** What the worker knows about this host when the page opens (real mode). */
export interface ServerDraft {
  draft: Partial<Draft>;
  hostStatus: string | null;
}

/** [HF-KYC-OTP-FALLBACK-1] Result of an Aadhaar OTP call. `fallback` = OTP cannot work for this host, offer DigiLocker instead.
 *  `attemptsLeft` = tries left on this OTP. `field` names the form field the error belongs to ('aadhaar' | 'consent'). */
export interface KycOtpResult extends ApiResult { fallback?: 'digilocker'; attemptsLeft?: number }

/** [HF-CREATOR-SPACES-1] GET /api/hf/spaces/me */
export interface SpacesMe {
  kind?: CreatorPath | null;
  /** [HF-CREATOR-BADGES-1] */
  badges?: { phone: boolean; channel: boolean; videoKyc: boolean; space: SpaceKind | null };
  canGoLive?: boolean; missing?: string[]; callerLevel?: CallerLevel; callerLevelLocked?: boolean; whatsappVerified: boolean; aadhaarVerified: boolean; gender: 'F' | 'M' | 'T' | null;
  selfie: { status: 'none' | 'pending' | 'approved' | 'rejected'; reason: string | null };
  lgbtqDeclared: boolean; videoKycVerified: boolean; qualified: boolean; hostStatus: string | null; minFollowers: number; minViews: number;
}

export type ChannelState = 'checking' | 'approved' | 'needs_followers' | 'needs_views' | 'disconnected';
export interface ChannelItem {
  id: string; platform: 'instagram' | 'youtube'; handle: string; url: string | null; followers: number; views: number;
  state: ChannelState; verified: boolean; needsCode: boolean; verifyCode?: string | null;
}
export interface ChannelsInfo { channels: ChannelItem[]; minFollowers: number; minViews: number; qualified: boolean }
export interface ChannelAction extends ApiResult { channel?: ChannelItem; result?: string; message?: string; info?: ChannelsInfo }

export interface OnboardingApi {
  /** 'mock' = clickable preview, nothing is sent. 'real' = talks to the worker. */
  readonly mode: 'mock' | 'real';
  sendOtp(phone: string): Promise<{ ok: boolean; error?: string }>;
  verifyOtp(phone: string, code: string): Promise<{ ok: boolean; error?: string }>;
  /** [HF-KYC-OTP-FALLBACK-1] Aadhaar OTP (primary). The number is used for this one call only and is never kept by the client. */
  aadhaarSendOtp(aadhaar: string, consent: boolean): Promise<KycOtpResult & { alreadyVerified?: { gender: KycGender | null; last4: string } }>;
  /** Mock only: `mockGender` is what the fake record returns. */
  aadhaarVerifyOtp(otp: string, mockGender?: KycGender): Promise<KycOtpResult & { last4?: string; name?: string; gender?: KycGender }>;
  /** [HF-KYC-DIGILOCKER-1] DigiLocker (fallback). Step 1: ask the worker for the DigiLocker sign-in link. Mock never returns a url. */
  digilockerStart(consent: boolean, returnPath?: string): Promise<{ ok: boolean; url?: string; error?: string; alreadyVerified?: { gender: KycGender | null; last4: string } }>;
  /** Step 2 (after the host comes back): finish the check. `pending` = DigiLocker has not answered yet, ask again shortly.
   *  `retry` = the sign-in cannot be finished, start again. Mock: `mockGender` is what the fake record returns. */
  digilockerComplete(mockGender?: KycGender): Promise<{ ok: boolean; pending?: boolean; retry?: boolean; last4?: string; name?: string; gender?: KycGender; error?: string }>;
  /** The number the host must say out loud in the selfie video. */
  getSelfieCode(): Promise<{ ok: boolean; code?: string; error?: string }>;
  /** Mock: stores nothing; the real one uploads the 10-second video with the spoken code. */
  uploadSelfie(blob: Blob, code: string): Promise<{ ok: boolean; error?: string; codeExpired?: boolean }>;
  /** Mock: penny-drop check. Real one compares nameAtBank with the Aadhaar name. */
  verifyPayout(input: { upi: string }): Promise<{ ok: boolean; nameAtBank?: string; match?: boolean; error?: string }>;
  listAvatars(): Promise<Avatar[]>;
  /** Real: takes the avatar for this host (exclusive). Mock: always ok. */
  claimAvatar(id: string): Promise<ApiResult>;
  /** [HF-VOICE-INTRO-1] Saves the host's own introduction. Mock: stores nothing, pretends it worked.
   *  Real: PUT /api/hosts/me/voice with the consent header; the status comes back as 'pending'. */
  uploadVoice(blob: Blob, durationSec: number, consent: boolean, onProgress?: (fraction: number) => void): Promise<ApiResult & { status?: VoiceStatus }>;
  /** Real only: the host's own saved introduction as a playable object URL (needs the sign-in token, so it cannot be a plain src). Null when none. */
  fetchMyVoice?(): Promise<string | null>;
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
  /** [HF-CREATOR-SPACES-1] What the server knows about the creator type. Null in mock or when the call fails. */
  getSpacesMe(): Promise<SpacesMe | null>;
  /** [HF-CREATOR-BADGES-1] POST /api/hf/spaces/space (null = leave). */
  setSpace(body: { space: SpaceKind | null; declare?: true; acceptTerms?: true; publicTagConsent?: true }): Promise<ApiResult>;
  /** [HF-CREATOR-BADGES-1] POST /api/hf/spaces/caller-level. 409 space_locked for space creators. */
  setCallerLevel(level: CallerLevel): Promise<ApiResult>;
  /** POST /api/hf/spaces/creator. Errors carry the worker message (not_eligible, consent_required, declare_required). */
  setCreator(body: { kind: CreatorPath; declare?: true; acceptTerms?: true; publicTagConsent?: true }): Promise<ApiResult>;
  /** GET /api/hf/channels. */
  listChannels(): Promise<ChannelsInfo | null>;
  /** POST /api/hf/channels (bio-code route). */
  addChannel(platform: 'instagram' | 'youtube', handleOrUrl: string): Promise<ChannelAction>;
  /** POST /api/hf/channels/:id/check */
  checkChannel(id: string): Promise<ChannelAction>;
  /** POST /api/hf/channels/youtube/connect with a Google access token (youtube.readonly). */
  connectYoutube(accessToken: string): Promise<ChannelAction>;
  removeChannel(id: string): Promise<ApiResult>;
}

/** What the shell's sticky bottom bar does on this step. A step sets it with
 *  `setAction`; when a step sets nothing, the bar shows "Continue" (enabled). */
export interface StepAction {
  label: string;
  disabled?: boolean;
  /** Return true to move to the next step. May be async (server check etc.). */
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
