// Shared identity-check pieces (HF-NATIVE-8). Host onboarding (HF-NATIVE-9/10) and the lane screens use these:
//
//   AadhaarVerifyWidget   OTP, DigiLocker fallback, resume after the Custom Tab
//   SelfieVideoWidget     front camera, code on screen, 10 s, review, upload
//   PermissionGate        explainer, Android prompt, "Open settings" (camera, mic)
//   KycApi / kycApiProvider, KycTelemetry, DigiLockerPendingStore
export 'data/digilocker_pending.dart';
export 'data/kyc_api.dart';
export 'data/kyc_models.dart';
export 'data/kyc_telemetry.dart';
export 'data/permission_service.dart';
export 'data/selfie_recorder.dart';
export 'ui/aadhaar_verify.dart';
export 'ui/kyc_copy.dart';
export 'ui/kyc_parts.dart';
export 'ui/permission_gate.dart';
export 'ui/selfie_video.dart';
