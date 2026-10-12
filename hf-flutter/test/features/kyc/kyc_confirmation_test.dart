import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/kyc/data/kyc_api.dart';
import 'package:hf_app/features/kyc/kyc.dart';
import 'package:hf_app/features/lanes/data/lanes_api.dart';
import 'package:hf_app/features/lanes/ui/lanes_screen.dart';
import '../../support/fake_api_client.dart';

void main() {
  test('selfie challenge must contain exactly six numeric digits', () async {
    final client = FakeApiClient()..onJson('POST', '/api/hosts/kyc/selfie/code', {'code': '1234'});
    await expectLater(KycApi(client).selfieCode(), throwsA(isA<ApiError>()));
    client.onJson('POST', '/api/hosts/kyc/selfie/code', {'code': '001234'});
    expect(await KycApi(client).selfieCode(), '001234');
  });

  test('an upload without a pending review receipt cannot finish KYC', () async {
    final client = FakeApiClient()..onJson('POST', '/api/hosts/kyc/selfie', {'ok': true});
    await expectLater(KycApi(client).uploadSelfie(bytes: Uint8List(24000), mime: 'video/mp4', code: '123456'),
      throwsA(isA<ApiError>()));
  });

  test('Aadhaar cannot succeed on an empty 2xx response', () async {
    final client = FakeApiClient()..onJson('POST', '/api/hosts/kyc/aadhaar/verify', {});
    await expectLater(KycApi(client).aadhaarVerify('123456'), throwsA(isA<ApiError>()));
  });

  test('visual refresh preserves the canonical selfie and declaration truths', () {
    expect(kSelfieSeconds, 10);
    expect(LaneCopy.declare, contains('I identify as LGBTQ+'));
    expect(LaneCopy.leadOf(Lane.lgbtq), isNot(contains('verifies your orientation')));
    expect(KycVisualAsset.selfieRecord, endsWith('.webp'));
  });
}
