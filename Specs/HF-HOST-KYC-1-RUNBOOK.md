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
1. `curl -XPOST $W/api/hosts/kyc/digilocker/start -H "authorization: Bearer $T" -d '{"consent":true,"role":"host"}'` → `{ok:true,url}` (open `url`, sign in to DigiLocker, share Aadhaar); 4th call within an hour → 429. The old `/aadhaar/otp` and `/aadhaar/verify` now answer `410 use_digilocker`.
2. After DigiLocker redirects back: `POST .../digilocker/complete {}` → `{ok, gender, ageOk:true, last4, firstName}`. While DigiLocker is still waiting: `202 {ok:false,pending:true}` (retry). Cancelled → 409 `consent_denied`; Aadhaar not shared → 409 `aadhaar_not_shared`; expired → 410 `session_expired`; no session → 400 `no_session`. `hf_kyc.provider='sandbox_digilocker'`, `provider_ref` = DigiLocker session id. D1: `SELECT uid,aadhaar_last4,gender,age_ok,substr(name_enc,1,3) FROM hf_kyc` — name_enc starts `v1:`; no 12-digit number anywhere. R2 VERIFICATION has `hf/kyc/<uid>/aadhaar-photo.jpg`.
3. `POST .../selfie/code` → `{code}`; upload a webm/mp4 ≥ 20 KB:
   `curl -XPOST $W/api/hosts/kyc/selfie -H "authorization: Bearer $T" -H "content-type: video/webm" -H "x-selfie-code: <code>" --data-binary @clip.webm` → `{ok, status:"pending"}`. Wrong code → 400 `code_mismatch`; > 12 MB → 413.
4. `POST .../payout/verify {"upi":"name@bank","account":"<9-18 digits>","ifsc":"HDFC0001234"}` → `{ok, nameAtBank, match, accountLast4, upiVerified:false}`. A non-matching name is returned masked (`R**** S*****`).
5. `GET .../kyc/status` → aadhaar done, selfie `pending`, payout done.
6. Admin: `GET /api/admin/hf/kyc?status=pending` → items with `selfieUrl`/`photoUrl` (valid 5 min; open in the browser, supports Range). `POST /api/admin/hf/kyc/<uid>/selfie {"decision":"approve"}` (reject needs `reason`). Each list/media view/decision is a row in `admin_audit` (DB_WALLET, action `hf_kyc_*`).
7. PostHog (project 139917): `hf_kyc_digilocker_started` (role), `hf_kyc_aadhaar_verified` (gender, age_ok, method), `hf_kyc_selfie_uploaded`, `hf_payout_verified` (match), `hf_kyc_selfie_reviewed`; failures as `hf_kyc_failed {step,reason}` and `$exception`.
8. `python3 tool/check_ship_readiness.py --check telemetry` once real traffic exists.

## 5. Known gaps / owner decisions needed
- **Aadhaar now comes from Sandbox DigiLocker** (the deprecated UIDAI OTP/OKYC API was removed). We never receive the full Aadhaar number, only the masked uid (last4). The e-Aadhaar XML is parsed by `parseEAadhaarXml()`; if it cannot be fetched/parsed we fall back to the DigiLocker user profile (name, DOB, gender; no photo, address or last4). XML attribute names and the profile `date_of_birth` format (epoch ms/seconds or DD-MM-YYYY) are handled defensively but UNCONFIRMED against live Sandbox: verify in staging. `redirect_url` must be public https (site origin + returnPath). The `hf_kyc_otp` table is unused now.
- **No UPI/VPA verification at Sandbox.** The UPI ID is stored encrypted and `upi_verified=0`. Pick a VPA vendor and implement `upiVerify()`.
- Penny-less works only for supported banks; unsupported banks return `bank_unsupported`. The paid penny-drop (₹1 deposit) is deliberately not called (HF-KYC-4 says no-deposit).
- Retention (HF-PRIV-6: hosting + 1 year): no purge job yet; selfie videos are kept after review. Needs a cron + delete-on-request flow.
- Same Aadhaar on two accounts is not detected (we never store the number or a hash of it).
- No WhatsApp notice to the host on selfie approve/reject yet; the host sees it via `GET /api/hosts/kyc/status`.
- Aadhaar photo is stored unencrypted in the private bucket (images are not field-encrypted).
