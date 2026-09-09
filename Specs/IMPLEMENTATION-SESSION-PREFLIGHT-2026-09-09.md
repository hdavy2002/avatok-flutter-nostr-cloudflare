# Session preparation implementation — 2026-09-09

Implemented under SESSION-PREFLIGHT-1 after the screen audit.

## User-visible changes

- App appointment setup now includes a private camera preview, real microphone input meter, camera/mic switches and a user-triggered speaker sound test.
- App live backstage now includes camera/mic switches, camera flip, a microphone meter from the existing Stream call and a speaker test. Controls lock during live handoff.
- Website live host preview and appointment preparation include a real microphone meter and speaker test with retry/error guidance.
- Availability explains that creators first create their appointment service through Create listing, then set their working hours here. The app page title now says Availability.
- An appointment cannot be joined while connection checks are pending, missing, failed or unknown. Enabled devices need permission and successful local acquisition.

## Media ownership and privacy

The app appointment preview uses a local video-only camera track and a single local PCM microphone capture. PCM is used only for RMS input level and discarded; it is never saved or uploaded. The preview recorder and camera are released before SDK room admission. Leaving, backgrounding or a delayed device startup cannot reopen released preview capture. Failed joins restore the preview through the setup panel lifecycle.

Live backstage keeps its existing Stream call as the sole media owner; it does not open another camera or microphone. Speaker tests generate a short local tone and serialize playback/stop/disposal. The test is stopped before live start or appointment join. A completed tone does not prove the user heard it; the UI asks them to check volume/headphones.

Browser microphone checks analyze the existing preview stream without connecting it to speaker output. Unsupported/suspended browser audio has retry guidance. Speaker tests retain user activation and invalidate delayed resume promises after stop/unmount.

## Verification evidence

- Commits: f2d2649e implementation; 8fef4fa5 harness compatibility; b484f342 handoff locking and focused CI option.
- Full verification run 34368539565 identified unrelated native wizard compile/design failures and existing worker test failures. Those are not represented as passing; native listing findings were sent to the task owning those files.
- Final focused run 34370404207 at 48eada0c passed: commercial Flutter analysis, 23 app tests, website TypeScript analysis and seven browser-audio unit tests. These are automated tests, not physical device acceptance.
- Production web deployment 34369665310 succeeded at b484f342. The production Availability page responds HTTP 200 and contains Create listing guidance.
- Integration repairs 6c7e97bc and 8fb4ccb2 address native wizard model/import/style issues; 48eada0c ensures missing permissions never emit a false ready telemetry event. Wider verification found pre-existing worker test failures and native listing integration errors. Native fixes are committed through 7cbe13e6 (including the listing task's cd6a99dd design cleanup); full verification 34371545722 now passes whole-app analysis (fatal on errors) and the design guard. The broader app unit suite also passed: 157 tests passed, 2 skipped. Worker failures remain unrelated to this change. None of the backend test failures were changed or hidden.
- App regression tests cover pending/unknown connection checks, disabled-device permissions, PCM energy, delayed camera/recorder release, retry after failure, small-screen layout and speaker lifecycle.
- No physical phone was visible to ADB or the filtered USB inventory at the last check. Browser sign-in repair is being handled in the separate Google login task.
- Real two-account media, inbox/calendar delivery and phone acceptance remain pending. These require a creator and separate customer account and the updated software on both sides. No production purchase, email resend or live broadcast was performed in this task.

## Delivery and acceptance boundary

No new Android release was dispatched for this implementation request; previously published build 10639 does not contain these new checks. The app source and CI verification are separate from Play distribution. Production web deployment is complete. A QA evidence event was accepted by PostHog (HTTP 200), explicitly marking physical device, two-account media and delivered email as unverified.
