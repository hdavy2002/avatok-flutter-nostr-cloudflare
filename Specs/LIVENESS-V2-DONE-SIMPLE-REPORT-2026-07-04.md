# Liveness V2 — What We Did (Simple English)

**Date:** 4 July 2026

## The problem we were fixing

The "prove you're a real person" video check was broken. **Nobody had ever passed it.**

Two things went wrong:

1. **It rushed you.** The old check moved from step to step on a stopwatch. It never actually looked to see if your face was there or if you did what it asked — it just counted a few seconds and took photos, whether you were ready or not. So it "raced past" the instructions.
2. **It lied about the reason.** When you finished, the phone sent everything to the server in one long request. The server took too long, the phone gave up, and it showed **"Network error — try again."** People kept retrying and used up their 3 tries.

## What we built (a whole new check, "Liveness V2")

We built a smarter version that **watches your camera in real time** and only moves forward when you actually do each thing.

- **It coaches you before taking any photo.** If the room is too dark, the light is behind you, your eyes are closed, your face is off to the side, more than one person is in frame, or something is covering your face — it tells you exactly what to fix, in plain words, before capturing.
- **It brightens your screen** and puts a white glow around the preview so your face is well-lit even in a dim room.
- **The challenge only advances when you really do it.** Move your head in a circle (it fills a ring as you go), do one expression (smile / open mouth / raise eyebrows / blink twice), and say the phrase out loud. No more stopwatch racing.
- **You can redo one step** without starting the whole thing over, and redoing a step doesn't cost you one of your 3 tries.
- **Honest waiting.** After you submit, the phone now says "Checking your clip… this can take up to a minute" and quietly checks in the background — instead of the fake "Network error".
- **Clear results.** If it fails, it lists exactly what went wrong ("Your eyes were closed", "Move to a brighter spot", etc.) and shows a "Tips for a good video" guide. If you close the app mid-check, it remembers and shows the result when you come back.

## The important fix that's already live for everyone

The "fake Network error" fix and the smarter server checks were **turned on for all users today** (they work with the old screen too, so nothing breaks). This alone should stop the false errors and wasted retries.

The brand-new on-screen experience (the head-circle, coaching, etc.) is **built but kept switched off** behind a flag called `livenessV2Enabled`. We turn it on after it's tested in the build system. The old screen keeps working until then.

## What we deployed

- **avatok-api** (the main server) — deployed. This is what carries the "no more fake Network error" fix.
- **avatok-consumers** — deployed to stay in sync.

## Safety kept exactly as before

Still 3 tries per 24 hours, the challenge is still secret until you start, and we still keep the evidence for audit. We did **not** use any paid face service — it runs on Cloudflare's free AI (LLaVA + Whisper).

## Tracking

A new PostHog dashboard **"Liveness V2"** shows where people get stuck, the most common coaching hints, the top failure reasons, and how long checking takes.

## Code status

All the work is **saved locally in 14 commits** (labelled `LIVE-V2-P0` through `P4`). As requested, **nothing was pushed** — that stays for you to do.
