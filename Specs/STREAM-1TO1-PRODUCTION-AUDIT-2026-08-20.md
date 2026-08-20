# Stream 1:1 Audio Production Audit — 20 August 2026

## Bottom line

- The call tested on 20 August was **not a Stream call**. PostHog shows it used the existing Cloudflare P2P path because build 10593 had the Stream bridge compiled out.
- The next release is now configured to compile both Stream and Cloudflare. Production can select Stream for new 1:1 audio calls, or return to Cloudflare with one remote flag and no rebuild.
- No app build or Play release was started as part of this work.

## What PostHog proved

- The first call connected quickly and received audio packets, but the emulator did not produce audible sound. That points to Android audio focus/routing rather than signalling delay.
- The two “phone did not respond” screens were two separate call attempts, not one duplicate popup. They had different call IDs and began about two seconds apart.
- Neither callback was successfully registered by the server. The caller began polling call state too early and received repeated `not_a_call_participant` responses.
- The old app treated some failed placement responses as success, so it could show a live-looking call and start no-answer/receptionist timing for a call that did not exist.

## Fixes made

1. **Stream is compiled into release builds by default.** Runtime flags still decide the provider.
2. **Cloudflare remains the rollback path.** Turning `streamCallPilotEnabled` off sends new 1:1 calls back to the existing Cloudflare implementation.
3. **Messages remain on Cloudflare.** No messaging route or storage was moved to Stream.
4. **Groups remain on Cloudflare.** Stream selection is limited to 1:1 audio.
5. **Video is excluded from Stream.** The Worker now forwards the real media type into provider selection, the Stream bridge disables the camera before and after joining, and native camera-enable commands fail closed.
6. **Duplicate Android audio-focus ownership was removed.** AvaTOK sets communication mode and routing, while the active RTC engine owns focus.
7. **Mute now controls the real Stream microphone.** User mute, cellular hold, focus hold and normal resume all apply the combined effective mic state.
8. **Hold now controls Stream playback as well as the microphone.** AvaTOK’s existing hold UI is preserved.
9. **Caller cancel now sends Stream `Cancel`.** A ringing recipient is dismissed instead of being left with a ghost call.
10. **Recipient decline reaches the caller as declined.** The caller ends and sees the existing “Call declined” result.
11. **Placement must succeed before polling or receptionist timers begin.** This removes the `403 not_a_call_participant` storm and the false offline screen.
12. **Placement now has an eight-second client deadline.** Unexpected HTTP responses become an honest network failure instead of a fake success.
13. **Cancel-during-placement is repaired.** If the user closes the call while the request is still completing, AvaTOK retries a room-specific cancel so a late server write cannot ring the recipient afterwards.
14. **Fast placement/start races are buffered.** A placement response arriving before the call session finishes attaching is replayed after session initialization instead of being lost or resetting state.
15. **Audio route recovery is bounded and call-scoped.** Unknown routes are retried, and a late result from an old call cannot overwrite the next call’s route.
16. **A call is not declared audibly healthy from RTP bytes alone.** Stream now separates first packet, decoded/jitter-buffer samples, first audible voice activity and confirmed audio route.
17. **The four-second Stream “healthy anyway” timeout was removed.** Stream waits for native audio evidence; it does not turn a remote join into a false audible call.
18. **Killed/background app handling remains native.** Stream FCM can show and accept the ringing call without waiting for Flutter to boot.
19. **Firebase token rotation is shared safely.** The Stream service registers the token with Stream and forwards the refresh to FlutterFire, preserving AvaTOK/Cloudflare messaging pushes.
20. **The Ava receptionist lane was not replaced.** The same server-authoritative missed-call/receptionist flow remains, and its timer cannot start until placement is real.

## New PostHog measurements

- Provider, call ID, role, media mode and call-stage timings.
- Placement latency, HTTP result, placement timeout and late-cancel outcome.
- Stream client initialization, native accept, join and reconnect timing.
- First remote join, first audio track, first RTP packet, first decoded/planned playout and first audible voice activity as separate events.
- Confirmed route, route-confirmed flag, available input/output device types, Android audio mode and whether focus ownership is inferred.
- Actual Stream SDK mic state, system mic mute, speaker state and voice-call volume/max.
- Native output sample rate, codec sample rate, channels and frames per buffer.
- RTT, jitter, packet loss, inbound/outbound bitrate, available bandwidth and network type.
- Received/sent packets and bytes, jitter-buffer output, concealed samples, concealment percentage and interruptions.
- A clear marker that Android/WebRTC does not expose the hardware AudioTrack underrun counter; concealment and playout-stall signals are recorded as the honest proxies.

## Production configuration verified

- Stream API key, secret and webhook secret exist in the production Worker.
- The Stream dashboard production app exists.
- Firebase push is enabled in the Stream dashboard.
- A production webhook URL is configured.
- Production flags already read `streamCallPilotEnabled=true` and `streamCallPilotPercent=100`.
- The required audio-readiness and audio-owner flags are enabled.
- No database migration is required for these fixes.

## Rollback

- Set `streamCallPilotEnabled=false` in production.
- New 1:1 calls immediately use Cloudflare.
- Calls already assigned to a provider stay on that provider until they end; no call switches networks halfway through.
- A later build can also set the compile switch off as a second, build-time escape hatch.

## What still requires the eventual build

- Static review and production configuration can prove that the Stream lane is wired correctly, but only a Stream-enabled signed app can prove real speaker and microphone behavior on the target phones.
- The first acceptance test should be a 30-second physical-phone-to-physical-phone audio call, followed by an emulator signalling test with Bluetooth avoided.
- The release should be judged in PostHog by provider=`stream`, first decoded/confirmed playout, route confirmation, non-zero outbound mic level, non-zero received audio, and clean cancel/decline events on both devices.

