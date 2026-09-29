// gmwatch - Google Messages watcher for Saathum UPI payment confirmation.
//
// Watches the paired Google Messages (web pairing) of the payment phone and
// forwards new HDFC credit SMS to the Saathum webhook, HMAC-signed exactly like
// the Android companion. INTERNAL USE ONLY: depends on the AGPL-3.0 library
// go.mau.fi/mautrix-gmessages (libgm); do not distribute the binary.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

const usage = `gmwatch - Google Messages watcher (internal use only, AGPL-3.0 dependency)

  gmwatch login [cookies-file|-]   pair with the phone (interactive)
  gmwatch run                      watch and forward (run under launchd)
  gmwatch listconvs                show how HDFC appears in Google Messages (sender tuning)
  gmwatch selftest                 print a sample signed payload (no network)

Config: env GMWATCH_DEVICE_ID, GMWATCH_DEVICE_SECRET, GMWATCH_WEBHOOK_URL,
GMWATCH_HEARTBEAT_URL, GMWATCH_SENDER_REGEX, GMWATCH_DATA_DIR, GMWATCH_DEBUG=1
or ~/Library/Application Support/gmwatch/config.json (chmod 600).
`

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "login":
		err = cmdLogin(os.Args[2:])
	case "run":
		err = cmdRun()
	case "listconvs":
		err = cmdListConvs()
	case "selftest":
		err = cmdSelfTest()
	default:
		fmt.Fprint(os.Stderr, usage)
		if cmd != "" && cmd != "help" && cmd != "-h" && cmd != "--help" {
			os.Exit(2)
		}
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

const (
	sampleSMS = "Credit Alert!\nRs.1.00 credited to HDFC Bank A/c XX3055 on 17-09-26 from VPA 9970176848@icici (UPI 110703825348)"
	sampleDev = "gmwatch-selftest"
	sampleSec = "dummy-secret-not-real"
	sampleNon = "00112233445566778899aabbccddeeff"
)

func cmdSelfTest() error {
	now := time.Date(2026, 9, 17, 10, 30, 5, 0, time.UTC)
	received := "2026-09-17T10:30:00Z"
	p, sts := BuildIncoming(sampleDev, sampleSec, "HDFCBK", sampleSMS, received, now, sampleNon)
	fmt.Printf("canonical string to sign (%%q):\n%q\n\n", sts)
	fmt.Printf("message_hash: %s\nsignature:    %s\n\npayload JSON:\n", p.MessageHash, p.Signature)
	b, _ := json.MarshalIndent(p, "", "  ")
	fmt.Println(string(b))
	hb := BuildHeartbeat(sampleDev, sampleSec, now, sampleNon)
	fmt.Printf("\nheartbeat string to sign: %q\nheartbeat JSON:\n", HeartbeatStringToSign(sampleDev, sampleNon, hb.SentAt))
	b, _ = json.MarshalIndent(hb, "", "  ")
	fmt.Println(string(b))
	fmt.Printf("\nsender passes server isHdfcSender: %v\n", passesServerSender(p.Sender))
	return nil
}
