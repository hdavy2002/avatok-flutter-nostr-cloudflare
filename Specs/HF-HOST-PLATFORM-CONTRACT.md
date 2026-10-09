# HF-HOST-PLATFORM-1 — shared contract (phases 2–5)

Owner approved all phases 2026-10-09 ("do all the phases one by one"). Everything is gated by flags (default false): `hostKycEnabled` (exists), `hostOnboardingEnabled`, `hostsPublicEnabled`. Tables: `worker/migrations/2026-10-09-hf-hosts.sql` + `2026-10-09-hf-host-kyc.sql`.
Auth: `requireUser` (Clerk JWT). Admin: `isAdminUid` (ADMIN_UIDS). Public media in `BLOBS` (url = `${BLOSSOM_BASE_URL}/${key}`); private evidence in `VERIFICATION`.
Brand: never type the brand name; use BRAND. Telemetry: PostHog via existing helpers; never PII.

## Host APIs (flag hostOnboardingEnabled; 404 `not_enabled` when off)
- `GET /api/hosts/me` → `{ host: Host|null, kyc: <same as GET /api/hosts/kyc/status> , media: Media[], job: Job|null }`
- `PUT /api/hosts/me` (partial) fields: displayName, about, languages[], style, topics[] (1–6 mood slugs), conversationLang, pricePerMin (5–100 int), hours{days[],from,to}, healthConsent, womenLane (only if kyc gender F), lgbtqLane, lgbtqPublic (only if lgbtqLane), agreements:true → `{host}`. Server validates; contact-leak filter on displayName/about (numbers, @, links, app names).
- `GET /api/hosts/avatars?gender=&age=&look=` → `[{id,url,gender,age,look,taken}]` (taken = claimed by someone else)
- `POST /api/hosts/avatars/:id/claim` → atomic; releases the host's previous avatar → `{ok, avatarId}` | 409 `avatar_taken`
- `POST /api/hosts/voice` raw audio (webm/ogg/mp4/mpeg/wav, ≤ 6 MB), headers `x-voice-seconds`, `x-voice-consent: v1` → private `VERIFICATION` key `hf/voice/<uid>/<ts>.<ext>` → `{ok}`
- `POST /api/hosts/generate` → requires kyc done (aadhaar+selfie+payout), avatar, profile fields, voice; max 3 attempts → starts Workflow → `{jobId}`
- `GET /api/hosts/generate/status` → `{status, stages:{text,images,voice,conversation,safety: 'waiting'|'working'|'done'|'skipped'|'failed'}, error?}`
- `PUT /api/hosts/me/generated` {tagline?, aboutPolished?, quote?} → host
- `POST /api/hosts/submit` → status pending_review (needs media done) → `{ok}`; WhatsApp to admin optional

## Host shape (JSON, camelCase)
`{ uid, slug, status, displayName, about, tagline, quote, aboutPolished, languages, style, topics, conversationLang, pricePerMin, hours, healthConsent, womenLane, lgbtqLane, lgbtqPublic, avatarId, avatarUrl, voiceSeconds, genAttempts, reviewNote, liveAt }`
Media: `{ id, kind, url, caption, transcript?: {speaker:'host'|'caller', text}[], sort }`

## Generation (Workflow `HostMediaWorkflow`, binding `HOST_MEDIA`)
Stages: text (Gemini: tagline, aboutPolished, quote, two-voice script in conversationLang with ElevenLabs v3 audio tags) → images (5 gallery scenes with the avatar image as reference, `gemini-3.1-flash-image`; profile image = avatar) → voice (ElevenLabs Instant Voice Clone from the host's sample) → conversation (ElevenLabs text-to-dialogue eleven_v3; caller = stock voice of opposite/neutral gender) → delete clone → safety (Gemini check images+text) → status `pending_host` → WhatsApp to host. If `ELEVENLABS_API_KEY` is missing, voice+conversation stages are `skipped` (owner will add the key) and the profile can still be reviewed.

## Admin (ADMIN_UIDS)
- `GET /api/admin/hf/hosts?status=` list; `GET /api/admin/hf/hosts/:uid` full (host, media, kyc summary, selfie + aadhaar photo via existing signed media route in hf_host_kyc.ts)
- `POST /api/admin/hf/hosts/:uid/decision` {decision:'approve'|'reject'|'pause', reason} → live/rejected/paused, audit, WhatsApp host
- `GET /api/admin/hf/avatars`, `POST /api/admin/hf/avatars/generate` {count≤12, gender, age, look} (queues avatar_batch job), `POST /api/admin/hf/avatars/:id/retire`

## Public (flag hostsPublicEnabled)
- `GET /api/hosts/public?limit=&offset=` → cards `[{slug, displayName, tagline, avatarUrl, languages, style, topics, pricePerMin, rating:null, reviewCount:0, talkedTo:0, lgbtqFriendly, womenOnly:false, sampleAudioUrl, status:'offline'}]`
- `GET /api/hosts/public/:slug` → card + aboutPolished, quote, gallery[], sampleAudio{url, transcript}
Web profile route: `/h/<slug>` (SSR, prerender=false). Women-only / LGBTQ lane hosts are listed publicly only per their public choice (lgbtqPublic); lane-only visibility comes with calls.
