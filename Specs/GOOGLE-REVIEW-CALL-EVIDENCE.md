# Google Play Review: Call Background + PiP Evidence Recording Script

**Date:** 2026-07-04 · **Owner decision:** professional in-call multitasking parity (WhatsApp/Telegram)
**Target:** Record a 60–90 second screen capture demonstrating that a P2P call survives backgrounding with audio flowing and notification visible. This is the core evidence Google Play reviewers require for the "calls in background" feature.

---

## Pre-Recording Setup

1. **Device:** Android 13+ (ideally a mid-range device for realistic performance)
2. **Accounts:**
   - Test account A: hdavy2005@gmail.com (the caller, on the phone being recorded)
   - Test account B: Another account on a desktop / browser / second phone (the peer being called)
3. **Network:** WiFi (stable, low latency for clear audio)
4. **Preparedness:**
   - Open Test Account B (peer) in a Chrome browser or on another device, ready to answer a call
   - Clear app cache, fresh APK install so the first startup is clean
   - Sign into Test Account A on the recording device
   - Open the HomeTab so the Call initiation is a natural flow
5. **Recording tool:** Screen recorder app (Android's built-in recorder, or an external tool like AZ Screen Recorder)

---

## Recording Script

### Part 1: Establish the Call (20 seconds)

**Narration:** "Here we're starting an outgoing call in AvaTOK. We'll call our peer, demonstrate that the call stays connected in the background, and show the ongoing notification."

**On-screen actions:**
1. **[0–3 s]** Open the Dialpad (dial tab at the bottom)
2. **[3–5 s]** Type or search for the peer's name/number (or tap a recent contact)
3. **[5–8 s]** Tap the green call icon (dial)
   - **Narration:** "The call is now placing. You can see the ringback tone indication and the peer's name on screen."
4. **[8–12 s]** The peer (Test Account B) answers the call on their end
   - **On screen:** Both sides now show "Connected · end-to-end encrypted" + call timer ticking
   - **Narration:** "The call is now connected. You can hear the two-way audio—I can hear the peer and they can hear me."
   - Optional: Say a few words on mic so audio flow is clear ("Hello, can you hear me? The call is working.") — **keep audio clear for review**
5. **[12–20 s]** Show the full call screen
   - **Narration:** "The app is currently in full-screen call mode. Now we're going to demonstrate what happens when we press Home to background the app—the call stays connected."

---

### Part 2: Background the App + Show Notification (15 seconds)

**Narration:** "Now we press the Home button to background AvaTOK. The call and audio continue, and Android's ongoing-call notification becomes visible."

**On-screen actions:**
1. **[20–22 s]** Press the Home button (long-press or single-press device Home)
   - App disappears, device Home screen appears
   - **Narration:** "The app is now backgrounded. Notice the notification at the top of the screen."
2. **[22–25 s]** Swipe the notification panel down to reveal the ongoing-call notification
   - **Expected:** Title shows peer name, running chronometer (e.g., "Call · 00:25"), and a Hang up button/action
   - **Narration:** "Here's the ongoing-call notification. You can see the peer's name, the call duration timer running, and a Hang up option. The call is still connected and audio is flowing in both directions."
3. **[25–30 s]** Keep the notification visible for 5 seconds while audio continues
   - **Off-screen:** The peer should periodically say something so the reviewer hears audio flowing ("I can still hear you…" etc.)
   - **Narration:** "The audio is live in both directions. The peer and I can communicate normally even though the app is backgrounded. This is verified by the green microphone indicator in the Android status bar" — **point to the green mic dot if visible**
   - Alternative: Keep quiet and let the two-way audio be the evidence (some reviewers prefer minimal narration)
4. **[30–35 s]** Tap the notification body (NOT the Hang up action) to return to the app
   - **Narration:** "Now I'll tap the notification to return to the call."

---

### Part 3: Return to Full Screen + Confirm Continuity (10 seconds)

**On-screen actions:**
1. **[35–37 s]** App foregrounds and the call screen is shown again
   - Call timer is still running (should show ≥35 seconds elapsed)
   - Both sides still see video/audio active
   - **Narration:** "The app is now back in the foreground. The call continued the entire time and the timer picked up where it left off. This demonstrates true background call survival."
2. **[37–42 s]** Hold the call screen for 5 seconds, showing the connected state
   - Optional: Hold the phone to ear or speak a few words ("The peer and I are still connected") to prove audio
   - **Narration:** "The call is still connected with full two-way audio and video uninterrupted. This is the core functionality: backgrounding a call no longer drops it."
3. **[42–45 s]** End the call (red hang-up button)
   - **Narration:** "We'll hang up to end the call." or simply end it without narration
4. **[45–50 s]** The call ends, showing "Call ended" and returning to the home screen
   - Call entry appears in the call log with the correct duration

---

## Visual Checklist for Reviewer

The evidence must clearly show:

- [ ] **App backgrounding** — Home button press clearly visible, app disappears
- [ ] **Ongoing notification** — Visible with peer name, call timer, and Hang up action
- [ ] **Audio flow** — Audible two-way conversation (peer speaks, you speak) while backgrounded
- [ ] **Green mic indicator** — Android status-bar green mic dot visible (OS-native, not app-drawn)
- [ ] **Notification return** — Tapping notification brings app back to the active call screen
- [ ] **Call continuity** — Timer continues from where it left off; no reconnect/disconnect events
- [ ] **Clean end** — Hang-up ends the call and logs the entry

---

## Recording Quality Standards

- **Resolution:** 1080p or higher (FullHD+)
- **Frame rate:** 30 fps minimum (60 fps ideal)
- **Audio:** Clear, not muffled; peer's voice and your voice audible during backgrounded portion
- **Duration:** 50–90 seconds total (keep it concise but complete)
- **File format:** MP4 (H.264 or H.265) or WebM (VP9)

---

## Narration Script (Optional; for Reviewer Clarity)

If you choose to narrate, keep it brief and clear:

**Opening:**
"This is AvaTOK demonstrating background call support. We're going to start a call, background the app, and show that the call continues with audio flowing and the ongoing notification visible."

**During call setup:**
"The call is now ringing. The peer will answer it."

**After peer answers:**
"The call is connected. Both sides can hear each other clearly."

**Before home button:**
"Now we'll background the app by pressing Home. The call will stay connected."

**At notification:**
"Notice the ongoing-call notification with the peer's name, the running timer, and a Hang up option. The audio continues flowing in both directions. The green microphone indicator shows the mic is active."

**Returning:**
"Tapping the notification brings us back to the call. The timer continued, and the call stayed connected the whole time."

**End:**
"Thank you for reviewing. This demonstrates production-ready background call support for AvaTOK."

---

## Alternative Scenarios (Optional; for Comprehensive Evidence)

If you want to record additional evidence for stronger reviewer confidence, consider these add-ons:

### A) Video Call Background + PiP Minimize

**Additional steps (2–3 minutes total):**
1. Start a VIDEO call instead of audio
2. Confirm both sides see video (remote + local self-preview)
3. Press Back to minimize → draggable PiP thumbnail appears
4. Drag the thumbnail to snap to a screen edge
5. Open Chat → send a message
6. Tap PiP to return to full screen → video resumes

**Narration:** "For video calls, the app minimizes to a draggable floating thumbnail instead of closing. You can navigate the app while the call continues, and the audio/video stay active."

### B) Reconnect Resilience (Airplane Mode 5 s)

**Additional steps (1–2 minutes):**
1. Call is connected
2. Enable Airplane Mode (Settings → Airplane Mode toggle ON)
3. Wait 5 seconds → see "Reconnecting…" appear
4. Disable Airplane Mode (toggle OFF)
5. Wait 10 seconds → call recovers automatically, shows "Connected" again

**Narration:** "The app also handles brief network blips gracefully. When the network drops, it automatically reconnects without the user having to do anything."

### C) Incoming Call While Backgrounded

**Additional steps (1–2 minutes):**
1. Have a SECOND peer call while the first call is ongoing
2. Show the incoming call notification (push or in-app, depending on state)
3. The app auto-replies busy to the second caller (if call 1 is still active)
4. The first call continues uninterrupted

**Narration:** "If a second call comes in while a call is already active, AvaTOK intelligently replies busy and keeps the first call going. No dropped calls or phantom-busy state."

---

## Post-Recording Checklist

1. **Export the recording** to an MP4 or WebM file (≤500 MB ideally)
2. **Test playback** on a desktop/laptop to confirm:
   - Video smooth, no corrupted frames
   - Audio clear, peer's voice audible in the background portion
   - No drops or stutters
3. **Trim if needed** (remove the first few seconds of lag, last few seconds of black screen)
4. **Add metadata** (optional):
   - Title: "AvaTOK Background Call Demonstration"
   - Description: "Outgoing audio call backgrounded and resumed via notification. Call audio and timer continue uninterrupted."
5. **Upload to Google Play Console** as supplementary evidence for the "Calls in Background" feature claim

---

## Submission Notes for Google Play Review

Include with the video:

> **Feature:** Professional in-call multitasking (background calls + ongoing notification)
> 
> **Evidence:** The attached video demonstrates:
> - Outgoing P2P audio call placed and connected
> - App backgrounded via Home button; call survives
> - Ongoing-call notification visible with peer name, running timer, and Hang up action
> - Two-way audio confirmed during background stint
> - Green microphone indicator (Android native) shows mic is active
> - Notification tap returns to the active call screen
> - Call timer continues uninterrupted from background → foreground
> 
> **Implementation:** CallSession extraction (WS-A), Android foreground service + ongoing notification (WS-B), and in-app PiP minimize (WS-C) per the architecture spec in Specs/CALL-BACKGROUND-PIP-PLAN.md.
> 
> **Commits:** Wave 2 local commits [CALL-PIP-C1..C2], [CALL-RC-D2], [CALL-GLIVE-E1] on top of Wave 1 [CALL-BG-A0..A4] + [CALL-BG-B1] + [CALL-RC-D1].

---

## FAQ for Reviewers

**Q: Why do we need background calls?**
A: Modern messaging apps (WhatsApp, Telegram, Signal) support background calls so users can multitask—look up information, send a message, check the time—without dropping the call. Google Play reviewers expect this for VoIP apps.

**Q: How does the notification work?**
A: Android's `CallForegroundService` (with `CATEGORY_CALL` and `phoneCall|microphone` service types) displays the notification. The OS enforces it and manages the notification lifecycle.

**Q: What if the network drops?**
A: The app auto-reconnects within 30 seconds (WS-D reconnect state machine). If it takes longer, it gracefully ends the call with a "Call ended" notification.

**Q: Can the user end the call from the notification?**
A: Yes, the "Hang up" action on the notification ends the call immediately via a method-channel callback to CallSession.hangup().

**Q: Does this work for group calls?**
A: Currently, group conferences (≤25 via LiveKit) are NOT yet in Wave 2; only 1:1 P2P calls and Gemini Live voice calls are supported. Group calls will follow in a later release.

