# Evening Report — What We Fixed & What To Test With Sat

Date: 5 July 2026, evening session. Plain English.

## First, good news from your afternoon test
The morning fixes WORKED — the data proves it: your end-call button ended 4 calls
instantly, minimize worked (it had never worked before), the app blocked 4 duplicate
call attempts automatically, and one call survived a network drop that would have
killed it yesterday.

## What we fixed tonight (10 fixes, all built by the AI team)

1. **A bug in our own new safety guard.** After a network hiccup, your phone was
   silently throwing away Sat's signals — including possibly his hang-up. Fixed.
2. **The last "user is busy" hole.** Accepting a call while the app was in the
   background could still create a double call that killed the real one. Closed on
   both the phone AND the server.
3. **Ava now steps aside.** If Ava is taking a message and you answer the real
   call, Ava quietly leaves — no voicemail, no confusion, no listening in.
4. **Calling each other at the same time now CONNECTS you** instead of "user is busy".
5. **Ava can now end a voicemail herself.** Short message + silence = polite
   goodbye and hang up. No more "that's all the time I have".
6. **Lock-screen call screen.** The app now asks Android for permission to show
   calls on your lock screen (Android hides this permission by default — you'll see
   a one-time prompt; please ACCEPT it). Your screen also wakes and shows the call.
7. **Coming back to the app = back in your call.** Go to WhatsApp mid-call, come
   back — the call screen reappears automatically. No more hunting for it.
8. **Calls survive other apps using sound.** If another app grabs the microphone,
   your call goes "on hold" and resumes — it no longer silently dies.
9. **Files now open like WhatsApp.** Tap a PDF → opens inside the app with
   pinch-zoom; images open full-screen with an X; other files open in their default
   app; share button included. Uploading a file during a call no longer chokes the
   call (uploads slow themselves down while you talk). "Paste image" removed from
   the menu — just long-press the message box and Paste.
10. **New network display on the call screen** — animated signal bars, WiFi/mobile,
    live speed up/down, data used this call, and a "weak network" badge when the
    OTHER person's connection is bad. Tap it for details.

## Your download
The arm64 APK is building now and will appear here (same link as always):
https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/releases/tag/calltest-latest
Both servers are already updated and live.

## Test checklist with Sat (in this order)

1. Install the new APK on BOTH phones. Accept the "show calls on lock screen"
   prompt when it appears.
2. Sat calls you with your phone LOCKED → you should see a real call screen.
3. Answer a call, go to WhatsApp, come back → you should land on the call screen.
4. During a call, send Sat a PDF → call should stay smooth; he taps it → opens
   in-app; tries an image → opens full-screen with X.
5. Call Sat when he can't answer → leave a SHORT message → Ava should say a quick
   goodbye and hang up herself.
6. While Ava is taking your message, have Sat call you back and ANSWER →
   Ava should vanish silently (no voicemail should arrive).
7. Both of you dial each other at the same moment → the call should just connect.
8. Watch the new network bars during the call — check the "weak" badge appears
   when Sat walks away from his router.
9. Try to hang up, minimize, and use the back button — all should stay instant.

Every one of these now leaves a trail in our analytics with a tracking number, so
if anything misbehaves, tell me WHICH test number failed and I can replay exactly
what happened.
