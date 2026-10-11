import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/features/host_profile/data/host_profile_providers.dart';
import '../support/fake_api_client.dart';
import 'explore/explore_test_support.dart';

class _Session extends SessionController {
  @override
  SessionState build() => const SessionState(status: SessionStatus.signedIn, me: HfMe(uid: 'first'));
  void change(String uid) => state = SessionState(status: SessionStatus.signedIn, me: HfMe(uid: uid));
}
void main() {
  const path='/api/hosts/public/asha';
  Map<String,dynamic> payload(String? lane) => {
    'slug':'asha','displayName':'Asha','protectedLane':lane,
  };
  ProviderContainer rig(FakeApiClient api, MemoryJsonCache cache) {
    final c=ProviderContainer(overrides:[
      sessionProvider.overrideWith(_Session.new),
      apiClientProvider.overrideWithValue(api), jsonCacheProvider.overrideWithValue(cache)]);
    addTearDown(c.dispose); return c;
  }
  test('lane detail authenticates, carries lane and never persists protected data', () async {
    final api=FakeApiClient()..onJson('GET',path,payload('lgbtq'));
    final cache=MemoryJsonCache();
    final c=rig(api,cache);
    await c.read(laneHostProfileProvider((slug:'asha',lane:'lgbtq')).future);
    expect(api.calls.single.auth,isTrue);
    expect(api.calls.single.query,{'lane':'lgbtq'});
    expect(cache.store.containsKey(hostProfileCacheKey('asha')),isFalse);
  });
  test('authorization failure cannot resurrect an explicitly public cache', () async {
    final cache=MemoryJsonCache()..seed(hostProfileCacheKey('asha'),payload(null));
    final api=FakeApiClient()..onError('GET',path,const ApiError(status:403,code:'lane_required'));
    final c=rig(api,cache);
    await expectLater(c.read(hostProfileProvider('asha').future),throwsA(isA<ApiError>()));
  });
  test('offline lane request never borrows public or other-account cache', () async {
    final cache=MemoryJsonCache()..seed(hostProfileCacheKey('asha'),payload(null));
    final api=FakeApiClient()..onError('GET',path,ApiError.network());
    final c=rig(api,cache);
    await expectLater(c.read(laneHostProfileProvider((slug:'asha',lane:'lgbtq')).future),throwsA(isA<ApiError>()));
  });
  test('legacy unmarked cache is rejected, explicitly public cache works offline', () async {
    final cache=MemoryJsonCache()..seed(hostProfileCacheKey('asha'),{'slug':'asha','displayName':'Old'});
    final api=FakeApiClient()..onError('GET',path,ApiError.network());
    final c=rig(api,cache);
    await expectLater(c.read(hostProfileProvider('asha').future),throwsA(isA<ApiError>()));
    cache.seed(hostProfileCacheKey('asha'),payload(null));
    c.invalidate(hostProfileProvider('asha'));
    expect((await c.read(hostProfileProvider('asha').future)).fromCache,isTrue);
  });
  test('account change rechecks lane authority instead of reusing old provider result', () async {
    final cache=MemoryJsonCache();
    final api=FakeApiClient()..onJson('GET',path,payload('lgbtq'));
    final c=rig(api,cache);
    final provider=laneHostProfileProvider((slug:'asha',lane:'lgbtq'));
    final sub=c.listen(provider,(_,__) {});
    addTearDown(sub.close);
    await c.read(provider.future);
    api.onError('GET',path,const ApiError(status:403,code:'lane_required'));
    (c.read(sessionProvider.notifier) as _Session).change('second');
    await expectLater(c.read(provider.future),throwsA(isA<ApiError>()));
    expect(api.calls.length,2);
  });
}
