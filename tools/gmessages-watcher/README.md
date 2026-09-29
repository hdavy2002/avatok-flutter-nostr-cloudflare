# gmwatch - Google Messages watcher for Saathum UPI confirmation

Runs 24/7 on the owner's Mac mini. It stays paired to the payment phone's
Google Messages (the same thing as "Messages for web"), notices new HDFC
"credited" SMS, and sends each one to the Saathum webhook, signed exactly like
the Android companion app signs it. It also sends a heartbeat every 5 minutes so
the server can alert the owner if the watcher goes quiet.

**PROTOTYPE - INTERNAL USE ONLY.** It uses the AGPL-3.0 library
`go.mau.fi/mautrix-gmessages` (libgm), which talks to Google's *undocumented*
Messages-for-web API. Keep the binary on the owner's own machine; do not
distribute or host it as a service for others (AGPL obligations). Google can
change or block that API at any time, so keep the Android companion as backup.

## What you need

- The Mac mini (Apple Silicon), always on and online.
- The payment phone with Google Messages as its **default SMS app**, online, and
  with a **separate, dedicated Google account** signed in on it. Do NOT use a
  personal account (the session keeps that account's Messages open and the
  cookies are stored on disk).
- On the phone: Google Messages -> profile picture -> **Device pairing** ->
  turn on **Account pairing** for that Google account.
- The watcher device id and secret. The worker must have them set as
  `HDFC_SMS_WATCHER_DEVICE_ID` and `HDFC_SMS_WATCHER_DEVICE_SECRET`
  (see Specs/PLAN-SAATHUM-UPI-3LAYER.md, "Multi-source ingest"). Until the
  server side of that plan is deployed, the current worker only accepts the
  companion's `HDFC_SMS_DEVICE_ID/SECRET`.

## Build (once)

    brew install go            # already done if `go version` works
    cd tools/gmessages-watcher
    go build -o gmwatch .
    mkdir -p ~/bin && cp gmwatch ~/bin/

## Configure

Create `~/Library/Application Support/gmwatch/config.json` and `chmod 600` it:

    {
      "device_id": "the-watcher-device-id",
      "device_secret": "the-watcher-secret"
    }

Optional keys: `webhook_url`, `heartbeat_url`, `sender_regex`. Environment
variables override the file: `GMWATCH_DEVICE_ID`, `GMWATCH_DEVICE_SECRET`,
`GMWATCH_WEBHOOK_URL`, `GMWATCH_HEARTBEAT_URL`, `GMWATCH_SENDER_REGEX`,
`GMWATCH_DATA_DIR`, `GMWATCH_DEBUG=1` (verbose).

Defaults: webhook `https://api.avatok.ai/api/sms/incoming`, heartbeat = same
URL with `/heartbeat`. The API worker answers on both `api.avatok.ai` and
`api.saathum.com` (worker/wrangler.toml routes); either base works. Note the
route is dark (HTTP 410) until the flag `saathumSmsIngestEnabled` (or
`hdfcSmsRailEnabled`) is on.

## Pair (once, interactive)

    ./gmwatch login

It prints step-by-step instructions. In short:

1. Open a **private/incognito** window, sign in to the dedicated Google
   account, open https://messages.google.com/web/ .
2. DevTools -> Network -> reload -> right-click the `config` request ->
   Copy as cURL. Paste it into the terminal, press Enter, then Ctrl-D.
   (Or save it to a file and run `./gmwatch login file.txt`.)
3. Close the private window **without signing out**.
4. An emoji appears in the terminal; tap the same emoji on the phone.
5. It saves `~/Library/Application Support/gmwatch/session.json` (mode 0600).
   That file is as sensitive as a password - never commit or share it.

QR pairing no longer works, which is why the Google-account flow is used.

## Check how HDFC appears, then run

    ./gmwatch listconvs      # shows conversations and whether each matches the HDFC regex
    ./gmwatch run            # foreground test; Ctrl-C to stop

Send yourself a test credit (or wait for a real one) and watch the log lines
`incoming message ... sender_candidates=[...]`, `QUEUED HDFC credit`, and
`DELIVERED to webhook`. If `catch-up: NO conversation matched` appears, the log
lists the names/numbers libgm sees; adjust `GMWATCH_SENDER_REGEX` to match.

Sender handling: the server only accepts senders like `HDFCBK`, `VM-HDFCBK-S`.
Google Messages may show a verified-business display name ("HDFC Bank") instead.
The watcher sends the first raw value that already passes the server's
`isHdfcSender()`; otherwise it sends the fixed string `HDFCBK` (the match on the
watcher side already proved it is HDFC). The message hash covers whichever
value was sent, so it is consistent.

## Run forever (launchd)

    cp launchd/ai.saathum.gmwatch.plist ~/Library/LaunchAgents/
    # edit YOUR_USER in the file first
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.saathum.gmwatch.plist
    tail -f ~/Library/Logs/gmwatch.log

`KeepAlive` restarts it if it crashes; `RunAtLoad` starts it at login. A
LaunchAgent needs the Mac mini to be logged in (enable automatic login), or
adapt the plist to a LaunchDaemon. Trim the log occasionally (or add a
`newsyslog` rule) - it is plain text.

## Keep the Mac awake

- System Settings -> Energy: turn on "Prevent automatic sleeping when the
  display is off" and "Start up automatically after a power failure"; enable
  "Wake for network access".
- Or: `sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1`
  (`pmset -g` to verify). Alternatively wrap the service in `caffeinate -s`.
- Also on the phone: disable battery optimisation for Google Messages, keep it
  charging and on Wi-Fi/mobile data. If the phone or Messages goes offline the
  watcher reports "PHONE NOT RESPONDING" and stops heartbeats.
- Do not open messages.google.com on the dedicated account in any browser: a
  second web session steals the connection (`BROWSER_INACTIVE`). The watcher
  tries to reclaim it every minute and stops heartbeats meanwhile.

## What it does when things go wrong

- **Webhook down / offline:** every message is first written to
  `queue.json`, retried with exponential backoff (2 s up to 5 min, jittered),
  and survives restarts. Signatures are re-created on each attempt so `sent_at`
  stays inside the server's +-5 minute window. Permanent 4xx rejections are
  moved to `dead-letter.jsonl` after 5 tries (never for clock errors).
- **Missed while offline:** on start, after every reconnect, and every 15
  minutes it lists conversations, fetches the last 50 messages of HDFC ones and
  queues any credit from the last 48 h. `seen.json` avoids resending; the
  server dedupes by message hash anyway.
- **Logged out / unpaired / cookies revoked:** logs `!!!!! LOGGED OUT` every
  5 minutes and stops heartbeats. Fix: `./gmwatch login`, then
  `launchctl kickstart -k gui/$(id -u)/ai.saathum.gmwatch`.
- **Heartbeats** are sent only while connected, phone responding and the web
  session active, so server-side staleness (15 min) is the alarm for all of the
  above.

## Files (all under ~/Library/Application Support/gmwatch, mode 0600)

`session.json` (cookies + pairing keys), `config.json`, `queue.json`,
`seen.json`, `dead-letter.jsonl`.

## Self test (no network, no login)

    ./gmwatch selftest
    go test ./...

Prints the canonical string, hash and signature for a sample HDFC SMS with a
dummy secret; the unit test checks them against values produced with Node's
crypto exactly as the worker computes them.

## Signing scheme (matches worker + companion)

    message_hash = sha256_hex(sender|message|received_at)
    to_sign      = device_id\nsender\nmessage\nreceived_at\n<sim_slot or empty>\nmessage_hash\nnonce\nsent_at
    signature    = hmac_sha256_hex(secret, to_sign)
    heartbeat    = hmac_sha256_hex(secret, device_id\nnonce\nsent_at)

`sim_slot` is omitted (empty in the signed string). Timestamps are UTC
`YYYY-MM-DDTHH:MM:SSZ`.
