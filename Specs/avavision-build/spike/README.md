# AvaVision Phase 0 — throwaway spike (NOT shipped)

This folder proves the three AvaVision vision layers end-to-end and feeds the numbers in
`../PRICING.md`. **It is deleted by Phase Z.** Nothing here is wired into the app, the Worker,
or the web client. No secret is committed — you paste the key/token at runtime.

## What `index.html` proves
1. **Free overlay layer** — opens the camera (`getUserMedia`), runs **MediaPipe Tasks
   `pose_landmarker`** at ~30fps drawing a skeleton on a `<canvas>`, and computes a trivial
   geometry score (left-knee angle). Proves the zero-cost on-device layer.
2. **Gemini Live (voice + 1fps LOW-res video in)** — opens a Gemini Live WebSocket with an
   **ephemeral token** and streams mic audio + ~1 frame/sec downscaled JPEG, confirming the agent
   "sees" coarsely and talks back. The Live token reports usage metadata you copy into PRICING.md.
3. **Agentic-Vision snapshot** — a button posts **one** hi-res frame to
   `gemini-3-flash-preview` `generateContent` with **code execution** on and renders the returned
   text/annotated image. Confirms the snapshot path and the exact working model string.

## How to run (local, throwaway)
1. Mint an ephemeral Live token manually with the project key from `secrets/secret-values.env`
   (do **not** paste the raw long-lived key into a committed file). Quick mint:
   ```bash
   curl -s -X POST \
     "https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=$GEMINI_API_KEY" \
     -H 'content-type: application/json' \
     -d '{"uses":2,"expireTime":"'"$(date -u -v+30M +%Y-%m-%dT%H:%M:%SZ)"'"}'
   ```
   (on Linux use `date -u -d '+30 min' +%Y-%m-%dT%H:%M:%SZ`).
2. Serve the folder over HTTPS/localhost (camera + WS need a secure context):
   ```bash
   npx http-server . -p 8080   # or: python3 -m http.server 8080
   ```
3. Open `http://localhost:8080/`, paste the **ephemeral token** (Live) and your **API key**
   (snapshot-only, stays in the tab) into the fields, allow the camera, and exercise the three
   buttons. Read the on-page "usage" panel and copy figures into `../PRICING.md`.

## Notes
- Model strings used: Live = `gemini-3.1-flash-live-preview`; snapshot = `gemini-3-flash-preview`.
- Video is locked to `MEDIA_RESOLUTION_LOW` + ~1 fps to mirror the server-locked token AvaVision
  will mint. Do not raise it — that is the whole cost-control point.
- This page intentionally has no build step and no dependencies beyond CDN MediaPipe/TF.js.
