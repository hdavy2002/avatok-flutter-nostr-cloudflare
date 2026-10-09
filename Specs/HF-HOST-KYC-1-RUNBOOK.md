# HF-HOST-KYC-1 — Host verification backend: runbook

Rulebook: `Specs/RULEBOOK-HELLO-FRAANDS.md` §13 (HF-KYC-1..5, HF-PRIV-6). Code: `worker/src/routes/hf_host_kyc.ts`,
`lib/sandbox_client.ts`, `lib/pii_crypto.ts`, `lib/hf_kyc_util.ts`. Everything is dark behind flag `hostKycEnabled` (default false).
Nothing here has been deployed, migrated or flipped.

## 1. Secrets (staging first; prod needs ALLOW_PROD=1)
```bash
# Sandbox.co.in dashboard -> API keys (use TEST keys + SANDBOX_BASE_URL on staging)
scripts/cf.sh worker secret put SANDBOX_API_KEY
scripts/cf.sh worker secret put SANDBOX_API_SECRET
# Field-encryption key: 32 random bytes, base64. BACK IT UP (password manager). Lose it = every encrypted KYC field is unreadable.
openssl rand -base64 32 | scripts/cf.sh worker secret put HF_PII_KEY
# Staging only, to hit the vendor sandbox instead of production:
#   add a wrangler var SANDBOX_BASE_URL=https://test-api.sandbox.co.in
```
Never paste the values into chat, commits or logs. Rotating HF_PII_KEY needs a re-encrypt job (ciphertexts are `v1:`-prefixed for that).

## 2. Migration (CREATE TABLEs only — D1 DB_META)
```bash
scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-host-kyc.sql
```
Creates `hf_kyc`, `hf_selfie`, `hf_payout`, `hf_kyc_otp`. Staging first; check `PRAGMA table_info(hf_kyc)`.

## 3. Deploy + flag
Commit first, then `scripts/cf.sh worker deploy`. Flip in ONE call, wait ~60 s, confirm:
```bash
scripts/flags.sh set hostKycEnabled=true
scripts/flags.sh get
```
Off = every route answers `404 {"error":"not_enabled"}`. Admins must be in `ADMIN_UIDS`.

## 4. Test steps (staging, signed-in Clerk token `$T`, base `$W`)
1. **Primary: Aadhaar OTP.** `curl -XPOST $W/api/hosts/kyc/aadhaar/otp -H "authorization: Bearer $T" -d '{"aadhaar":"<12 digits>","consent":true,"role":"host"}'` → `{ok:true,expires_in_s:600}` (UIDAI SMS to the linked mobile); then `POST .../aadhaar/verify {"otp":"<6 digits>"}` → `{ok, gender, ageOk:true, last4, firstName}`. `hf_kyc.provider='sandbox_okyc'`, `provider_ref` = Sandbox reference id. KV `hfkyc:ref:<uid>` holds only reference id + last4 + role + wrong-OTP counter (10 min); the 12-digit number is never stored.
   **When the UI must switch to DigiLocker:** every error from these two routes carries a stable `error` and, when DigiLocker is the right next move, `"fallback":"digilocker"`:
   | status | error | fallback | when |
   |---|---|---|---|
   | 503 | `otp_unavailable` | yes | Sandbox timeout / 5xx / "Source Unavailable" / bad response / 401-403 after re-auth / message says deprecated, not enabled, not allowed, unauthorised / "retry later" twice |
   | 422 | `otp_no_mobile` | yes | no mobile linked to the Aadhaar |
   | 429 | `too_many` | yes | our rate limits (3/h, 10/day per user, global; 6 verifies per 10 min) |
   | 429 | `otp_attempts_exhausted` | yes | 3rd wrong/expired OTP for one reference (reference is dropped) |
   | 422 / 410 | `invalid_otp` / `otp_expired` | no | 1st and 2nd failure, with `attemptsLeft` (2, 1) |
   | 422 | `invalid_aadhaar` (`field:"aadhaar"`) | no | typo in the number |
   | 429 | `retry_later` | no | first "request under process" |
   | 503 | `kyc_unavailable` | no | Sandbox / HF_PII_KEY not configured (DigiLocker needs the same keys) |
   Telemetry: `hf_kyc_failed {step, reason, fallback}` and, when offered, `hf_kyc_fallback_offered {from:"otp", reason}`; success `hf_kyc_aadhaar_verified {method:"otp"}`.
2. **Fallback: DigiLocker.** `curl -XPOST $W/api/hosts/kyc/digilocker/start -H "authorization: Bearer $T" -d '{"consent":true,"role":"host"}'` → `{ok:true,url}` (open `url`, sign in to DigiLocker, share Aadhaar); 4th call within an hour → 429. After DigiLocker redirects back: `POST .../digilocker/complete {}` → `{ok, gender, ageOk:true, last4, firstName}`. While DigiLocker is still waiting: `202 {ok:false,pending:true}` (retry). Cancelled → 409 `consent_denied`; Aadhaar not shared → 409 `aadhaar_not_shared`; expired → 410 `session_expired`; no session → 400 `no_session`. `hf_kyc.provider='sandbox_digilocker'`, `provider_ref` = DigiLocker session id, event `method:"digilocker"`. D1: `SELECT uid,aadhaar_last4,gender,age_ok,substr(name_enc,1,3) FROM hf_kyc` — name_enc starts `v1:`; no 12-digit number anywhere. R2 VERIFICATION has `hf/kyc/<uid>/aadhaar-photo.jpg` (OTP path always has a photo; DigiLocker profile fallback does not).
3. `POST .../selfie/code` → `{code}`; upload a webm/mp4 ≥ 20 KB:
   `curl -XPOST $W/api/hosts/kyc/selfie -H "authorization: Bearer $T" -H "content-type: video/webm" -H "x-selfie-code: <code>" --data-binary @clip.webm` → `{ok, status:"pending"}`. Wrong code → 400 `code_mismatch`; > 12 MB → 413.
4. `POST .../payout/verify {"upi":"name@bank","account":"<9-18 digits>","ifsc":"HDFC0001234"}` → `{ok, nameAtBank, match, accountLast4, upiVerified:false}`. A non-matching name is returned masked (`R**** S*****`).
5. `GET .../kyc/status` → aadhaar done (`aadhaar.method` = `otp` | `digilocker`), selfie `pending`, payout done.
6. Admin: `GET /api/admin/hf/kyc?status=pending` → items with `selfieUrl`/`photoUrl` (valid 5 min; open in the browser, supports Range). `POST /api/admin/hf/kyc/<uid>/selfie {"decision":"approve"}` (reject needs `reason`). Each list/media view/decision is a row in `admin_audit` (DB_WALLET, action `hf_kyc_*`).
7. PostHog (project 139917): `hf_kyc_aadhaar_otp_sent` (ok, role), `hf_kyc_digilocker_started` (role), `hf_kyc_fallback_offered` (from, reason), `hf_kyc_aadhaar_verified` (gender, age_ok, method), `hf_kyc_selfie_uploaded`, `hf_payout_verified` (match), `hf_kyc_selfie_reviewed`; failures as `hf_kyc_failed {step,reason}` and `$exception`.
8. `python3 tool/check_ship_readiness.py --check telemetry` once real traffic exists.

## 5. Known gaps / owner decisions needed
- **Aadhaar: OTP primary, DigiLocker fallback** (owner instruction, HF-KYC-OTP-FALLBACK-1). The OTP (OKYC) endpoints carry a UIDAI deprecation notice at Sandbox and may stop working without notice (TODO(owner): ask Sandbox support if OKYC is live for our account); that is what the fallback signal is for. The OTP path receives the 12-digit number only in the `/aadhaar/otp` body and forwards it to Sandbox; only last4 is kept. DigiLocker never sees the number (masked uid). The DigiLocker e-Aadhaar XML is parsed by `parseEAadhaarXml()`; if it cannot be fetched/parsed we use the DigiLocker user profile (name, DOB, gender; no photo, address or last4). XML attribute names and the profile `date_of_birth` format are handled defensively but UNCONFIRMED against live Sandbox: verify in staging. `redirect_url` must be public https. The `hf_kyc_otp` table is the OTP request ledger again (status sent/failed/verified/declined/rejected). Classification lives in `lib/hf_kyc_fallback.ts`; vendor message patterns (no-mobile, deprecated) are best guesses until seen live.
- **No UPI/VPA verification at Sandbox.** The UPI ID is stored encrypted and `upi_verified=0`. Pick a VPA vendor and implement `upiVerify()`.
- Penny-less works only for supported banks; unsupported banks return `bank_unsupported`. The paid penny-drop (₹1 deposit) is deliberately not called (HF-KYC-4 says no-deposit).
- Retention (HF-PRIV-6: hosting + 1 year): no purge job yet; selfie videos are kept after review. Needs a cron + delete-on-request flow.
- Same Aadhaar on two accounts is not detected (we never store the number or a hash of it).
- No WhatsApp notice to the host on selfie approve/reject yet; the host sees it via `GET /api/hosts/kyc/status`.
- Aadhaar photo is stored unencrypted in the private bucket (images are not field-encrypted).
